/**
 * THE WINDOW SLIDES (slice 5c evidence). One caller, a limit of 10 per 60 s window, the same traffic sent to the
 * real sliding-window script (a throwaway local Redis, a clock that is moved by hand) and to a plain fixed-window
 * counter for comparison:
 *
 *   source <env with TEST_REDIS_URL on loopback> && npx tsx docs/evidence/traffic-5c/window-slide.ts
 *
 * Ten requests land at the very end of a window (t = 59.0 s). Then one request every half second, across the
 * boundary at t = 60 s. A fixed window forgets everything at the boundary and lets ten more in immediately.
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '../../../src/http/logger.js';
import { createRedisClient } from '../../../src/jobs/connection.js';
import { assertLoopbackRedis, TEST_REDIS_URL } from '../../../src/bookings/testkit.js';
import { createRedisRateLimitStore } from '../../../src/ratelimit/slidingWindow.js';

if (!TEST_REDIS_URL) throw new Error('TEST_REDIS_URL is not set');
assertLoopbackRedis(TEST_REDIS_URL);
const redis = createRedisClient(createLogger(() => {}), TEST_REDIS_URL);
await redis.connect();

const WIN = 60_000;
const MAX = 10;
const T0 = 1_000 * WIN; // a window boundary
const policy = `slide${randomUUID().slice(0, 6)}`;
const store = createRedisRateLimitStore(redis);
const user = randomUUID();

const fixed = new Map<number, number>();
const fixedAllows = (at: number) => {
  const window = Math.floor(at / WIN);
  const used = fixed.get(window) ?? 0;
  if (used >= MAX) return false;
  fixed.set(window, used + 1);
  return true;
};

type Row = { t: number; sliding: string; fixed: string };
const rows: Row[] = [];
const admitted = { sliding: [] as number[], fixed: [] as number[] };

async function attempt(t: number) {
  const at = T0 + Math.round(t * 1000);
  const result = await store.check(policy, WIN, [{ kind: 'user', id: user, max: MAX }], at);
  const fixedOk = fixedAllows(at);
  if (result.allowed) admitted.sliding.push(t);
  if (fixedOk) admitted.fixed.push(t);
  return {
    t,
    sliding: result.allowed ? 'admitted' : `429  Retry-After: ${Math.ceil(result.retryAfterMs / 1000)}`,
    fixed: fixedOk ? 'admitted' : '429',
  };
}

for (let i = 0; i < 10; i += 1) await attempt(59.0);
process.stdout.write('limit 10 per 60 s window, one caller. Ten requests at t = 59.0 s (the end of a window) were admitted by both.\n\n');
process.stdout.write('  t (s)   sliding window (the limiter)   fixed window (for comparison)\n');
for (let t = 60.0; t <= 72.0; t += 0.5) rows.push(await attempt(t));
for (const row of rows) {
  const marker = row.t === 60 ? '   <- the boundary' : '';
  process.stdout.write(`  ${row.t.toFixed(1).padStart(5)}   ${row.sliding.padEnd(30)} ${row.fixed}${marker}\n`);
}

const inSpan = (times: number[], from: number, to: number) => times.filter((t) => t >= from && t <= to).length;
process.stdout.write('\nadmitted between t = 59.0 s and t = 65.0 s (a 6 second span):\n');
process.stdout.write(`  sliding window: ${10 + inSpan(admitted.sliding.filter((t) => t >= 60), 60, 65)}\n`);
process.stdout.write(`  fixed window:   ${10 + inSpan(admitted.fixed.filter((t) => t >= 60), 60, 65)}   (twice the limit)\n`);

const keys = await redis.keys(`rl:${policy}:*`);
if (keys.length > 0) await redis.del(...keys);
redis.disconnect();
