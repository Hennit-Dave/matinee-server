import type { Redis } from 'ioredis';
import { DEFAULT_HOLD_CAPS } from './holdCaps.js';
import { HOLD_OP_TIMEOUT_MS, HoldsUnavailableError, failClosed } from './redisGuard.js';

export { HoldsUnavailableError };

/**
 * Seat holds in Redis (ADR 0015). A hold is one key per (showtime, seat) whose value is the OWNER's id:
 *
 *     hold:{<showtimeId>}:<seatId>  ->  <ownerId>      (expires after SEAT_HOLD_TTL_MS)
 *
 * Two small SET indexes list which seats an owner, and an address, took, so the hold caps (ADR 0018) can count them:
 *
 *     hold-owner:{<showtimeId>}:<ownerId>   ->  { seatId, ... }
 *     hold-addr:{<showtimeId>}:<address>    ->  { "<ownerId>:<seatId>", ... }
 *
 * An index is only a list of CANDIDATES. A member counts only while its hold key still exists and belongs to the member's
 * owner, so a hold that expired, was released or was taken by someone else is pruned at the next count and never counted.
 * The hold key stays the single source of truth; nothing about the caps needs a timer or a cleanup job.
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

/** The candidates list for one owner's holds on one showing (ADR 0018). */
export function holdOwnerIndexKey(showtimeId: string, ownerId: string): string {
  return `hold-owner:{${showtimeId}}:${ownerId}`;
}

/** The candidates list for one address's holds on one showing (ADR 0018). `address` is the limiter's key: an IPv4 address or an IPv6 /64. */
export function holdAddressIndexKey(showtimeId: string, address: string): string {
  return `hold-addr:{${showtimeId}}:${address}`;
}

/** Which cap a refused hold hit, how high it is, and how many seats the owner (or address) already holds. */
export interface HoldLimitReached {
  scope: 'owner' | 'address';
  limit: number;
  held: number;
}

export type AcquireResult =
  | { ok: true; /** Time left on the soonest-expiring seat of the request. */ expiresInMs: number }
  | { ok: false; takenSeatIds: string[] }
  | { ok: false; limitReached: HoldLimitReached };

/** What the store needs to know about the caller besides who they are. */
export interface AcquireContext {
  /** The caller's address key (see `resolveClientAddress`). Left out when it could not be resolved: the address cap is then skipped. */
  address?: string;
}

export interface HoldStore {
  /**
   * All or nothing. Every seat is held for `ownerId`, or none is and the seats someone else holds come back
   * in `takenSeatIds`. Asking for a seat you already hold counts as success and does NOT restart its timer,
   * so a retry is safe and the countdown stays honest.
   *
   * Also refused, as `limitReached`, when it would take the owner (or the address) past the hold cap for this showing
   * (ADR 0018). The caps are judged first and inside the same atomic step, so a refused request holds nothing.
   */
  acquire(showtimeId: string, ownerId: string, seatIds: readonly string[], context?: AcquireContext): Promise<AcquireResult>;
  /** Compare-and-delete: frees only the seats `ownerId` holds, and returns which ones it freed. */
  release(showtimeId: string, ownerId: string, seatIds: readonly string[]): Promise<string[]>;
  /** The subset of `seatIds` that `ownerId` currently holds. */
  heldBy(showtimeId: string, ownerId: string, seatIds: readonly string[]): Promise<string[]>;
  /** The subset of `seatIds` that anyone currently holds (the seat map). */
  heldAmong(showtimeId: string, seatIds: readonly string[]): Promise<Set<string>>;
  /** How many seats of this showing `ownerId` holds right now: the waiting room lets a holder back in ahead of the line (ADR 0017). */
  heldCount(showtimeId: string, ownerId: string): Promise<number>;
}

/**
 * ACQUIRE, one atomic step for the whole request. Redis runs a script start to finish without another client
 * interleaving, so no one ever sees half a set held, and there is no separate "undo" round trip that could
 * itself fail. Per seat it is `SET key owner NX PX ttl` (RULES D5.1); if any seat is taken, the keys THIS
 * script just set are removed again before it returns. (That plain DEL is safe: those keys were created inside
 * this same atomic script, so nobody else can own them. Releasing a hold later is compare-and-delete.)
 *
 * THE HOLD CAPS (ADR 0018) are judged first, in the same step. An index member counts only while its hold key still exists and
 * is owned by the member's owner (a lapsed, released or re-taken hold is pruned, never counted), so a hold that expires frees
 * its slot by itself. Seats the owner ALREADY holds are not "new", so asking again is free. A refused request writes nothing.
 * (The scripted GETs below name keys that are not in KEYS: they all share the `{showtimeId}` hash tag, so they are in one cluster
 * slot, and ADR 0008 runs one node. If Redis is ever clustered, those index members must be passed in KEYS: ADR 0018.)
 *
 * KEYS = one hold key per seat, then the owner index, then (only when there is an address and a cap for it) the address index.
 * ARGV = owner id, ttl ms, number of seats, owner cap (0 = off), address cap (0 = off), the hold key prefix `hold:{showtime}:`.
 * Returns `{1, minRemainingMs}` on success, `{0, i1, i2, ...}` with the 1-based positions that were taken, or
 * `{3, scope, limit, held}` when a cap refused (scope 1 = owner, 2 = address).
 */
const ACQUIRE_LUA = `
local owner = ARGV[1]
local ttl = tonumber(ARGV[2])
local nSeats = tonumber(ARGV[3])
local ownerCap = tonumber(ARGV[4])
local addrCap = tonumber(ARGV[5])
local prefix = ARGV[6]
local ownerIdx = KEYS[nSeats + 1]
local addrIdx = KEYS[nSeats + 2]

local liveOwn = {}
local ownCount = 0
for _, seat in ipairs(redis.call('SMEMBERS', ownerIdx)) do
  if redis.call('GET', prefix .. seat) == owner then
    liveOwn[seat] = true
    ownCount = ownCount + 1
  else
    redis.call('SREM', ownerIdx, seat)
  end
end
local fresh = 0
for i = 1, nSeats do
  if not liveOwn[string.sub(KEYS[i], #prefix + 1)] then fresh = fresh + 1 end
end
if ownerCap > 0 and ownCount + fresh > ownerCap then
  return {3, 1, ownerCap, ownCount}
end
if addrIdx and addrCap > 0 then
  local addrCount = 0
  for _, member in ipairs(redis.call('SMEMBERS', addrIdx)) do
    local sep = string.find(member, ':', 1, true)
    if sep and redis.call('GET', prefix .. string.sub(member, sep + 1)) == string.sub(member, 1, sep - 1) then
      addrCount = addrCount + 1
    else
      redis.call('SREM', addrIdx, member)
    end
  end
  if addrCount + fresh > addrCap then
    return {3, 2, addrCap, addrCount}
  end
end

local created = {}
local failed = {}
local soonest = ttl
for i = 1, nSeats do
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
for i = 1, nSeats do
  local seat = string.sub(KEYS[i], #prefix + 1)
  redis.call('SADD', ownerIdx, seat)
  if addrIdx then redis.call('SADD', addrIdx, owner .. ':' .. seat) end
end
redis.call('PEXPIRE', ownerIdx, ttl)
if addrIdx then redis.call('PEXPIRE', addrIdx, ttl) end
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
  /** Live held seats allowed per owner and per address, per showing; 0 turns one off. Defaults to the production caps (holdCaps.ts). */
  caps?: { perOwner?: number; perAddress?: number };
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
  const ownerCap = options.caps?.perOwner ?? DEFAULT_HOLD_CAPS.perOwner;
  const addressCap = options.caps?.perAddress ?? DEFAULT_HOLD_CAPS.perAddress;
  const run = <T>(op: () => Promise<T>) => failClosed(redis, timeoutMs, op);
  const keysFor = (showtimeId: string, seatIds: readonly string[]) => seatIds.map((id) => holdKey(showtimeId, id));

  return {
    async acquire(showtimeId, ownerId, seatIds, context = {}) {
      const keys = keysFor(showtimeId, seatIds);
      const useAddress = addressCap > 0 && context.address !== undefined;
      const indexKeys = [holdOwnerIndexKey(showtimeId, ownerId), ...(useAddress ? [holdAddressIndexKey(showtimeId, context.address!)] : [])];
      const allKeys = [...keys, ...indexKeys];
      const reply = asNumbers(
        await run(() =>
          redis.eval(
            ACQUIRE_LUA,
            allKeys.length,
            ...allKeys,
            ownerId,
            String(ttlMs),
            String(keys.length),
            String(ownerCap),
            String(useAddress ? addressCap : 0),
            holdKey(showtimeId, ''),
          ),
        ),
      );
      if (reply[0] === 1) return { ok: true, expiresInMs: reply[1] ?? ttlMs };
      if (reply[0] === 3) {
        return { ok: false, limitReached: { scope: reply[1] === 1 ? 'owner' : 'address', limit: reply[2] ?? 0, held: reply[3] ?? 0 } };
      }
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

    async heldCount(showtimeId, ownerId) {
      // The owner index lists candidates; only seats whose hold key is still this owner's count (ADR 0018).
      const seatIds = await run(() => redis.smembers(holdOwnerIndexKey(showtimeId, ownerId)));
      if (seatIds.length === 0) return 0;
      const values = await run(() => redis.mget(...keysFor(showtimeId, seatIds)));
      return values.filter((value) => value === ownerId).length;
    },

    async heldAmong(showtimeId, seatIds) {
      if (seatIds.length === 0) return new Set();
      const values = await run(() => redis.mget(...keysFor(showtimeId, seatIds)));
      return new Set(seatIds.filter((_, i) => values[i] !== null && values[i] !== undefined));
    },
  };
}
