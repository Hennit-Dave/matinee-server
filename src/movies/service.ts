import { ApiError } from '../http/errors.js';
import type { Logger } from '../http/logger.js';
import type { MovieCache } from './cache.js';
import { MovieSourceError, type MovieDetail, type MoviesPage, type MovieSource } from './movie.js';

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
 * - detail, FRESH 24 hours. A film's synopsis, runtime, genres and artwork rarely change once
 *   listed, and keys are bounded to movies users actually open.
 * - STALE GRACE: Redis keeps an entry for the fresh TTL PLUS this much longer, purely so there is
 *   something to serve when TMDB is down. now-playing keeps 24 h (yesterday's list beats an error
 *   screen). Search keeps 1 h (stale search results are rarely worth the memory). Detail keeps 7 d
 *   (detail metadata stays accurate for days, so serving stale beats an error screen).
 *
 * So the Redis TTL on every key is: now-playing 27 h, search 65 min, detail 8 d. No key ever lives forever.
 */
export const NOW_PLAYING_FRESH_TTL_SECONDS = 3 * 60 * 60;
export const NOW_PLAYING_STALE_GRACE_SECONDS = 24 * 60 * 60;
export const SEARCH_FRESH_TTL_SECONDS = 5 * 60;
export const SEARCH_STALE_GRACE_SECONDS = 60 * 60;
export const DETAIL_FRESH_TTL_SECONDS = 24 * 60 * 60;
export const DETAIL_STALE_GRACE_SECONDS = 7 * 24 * 60 * 60;

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
export const detailKey = (id: number) => `movies:${KEY_VERSION}:detail:${id}`;

/** Where the answer came from. Sent as `X-Cache` and logged, so "was that TMDB or Redis?" is answerable. */
export type CacheStatus = 'hit' | 'miss' | 'stale';

export interface MoviesResult {
  page: MoviesPage;
  cache: CacheStatus;
}

export interface MovieDetailResult {
  movie: MovieDetail;
  cache: CacheStatus;
}

export interface MovieService {
  nowPlaying(page: number): Promise<MoviesResult>;
  /** `query` must already be normalised (see normaliseQuery). */
  search(query: string, page: number): Promise<MoviesResult>;
  detail(id: number): Promise<MovieDetailResult>;
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
  const inFlight = new Map<string, Promise<unknown>>();
  function refresh<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const started = load().finally(() => inFlight.delete(key));
    inFlight.set(key, started);
    return started;
  }

  async function cacheAside<T>(opts: {
    key: string;
    freshTtl: number;
    staleGrace: number;
    read: (key: string) => Promise<{ value: T; freshUntil: number } | null>;
    write: (key: string, value: T, freshTtl: number, staleGrace: number) => Promise<void>;
    load: () => Promise<T | null>;
  }): Promise<{ value: T; cache: CacheStatus }> {
    const entry = await opts.read(opts.key);
    if (entry && entry.freshUntil > now()) return { value: entry.value, cache: 'hit' };

    try {
      const loaded = await refresh(opts.key, opts.load);
      if (loaded === null) throw new ApiError('not_found');
      // Not awaited: the user does not wait on Redis to see their movies. write() never throws.
      void opts.write(opts.key, loaded, opts.freshTtl, opts.staleGrace);
      return { value: loaded, cache: 'miss' };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (!(err instanceof MovieSourceError)) throw err; // a bug, not an outage: let it be a 500
      if (entry) {
        logger.warn('movies_served_stale', { cache: 'stale', reason: err.reason });
        return { value: entry.value, cache: 'stale' };
      }
      // Nothing cached and TMDB is down: a clean, retryable error. The reason is logged by the
      // error handler and never sent to the app.
      throw new ApiError('upstream_unavailable', { reason: `movie source: ${err.reason}` });
    }
  }

  const readPage = async (key: string) => {
    const entry = await cache.read(key);
    return entry ? { value: entry.page, freshUntil: entry.freshUntil } : null;
  };
  const readDetail = async (key: string) => {
    const entry = await cache.readDetail(key);
    return entry ? { value: entry.movie, freshUntil: entry.freshUntil } : null;
  };

  return {
    nowPlaying: async (page) => {
      const res = await cacheAside({
        key: nowPlayingKey(page),
        freshTtl: NOW_PLAYING_FRESH_TTL_SECONDS,
        staleGrace: NOW_PLAYING_STALE_GRACE_SECONDS,
        read: readPage,
        write: cache.write,
        load: () => source.nowPlaying(page),
      });
      return { page: res.value, cache: res.cache };
    },
    search: async (query, page) => {
      const res = await cacheAside({
        key: searchKey(query, page),
        freshTtl: SEARCH_FRESH_TTL_SECONDS,
        staleGrace: SEARCH_STALE_GRACE_SECONDS,
        read: readPage,
        write: cache.write,
        load: () => source.search(query, page),
      });
      return { page: res.value, cache: res.cache };
    },
    detail: async (id) => {
      const res = await cacheAside({
        key: detailKey(id),
        freshTtl: DETAIL_FRESH_TTL_SECONDS,
        staleGrace: DETAIL_STALE_GRACE_SECONDS,
        read: readDetail,
        write: cache.writeDetail,
        load: () => source.detail(id),
      });
      return { movie: res.value, cache: res.cache };
    },
  };
}
