import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshShowtime, openStack, ownerId, skip } from './testkit.js';
import { holdAddressIndexKey, holdKey, holdOwnerIndexKey, type AcquireResult } from './holdStore.js';

/**
 * The hold caps (ADR 0018) on a real Redis: the exact numbers, that a lapsed hold frees its slot with no timer, that the cap is
 * atomic under a storm, and that a refused request leaves nothing behind. Per-owner 8 and per-address 16 are the production caps.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const ADDRESS = '203.0.113.9';
const OTHER_ADDRESS = '198.51.100.7';

function limited(result: AcquireResult) {
  assert.equal(result.ok, false);
  assert.ok('limitReached' in result, `expected a cap refusal, got ${JSON.stringify(result)}`);
  return result.limitReached;
}

test('an install may hold 8 seats of one showing in one request; the next seat is refused with the cap and what it holds', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 12, stack.redis);
    const owner = ownerId();
    assert.equal((await stack.holds.acquire(showtimeId, owner, seatIds.slice(0, 8))).ok, true);

    const refusal = limited(await stack.holds.acquire(showtimeId, owner, [seatIds[8]!]));
    assert.deepEqual(refusal, { scope: 'owner', limit: 8, held: 8 });
    assert.equal((await stack.holds.heldAmong(showtimeId, [seatIds[8]!])).size, 0, 'the refused request held nothing');
  } finally {
    await stack.close();
  }
});

test('the cap is on what is held IN TOTAL: 5 then 3 is fine, one more is not, and a request that would cross it holds none of its seats', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 12, stack.redis);
    const owner = ownerId();
    assert.equal((await stack.holds.acquire(showtimeId, owner, seatIds.slice(0, 5))).ok, true);
    assert.deepEqual(limited(await stack.holds.acquire(showtimeId, owner, seatIds.slice(5, 9))), { scope: 'owner', limit: 8, held: 5 }, '5 + 4 would be 9');
    assert.equal((await stack.holds.heldAmong(showtimeId, seatIds.slice(5, 9))).size, 0, 'all or nothing: not even the 3 that would have fit');
    assert.equal((await stack.holds.acquire(showtimeId, owner, seatIds.slice(5, 8))).ok, true, '5 + 3 is exactly the cap');
    assert.equal(limited(await stack.holds.acquire(showtimeId, owner, [seatIds[8]!])).held, 8);
  } finally {
    await stack.close();
  }
});

test('asking again for seats you already hold is not new, even at the cap, and it does not restart their timer', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 8, stack.redis);
    const owner = ownerId();
    await stack.holds.acquire(showtimeId, owner, seatIds);
    const before = await stack.redis.pttl(holdKey(showtimeId, seatIds[0]!));
    await sleep(60);
    const again = await stack.holds.acquire(showtimeId, owner, seatIds);
    assert.equal(again.ok, true);
    assert.ok(again.ok && again.expiresInMs < before, 'the countdown kept running');
  } finally {
    await stack.close();
  }
});

test('releasing frees slots: after giving back 3 of 8 the install can take 3 more', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 12, stack.redis);
    const owner = ownerId();
    await stack.holds.acquire(showtimeId, owner, seatIds.slice(0, 8));
    assert.deepEqual(await stack.holds.release(showtimeId, owner, seatIds.slice(0, 3)), seatIds.slice(0, 3));
    assert.equal((await stack.holds.acquire(showtimeId, owner, seatIds.slice(8, 11))).ok, true);
    assert.equal(limited(await stack.holds.acquire(showtimeId, owner, [seatIds[11]!])).held, 8);
  } finally {
    await stack.close();
  }
});

test('A HOLD THAT LAPSES FREES ITS SLOT, with no timer or job: the real TTL decides', { skip }, async () => {
  const stack = await openStack({ ttlMs: 300 });
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 20, stack.redis);
    const owner = ownerId();
    assert.equal((await stack.holds.acquire(showtimeId, owner, seatIds.slice(0, 8))).ok, true);
    assert.equal(limited(await stack.holds.acquire(showtimeId, owner, [seatIds[8]!])).held, 8, 'at the cap while the holds are live');

    await sleep(400); // every hold has now expired inside Redis
    assert.equal((await stack.holds.acquire(showtimeId, owner, seatIds.slice(8, 16))).ok, true, 'all 8 slots are free again');
  } finally {
    await stack.close();
  }
});

test('a hold that lapsed and was taken by SOMEONE ELSE is not counted against the first owner', { skip }, async () => {
  const stack = await openStack({ ttlMs: 300 });
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 20, stack.redis);
    const first = ownerId();
    const second = ownerId();
    await stack.holds.acquire(showtimeId, first, seatIds.slice(0, 4));
    await sleep(400);
    assert.equal((await stack.holds.acquire(showtimeId, second, seatIds.slice(0, 4))).ok, true, 'someone else takes the lapsed seats');

    // The first owner's index still LISTS those four seats. They must not count: the keys now belong to the second owner.
    assert.equal((await stack.holds.acquire(showtimeId, first, seatIds.slice(4, 12))).ok, true, 'all 8 slots are free for the first owner');
    const listed = await stack.redis.smembers(holdOwnerIndexKey(showtimeId, first));
    assert.deepEqual(listed.sort(), seatIds.slice(4, 12).sort(), 'and the stale members were pruned while counting');
  } finally {
    await stack.close();
  }
});

test('the caps are per showing: 8 on one showing does not count against 8 on another', { skip }, async () => {
  const stack = await openStack();
  try {
    const a = await freshShowtime(stack.db, 8, stack.redis);
    const b = await freshShowtime(stack.db, 8, stack.redis);
    const owner = ownerId();
    assert.equal((await stack.holds.acquire(a.showtimeId, owner, a.seatIds)).ok, true);
    assert.equal((await stack.holds.acquire(b.showtimeId, owner, b.seatIds, { address: ADDRESS })).ok, true);
  } finally {
    await stack.close();
  }
});

test('one ADDRESS may hold 16 seats of a showing however many installs it uses: the third install is refused with scope address', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 30, stack.redis);
    assert.equal((await stack.holds.acquire(showtimeId, ownerId(), seatIds.slice(0, 8), { address: ADDRESS })).ok, true);
    assert.equal((await stack.holds.acquire(showtimeId, ownerId(), seatIds.slice(8, 16), { address: ADDRESS })).ok, true);

    assert.deepEqual(limited(await stack.holds.acquire(showtimeId, ownerId(), [seatIds[16]!], { address: ADDRESS })), { scope: 'address', limit: 16, held: 16 });
    assert.equal((await stack.holds.heldAmong(showtimeId, [seatIds[16]!])).size, 0);

    assert.equal((await stack.holds.acquire(showtimeId, ownerId(), [seatIds[16]!], { address: OTHER_ADDRESS })).ok, true, 'another address is unaffected');
    assert.equal((await stack.holds.acquire(showtimeId, ownerId(), [seatIds[17]!])).ok, true, 'no address resolved: the address cap is skipped');
  } finally {
    await stack.close();
  }
});

test('an address cap of 0 is off, and a lapsed address hold frees its slot', { skip }, async () => {
  const off = await openStack({ holdCaps: { perAddress: 0 } });
  try {
    const { showtimeId, seatIds } = await freshShowtime(off.db, 30, off.redis);
    for (let i = 0; i < 4; i += 1) {
      assert.equal((await off.holds.acquire(showtimeId, ownerId(), seatIds.slice(i * 8, i * 8 + 8), { address: ADDRESS })).ok, true);
    }
    assert.equal(await off.redis.exists(holdAddressIndexKey(showtimeId, ADDRESS)), 0, 'no address index is even written when the cap is off');
  } finally {
    await off.close();
  }

  const short = await openStack({ ttlMs: 300 });
  try {
    const { showtimeId, seatIds } = await freshShowtime(short.db, 40, short.redis);
    await short.holds.acquire(showtimeId, ownerId(), seatIds.slice(0, 8), { address: ADDRESS });
    await short.holds.acquire(showtimeId, ownerId(), seatIds.slice(8, 16), { address: ADDRESS });
    assert.equal(limited(await short.holds.acquire(showtimeId, ownerId(), [seatIds[16]!], { address: ADDRESS })).scope, 'address');
    await sleep(400);
    assert.equal((await short.holds.acquire(showtimeId, ownerId(), seatIds.slice(16, 24), { address: ADDRESS })).ok, true, 'the lapsed holds freed the address');
  } finally {
    await short.close();
  }
});

test('100 simultaneous single-seat requests from ONE install hold exactly 8 seats: the cap is atomic', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 100, stack.redis);
    const owner = ownerId();
    const results = await Promise.all(seatIds.map((seatId) => stack.holds.acquire(showtimeId, owner, [seatId])));
    assert.equal(results.filter((r) => r.ok).length, 8, 'exactly the cap');
    assert.equal(results.filter((r) => !r.ok && 'limitReached' in r).length, 92);
    assert.equal((await stack.holds.heldAmong(showtimeId, seatIds)).size, 8, 'and exactly 8 hold keys exist');
  } finally {
    await stack.close();
  }
});

test('100 DIFFERENT installs behind ONE address take exactly 16 seats between them', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 100, stack.redis);
    const results = await Promise.all(seatIds.map((seatId) => stack.holds.acquire(showtimeId, ownerId(), [seatId], { address: ADDRESS })));
    assert.equal(results.filter((r) => r.ok).length, 16);
    assert.ok(results.filter((r) => !r.ok).every((r) => 'limitReached' in r && r.limitReached.scope === 'address'));
    assert.equal((await stack.holds.heldAmong(showtimeId, seatIds)).size, 16);
  } finally {
    await stack.close();
  }
});

test('a request refused because a seat is TAKEN leaves nothing in the indexes: the owner still has all 8 slots', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 20, stack.redis);
    const rival = ownerId();
    const owner = ownerId();
    await stack.holds.acquire(showtimeId, rival, [seatIds[0]!]);

    const result = await stack.holds.acquire(showtimeId, owner, [seatIds[0]!, seatIds[1]!], { address: ADDRESS });
    assert.deepEqual(result, { ok: false, takenSeatIds: [seatIds[0]!] });
    assert.equal(await stack.redis.scard(holdOwnerIndexKey(showtimeId, owner)), 0, 'no index entry for a hold that was rolled back');
    assert.equal(await stack.redis.scard(holdAddressIndexKey(showtimeId, ADDRESS)), 0);
    assert.equal((await stack.holds.acquire(showtimeId, owner, seatIds.slice(2, 10), { address: ADDRESS })).ok, true, 'all 8 slots are still free');
  } finally {
    await stack.close();
  }
});

test('the cap is judged BEFORE seat availability: at the cap, asking for a seat someone else holds is a cap refusal', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 12, stack.redis);
    const owner = ownerId();
    await stack.holds.acquire(showtimeId, owner, seatIds.slice(0, 8));
    await stack.holds.acquire(showtimeId, ownerId(), [seatIds[8]!]);
    assert.equal(limited(await stack.holds.acquire(showtimeId, owner, [seatIds[8]!])).scope, 'owner');
  } finally {
    await stack.close();
  }
});

test('every index key has a TTL no longer than a hold\'s (RULES C4): nothing the caps add can live forever', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 4, stack.redis);
    const owner = ownerId();
    await stack.holds.acquire(showtimeId, owner, seatIds, { address: ADDRESS });
    for (const key of [holdOwnerIndexKey(showtimeId, owner), holdAddressIndexKey(showtimeId, ADDRESS)]) {
      const ttl = await stack.redis.pttl(key);
      assert.ok(ttl > 0 && ttl <= 600_000, `${key} has a TTL (${ttl} ms)`);
    }
  } finally {
    await stack.close();
  }
});

test('over HTTP: the 409 carries code, scope, limit and held, and the address cap applies to callers on one address', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 30, stack.redis);
    const post = (client: string, ids: string[]) =>
      fetch(`${stack.base}/showtimes/${showtimeId}/holds`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-client-id': client },
        body: JSON.stringify({ seatIds: ids }),
      });

    const alice = ownerId();
    assert.equal((await post(alice, seatIds.slice(0, 8))).status, 201);
    const owner = await post(alice, [seatIds[8]!]);
    assert.equal(owner.status, 409);
    const body = (await owner.json()) as { error: Record<string, unknown> };
    assert.deepEqual(
      [body.error.code, body.error.scope, body.error.limit, body.error.held],
      ['hold_limit_reached', 'owner', 8, 8],
    );
    assert.equal(owner.headers.get('retry-after'), null);

    // Test callers all come from 127.0.0.1, which the server resolves as one address: two installs fill it, the third is refused.
    assert.equal((await post(ownerId(), seatIds.slice(10, 18))).status, 201);
    const third = await post(ownerId(), [seatIds[20]!]);
    assert.equal(third.status, 409);
    assert.equal(((await third.json()) as { error: { scope: string } }).error.scope, 'address');
  } finally {
    await stack.close();
  }
});

test('RELEASING frees the ADDRESS slots too, though the address index is not touched by a release: stale members are never counted', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 30, stack.redis);
    const first = ownerId();
    await stack.holds.acquire(showtimeId, first, seatIds.slice(0, 8), { address: ADDRESS });
    await stack.holds.acquire(showtimeId, ownerId(), seatIds.slice(8, 16), { address: ADDRESS });
    assert.equal(limited(await stack.holds.acquire(showtimeId, ownerId(), [seatIds[16]!], { address: ADDRESS })).held, 16, 'the address is full');

    // The first install gives its seats back. Its entries are still LISTED in the address index.
    await stack.holds.release(showtimeId, first, seatIds.slice(0, 8));
    assert.equal(await stack.redis.scard(holdAddressIndexKey(showtimeId, ADDRESS)), 16, 'the release left the index members behind');

    assert.equal((await stack.holds.acquire(showtimeId, ownerId(), seatIds.slice(16, 24), { address: ADDRESS })).ok, true, 'but they do not count: 8 slots are free');
    assert.equal(await stack.redis.scard(holdAddressIndexKey(showtimeId, ADDRESS)), 16, 'the 8 stale members were pruned, the 8 new ones added');
  } finally {
    await stack.close();
  }
});

test('a seat released by one install and taken by ANOTHER on the same address counts once, for the new owner', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 30, stack.redis);
    const first = ownerId();
    const second = ownerId();
    await stack.holds.acquire(showtimeId, first, seatIds.slice(0, 8), { address: ADDRESS });
    await stack.holds.release(showtimeId, first, seatIds.slice(0, 8));
    await stack.holds.acquire(showtimeId, second, seatIds.slice(0, 8), { address: ADDRESS });
    // The address holds 8 seats, not 16: the first install's stale entries name keys that now belong to the second.
    assert.equal((await stack.holds.acquire(showtimeId, ownerId(), seatIds.slice(8, 16), { address: ADDRESS })).ok, true);
    assert.equal(limited(await stack.holds.acquire(showtimeId, ownerId(), [seatIds[16]!], { address: ADDRESS })).held, 16);
  } finally {
    await stack.close();
  }
});
