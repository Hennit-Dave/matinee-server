import type { Redis } from 'ioredis';
import { HOLD_OP_TIMEOUT_MS, HoldsUnavailableError, failClosed } from './redisGuard.js';

export { HoldsUnavailableError };

/**
 * Seat holds in Redis (ADR 0015). A hold is one key per (showtime, seat) whose value is the OWNER's id:
 *
 *     hold:{<showtimeId>}:<seatId>  ->  <ownerId>      (expires after SEAT_HOLD_TTL_MS)
 *
 * Redis is the fast path: it decides who may TRY to book a seat. The unique key on `bookings` is the final
 * guard that decides who owns it, and it still holds when Redis is empty, wrong or down.
 *
 * The `{<showtimeId>}` braces are a hash tag: they keep every hold of one showtime in one cluster slot, which
 * multi-key Lua needs if Redis is ever clustered (SHARDING.md).
 *
 * Every key has a TTL (RULES C4) and none of this is ever cached: this module is the source of truth for
 * "held", and the seat map reads it fresh on every request.
 */

/** The hold window: 10 minutes (AGENTS.md section 7, RULES D5.1). The app's countdown starts at ~9:58. */
export const SEAT_HOLD_TTL_MS = 10 * 60 * 1000;

export function holdKey(showtimeId: string, seatId: string): string {
  return `hold:{${showtimeId}}:${seatId}`;
}

export type AcquireResult =
  | { ok: true; /** Time left on the soonest-expiring seat of the request. */ expiresInMs: number }
  | { ok: false; takenSeatIds: string[] };

export interface HoldStore {
  /**
   * All or nothing. Every seat is held for `ownerId`, or none is and the seats someone else holds come back
   * in `takenSeatIds`. Asking for a seat you already hold counts as success and does NOT restart its timer,
   * so a retry is safe and the countdown stays honest.
   */
  acquire(showtimeId: string, ownerId: string, seatIds: readonly string[]): Promise<AcquireResult>;
  /** Compare-and-delete: frees only the seats `ownerId` holds, and returns which ones it freed. */
  release(showtimeId: string, ownerId: string, seatIds: readonly string[]): Promise<string[]>;
  /** The subset of `seatIds` that `ownerId` currently holds. */
  heldBy(showtimeId: string, ownerId: string, seatIds: readonly string[]): Promise<string[]>;
  /** The subset of `seatIds` that anyone currently holds (the seat map). */
  heldAmong(showtimeId: string, seatIds: readonly string[]): Promise<Set<string>>;
}

/**
 * ACQUIRE, one atomic step for the whole request. Redis runs a script start to finish without another client
 * interleaving, so no one ever sees half a set held, and there is no separate "undo" round trip that could
 * itself fail. Per seat it is `SET key owner NX PX ttl` (RULES D5.1); if any seat is taken, the keys THIS
 * script just set are removed again before it returns. (That plain DEL is safe: those keys were created inside
 * this same atomic script, so nobody else can own them. Releasing a hold later is compare-and-delete.)
 *
 * KEYS = one hold key per seat; ARGV = owner id, ttl in ms.
 * Returns `{1, minRemainingMs}` on success, or `{0, i1, i2, ...}` with the 1-based positions that failed.
 */
const ACQUIRE_LUA = `
local owner = ARGV[1]
local ttl = tonumber(ARGV[2])
local created = {}
local failed = {}
local soonest = ttl
for i = 1, #KEYS do
  local key = KEYS[i]
  if redis.call('SET', key, owner, 'NX', 'PX', ttl) then
    created[#created + 1] = key
  elseif redis.call('GET', key) == owner then
    local remaining = redis.call('PTTL', key)
    if remaining < 0 then
      redis.call('PEXPIRE', key, ttl)
      remaining = ttl
    end
    if remaining < soonest then soonest = remaining end
  else
    failed[#failed + 1] = i
  end
end
if #failed > 0 then
  for _, key in ipairs(created) do redis.call('DEL', key) end
  return {0, unpack(failed)}
end
return {1, soonest}
`;

/**
 * RELEASE: compare, then delete (RULES D5.8). Never a plain DEL: by the time this runs the hold may have
 * expired and been taken by someone else, and deleting that would free another user's seat.
 * KEYS = hold keys; ARGV[1] = owner id. Returns the 1-based positions that were released.
 */
const RELEASE_LUA = `
local released = {}
for i = 1, #KEYS do
  if redis.call('GET', KEYS[i]) == ARGV[1] then
    redis.call('DEL', KEYS[i])
    released[#released + 1] = i
  end
end
return released
`;

export interface RedisHoldStoreOptions {
  ttlMs?: number;
  opTimeoutMs?: number;
}

function asNumbers(reply: unknown): number[] {
  if (!Array.isArray(reply) || reply.some((n) => typeof n !== 'number')) {
    throw new HoldsUnavailableError('unexpected reply from the hold script');
  }
  return reply as number[];
}

/**
 * The real store, on the app's existing ioredis client. Every call goes through `failClosed`: a missing
 * connection, a Redis error or a missed deadline becomes `HoldsUnavailableError`, never a silent success.
 *
 * Scripts are idempotent for the same owner, which is what makes a retry safe after a timeout. (A command
 * sent just before a connection dropped can still run afterwards, leaving a "ghost" hold that lives at most
 * one TTL; the same owner asking again simply succeeds. ADR 0015.)
 */
export function createRedisHoldStore(redis: Redis, options: RedisHoldStoreOptions = {}): HoldStore {
  const ttlMs = options.ttlMs ?? SEAT_HOLD_TTL_MS;
  const timeoutMs = options.opTimeoutMs ?? HOLD_OP_TIMEOUT_MS;
  const run = <T>(op: () => Promise<T>) => failClosed(redis, timeoutMs, op);
  const keysFor = (showtimeId: string, seatIds: readonly string[]) => seatIds.map((id) => holdKey(showtimeId, id));

  return {
    async acquire(showtimeId, ownerId, seatIds) {
      const keys = keysFor(showtimeId, seatIds);
      const reply = asNumbers(await run(() => redis.eval(ACQUIRE_LUA, keys.length, ...keys, ownerId, String(ttlMs))));
      if (reply[0] === 1) return { ok: true, expiresInMs: reply[1] ?? ttlMs };
      return { ok: false, takenSeatIds: reply.slice(1).map((position) => seatIds[position - 1]!) };
    },

    async release(showtimeId, ownerId, seatIds) {
      if (seatIds.length === 0) return [];
      const keys = keysFor(showtimeId, seatIds);
      const reply = asNumbers(await run(() => redis.eval(RELEASE_LUA, keys.length, ...keys, ownerId)));
      return reply.map((position) => seatIds[position - 1]!);
    },

    async heldBy(showtimeId, ownerId, seatIds) {
      if (seatIds.length === 0) return [];
      const values = await run(() => redis.mget(...keysFor(showtimeId, seatIds)));
      return seatIds.filter((_, i) => values[i] === ownerId);
    },

    async heldAmong(showtimeId, seatIds) {
      if (seatIds.length === 0) return new Set();
      const values = await run(() => redis.mget(...keysFor(showtimeId, seatIds)));
      return new Set(seatIds.filter((_, i) => values[i] !== null && values[i] !== undefined));
    },
  };
}
