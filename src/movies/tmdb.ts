import { z } from 'zod';
import type { Logger } from '../http/logger.js';
import {
  DETAIL_OVERVIEW_MAX_LENGTH,
  MovieSourceError,
  OVERVIEW_MAX_LENGTH,
  type Movie,
  type MovieDetail,
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

const TmdbMovieDetailSchema = TmdbMovieSchema.extend({
  backdrop_path: z.string().nullish(),
  runtime: z.number().int().nonnegative().nullish(),
  genres: z.array(z.object({ name: z.string() })).nullish(),
  vote_average: z.number().nullish(),
  vote_count: z.number().int().nonnegative().nullish(),
  tagline: z.string().nullish(),
  original_language: z.string().nullish(),
  spoken_languages: z
    .array(
      z.object({
        iso_639_1: z.string().nullish(),
        english_name: z.string().nullish(),
      }),
    )
    .nullish(),
  credits: z
    .object({
      cast: z.array(z.object({ name: z.string(), order: z.number().int().nonnegative().nullish() })).nullish(),
      crew: z.array(z.object({ name: z.string(), job: z.string().nullish() })).nullish(),
    })
    .nullish(),
  release_dates: z
    .object({
      results: z
        .array(
          z.object({
            iso_3166_1: z.string(),
            release_dates: z.array(z.object({ certification: z.string().nullish() })).nullish(),
          }),
        )
        .nullish(),
    })
    .nullish(),
});

const API_BASE = 'https://api.themoviedb.org/3';

/**
 * TMDB's image CDN: base + size + path (which starts with "/").
 * - w500 is sharp for a 2-3 column phone poster grid without the weight of "original".
 * - w780 fits a full-width detail backdrop cleanly.
 * The app is handed the finished URLs and never learns any of this.
 */
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';
const BACKDROP_IMAGE_BASE = 'https://image.tmdb.org/t/p/w780';

// ---- Mapping: TMDB -> our Movie / MovieDetail -----------------------------------------------

function toPosterUrl(posterPath: string | null | undefined): string | null {
  return posterPath ? `${IMAGE_BASE}${posterPath}` : null;
}

function toBackdropUrl(backdropPath: string | null | undefined): string | null {
  return backdropPath ? `${BACKDROP_IMAGE_BASE}${backdropPath}` : null;
}

function toYear(releaseDate: string | null | undefined): number | null {
  const match = /^(\d{4})/.exec(releaseDate ?? '');
  const year = match ? Number(match[1]) : 0;
  return year > 0 ? year : null;
}

function toReleaseDate(releaseDate: string | null | undefined): string | null {
  const trimmed = (releaseDate ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

/** Whitespace-tidy, then cut to `maxLength` on a word boundary with an ellipsis. */
function toOverview(overview: string | null | undefined, maxLength = OVERVIEW_MAX_LENGTH): string | null {
  const text = (overview ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return null;
  const chars = Array.from(text); // code points, so we never split an emoji in half
  if (chars.length <= maxLength) return text;
  const cut = chars.slice(0, maxLength - 1).join('');
  const lastSpace = cut.lastIndexOf(' ');
  const onWord = lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${onWord.trimEnd()}…`;
}

function toRuntimeMinutes(runtime: number | null | undefined): number | null {
  return runtime && runtime > 0 ? runtime : null;
}

function toGenres(genres: Array<{ name: string }> | null | undefined): string[] {
  return (genres ?? []).map((g) => g.name.trim()).filter(Boolean);
}

function toRating(voteAverage: number | null | undefined, voteCount: number | null | undefined): number | null {
  if (voteAverage == null || voteAverage <= 0 || voteCount === 0) return null;
  const rounded = Math.round(voteAverage * 10) / 10;
  return Math.min(10, Math.max(0, rounded));
}

function toTagline(tagline: string | null | undefined): string | null {
  const trimmed = (tagline ?? '').trim().replace(/\s+/g, ' ');
  return trimmed || null;
}

const MAX_CAST_NAMES = 5;

function firstCertForCountry(
  entries: Array<{ certification?: string | null | undefined }> | null | undefined,
): string | null {
  for (const entry of entries ?? []) {
    const cert = (entry.certification ?? '').trim();
    if (cert) return cert;
  }
  return null;
}

function toCertification(releaseDates: z.infer<typeof TmdbMovieDetailSchema>['release_dates']): string | null {
  const results = releaseDates?.results ?? [];
  for (const region of ['GB', 'US'] as const) {
    const match = results.find((r) => r.iso_3166_1 === region);
    const cert = firstCertForCountry(match?.release_dates);
    if (cert) return cert;
  }
  for (const country of results) {
    const cert = firstCertForCountry(country.release_dates);
    if (cert) return cert;
  }
  return null;
}

function toLanguage(
  originalLanguage: string | null | undefined,
  spokenLanguages: z.infer<typeof TmdbMovieDetailSchema>['spoken_languages'],
): string | null {
  const languages = spokenLanguages ?? [];
  if (originalLanguage) {
    const matched = languages.find((l) => l.iso_639_1 === originalLanguage && (l.english_name ?? '').trim());
    if (matched) return matched.english_name!.trim();
  }
  for (const lang of languages) {
    const name = (lang.english_name ?? '').trim();
    if (name) return name;
  }
  return null;
}

function toDirector(credits: z.infer<typeof TmdbMovieDetailSchema>['credits']): string | null {
  const directors = (credits?.crew ?? [])
    .filter((member) => member.job === 'Director')
    .map((member) => member.name.trim())
    .filter(Boolean);
  return directors.length > 0 ? directors.join(', ') : null;
}

function toCast(credits: z.infer<typeof TmdbMovieDetailSchema>['credits']): string[] {
  return [...(credits?.cast ?? [])]
    .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))
    .map((member) => member.name.trim())
    .filter(Boolean)
    .slice(0, MAX_CAST_NAMES);
}

export function mapTmdbMovie(raw: z.infer<typeof TmdbMovieSchema>): Movie {
  return {
    id: raw.id,
    title: raw.title,
    posterUrl: toPosterUrl(raw.poster_path),
    year: toYear(raw.release_date),
    overview: toOverview(raw.overview, OVERVIEW_MAX_LENGTH),
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

/** Parses a TMDB `/movie/{id}` response into our MovieDetail. Throws ZodError if the shape is not what we expect. */
export function mapTmdbMovieDetail(body: unknown): MovieDetail {
  const raw = TmdbMovieDetailSchema.parse(body);
  return {
    id: raw.id,
    title: raw.title,
    overview: toOverview(raw.overview, DETAIL_OVERVIEW_MAX_LENGTH),
    posterUrl: toPosterUrl(raw.poster_path),
    backdropUrl: toBackdropUrl(raw.backdrop_path),
    year: toYear(raw.release_date),
    releaseDate: toReleaseDate(raw.release_date),
    runtimeMinutes: toRuntimeMinutes(raw.runtime),
    genres: toGenres(raw.genres),
    rating: toRating(raw.vote_average, raw.vote_count),
    tagline: toTagline(raw.tagline),
    certification: toCertification(raw.release_dates),
    language: toLanguage(raw.original_language, raw.spoken_languages),
    director: toDirector(raw.credits),
    cast: toCast(raw.credits),
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

  /** GET `path`, parse JSON and map with `map`. Retries only transient failures. */
  async function requestTmdb<T>(
    path: string,
    params: Record<string, string>,
    map: (body: unknown) => T,
    options: { allowNotFound?: boolean } = {},
  ): Promise<T | null> {
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
            return map(body);
          } catch {
            throw new MovieSourceError('bad_shape', res.status);
          }
        }

        // Free the socket; we never read or log an error body. Not awaited: nothing here may block.
        void res.body?.cancel().catch(() => {});
        if (options.allowNotFound && res.status === 404) {
          return null;
        }
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
    nowPlaying: async (page) => (await requestTmdb('/movie/now_playing', { page: String(page) }, mapTmdbPage))!,
    search: async (query, page) =>
      (await requestTmdb('/search/movie', { query, page: String(page), include_adult: 'false' }, mapTmdbPage))!,
    detail: (id) =>
      requestTmdb(`/movie/${id}`, { append_to_response: 'credits,release_dates' }, mapTmdbMovieDetail, {
        allowNotFound: true,
      }),
  };
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}
