import type { Redis } from 'ioredis';
import { DEFAULT_TIMING, type RoomTiming } from './config.js';

/**
 * The waiting room's state in Redis (ADR 0017). Per showing, every key shares the `{showtimeId}` hash tag and has a TTL (RULES C4):
 *
 *   wr:active:{S}  ZSET  owner -> last heard from (ms). Membership IS the pass: an admitted user who stays quiet for the
 *                        heartbeat window drops out, so a closed app frees its slot by itself. No sweeper job.
 *   wr:queue:{S}   ZSET  owner -> ticket number (from the counter in wr:meta), so the line is first in, first out.
 *   wr:seen:{S}    ZSET  waiter -> last polled (ms). A waiter silent for the patience window loses their place.
 *   wr:since:{S}   ZSET  owner -> admitted at (ms): the pass's hard lifetime.
 *   wr:meta:{S}    HASH  seq (ticket counter), lastAdmit (when the last queued user was let in).
 *
 * Every script first removes what has lapsed, then counts, in ONE atomic step, so the room is never over its cap by a race and
 * nothing needs a background worker. Admission is lazy: it runs inside join and poll, at a fixed spacing, so the room also
 * fails open without any job to fall behind. The clock is the API process's, passed in (so a test can move time).
 */

export interface RoomPolicy {
  maxActive: number;
  admitPerMinute: number;
}

export type RoomState =
  | { status: 'admitted'; passExpiresInMs: number }
  | { status: 'waiting'; ahead: number; queueLength: number; pollAfterMs: number }
  | { status: 'not_queued' }
  /** Join only: the line is at its maximum. */
  | { status: 'full' };

export interface WaitingRoomStore {
  /** Joins the line (or takes a place at the door), idempotently. `holder`: the owner still holds seats here, so they skip the line. */
  join(showtimeId: string, ownerId: string, options: { holder: boolean }): Promise<RoomState>;
  /** Heartbeats and reports where the owner stands. Never joins. */
  poll(showtimeId: string, ownerId: string): Promise<RoomState>;
  /** True if the owner holds a valid pass; renews it. */
  touch(showtimeId: string, ownerId: string): Promise<boolean>;
  /** Gives up a pass or a place in the line. Idempotent. */
  leave(showtimeId: string, ownerId: string): Promise<void>;
}

/** The back of a long line asks less often: 3 s for the first 20, then 100 ms more for each extra person, up to 15 s. */
export function pollAfterMs(ahead: number): number {
  return Math.min(15_000, 3_000 + Math.max(0, ahead - 20) * 100);
}

export function roomKeys(showtimeId: string): { active: string; queue: string; seen: string; meta: string; since: string } {
  return {
    active: `wr:active:{${showtimeId}}`,
    queue: `wr:queue:{${showtimeId}}`,
    seen: `wr:seen:{${showtimeId}}`,
    meta: `wr:meta:{${showtimeId}}`,
    since: `wr:since:{${showtimeId}}`,
  };
}

/** The shared first step of every script: drop passes that lapsed or outlived their hard limit. ARGV[1]=now ARGV[2]=window ARGV[3]=passMax. */
const PURGE_PASSES = `
for _, who in ipairs(redis.call('ZRANGEBYSCORE', A, '-inf', now - window)) do
  redis.call('ZREM', A, who)
  redis.call('ZREM', P, who)
end
for _, who in ipairs(redis.call('ZRANGEBYSCORE', P, '-inf', now - passMax)) do
  redis.call('ZREM', A, who)
  redis.call('ZREM', P, who)
end
`;

/**
 * JOIN or POLL, one atomic step. KEYS = active, queue, seen, meta, since.
 * ARGV = now, cap, window, claim, patience, passMax, interval, maxQueue, owner, mode ('join' or 'poll'), holder ('1' or '0'), ttl.
 * Returns {1, passRemainingMs} admitted, {2, ahead, queueLength} waiting, {0} not queued, {3} the line is full.
 */
const ENTER_LUA = `
local A, Q, W, M, P = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5]
local now = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local claim = tonumber(ARGV[4])
local patience = tonumber(ARGV[5])
local passMax = tonumber(ARGV[6])
local interval = tonumber(ARGV[7])
local maxQueue = tonumber(ARGV[8])
local owner = ARGV[9]
local mode = ARGV[10]
local holder = ARGV[11] == '1'
local ttl = tonumber(ARGV[12])
${PURGE_PASSES}
for _, who in ipairs(redis.call('ZRANGEBYSCORE', W, '-inf', now - patience)) do
  redis.call('ZREM', Q, who)
  redis.call('ZREM', W, who)
end

-- A user let in from the queue gets a SHORT first window (the claim window): if their app never shows up, the slot is back soon.
local function admit(who, here)
  local score = now
  if not here then score = now - window + claim end
  redis.call('ZADD', A, score, who)
  redis.call('ZADD', P, now, who)
end

if redis.call('ZSCORE', A, owner) then
  redis.call('ZADD', A, now, owner)
elseif redis.call('ZSCORE', Q, owner) then
  redis.call('ZADD', W, now, owner)
elseif mode == 'join' then
  if holder then
    admit(owner, true)
  elseif redis.call('ZCARD', Q) == 0 and redis.call('ZCARD', A) < cap then
    admit(owner, true)
  elseif redis.call('ZCARD', Q) >= maxQueue then
    return {3}
  else
    local ticket = redis.call('HINCRBY', M, 'seq', 1)
    redis.call('ZADD', Q, ticket, owner)
    redis.call('ZADD', W, now, owner)
  end
end

-- Let queued users in at a FIXED spacing, as many as are due and as many as there are free slots. After a long idle at most one is due.
local free = cap - redis.call('ZCARD', A)
local waiting = redis.call('ZCARD', Q)
if free > 0 and waiting > 0 then
  local last = tonumber(redis.call('HGET', M, 'lastAdmit') or '0')
  if last < now - interval then last = now - interval end
  local due = math.floor((now - last) / interval)
  local n = math.min(free, due, waiting)
  if n > 0 then
    for _, who in ipairs(redis.call('ZRANGE', Q, 0, n - 1)) do
      redis.call('ZREM', Q, who)
      redis.call('ZREM', W, who)
      admit(who, false)
    end
    redis.call('HSET', M, 'lastAdmit', last + n * interval)
  end
end

for i = 1, 5 do redis.call('PEXPIRE', KEYS[i], ttl) end
local score = redis.call('ZSCORE', A, owner)
if score then return {1, tonumber(score) + window - now} end
local rank = redis.call('ZRANK', Q, owner)
if rank then return {2, rank, redis.call('ZCARD', Q)} end
return {0}
`;

/** TOUCH: KEYS = active, since. ARGV = now, window, passMax, owner, ttl. Returns 1 (and renews the pass) or 0. */
const TOUCH_LUA = `
local A, P = KEYS[1], KEYS[2]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local passMax = tonumber(ARGV[3])
local owner = ARGV[4]
local ttl = tonumber(ARGV[5])
${PURGE_PASSES}
if not redis.call('ZSCORE', A, owner) then return 0 end
redis.call('ZADD', A, now, owner)
redis.call('PEXPIRE', A, ttl)
redis.call('PEXPIRE', P, ttl)
return 1
`;

/** LEAVE: KEYS = active, queue, seen, since. ARGV[1] = owner. */
const LEAVE_LUA = `
for i = 1, 4 do redis.call('ZREM', KEYS[i], ARGV[1]) end
return 1
`;

interface RoomCommands {
  matineeRoomEnter(numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
  matineeRoomTouch(numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
  matineeRoomLeave(numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface RedisWaitingRoomStoreOptions {
  policy: RoomPolicy;
  /** Milliseconds since the epoch. Injected so a test can move time. */
  clock?: () => number;
  timing?: Partial<RoomTiming>;
}

function numbers(reply: unknown): number[] {
  if (!Array.isArray(reply) || reply.some((n) => typeof n !== 'number')) throw new Error('unexpected reply from the waiting room script');
  return reply as number[];
}

/**
 * The real store, on the app's existing ioredis client. `defineCommand` sends each script by its SHA after the first call, which
 * matters: the seat-map poll runs `touch` on every request. No fail-open or fail-closed policy here: a missing connection or a Redis
 * error is thrown, and the waiting room (waitingRoom.ts) decides what that means (it lets the request through).
 */
export function createRedisWaitingRoomStore(redis: Redis, options: RedisWaitingRoomStoreOptions): WaitingRoomStore {
  redis.defineCommand('matineeRoomEnter', { lua: ENTER_LUA });
  redis.defineCommand('matineeRoomTouch', { lua: TOUCH_LUA });
  redis.defineCommand('matineeRoomLeave', { lua: LEAVE_LUA });
  const commands = redis as unknown as RoomCommands;
  const clock = options.clock ?? Date.now;
  const timing: RoomTiming = { ...DEFAULT_TIMING, ...options.timing };
  const { maxActive, admitPerMinute } = options.policy;
  const intervalMs = Math.max(1, Math.round(60_000 / admitPerMinute));
  /** Every key outlives the longest thing it can hold, and renews on use. */
  const ttlMs = timing.passMaxMs + timing.heartbeatWindowMs;
  const ready = () => {
    if (redis.status !== 'ready') throw new Error(`redis not ready (${redis.status})`);
  };

  async function enter(showtimeId: string, ownerId: string, mode: 'join' | 'poll', holder: boolean): Promise<RoomState> {
    ready();
    const k = roomKeys(showtimeId);
    const reply = numbers(
      await commands.matineeRoomEnter(
        5,
        k.active,
        k.queue,
        k.seen,
        k.meta,
        k.since,
        clock(),
        maxActive,
        timing.heartbeatWindowMs,
        timing.claimWindowMs,
        timing.waiterPatienceMs,
        timing.passMaxMs,
        intervalMs,
        timing.maxQueue,
        ownerId,
        mode,
        holder ? '1' : '0',
        ttlMs,
      ),
    );
    if (reply[0] === 1) return { status: 'admitted', passExpiresInMs: Math.max(0, reply[1] ?? 0) };
    if (reply[0] === 2) return { status: 'waiting', ahead: reply[1] ?? 0, queueLength: reply[2] ?? 0, pollAfterMs: pollAfterMs(reply[1] ?? 0) };
    if (reply[0] === 3) return { status: 'full' };
    return { status: 'not_queued' };
  }

  return {
    join: (showtimeId, ownerId, { holder }) => enter(showtimeId, ownerId, 'join', holder),
    poll: (showtimeId, ownerId) => enter(showtimeId, ownerId, 'poll', false),

    async touch(showtimeId, ownerId) {
      ready();
      const k = roomKeys(showtimeId);
      const reply = await commands.matineeRoomTouch(2, k.active, k.since, clock(), timing.heartbeatWindowMs, timing.passMaxMs, ownerId, ttlMs);
      if (typeof reply !== 'number') throw new Error('unexpected reply from the waiting room script');
      return reply === 1;
    },

    async leave(showtimeId, ownerId) {
      ready();
      const k = roomKeys(showtimeId);
      await commands.matineeRoomLeave(4, k.active, k.queue, k.seen, k.since, ownerId);
    },
  };
}
