import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshShowtime, openStack, ownerId, skip } from './testkit.js';

/**
 * `heldCount` (ADR 0017): how many seats of a showing an owner holds RIGHT NOW. The waiting room asks it to decide whether someone
 * mid-purchase may skip the line. Like the hold caps (ADR 0018) it trusts the hold keys, never the index that merely lists candidates.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('heldCount counts live holds, and not released ones', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 6, stack.redis);
    const owner = ownerId();
    assert.equal(await stack.holds.heldCount(showtimeId, owner), 0, 'nothing held');
    await stack.holds.acquire(showtimeId, owner, seatIds.slice(0, 4));
    assert.equal(await stack.holds.heldCount(showtimeId, owner), 4);
    await stack.holds.release(showtimeId, owner, seatIds.slice(0, 3));
    assert.equal(await stack.holds.heldCount(showtimeId, owner), 1, 'a release is not counted (the index still lists it)');
    assert.equal(await stack.holds.heldCount(showtimeId, ownerId()), 0, 'and it is per owner');
  } finally {
    await stack.close();
  }
});

test('heldCount does not count a hold that LAPSED, or a seat that someone else now holds', { skip }, async () => {
  const stack = await openStack({ ttlMs: 300 });
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 6, stack.redis);
    const first = ownerId();
    await stack.holds.acquire(showtimeId, first, seatIds.slice(0, 3));
    assert.equal(await stack.holds.heldCount(showtimeId, first), 3);
    await sleep(400);
    assert.equal(await stack.holds.heldCount(showtimeId, first), 0, 'the holds lapsed');
    await stack.holds.acquire(showtimeId, ownerId(), seatIds.slice(0, 3)); // someone else takes the same seats
    assert.equal(await stack.holds.heldCount(showtimeId, first), 0, 'and they are not the first owner\'s any more');
  } finally {
    await stack.close();
  }
});
