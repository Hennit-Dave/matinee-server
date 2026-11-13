import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { Logger } from '../http/logger.js';
import { MoviesPageSchema, type MoviesPage } from './movie.js';

/**
 * Cache-aside storage for movie pages. It stores OUR mapped MoviesPage, never TMDB's raw
 * response, so the cache holds nothing that depends on TMDB's shape.
 *
 * Each entry carries its own `freshUntil`; the Redis key itself lives for the fresh TTL PLUS a
 * "stale grace" window. Past `freshUntil` the entry is stale: the service refreshes it from TMDB,
 * but if TMDB is down it can still serve it. Past the grace window Redis drops it. So EVERY key
 * has a TTL (RULES C4), and a stale copy exists exactly when serving one is worth it.
 *
 * Movie data is safe to cache and safe to fail open on: an unreachable Redis just means a miss
 * (we go to TMDB). That is the opposite of seat holds, which fail closed (AGENTS.md section 7).
 * Never put seat availability, payment state or webhook records through this module.
 */

/** The two Redis operations we need. Narrow on purpose: easy to fake in tests. */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/** Longest we wait on Redis before treating the cache as unavailable for this request. */
export const CACHE_OP_TIMEOUT_MS = 500;

export function createRedisStore(redis: Pick<Redis, 'get' | 'set' | 'status'>): CacheStore {
  // If the connection is not up, fail at once rather than queueing behind a reconnect.
  const ready = () => {
    if (redis.status !== 'ready') throw new Error(`redis not ready (${redis.status})`);
  };
  return {
    async get(key) {
      ready();
      return redis.get(key);
    },
    async set(key, value, ttlSeconds) {
      ready();
      await redis.set(key, value, 'EX', ttlSeconds);
    },
  };
}

const EntrySchema = z.strictObject({ freshUntil: z.number(), page: MoviesPageSchema });

export interface CacheEntry {
  page: MoviesPage;
  /** Epoch ms. Before this the entry is fresh; after it, stale (usable only as a fallback). */
  freshUntil: number;
}

export interface MovieCache {
  /** The entry, or null on a miss, a corrupt/old-shape entry, or an unreachable Redis. Never throws. */
  read(key: string): Promise<CacheEntry | null>;
  /** Best effort. Never throws. */
  write(key: string, page: MoviesPage, freshTtlSeconds: number, staleGraceSeconds: number): Promise<void>;
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`cache timed out after ${CACHE_OP_TIMEOUT_MS}ms`)), CACHE_OP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export function createMovieCache(deps: { store: CacheStore; logger: Logger; now?: () => number }): MovieCache {
  const { store, logger } = deps;
  const now = deps.now ?? Date.now;

  return {
    async read(key) {
      let raw: string | null;
      try {
        raw = await withTimeout(store.get(key));
      } catch (err) {
        logger.warn('movies_cache_read_failed', { reason: err instanceof Error ? err.message : String(err) });
        return null;
      }
      if (raw === null) return null;

      // Validate against the CURRENT contract: an entry written by an older version of the shape
      // is a miss and gets rewritten, so a contract change never serves stale-shaped data.
      try {
        return EntrySchema.parse(JSON.parse(raw));
      } catch {
        logger.warn('movies_cache_entry_invalid', { reason: 'unreadable or old-shape entry, treated as a miss' });
        return null;
      }
    },

    async write(key, page, freshTtlSeconds, staleGraceSeconds) {
      const entry: CacheEntry = { page, freshUntil: now() + freshTtlSeconds * 1000 };
      try {
        await withTimeout(store.set(key, JSON.stringify(entry), freshTtlSeconds + staleGraceSeconds));
      } catch (err) {
        logger.warn('movies_cache_write_failed', { reason: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}
