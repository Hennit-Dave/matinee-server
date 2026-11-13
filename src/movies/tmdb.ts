import { z } from 'zod';
import type { Logger } from '../http/logger.js';
import {
  MovieSourceError,
  OVERVIEW_MAX_LENGTH,
  type Movie,
  type MoviesPage,
  type MovieSource,
} from './movie.js';

/**
 * THE ONE FILE THAT KNOWS TMDB'S SHAPE (AGENTS.md section 4, RULES D1.5). Field names, URLs, the
 * image CDN and the auth scheme live here and nowhere else. If TMDB renames a field, this is the
 * only file that changes; everything else imports our own types from `movie.ts`.
 */

// ---- TMDB's response shape (the only place it is written down) -------------------------------

// Only the fields we use are listed. Plain z.object (not strict): TMDB adds fields freely and
// that must never break us. A field we DO use going missing or changing type fails the parse,
// which surfaces as `bad_shape` (logged, served from cache if we have one) instead of garbage.
const TmdbMovieSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  poster_path: z.string().nullish(),
  release_date: z.string().nullish(),
  overview: z.string().nullish(),
});

const TmdbListSchema = z.object({
  page: z.number().int().positive(),
  results: z.array(TmdbMovieSchema),
  total_pages: z.number().int().nonnegative(),
  total_results: z.number().int().nonnegative(),
});

const API_BASE = 'https://api.themoviedb.org/3';

/**
 * TMDB's image CDN: base + size + `poster_path` (which starts with "/"). w500 is one of TMDB's
 * fixed poster sizes and is sharp for a 2-3 column phone grid without the weight of "original".
 * The app is handed the finished URL and never learns any of this.
 */
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

// ---- Mapping: TMDB -> our Movie -------------------------------------------------------------

function toPosterUrl(posterPath: string | null | undefined): string | null {
  return posterPath ? `${IMAGE_BASE}${posterPath}` : null;
}

function toYear(releaseDate: string | null | undefined): number | null {
  const match = /^(\d{4})/.exec(releaseDate ?? '');
  const year = match ? Number(match[1]) : 0;
  return year > 0 ? year : null;
}

/** Whitespace-tidy, then cut to OVERVIEW_MAX_LENGTH on a word boundary with an ellipsis. */
function toOverview(overview: string | null | undefined): string | null {
  const text = (overview ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return null;
  const chars = Array.from(text); // code points, so we never split an emoji in half
  if (chars.length <= OVERVIEW_MAX_LENGTH) return text;
  const cut = chars.slice(0, OVERVIEW_MAX_LENGTH - 1).join('');
  const lastSpace = cut.lastIndexOf(' ');
  const onWord = lastSpace > OVERVIEW_MAX_LENGTH * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${onWord.trimEnd()}…`;
}

export function mapTmdbMovie(raw: z.infer<typeof TmdbMovieSchema>): Movie {
  return {
    id: raw.id,
    title: raw.title,
    posterUrl: toPosterUrl(raw.poster_path),
    year: toYear(raw.release_date),
    overview: toOverview(raw.overview),
  };
}

/** Parses a TMDB list response (now_playing or search) into our page. Throws ZodError if the shape is not what we expect. */
export function mapTmdbPage(body: unknown): MoviesPage {
  const list = TmdbListSchema.parse(body);
  return {
    movies: list.results.map(mapTmdbMovie),
    page: list.page,
    totalPages: list.total_pages,
    totalResults: list.total_results,
  };
}

// ---- Talking to TMDB: timeouts, retry with backoff -------------------------------------------

/** One attempt may take this long before we give up on it. */
export const ATTEMPT_TIMEOUT_MS = 3_000;
/** Attempts per call (1 try + 2 retries). */
export const MAX_ATTEMPTS = 3;
/** Hard ceiling for one call including retries and waits, so a request can never hang on TMDB. */
export const TOTAL_BUDGET_MS = 8_000;
/** Backoff before retry n is BASE * 2^(n-1) (250 ms, then 500 ms), with jitter. */
export const BACKOFF_BASE_MS = 250;
/** A 429's Retry-After is honoured up to this; a longer ask is not worth making a user wait for. */
export const RETRY_AFTER_CAP_MS = 2_000;

export interface TmdbDeps {
  /** TMDB v4 "API Read Access Token". Sent as a Bearer header; never logged. */
  readToken: string;
  logger: Logger;
  // Injectable so tests need no network and no real waiting.
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Seconds (or an HTTP date) from a Retry-After header, in ms. undefined if absent or unusable. */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export function createTmdbMovieSource(deps: TmdbDeps): MovieSource {
  const { readToken, logger } = deps;
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? realSleep;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;

  /** GET `path` and return TMDB's parsed list as our page. Retries only transient failures. */
  async function getPage(path: string, params: Record<string, string>): Promise<MoviesPage> {
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set('language', 'en-US');

    const startedAt = now();
    let lastFailure = new MovieSourceError('no_attempt');

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const remaining = TOTAL_BUDGET_MS - (now() - startedAt);
      if (remaining <= 0) break;

      let retryable = true;
      let hintMs: number | undefined;
      const attemptStartedAt = now();
      try {
        const res = await doFetch(url, {
          headers: { Authorization: `Bearer ${readToken}`, Accept: 'application/json' },
          // Covers connecting AND reading the body, so a stalled response cannot hang us.
          signal: AbortSignal.timeout(Math.min(ATTEMPT_TIMEOUT_MS, remaining)),
        });

        if (res.ok) {
          let body: unknown;
          try {
            body = await res.json();
          } catch (err) {
            if (isTimeout(err)) throw err;
            throw new MovieSourceError('invalid_json', res.status);
          }
          try {
            return mapTmdbPage(body);
          } catch {
            throw new MovieSourceError('bad_shape', res.status);
          }
        }

        // Free the socket; we never read or log an error body. Not awaited: nothing here may block.
        void res.body?.cancel().catch(() => {});
        if (res.status === 429) {
          hintMs = retryAfterMs(res.headers.get('retry-after'));
          lastFailure = new MovieSourceError('rate_limited', 429);
        } else if (res.status >= 500) {
          lastFailure = new MovieSourceError('upstream_error', res.status);
        } else {
          // 401 (bad token), 404, 422 ...: our request is wrong; repeating it cannot help.
          retryable = false;
          lastFailure = new MovieSourceError('rejected', res.status);
        }
      } catch (err) {
        if (err instanceof MovieSourceError) {
          // invalid_json / bad_shape: TMDB answered, but not with what we can use. Not transient.
          retryable = false;
          lastFailure = err;
        } else {
          lastFailure = new MovieSourceError(isTimeout(err) ? 'timeout' : 'network_error');
        }
      }

      logger.warn('tmdb_attempt_failed', {
        attempt,
        reason: lastFailure.reason,
        ...(lastFailure.upstreamStatus ? { upstreamStatus: lastFailure.upstreamStatus } : {}),
        durationMs: now() - attemptStartedAt,
      });

      if (!retryable || attempt === MAX_ATTEMPTS) break;

      // Exponential backoff with jitter (half fixed, half random) so retries from many requests
      // do not all land on TMDB at the same instant. A 429's Retry-After overrides it, capped.
      const exponential = BACKOFF_BASE_MS * 2 ** (attempt - 1);
      const delay =
        hintMs !== undefined ? Math.min(hintMs, RETRY_AFTER_CAP_MS) : exponential / 2 + random() * (exponential / 2);
      if (delay >= TOTAL_BUDGET_MS - (now() - startedAt)) break; // no budget left to wait AND try again
      await sleep(delay);
    }

    throw lastFailure;
  }

  return {
    nowPlaying: (page) => getPage('/movie/now_playing', { page: String(page) }),
    search: (query, page) =>
      getPage('/search/movie', { query, page: String(page), include_adult: 'false' }),
  };
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}
