import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Redis } from 'ioredis';
import { SEAT_HOLD_TTL_MS, createRedisHoldStore, holdKey } from './holdStore.js';
import { HoldsUnavailableError, failClosed } from './redisGuard.js';
import { RYOW_WINDOW_MS, createRedisRyowStore, ryowKey } from './ryow.js';

const SHOWTIME = '11111111-1111-4111-8111-111111111111';
const [S1, S2, S3] = ['aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3'];
const OWNER = '0a11ce00-0000-4000-8000-000000000001';

/** A scripted Redis: records the calls it gets and answers from `replies`. */
function fakeRedis(status: string, replies: Record<string, unknown> = {}) {
  const calls: { command: string; args: unknown[] }[] = [];
  const reply = (command: string) => async (...args: unknown[]) => {
    calls.push({ command, args });
    const answer = replies[command];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const redis = { status, eval: reply('eval'), mget: reply('mget'), set: reply('set'), exists: reply('exists') };
  return { redis: redis as unknown as Redis, calls };
}

test('the hold window is 10 minutes (AGENTS.md section 7, RULES D5.1)', () => {
  assert.equal(SEAT_HOLD_TTL_MS, 600_000);
  assert.equal(RYOW_WINDOW_MS, 5_000);
});

test('keys carry the showtime as a hash tag and the seat, and the ryow key carries the user', () => {
  assert.equal(holdKey(SHOWTIME, S1), `hold:{${SHOWTIME}}:${S1}`);
  assert.equal(ryowKey(OWNER), `ryow:${OWNER}`);
});

test('acquire sends one script with every seat key, then the owner and the TTL in milliseconds', async () => {
  const { redis, calls } = fakeRedis('ready', { eval: [1, 599_000] });
  const result = await createRedisHoldStore(redis).acquire(SHOWTIME, OWNER, [S1, S2]);

  assert.deepEqual(result, { ok: true, expiresInMs: 599_000 });
  assert.equal(calls.length, 1, 'one round trip for the whole request');
  const [script, numKeys, ...rest] = calls[0]!.args as [string, number, ...string[]];
  assert.equal(numKeys, 2);
  assert.deepEqual(rest, [holdKey(SHOWTIME, S1), holdKey(SHOWTIME, S2), OWNER, '600000']);
  assert.match(script, /SET', key, owner, 'NX', 'PX', ttl/, 'each seat is taken with SET ... NX PX');
});

test('acquire maps the failed positions the script returns back to seat ids', async () => {
  const { redis } = fakeRedis('ready', { eval: [0, 1, 3] });
  assert.deepEqual(await createRedisHoldStore(redis).acquire(SHOWTIME, OWNER, [S1, S2, S3]), { ok: false, takenSeatIds: [S1, S3] });
});

test('release is a compare-and-delete script, never a plain DEL, and maps positions back to seat ids', async () => {
  const { redis, calls } = fakeRedis('ready', { eval: [2] });
  assert.deepEqual(await createRedisHoldStore(redis).release(SHOWTIME, OWNER, [S1, S2]), [S2]);
  const script = calls[0]!.args[0] as string;
  assert.match(script, /GET', KEYS\[i\]\) == ARGV\[1\]/, 'compares the stored owner first');
  assert.ok(script.indexOf("'GET'") < script.indexOf("'DEL'"));
});

test('heldBy and heldAmong read the keys with one MGET', async () => {
  const { redis, calls } = fakeRedis('ready', { mget: [OWNER, 'someone-else', null] });
  const store = createRedisHoldStore(redis);
  assert.deepEqual(await store.heldBy(SHOWTIME, OWNER, [S1, S2, S3]), [S1]);
  assert.deepEqual([...(await store.heldAmong(SHOWTIME, [S1, S2, S3]))], [S1, S2]);
  assert.deepEqual(calls.map((c) => c.command), ['mget', 'mget']);
});

test('an empty seat list never reaches Redis (MGET with no keys is an error)', async () => {
  const { redis, calls } = fakeRedis('ready');
  const store = createRedisHoldStore(redis);
  assert.deepEqual([...(await store.heldAmong(SHOWTIME, []))], []);
  assert.deepEqual(await store.heldBy(SHOWTIME, OWNER, []), []);
  assert.deepEqual(await store.release(SHOWTIME, OWNER, []), []);
  assert.equal(calls.length, 0);
});

test('Redis not ready: every operation refuses at once and sends nothing (fail closed)', async () => {
  for (const status of ['wait', 'connecting', 'reconnecting', 'close', 'end']) {
    const { redis, calls } = fakeRedis(status, { eval: [1, 1] });
    const store = createRedisHoldStore(redis);
    await assert.rejects(store.acquire(SHOWTIME, OWNER, [S1]), HoldsUnavailableError);
    await assert.rejects(store.release(SHOWTIME, OWNER, [S1]), HoldsUnavailableError);
    await assert.rejects(store.heldBy(SHOWTIME, OWNER, [S1]), HoldsUnavailableError);
    await assert.rejects(store.heldAmong(SHOWTIME, [S1]), HoldsUnavailableError);
    await assert.rejects(createRedisRyowStore(redis).isActive(OWNER), HoldsUnavailableError);
    assert.equal(calls.length, 0, `status "${status}": nothing was sent`);
  }
});

test('a Redis error, or a reply we do not understand, is also a refusal rather than a guess', async () => {
  const broken = fakeRedis('ready', { eval: new Error('LOADING Redis is loading the dataset') });
  await assert.rejects(createRedisHoldStore(broken.redis).acquire(SHOWTIME, OWNER, [S1]), HoldsUnavailableError);
  const odd = fakeRedis('ready', { eval: 'OK' });
  await assert.rejects(createRedisHoldStore(odd.redis).acquire(SHOWTIME, OWNER, [S1]), /unexpected reply/);
});

test('failClosed gives up at the deadline and never leaves an unhandled rejection behind', async () => {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    const slowThenFails = () => new Promise<string>((_, reject) => setTimeout(() => reject(new Error('late failure')), 60));
    const started = Date.now();
    await assert.rejects(failClosed({ status: 'ready' }, 20, slowThenFails), /did not answer within 20 ms/);
    assert.ok(Date.now() - started < 55, 'it returned at the deadline, not when the operation finally failed');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', listener);
  }
});

test('failClosed passes a normal result straight through', async () => {
  assert.equal(await failClosed({ status: 'ready' }, 50, async () => 'fine'), 'fine');
});

test('the ryow marker is a key with a TTL: set with PX, and read with EXISTS', async () => {
  const { redis, calls } = fakeRedis('ready', { set: 'OK', exists: 1 });
  const store = createRedisRyowStore(redis);
  await store.mark(OWNER);
  assert.deepEqual(calls[0]!.args, [ryowKey(OWNER), '1', 'PX', 5_000]);
  assert.equal(await store.isActive(OWNER), true);
});
