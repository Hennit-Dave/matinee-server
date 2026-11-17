import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { assertLoopbackRedis, skip, TEST_REDIS_URL } from '../bookings/testkit.js';
import { createLogger } from '../http/logger.js';
import { createRedisClient } from '../jobs/connection.js';
import { createRedisRateLimitStore, slidingWindowKey, type CheckResult, type RateLimitStore, type ScopeCheck } from './slidingWindow.js';

/**
 * The sliding-window Lua against a REAL Redis (loopback only, same guard as the hold tests), with the clock passed
 * in so a window can slide without anyone sleeping. This is where the arithmetic is proven; the middleware tests
 * around it use a fake store. Every test uses its own policy name, so nothing here touches another test's keys.
 */

const WIN = 60_000;
/** The start of window 1000: every "time" below is an offset from a window boundary. */
const T0 = 1_000 * WIN;

async function connect(): Promise<Redis> {
  if (!TEST_REDIS_URL) throw new Error('test env is not set');
  assertLoopbackRedis(TEST_REDIS_URL);
  const redis = createRedisClient(createLogger(() => {}), TEST_REDIS_URL);
  await redis.connect();
  return redis;
}

interface Rig {
  redis: Redis;
  store: RateLimitStore;
  policy: string;
  /** Extra connections, to make a race real (one connection would queue everything in order). */
  stores: RateLimitStore[];
  close(): Promise<void>;
}

async function rig(connections = 1): Promise<Rig> {
  const redis = await connect();
  const extras = await Promise.all(Array.from({ length: connections }, connect));
  const policy = `t${randomUUID().slice(0, 8)}`;
  return {
    redis,
    store: createRedisRateLimitStore(redis),
    stores: extras.map((r) => createRedisRateLimitStore(r)),
    policy,
    async close() {
      const keys = await redis.keys(`rl:${policy}:*`);
      if (keys.length > 0) await redis.del(...keys);
      redis.disconnect();
      for (const r of extras) r.disconnect();
    },
  };
}

const both = (user: string, ip: string, userMax: number, ipMax: number): ScopeCheck[] => [
  { kind: 'user', id: user, max: userMax },
  { kind: 'ip', id: ip, max: ipMax },
];

const denied = (result: CheckResult) => {
  assert.equal(result.allowed, false, 'expected a refusal');
  return result as Extract<CheckResult, { allowed: false }>;
};

test('under the limit passes, the request after it does not, and the answer names the counter that tripped', { skip }, async () => {
  const t = await rig();
  try {
    const [user, ip] = [randomUUID(), '203.0.113.7'];
    for (let i = 0; i < 3; i += 1) assert.deepEqual(await t.store.check(t.policy, WIN, both(user, ip, 3, 100), T0 + i), { allowed: true });
    const refusal = denied(await t.store.check(t.policy, WIN, both(user, ip, 3, 100), T0 + 3));
    assert.deepEqual(refusal.deniedScopes, ['user']);
    assert.ok(refusal.retryAfterMs >= 1);
  } finally {
    await t.close();
  }
});

test('the numbers are exact: 10 at the end of a window, refused at +1 s with a 5 s wait, refused until the very millisecond that wait ends', { skip }, async () => {
  const t = await rig();
  try {
    const [user, ip] = [randomUUID(), '203.0.113.8'];
    const at = (ms: number) => t.store.check(t.policy, WIN, both(user, ip, 10, 1000), T0 + ms);

    for (let i = 0; i < 10; i += 1) assert.deepEqual(await at(55_000), { allowed: true });

    // One second into the next window: prev = 10, weight = 59/60, estimate 9.83, so the 11th... is refused.
    const refusal = denied(await at(61_000));
    assert.equal(refusal.retryAfterMs, 5_000, 'est 9.83 must fade to 9: 60 s * (9.83 - 9) / 10 = 5 s');
    assert.deepEqual(refusal.deniedScopes, ['user']);

    assert.equal(denied(await at(65_999)).retryAfterMs, 1, '1 ms short of the computed instant: refused, and one more ms is all that is left');
    assert.deepEqual(await at(66_000), { allowed: true }, 'the instant Retry-After named: admitted');
  } finally {
    await t.close();
  }
});

test('a window that is full on its own waits for the boundary and then for the blend to fade (the other Retry-After branch)', { skip }, async () => {
  const t = await rig();
  try {
    const [user, ip] = [randomUUID(), '203.0.113.9'];
    const at = (ms: number) => t.store.check(t.policy, WIN, both(user, ip, 3, 1000), T0 + ms);
    for (let i = 0; i < 3; i += 1) await at(10_000);

    // remaining 40 s to the boundary, then cur=3 becomes prev and must fade to max-1=2: weight 2/3, i.e. 20 s into the window.
    const refusal = denied(await at(20_000));
    assert.equal(refusal.retryAfterMs, 40_000 + 20_000);
    assert.equal(denied(await at(79_999)).allowed, false);
    assert.deepEqual(await at(80_000), { allowed: true });
  } finally {
    await t.close();
  }
});

/** The thing a fixed window does, for comparison: one counter per window, forgetting everything at the boundary. */
function fixedWindowAdmits(attempts: { at: number }[], max: number): number {
  const counts = new Map<number, number>();
  let admitted = 0;
  for (const { at } of attempts) {
    const window = Math.floor(at / WIN);
    const used = counts.get(window) ?? 0;
    if (used < max) {
      counts.set(window, used + 1);
      admitted += 1;
    }
  }
  return admitted;
}

test('THE WINDOW SLIDES: a burst at the end of a window and another just after the boundary is caught (a fixed window lets all 20 through)', { skip }, async () => {
  const t = await rig();
  try {
    const [user, ip] = [randomUUID(), '203.0.113.10'];
    const max = 10;
    const attempts = [
      ...Array.from({ length: 10 }, () => ({ at: T0 + 59_000 })), // the end of window 1000
      ...Array.from({ length: 10 }, () => ({ at: T0 + 60_500 })), // half a second into window 1001
    ];

    let slidingAdmitted = 0;
    for (const { at } of attempts) {
      if ((await t.store.check(t.policy, WIN, both(user, ip, max, 1000), at)).allowed) slidingAdmitted += 1;
    }
    assert.equal(slidingAdmitted, 10, 'only the first burst: the second is still inside the window the first one filled');
    assert.equal(fixedWindowAdmits(attempts, max), 20, 'the same traffic against a fixed window: twice the limit inside 1.5 seconds');
  } finally {
    await t.close();
  }
});

test('KNOWN LIMIT, pinned: two bursts timed one whole window apart, at the very end of consecutive windows, get through (about 2x in one window)', { skip }, async () => {
  const t = await rig();
  try {
    const [user, ip] = [randomUUID(), '203.0.113.11'];
    const at = (ms: number) => t.store.check(t.policy, WIN, both(user, ip, 10, 1000), T0 + ms);
    for (let i = 0; i < 10; i += 1) assert.deepEqual(await at(59_999), { allowed: true });

    // 59.998 s into the NEXT window: the blend thinks the first burst has all but expired (weight 2/60000), but it is
    // only 59.999 s old, so a true sliding window would still hold it. This is what ADR 0016 means by "approximation".
    let admitted = 0;
    for (let i = 0; i < 10; i += 1) if ((await at(60_000 + 59_998)).allowed) admitted += 1;
    assert.ok(admitted >= 9, `admitted ${admitted} of 10: nearly double the limit in just under one window`);
    // If this starts failing, the algorithm changed: update ADR 0016 (and the comment in slidingWindow.ts) with it.
  } finally {
    await t.close();
  }
});

test('property: over thousands of random requests no window ever admits more than max, and no span of one window sees more than 2x max', { skip }, async () => {
  const t = await rig();
  try {
    const [user, ip] = [randomUUID(), '203.0.113.12'];
    const max = 10;
    let seed = 12_345; // a fixed seed, so a failure is reproducible
    const random = () => (seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296) / 4_294_967_296;

    let now = T0;
    const admittedAt: number[] = [];
    for (let i = 0; i < 3_000; i += 1) {
      now += random() < 0.1 ? Math.floor(random() * 20_000) : Math.floor(random() * 400); // mostly bursts, sometimes a pause
      if ((await t.store.check(t.policy, WIN, both(user, ip, max, 1_000_000), now)).allowed) admittedAt.push(now);
    }
    assert.ok(admittedAt.length > 100, 'the run admitted something');

    const perWindow = new Map<number, number>();
    for (const at of admittedAt) perWindow.set(Math.floor(at / WIN), (perWindow.get(Math.floor(at / WIN)) ?? 0) + 1);
    assert.ok(Math.max(...perWindow.values()) <= max, 'a single window never exceeds max');

    let worst = 0;
    let from = 0;
    for (let i = 0; i < admittedAt.length; i += 1) {
      while (admittedAt[i]! - admittedAt[from]! >= WIN) from += 1;
      worst = Math.max(worst, i - from + 1);
    }
    assert.ok(worst <= 2 * max, `the busiest span of one window held ${worst} admitted requests`);
  } finally {
    await t.close();
  }
});

test('a refused request costs nothing: it writes no counter, so hammering cannot extend a lock-out', { skip }, async () => {
  const t = await rig();
  try {
    const [user, ip] = [randomUUID(), '203.0.113.13'];
    const at = (ms: number) => t.store.check(t.policy, WIN, both(user, ip, 3, 1000), T0 + ms);
    for (let i = 0; i < 3; i += 1) await at(10_000);
    const keysBefore = (await t.redis.keys(`rl:${t.policy}:*`)).sort();
    const countBefore = await t.redis.get(slidingWindowKey(t.policy, { kind: 'user', id: user, max: 3 }, 1000));
    const first = denied(await at(20_000));

    for (let i = 0; i < 100; i += 1) denied(await at(20_001 + i));

    assert.deepEqual((await t.redis.keys(`rl:${t.policy}:*`)).sort(), keysBefore, 'no key appeared');
    assert.equal(await t.redis.get(slidingWindowKey(t.policy, { kind: 'user', id: user, max: 3 }, 1000)), countBefore, 'the counter did not move');
    assert.equal(denied(await at(20_000)).retryAfterMs, first.retryAfterMs, 'the wait is the same after 100 refused requests');
    assert.deepEqual(await at(80_000), { allowed: true }, 'and it ends when it said it would');
  } finally {
    await t.close();
  }
});

test('user and address are judged together but independently: either can trip alone, neither masks the other, and a refusal writes to neither', { skip }, async () => {
  const t = await rig();
  try {
    const at = (ms: number, user: string, ip: string, userMax: number, ipMax: number) =>
      t.store.check(t.policy, WIN, both(user, ip, userMax, ipMax), T0 + ms);
    const counter = (kind: 'user' | 'ip', id: string, window = 1000) => t.redis.get(slidingWindowKey(t.policy, { kind, id, max: 0 }, window));

    // The user trips alone; the address has plenty of room, and another user on the same address is unaffected.
    const [alice, bob, ipA] = [randomUUID(), randomUUID(), '203.0.113.20'];
    for (let i = 0; i < 3; i += 1) await at(1_000, alice, ipA, 3, 100);
    assert.deepEqual(denied(await at(1_000, alice, ipA, 3, 100)).deniedScopes, ['user']);
    assert.equal(await counter('ip', ipA), '3', 'the refused request did not count against the address');
    assert.deepEqual(await at(1_000, bob, ipA, 3, 100), { allowed: true }, 'bob, same address, is fine');
    assert.equal(await counter('ip', ipA), '4');
    // Alice from a different address is still alice: the user counter follows her.
    assert.deepEqual(denied(await at(1_000, alice, '203.0.113.21', 3, 100)).deniedScopes, ['user']);

    // The address trips alone; each user is far under their own limit, and a refused newcomer leaves no mark.
    const ipB = '203.0.113.22';
    for (let i = 0; i < 5; i += 1) assert.deepEqual(await at(1_000, randomUUID(), ipB, 100, 5), { allowed: true });
    const carol = randomUUID();
    assert.deepEqual(denied(await at(1_000, carol, ipB, 100, 5)).deniedScopes, ['ip']);
    assert.equal(await counter('user', carol), null, "carol's own counter was not touched by a request the address refused");
    assert.deepEqual(await at(1_000, carol, '203.0.113.23', 100, 5), { allowed: true }, 'carol from another address is fine');
  } finally {
    await t.close();
  }
});

test('when both trip, both are named and Retry-After is the LONGER wait', { skip }, async () => {
  const t = await rig();
  try {
    const [user, ip] = [randomUUID(), '203.0.113.30'];
    const at = (ms: number, u: string) => t.store.check(t.policy, WIN, both(u, ip, 4, 8), T0 + ms);
    for (let i = 0; i < 4; i += 1) await at(50_000, user); // the user is full (4/4) and has used 4 of the address's 8
    for (let i = 0; i < 4; i += 1) await at(50_000, randomUUID()); // four others bring the address to 8/8

    // 6 s into the next window (weight 0.9): user estimate 3.6 (needs 9 s to fade to 3), address estimate 7.2 (needs 1.5 s to fade to 7).
    const refusal = denied(await at(66_000, user));
    assert.deepEqual(refusal.deniedScopes, ['user', 'ip']);
    assert.equal(refusal.retryAfterMs, 9_000);
    assert.equal(await t.redis.get(slidingWindowKey(t.policy, { kind: 'user', id: user, max: 0 }, 1001)), null, 'nothing was written');
  } finally {
    await t.close();
  }
});

test('ATOMIC: 200 simultaneous checks over several connections admit exactly the limit, for the user and the address alike', { skip }, async () => {
  const t = await rig(4);
  try {
    // One user and one address, 200 at once. User max 50, address max 80: exactly 50 get in, and BOTH counters say 50
    // (a refusal writes to neither), so there is no read-then-write gap for a second request to slip through.
    const [user, ip] = [randomUUID(), '203.0.113.40'];
    const calls = Array.from({ length: 200 }, (_, i) => t.stores[i % t.stores.length]!.check(t.policy, WIN, both(user, ip, 50, 80), T0 + 1_000));
    const results = await Promise.all(calls);
    assert.equal(results.filter((r) => r.allowed).length, 50);
    assert.equal(await t.redis.get(slidingWindowKey(t.policy, { kind: 'user', id: user, max: 0 }, 1000)), '50');
    assert.equal(await t.redis.get(slidingWindowKey(t.policy, { kind: 'ip', id: ip, max: 0 }, 1000)), '50');

    // 200 different users on one address, address max 80: exactly 80 get in, and only those 80 have a user counter.
    const ipB = '203.0.113.41';
    const users = Array.from({ length: 200 }, () => randomUUID());
    const wave = await Promise.all(users.map((u, i) => t.stores[i % t.stores.length]!.check(t.policy, WIN, both(u, ipB, 10, 80), T0 + 2_000)));
    assert.equal(wave.filter((r) => r.allowed).length, 80);
    assert.equal(await t.redis.get(slidingWindowKey(t.policy, { kind: 'ip', id: ipB, max: 0 }, 1000)), '80');
    const userKeys = (await t.redis.keys(`rl:${t.policy}:u:*`)).filter((k) => users.some((u) => k.includes(u)));
    assert.equal(userKeys.length, 80, 'the 120 refused users left no counter behind');
  } finally {
    await t.close();
  }
});

test('every key has a TTL of two windows, and the key shape is the documented one', { skip }, async () => {
  const t = await rig();
  try {
    const [user, ip] = [randomUUID(), '203.0.113.50'];
    await t.store.check(t.policy, WIN, both(user, ip, 5, 5), T0 + 1_000);
    const keys = (await t.redis.keys(`rl:${t.policy}:*`)).sort();
    assert.deepEqual(keys, [`rl:${t.policy}:ip:${ip}:1000`, `rl:${t.policy}:u:${user}:1000`].sort());
    for (const key of keys) {
      const ttl = await t.redis.pttl(key);
      assert.ok(ttl > 2 * WIN - 5_000 && ttl <= 2 * WIN, `${key} expires in ${ttl} ms`);
    }
  } finally {
    await t.close();
  }
});

test('a Redis that is not connected is an error from the store, not an answer (the limiter decides to fail open)', { skip }, async () => {
  if (!TEST_REDIS_URL) throw new Error('test env is not set');
  const redis = createRedisClient(createLogger(() => {}), TEST_REDIS_URL); // never connected
  try {
    const store = createRedisRateLimitStore(redis);
    await assert.rejects(store.check('x', WIN, both('u', 'i', 1, 1), T0), /redis not ready/);
  } finally {
    redis.disconnect();
  }
});
