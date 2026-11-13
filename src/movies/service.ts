import { ApiError } from '../http/errors.js';
import type { Logger } from '../http/logger.js';
import type { MovieCache } from './cache.js';
import { MovieSourceError, type MoviesPage, type MovieSource } from './movie.js';

/**
 * CACHE POLICY (RULES D1.3 / C4). Every TTL and why:
 *
 * - now-playing, FRESH 3 hours. The list changes about once a day, so a few hours is invisible
 *   to users and still costs TMDB only a handful of calls per page per day, however many people
 *   open the app. Not longer: a new release should not take a working day to appear.
 * - search, FRESH 5 minutes. Results for a given text barely move, but the set of distinct
 *   queries is unbounded (people type anything), so a short TTL keeps memory bounded while
 *   still absorbing repeats: the same title searched by many users, or retyped on a flaky
 *   connection.
 * - STALE GRACE: Redis keeps an entry for the fresh TTL PLUS this much longer, purely so there is
 *   something to serve when TMDB is down. now-playing keeps 24 h (yesterday's list beats an error
 *   screen). Search keeps 1 h (stale search results are rarely worth the memory).
 *
 * So the Redis TTL on every key is: now-playing 27 h, search 65 min. No key ever lives forever.
 */
export const NOW_PLAYING_FRESH_TTL_SECONDS = 3 * 60 * 60;
export const NOW_PLAYING_STALE_GRACE_SECONDS = 24 * 60 * 60;
export const SEARCH_FRESH_TTL_SECONDS = 5 * 60;
export const SEARCH_STALE_GRACE_SECONDS = 60 * 60;

/** Bump when the cached value's meaning changes. (A changed Movie SHAPE is already caught: cache.ts re-validates on read.) */
const KEY_VERSION = 'v1';

/**
 * Cache keys, spelled out so they are readable in redis-cli:
 *   movies:v1:now-playing:page:2
 *   movies:v1:search:dune%20part%20two:page:1   (normalised query, URL-encoded, then page)
 * The query is URL-encoded so it can never contain ":" and run into the ":page:" part.
 */
export const nowPlayingKey = (page: number) => `movies:${KEY_VERSION}:now-playing:page:${page}`;
export const searchKey = (normalisedQuery: string, page: number) =>
  `movies:${KEY_VERSION}:search:${encodeURIComponent(normalisedQuery)}:page:${page}`;

/** Where the answer came from. Sent as `X-Cache` and logged, so "was that TMDB or Redis?" is answerable. */
export type CacheStatus = 'hit' | 'miss' | 'stale';

export interface MoviesResult {
  page: MoviesPage;
  cache: CacheStatus;
}

export interface MovieService {
  nowPlaying(page: number): Promise<MoviesResult>;
  /** `query` must already be normalised (see normaliseQuery). */
  search(query: string, page: number): Promise<MoviesResult>;
}

export function createMovieService(deps: {
  source: MovieSource;
  cache: MovieCache;
  logger: Logger;
  now?: () => number;
}): MovieService {
  const { source, cache, logger } = deps;
  const now = deps.now ?? Date.now;

  // One refresh per key at a time. When a popular entry expires, many requests arrive together;
  // they share one TMDB call instead of each making their own.
  const inFlight = new Map<string, Promise<MoviesPage>>();
  function refresh(key: string, load: () => Promise<MoviesPage>): Promise<MoviesPage> {
    const existing = inFlight.get(key);
    if (existing) return existing;
    const started = load().finally(() => inFlight.delete(key));
    inFlight.set(key, started);
    return started;
  }

  async function cacheAside(
    key: string,
    freshTtl: number,
    staleGrace: number,
    load: () => Promise<MoviesPage>,
  ): Promise<MoviesResult> {
    const entry = await cache.read(key);
    if (entry && entry.freshUntil > now()) return { page: entry.page, cache: 'hit' };

    try {
      const page = await refresh(key, load);
      // Not awaited: the user does not wait on Redis to see their movies. write() never throws.
      void cache.write(key, page, freshTtl, staleGrace);
      return { page, cache: 'miss' };
    } catch (err) {
      if (!(err instanceof MovieSourceError)) throw err; // a bug, not an outage: let it be a 500
      if (entry) {
        logger.warn('movies_served_stale', { cache: 'stale', reason: err.reason });
        return { page: entry.page, cache: 'stale' };
      }
      // Nothing cached and TMDB is down: a clean, retryable error. The reason is logged by the
      // error handler and never sent to the app.
      throw new ApiError('upstream_unavailable', { reason: `movie source: ${err.reason}` });
    }
  }

  return {
    nowPlaying: (page) =>
      cacheAside(nowPlayingKey(page), NOW_PLAYING_FRESH_TTL_SECONDS, NOW_PLAYING_STALE_GRACE_SECONDS, () =>
        source.nowPlaying(page),
      ),
    search: (query, page) =>
      cacheAside(searchKey(query, page), SEARCH_FRESH_TTL_SECONDS, SEARCH_STALE_GRACE_SECONDS, () =>
        source.search(query, page),
      ),
  };
}
