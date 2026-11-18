import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { createLogger } from '../http/logger.js';
import { createRedisClient } from '../jobs/connection.js';
import { assertLoopbackRedis, skip, TEST_REDIS_URL } from '../bookings/testkit.js';
import { DEFAULT_TIMING, type RoomTiming } from './config.js';
import { createRedisWaitingRoomStore, roomKeys, type RoomState, type WaitingRoomStore } from './store.js';

/**
 * The waiting room's atomic scripts on a real Redis, with a clock the test moves (ADR 0017). Everything is per showing and every
 * test uses its own showing id, so nothing here can touch another test's keys.
 */

interface Room {
  store: WaitingRoomStore;
  redis: Redis;
  showtimeId: string;
  /** The clock the store reads. Move it with `at`. */
  clock: { now: number };
  close(): Promise<void>;
}

const T0 = 1_000_000;

async function openRoom(options: { maxActive: number; admitPerMinute?: number; timing?: Partial<RoomTiming> }): Promise<Room> {
  assert.ok(TEST_REDIS_URL);
  assertLoopbackRedis(TEST_REDIS_URL);
  const redis = createRedisClient(createLogger(() => {}), TEST_REDIS_URL);
  await redis.connect();
  const clock = { now: T0 };
  const store = createRedisWaitingRoomStore(redis, {
    policy: { maxActive: options.maxActive, admitPerMinute: options.admitPerMinute ?? 60 },
    clock: () => clock.now,
    timing: options.timing,
  });
  const showtimeId = randomUUID();
  return {
    store,
    redis,
    showtimeId,
    clock,
    async close() {
      const keys = await redis.keys(`wr:*:{${showtimeId}}`);
      if (keys.length > 0) await redis.del(...keys);
      redis.disconnect();
    },
  };
}

const owner = () => randomUUID();
const join = (r: Room, who: string, holder = false) => r.store.join(r.showtimeId, who, { holder });
const poll = (r: Room, who: string) => r.store.poll(r.showtimeId, who);
const touch = (r: Room, who: string) => r.store.touch(r.showtimeId, who);
const leave = (r: Room, who: string) => r.store.leave(r.showtimeId, who);
const status = (s: RoomState) => s.status;
const ahead = (s: RoomState) => (s.status === 'waiting' ? s.ahead : -1);

test('while there is room, joining is instant and there is no line at all', { skip }, async () => {
  const r = await openRoom({ maxActive: 3 });
  try {
    for (let i = 0; i < 3; i += 1) assert.equal(status(await join(r, owner())), 'admitted');
    assert.equal(await r.redis.zcard(roomKeys(r.showtimeId).queue), 0);
  } finally {
    await r.close();
  }
});

test('past the cap the next arrivals queue FIFO: "0 ahead", "1 ahead", ... and joining again keeps your place', { skip }, async () => {
  const r = await openRoom({ maxActive: 2 });
  try {
    await join(r, owner());
    await join(r, owner());
    const [a, b, c] = [owner(), owner(), owner()];
    assert.equal(ahead(await join(r, a)), 0);
    assert.equal(ahead(await join(r, b)), 1);
    assert.equal(ahead(await join(r, c)), 2);
    assert.equal(ahead(await join(r, a)), 0, 're-joining does not move you');
    assert.equal(ahead(await join(r, c)), 2);
    const state = await join(r, b);
    assert.ok(state.status === 'waiting' && state.queueLength === 3 && state.pollAfterMs === 3_000);
  } finally {
    await r.close();
  }
});

test('200 simultaneous joins to a room of 5 admit EXACTLY 5, and the other 195 get 195 different places', { skip }, async () => {
  const r = await openRoom({ maxActive: 5 });
  try {
    const states = await Promise.all(Array.from({ length: 200 }, () => join(r, owner())));
    assert.equal(states.filter((s) => s.status === 'admitted').length, 5);
    const places = states.filter((s) => s.status === 'waiting').map(ahead).sort((x, y) => x - y);
    assert.deepEqual(places, Array.from({ length: 195 }, (_, i) => i), 'every place from 0 to 194 exactly once');
    assert.equal(await r.redis.zcard(roomKeys(r.showtimeId).active), 5);
  } finally {
    await r.close();
  }
});

test('people are let in in the order they arrived', { skip }, async () => {
  const r = await openRoom({ maxActive: 1 });
  try {
    const first = owner();
    await join(r, first);
    const line = Array.from({ length: 6 }, owner);
    for (const who of line) await join(r, who);
    const admittedOrder: string[] = [];
    let current = first;
    for (let step = 0; step < 6; step += 1) {
      await leave(r, current);
      r.clock.now += 1_000; // one admission interval
      const next = line.find((who) => !admittedOrder.includes(who))!;
      assert.equal(status(await poll(r, next)), 'admitted', `step ${step}`);
      for (const other of line.filter((w) => w !== next && !admittedOrder.includes(w))) assert.equal(status(await poll(r, other)), 'waiting');
      admittedOrder.push(next);
      current = next;
    }
    assert.deepEqual(admittedOrder, line);
  } finally {
    await r.close();
  }
});

test('ADMISSION IS AT A FIXED RATE: with 4 free slots and 5 waiting, one is let in per interval, not all at once', { skip }, async () => {
  const r = await openRoom({ maxActive: 4, admitPerMinute: 60 }); // one every 1000 ms
  try {
    const actives = Array.from({ length: 4 }, owner);
    for (const who of actives) await join(r, who);
    const waiters = Array.from({ length: 5 }, owner);
    for (const who of waiters) await join(r, who);
    r.clock.now += 10_000;
    for (const who of actives) await leave(r, who); // 4 slots are free, 5 people are waiting

    const admittedCount = async () => (await r.redis.zcard(roomKeys(r.showtimeId).active));
    const pollAll = async () => { for (const who of waiters) await poll(r, who); };

    await pollAll();
    assert.equal(await admittedCount(), 1, 'after an idle spell exactly one is due');
    await pollAll();
    assert.equal(await admittedCount(), 1, 'asking again in the same millisecond admits nobody');
    r.clock.now += 999;
    await pollAll();
    assert.equal(await admittedCount(), 1, 'one millisecond short of the interval');
    r.clock.now += 1;
    await pollAll();
    assert.equal(await admittedCount(), 2, 'the second, exactly one interval after the first');
    r.clock.now += 1_000;
    await pollAll();
    r.clock.now += 1_000;
    await pollAll();
    assert.equal(await admittedCount(), 4, 'and the 3rd and 4th, each an interval apart');
    r.clock.now += 5_000;
    await pollAll();
    assert.equal(await admittedCount(), 4, 'the 5th waits: the room is full again');
  } finally {
    await r.close();
  }
});

test('after a long quiet spell at most ONE person is let in at once (no burst), however many waited', { skip }, async () => {
  // Patience is stretched here so the waiters are still "there" after the hour; this test is about the burst, not about patience.
  const r = await openRoom({ maxActive: 5, admitPerMinute: 60, timing: { waiterPatienceMs: 7_200_000 } });
  try {
    const actives = Array.from({ length: 5 }, owner);
    for (const who of actives) await join(r, who);
    const waiters = Array.from({ length: 4 }, owner);
    for (const who of waiters) await join(r, who);
    for (const who of actives) await leave(r, who);
    r.clock.now += 3_600_000; // an hour of nobody asking
    await poll(r, waiters[3]!);
    assert.equal(await r.redis.zcard(roomKeys(r.showtimeId).active), 1);
  } finally {
    await r.close();
  }
});

test('a user who leaves frees the slot, and the next in line gets it on their next poll', { skip }, async () => {
  const r = await openRoom({ maxActive: 1 });
  try {
    const a = owner();
    const b = owner();
    await join(r, a);
    assert.equal(ahead(await join(r, b)), 0);
    await leave(r, a);
    r.clock.now += 1_000;
    assert.equal(status(await poll(r, b)), 'admitted');
  } finally {
    await r.close();
  }
});

test('A CLOSED APP FREES ITS SLOT BY ITSELF: a user not heard from for the heartbeat window lapses and the next is let in (no job)', { skip }, async () => {
  const r = await openRoom({ maxActive: 1 });
  try {
    const gone = owner();
    const next = owner();
    await join(r, gone);
    await join(r, next);
    r.clock.now += 29_000;
    assert.equal(status(await poll(r, next)), 'waiting', 'still inside the 30 s window');
    r.clock.now += 1_001;
    assert.equal(status(await poll(r, next)), 'admitted', 'the silent pass lapsed');
    assert.equal(await touch(r, gone), false, 'and the silent user no longer has a pass');
  } finally {
    await r.close();
  }
});

test('a heartbeat (touch) keeps a pass alive indefinitely inside the window', { skip }, async () => {
  const r = await openRoom({ maxActive: 1 });
  try {
    const a = owner();
    await join(r, a);
    for (let i = 0; i < 5; i += 1) {
      r.clock.now += 20_000;
      assert.equal(await touch(r, a), true);
    }
    r.clock.now += 20_000;
    assert.equal(await touch(r, a), true);
  } finally {
    await r.close();
  }
});

test('THE CLAIM WINDOW: someone let in from the queue who never shows up gives the slot back after 15 s; one who does show up keeps a full window', { skip }, async () => {
  const r = await openRoom({ maxActive: 1 });
  try {
    const first = owner();
    const ghost = owner();
    const real = owner();
    await join(r, first);
    await join(r, ghost);
    await join(r, real);
    await leave(r, first);
    r.clock.now += 1_000;
    assert.equal(status(await poll(r, ghost)), 'admitted', 'the ghost is let in...');
    r.clock.now += 14_000;
    assert.equal(await touch(r, ghost), true, '...and inside the claim window the pass still stands');
    // The ghost touched once, which counts as showing up: a full window from now.
    r.clock.now += 29_000;
    assert.equal(await touch(r, ghost), true);

    // Now a ghost that NEVER touches:
    const r2 = await openRoom({ maxActive: 1 });
    try {
      const a = owner();
      const never = owner();
      const after = owner();
      await join(r2, a);
      await join(r2, never);
      await join(r2, after);
      await leave(r2, a);
      r2.clock.now += 1_000;
      assert.equal(status(await poll(r2, never)), 'admitted');
      r2.clock.now += 15_001;
      assert.equal(status(await poll(r2, after)), 'admitted', 'the unclaimed pass lapsed after 15 s and the next in line took the slot');
      assert.equal(await touch(r2, never), false);
    } finally {
      await r2.close();
    }
  } finally {
    await r.close();
  }
});

test('NO PASS LASTS FOREVER: a user who keeps heartbeating still loses the pass at the hard limit', { skip }, async () => {
  const r = await openRoom({ maxActive: 1, timing: { passMaxMs: 60_000 } });
  try {
    const a = owner();
    await join(r, a);
    for (const at of [20_000, 40_000, 59_000]) {
      r.clock.now = T0 + at;
      assert.equal(await touch(r, a), true, `at ${at} ms`);
    }
    r.clock.now = T0 + 61_000;
    assert.equal(await touch(r, a), false, 'past the hard limit');
    assert.equal(status(await poll(r, a)), 'not_queued');
  } finally {
    await r.close();
  }
});

test('a waiter silent for the patience window loses their place and everyone behind moves up', { skip }, async () => {
  // The admitted user's window is stretched so they stay admitted while the clock moves: this test is about WAITERS.
  const r = await openRoom({ maxActive: 1, timing: { heartbeatWindowMs: 600_000, passMaxMs: 1_200_000 } });
  try {
    await join(r, owner());
    const [gone, kept] = [owner(), owner()];
    await join(r, gone);
    await join(r, kept);
    r.clock.now += 60_000;
    assert.equal(ahead(await poll(r, kept)), 1);
    r.clock.now += 31_000; // 91 s since `gone` was last heard from; `kept` polled 31 s ago
    assert.equal(ahead(await poll(r, kept)), 0, 'the one in front of me is gone');
    assert.equal(status(await poll(r, gone)), 'not_queued');
  } finally {
    await r.close();
  }
});

test('a holder skips the line: someone who still holds seats here is let back in even when the room is full', { skip }, async () => {
  const r = await openRoom({ maxActive: 1 });
  try {
    await join(r, owner());
    await join(r, owner());
    assert.equal(status(await join(r, owner(), true)), 'admitted');
    assert.equal(await r.redis.zcard(roomKeys(r.showtimeId).active), 2, 'the cap yields to someone mid-purchase');
  } finally {
    await r.close();
  }
});

test('the line has a maximum: past it joining is refused (bounds Redis memory under abuse)', { skip }, async () => {
  const r = await openRoom({ maxActive: 1, timing: { maxQueue: 3 } });
  try {
    await join(r, owner());
    for (let i = 0; i < 3; i += 1) assert.equal(status(await join(r, owner())), 'waiting');
    assert.equal(status(await join(r, owner())), 'full');
    assert.equal(await r.redis.zcard(roomKeys(r.showtimeId).queue), 3);
  } finally {
    await r.close();
  }
});

test('only an ADMITTED user has a pass: a waiter, a stranger and a user who left do not', { skip }, async () => {
  const r = await openRoom({ maxActive: 1 });
  try {
    const [admitted, waiter, left] = [owner(), owner(), owner()];
    await join(r, admitted);
    await join(r, waiter);
    assert.equal(await touch(r, admitted), true);
    assert.equal(await touch(r, waiter), false);
    assert.equal(await touch(r, owner()), false);
    await leave(r, admitted);
    assert.equal(await touch(r, admitted), false);
    void left;
  } finally {
    await r.close();
  }
});

test('polling never joins: a stranger is "not queued"; leaving is idempotent; a waiter who leaves moves everyone behind up', { skip }, async () => {
  const r = await openRoom({ maxActive: 1 });
  try {
    assert.equal(status(await poll(r, owner())), 'not_queued');
    await join(r, owner());
    const [w1, w2, w3] = [owner(), owner(), owner()];
    await join(r, w1);
    await join(r, w2);
    await join(r, w3);
    assert.equal(ahead(await poll(r, w3)), 2);
    await leave(r, w1);
    await leave(r, w1);
    assert.equal(ahead(await poll(r, w3)), 1);
    assert.equal(status(await poll(r, w1)), 'not_queued');
  } finally {
    await r.close();
  }
});

test('the cap is per SHOWING', { skip }, async () => {
  const r = await openRoom({ maxActive: 1 });
  try {
    await join(r, owner());
    const other = randomUUID();
    assert.equal(status(await r.store.join(other, owner(), { holder: false })), 'admitted', 'a different showing has its own room');
    const keys = await r.redis.keys(`wr:*:{${other}}`);
    if (keys.length > 0) await r.redis.del(...keys);
  } finally {
    await r.close();
  }
});

test('EVERY key has a TTL (RULES C4), longer than anything it holds, so an abandoned showing disappears entirely', { skip }, async () => {
  const r = await openRoom({ maxActive: 1 });
  try {
    await join(r, owner());
    await join(r, owner());
    const k = roomKeys(r.showtimeId);
    for (const key of [k.active, k.queue, k.seen, k.meta, k.since]) {
      const ttl = await r.redis.pttl(key);
      assert.ok(ttl > DEFAULT_TIMING.passMaxMs && ttl <= DEFAULT_TIMING.passMaxMs + DEFAULT_TIMING.heartbeatWindowMs, `${key}: ${ttl} ms`);
    }
  } finally {
    await r.close();
  }
});

test('a Redis that is not connected is an ERROR from the store, never an answer (the room decides to fail open)', { skip }, async () => {
  assert.ok(TEST_REDIS_URL);
  assertLoopbackRedis(TEST_REDIS_URL);
  const redis = createRedisClient(createLogger(() => {}), TEST_REDIS_URL); // never connected
  const store = createRedisWaitingRoomStore(redis, { policy: { maxActive: 1, admitPerMinute: 60 } });
  const showtimeId = randomUUID();
  await assert.rejects(() => store.join(showtimeId, owner(), { holder: false }), /redis not ready/);
  await assert.rejects(() => store.poll(showtimeId, owner()), /redis not ready/);
  await assert.rejects(() => store.touch(showtimeId, owner()), /redis not ready/);
  await assert.rejects(() => store.leave(showtimeId, owner()), /redis not ready/);
  redis.disconnect();
});

// ---- A property test: whatever happens, the invariants hold --------------------------------------------

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test('PROPERTY: over 600 random joins, polls, touches, leaves and clock jumps the room is never over its cap, nobody is in both places, and the line has no gaps', { skip }, async () => {
  for (const seed of [1, 7, 42]) {
    const cap = 3;
    const r = await openRoom({ maxActive: cap, admitPerMinute: 30, timing: { passMaxMs: 120_000 } });
    const random = seeded(seed);
    const people = Array.from({ length: 9 }, owner);
    const k = roomKeys(r.showtimeId);
    try {
      for (let step = 0; step < 600; step += 1) {
        const who = people[Math.floor(random() * people.length)]!;
        const dice = random();
        if (dice < 0.3) await join(r, who);
        else if (dice < 0.55) await poll(r, who);
        else if (dice < 0.7) await touch(r, who);
        else if (dice < 0.8) await leave(r, who);
        else r.clock.now += Math.floor(random() * 25_000);

        const active = await r.redis.zrange(k.active, 0, -1);
        const queue = await r.redis.zrange(k.queue, 0, -1, 'WITHSCORES');
        const queued = queue.filter((_, i) => i % 2 === 0);
        const tickets = queue.filter((_, i) => i % 2 === 1).map(Number);
        assert.ok(active.length <= cap, `seed ${seed} step ${step}: ${active.length} active in a room of ${cap}`);
        assert.ok(queued.every((q) => !active.includes(q)), `seed ${seed} step ${step}: someone is both admitted and queued`);
        assert.equal(new Set(tickets).size, tickets.length, `seed ${seed} step ${step}: two people share a ticket`);
        assert.deepEqual([...tickets].sort((x, y) => x - y), tickets, 'the line is in ticket order');
        const seen = await r.redis.zrange(k.seen, 0, -1);
        assert.ok(queued.every((q) => seen.includes(q)), `seed ${seed} step ${step}: a queued user is not tracked as waiting`);
      }
    } finally {
      await r.close();
    }
  }
});
