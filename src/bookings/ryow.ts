import type { Redis } from 'ioredis';
import { HOLD_OP_TIMEOUT_MS, failClosed } from './redisGuard.js';

/**
 * Read-your-own-writes (RULES C2). Seat reads normally come from the Postgres read replica, which can lag
 * the primary by a moment. For a short window after a user BOOKS, that user's reads go to the primary
 * instead, so they see their own booking at once instead of a map that has not heard of it yet.
 *
 * "This user wrote recently" is a Redis key with a TTL, not a variable in the API process: with two API
 * instances a booking handled by one would otherwise be invisible to the other.
 *
 * In production the window should be sized from measured replica lag; 5 s is the course's rule and a
 * comfortable multiple of Neon's typical lag, not a measurement (ADR 0015).
 */
export const RYOW_WINDOW_MS = 5_000;

export function ryowKey(ownerId: string): string {
  return `ryow:${ownerId}`;
}

export interface RyowStore {
  /** Marks `ownerId` as having just written. */
  mark(ownerId: string): Promise<void>;
  /** True while `ownerId` is inside the window. */
  isActive(ownerId: string): Promise<boolean>;
}

export function createRedisRyowStore(redis: Redis, options: { windowMs?: number; opTimeoutMs?: number } = {}): RyowStore {
  const windowMs = options.windowMs ?? RYOW_WINDOW_MS;
  const timeoutMs = options.opTimeoutMs ?? HOLD_OP_TIMEOUT_MS;
  return {
    async mark(ownerId) {
      await failClosed(redis, timeoutMs, () => redis.set(ryowKey(ownerId), '1', 'PX', windowMs));
    },
    async isActive(ownerId) {
      return (await failClosed(redis, timeoutMs, () => redis.exists(ryowKey(ownerId)))) === 1;
    },
  };
}
