import type { Redis } from 'ioredis';

/**
 * Seat holds FAIL CLOSED (AGENTS.md section 7, RULES D5.9). The movie cache (`movies/cache.ts`) treats an
 * unreachable Redis as a cache miss and carries on, which is right for movie data. For seats it would be
 * wrong: without Redis nobody can know who is holding what, so we refuse to take or confirm holds instead
 * of guessing. Postgres' unique key means even a wrong guess could not double-book, but refusing is the
 * honest answer and keeps the system's behaviour simple to explain.
 */
export class HoldsUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'HoldsUnavailableError';
  }
}

/** Longest we wait for one Redis call before giving up. CHOSEN, NOT MEASURED: the load test (5e) measures it. */
export const HOLD_OP_TIMEOUT_MS = 1_000;

/**
 * Runs one Redis operation under the fail-closed rules: not connected means refuse at once (same check
 * as the movie cache, opposite policy), no answer within the deadline means refuse, and any Redis error
 * means refuse. Every refusal is a `HoldsUnavailableError`, so callers handle exactly one thing.
 */
export async function failClosed<T>(redis: Pick<Redis, 'status'>, timeoutMs: number, op: () => Promise<T>): Promise<T> {
  if (redis.status !== 'ready') throw new HoldsUnavailableError(`redis not ready (${redis.status})`);

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HoldsUnavailableError(`redis did not answer within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([op(), deadline]);
  } catch (err) {
    throw err instanceof HoldsUnavailableError ? err : new HoldsUnavailableError(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}
