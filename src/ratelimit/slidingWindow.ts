import type { Redis } from 'ioredis';

/**
 * A sliding-window rate limit in Redis (ADR 0016), the "weighted counter" form.
 *
 * One counter per (policy, scope, id, window), where window = floor(now / windowMs). To judge a request
 * the limiter blends the window we are in with the one before it:
 *
 *     weight   = (windowMs - elapsedInThisWindow) / windowMs     how much of the previous window still counts
 *     estimate = previous * weight + current
 *     allow when estimate + 1 <= max                              (the +1 is this request)
 *
 * THIS IS AN APPROXIMATION. It assumes the previous window's requests were spread evenly across it. What it
 * buys, compared with a plain fixed window, is the natural exploit: `max` requests at the end of one window and
 * `max` more just after the boundary is twice the limit in a moment, and the blend refuses it. What it does
 * NOT buy is an exact limit over every span of one window. The worst case is 2x `max` inside a span just under
 * one window, for a caller who times one burst at the very end of a window and another at the very end of the
 * next (a fixed window has that hole too). For ordinary traffic the estimate is close. That is acceptable for
 * ABUSE limits with the headroom these have (policies.ts); it would not be for a billing quota. The exact
 * alternative, a log of timestamps per counter, costs a sorted set per caller. Both facts are pinned by tests
 * in slidingWindow.integration.test.ts, and the reasoning is in ADR 0016.
 *
 * KEY SHAPE:   rl:<policy>:u:<clientId>:<window>     rl:<policy>:ip:<address>:<window>
 * Every key is written with a TTL of two windows, so it outlives its own window by exactly as long as it is
 * needed as "the previous window", and then disappears (RULES C4: a TTL on everything).
 *
 * ONE ATOMIC SCRIPT PER REQUEST CHECK, covering every scope of the request (user and address). Redis runs a
 * script start to finish with nothing interleaved, so there is no read-then-write race, and the scopes are
 * decided together: a request refused by either is written to neither. Rejected traffic costs nothing and
 * cannot extend its own lock-out. (Redis here is one node, ADR 0008. If it were ever clustered the keys of one
 * check would need a shared hash tag.)
 *
 * The clock is the API process's, passed in, not Redis `TIME`. That keeps the window arithmetic in one place
 * a test can move without sleeping. With several API instances their clocks differ by milliseconds, which only
 * shifts a window edge by that much.
 */
export type ScopeKind = 'user' | 'ip';

export interface ScopeCheck {
  kind: ScopeKind;
  /** The client id (a UUID) or the normalised address. Becomes part of the key. */
  id: string;
  max: number;
}

export type CheckResult = { allowed: true } | { allowed: false; retryAfterMs: number; deniedScopes: ScopeKind[] };

export interface RateLimitStore {
  /** Judges one request against every scope, and counts it only if all of them allow it. */
  check(policy: string, windowMs: number, scopes: readonly ScopeCheck[], nowMs: number): Promise<CheckResult>;
}

/**
 * KEYS: per scope i (1-based): KEYS[2i-1] = this window's counter, KEYS[2i] = the previous window's.
 * ARGV: [1] now in ms, [2] window in ms, [2+i] the max for scope i.
 * Returns {1} when allowed (every scope counted), or {0, retryAfterMs, deniedScope1, deniedScope2, ...} with
 * 1-based positions, and nothing written.
 *
 * Retry-After: the earliest moment a retry could pass if nothing else were admitted meanwhile.
 *   - this window is not full by itself (cur < max): the previous window is what blocks us, and it fades
 *     linearly, so we wait until prev * weight has dropped to max - 1 - cur.
 *   - this window is full (cur >= max): nothing helps until it becomes "the previous window", so wait for the
 *     boundary and then for the blend to fade from cur down to max - 1.
 * EPS keeps a request that lands exactly on the computed instant from being refused by float rounding.
 */
export const SLIDING_WINDOW_LUA = `
local EPS = 1e-9
local now = tonumber(ARGV[1])
local win = tonumber(ARGV[2])
local elapsed = now % win
local remaining = win - elapsed
local weight = remaining / win
local n = #KEYS / 2
local retry = 0
local denied = {}
for i = 1, n do
  local max = tonumber(ARGV[2 + i])
  local cur = tonumber(redis.call('GET', KEYS[2 * i - 1]) or '0')
  local prev = tonumber(redis.call('GET', KEYS[2 * i]) or '0')
  local est = prev * weight + cur
  if est + 1 > max + EPS then
    local wait
    if cur >= max then
      wait = remaining + win * (1 - (max - 1) / cur)
    else
      wait = win * (est - (max - 1)) / prev
      if wait > remaining then wait = remaining end
    end
    if wait > retry then retry = wait end
    denied[#denied + 1] = i
  end
end
if #denied > 0 then
  local reply = {0, math.max(1, math.ceil(retry - 1e-6))}
  for _, i in ipairs(denied) do reply[#reply + 1] = i end
  return reply
end
for i = 1, n do
  redis.call('INCR', KEYS[2 * i - 1])
  redis.call('PEXPIRE', KEYS[2 * i - 1], 2 * win)
end
return {1}
`;

interface RateLimitCommands {
  /** `numberOfKeys` first because the script is defined without a fixed key count (it has one pair per scope). */
  matineeSlidingWindow(numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export function slidingWindowKey(policy: string, scope: ScopeCheck, windowIndex: number): string {
  return `rl:${policy}:${scope.kind === 'user' ? 'u' : 'ip'}:${scope.id}:${windowIndex}`;
}

/**
 * The real store, on the app's existing ioredis client. `defineCommand` sends the script by its SHA after the
 * first call, which matters here: this runs on every guarded request. It does NOT apply any fail-open or
 * fail-closed policy: a missing connection or a Redis error is thrown, and the limiter decides what that means
 * (it lets the request through, see limiter.ts).
 */
export function createRedisRateLimitStore(redis: Redis): RateLimitStore {
  redis.defineCommand('matineeSlidingWindow', { lua: SLIDING_WINDOW_LUA });
  const commands = redis as unknown as RateLimitCommands;

  return {
    async check(policy, windowMs, scopes, nowMs) {
      if (redis.status !== 'ready') throw new Error(`redis not ready (${redis.status})`);
      const windowIndex = Math.floor(nowMs / windowMs);
      const keys = scopes.flatMap((scope) => [
        slidingWindowKey(policy, scope, windowIndex),
        slidingWindowKey(policy, scope, windowIndex - 1),
      ]);
      const reply = await commands.matineeSlidingWindow(
        keys.length,
        ...keys,
        String(nowMs),
        String(windowMs),
        ...scopes.map((scope) => String(scope.max)),
      );
      if (!Array.isArray(reply) || reply.some((n) => typeof n !== 'number')) {
        throw new Error('unexpected reply from the rate limit script');
      }
      const numbers = reply as number[];
      if (numbers[0] === 1) return { allowed: true };
      return {
        allowed: false,
        retryAfterMs: numbers[1] ?? 1_000,
        deniedScopes: numbers.slice(2).map((position) => scopes[position - 1]!.kind),
      };
    },
  };
}
