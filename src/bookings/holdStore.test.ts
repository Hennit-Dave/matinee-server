import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Redis } from 'ioredis';
import { SEAT_HOLD_TTL_MS, createRedisHoldStore, holdAddressIndexKey, holdKey, holdOwnerIndexKey } from './holdStore.js';
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

test('acquire sends one script with every seat key, then the owner index, then the owner, TTL, seat count, caps and key prefix', async () => {
  const { redis, calls } = fakeRedis('ready', { eval: [1, 599_000] });
  const result = await createRedisHoldStore(redis).acquire(SHOWTIME, OWNER, [S1, S2]);

  assert.deepEqual(result, { ok: true, expiresInMs: 599_000 });
  assert.equal(calls.length, 1, 'one round trip for the whole request');
  const [script, numKeys, ...rest] = calls[0]!.args as [string, number, ...string[]];
  assert.equal(numKeys, 3, 'two seats plus the owner index (no address was given, so no address index)');
  assert.deepEqual(rest, [
    holdKey(SHOWTIME, S1),
    holdKey(SHOWTIME, S2),
    holdOwnerIndexKey(SHOWTIME, OWNER),
    OWNER,
    '600000', // the TTL in milliseconds
    '2', // how many of the keys are seats
    '8', // the owner cap
    '0', // the address cap is not used without an address
    `hold:{${SHOWTIME}}:`,
  ]);
  assert.match(script, /SET', key, owner, 'NX', 'PX', ttl/, 'each seat is taken with SET ... NX PX');
});

test('with an address, acquire also sends the address index and the address cap', async () => {
  const { redis, calls } = fakeRedis('ready', { eval: [1, 599_000] });
  await createRedisHoldStore(redis).acquire(SHOWTIME, OWNER, [S1], { address: '203.0.113.9' });
  const [, numKeys, ...rest] = calls[0]!.args as [string, number, ...string[]];
  assert.equal(numKeys, 3, 'one seat, the owner index and the address index');
  assert.equal(rest[1], holdOwnerIndexKey(SHOWTIME, OWNER));
  assert.equal(rest[2], holdAddressIndexKey(SHOWTIME, '203.0.113.9'));
  assert.deepEqual(rest.slice(-4), ['1', '8', '16', `hold:{${SHOWTIME}}:`]);
});

test('the caps come from the options, and 0 turns a cap off (the address index is then not even sent)', async () => {
  const { redis, calls } = fakeRedis('ready', { eval: [1, 599_000] });
  await createRedisHoldStore(redis, { caps: { perOwner: 3, perAddress: 0 } }).acquire(SHOWTIME, OWNER, [S1], { address: '203.0.113.9' });
  const [, numKeys, ...rest] = calls[0]!.args as [string, number, ...string[]];
  assert.equal(numKeys, 2, 'no address cap, so no address index');
  assert.deepEqual(rest.slice(-4), ['1', '3', '0', `hold:{${SHOWTIME}}:`]);
});

test('acquire maps a cap refusal ({3, scope, limit, held}) to limitReached, for both scopes', async () => {
  const owner = fakeRedis('ready', { eval: [3, 1, 8, 6] });
  assert.deepEqual(await createRedisHoldStore(owner.redis).acquire(SHOWTIME, OWNER, [S1]), {
    ok: false,
    limitReached: { scope: 'owner', limit: 8, held: 6 },
  });
  const address = fakeRedis('ready', { eval: [3, 2, 16, 16] });
  assert.deepEqual(await createRedisHoldStore(address.redis).acquire(SHOWTIME, OWNER, [S1], { address: '203.0.113.9' }), {
    ok: false,
    limitReached: { scope: 'address', limit: 16, held: 16 },
  });
});

test('the cap check comes BEFORE any seat is taken, and an index only ever lists candidates', async () => {
  const { redis, calls } = fakeRedis('ready', { eval: [1, 1] });
  await createRedisHoldStore(redis).acquire(SHOWTIME, OWNER, [S1]);
  const script = calls[0]!.args[0] as string;
  assert.ok(script.indexOf('return {3, 1, ownerCap') < script.indexOf("'SET', key, owner, 'NX'"), 'caps are judged before the first SET');
  assert.match(script, /GET', prefix \.\. seat\) == owner/, 'an owner-index member counts only if its hold key is still owned by the owner');
  assert.match(script, /SREM/, 'a stale member is pruned, not counted');
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
