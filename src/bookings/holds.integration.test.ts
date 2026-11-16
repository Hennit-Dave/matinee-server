import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../http/errors.js';
import { ShowtimeSeatsResponseSchema } from '../showtimes/seat.js';
import { LOAD_TEST_SCREEN_ID } from '../showtimes/seedPlan.js';
import { BookingResponseSchema, HoldResponseSchema, ReleaseResponseSchema } from './booking.js';
import { SEAT_HOLD_TTL_MS, holdKey } from './holdStore.js';
import {
  assertLoopbackRedis,
  createLaggingReplica,
  ensureSeeded,
  freshShowtime,
  openStack,
  ownerId,
  skip,
  type Stack,
} from './testkit.js';

/**
 * The traffic slice's proof (RULES D5): a seat is never held twice, never sold twice, and a Redis outage
 * cannot change that. Real Postgres and a real, local Redis. Storms go through the services (so 200
 * "users" cost nothing in sockets); the HTTP tests prove the status codes and bodies on top.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function call(stack: Stack, method: string, path: string, client: string | null, body?: unknown) {
  return fetch(`${stack.base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(client ? { 'x-client-id': client } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A rejection must be one of OUR errors: a raw Prisma or Redis error escaping would be a 500. */
function refusal(result: PromiseSettledResult<unknown>): ApiError {
  assert.equal(result.status, 'rejected');
  const reason = (result as PromiseRejectedResult).reason as unknown;
  assert.ok(reason instanceof ApiError, `an unexpected failure escaped: ${String(reason)}`);
  return reason;
}

async function seatStatuses(stack: Stack, showtimeId: string, client?: string): Promise<Map<string, string>> {
  const res = await fetch(`${stack.base}/showtimes/${showtimeId}/seats`, client ? { headers: { 'x-client-id': client } } : undefined);
  assert.equal(res.status, 200);
  const body = ShowtimeSeatsResponseSchema.parse(await res.json());
  return new Map(body.rows.flatMap((r) => r.seats).map((s) => [s.id, s.status]));
}

test('the hold tests refuse to run against a Redis that is not on this machine', () => {
  assert.doesNotThrow(() => assertLoopbackRedis('redis://127.0.0.1:6391'));
  assert.doesNotThrow(() => assertLoopbackRedis('redis://localhost:6379'));
  assert.throws(() => assertLoopbackRedis('redis://default:x@my-app.up.railway.app:6379'), /non-local Redis/);
  assert.throws(() => assertLoopbackRedis('rediss://default:x@eu1-calm-1234.upstash.io:6379'), /non-local Redis/);
});

test('200 users take the same seat at the same moment: exactly one wins, 199 are told seat_taken', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 1, stack.redis);
    const seatId = seatIds[0]!;
    const owners = Array.from({ length: 200 }, ownerId);

    const results = await Promise.allSettled(
      owners.map((owner) => stack.bookings.acquireHolds({ showtimeId, ownerId: owner, seatIds: [seatId] })),
    );

    const winners = owners.filter((_, i) => results[i]!.status === 'fulfilled');
    assert.equal(winners.length, 1, 'exactly one hold is granted');
    for (const result of results) {
      if (result.status === 'fulfilled') continue;
      const error = refusal(result);
      assert.equal(error.code, 'seat_taken');
      assert.deepEqual(error.seatIds, [seatId]);
    }
    const key = holdKey(showtimeId, seatId);
    assert.equal(await stack.redis.get(key), winners[0], 'the stored owner is the winner');
    const ttl = await stack.redis.pttl(key);
    assert.ok(ttl > SEAT_HOLD_TTL_MS - 10_000 && ttl <= SEAT_HOLD_TTL_MS, `the hold carries the 10-minute TTL (${ttl} ms left)`);
  } finally {
    await stack.close();
  }
});

test('the same storm over HTTP: one 201, the rest 409 with the contested seat', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 1, stack.redis);
    const responses = await Promise.all(
      Array.from({ length: 30 }, () => call(stack, 'POST', `/showtimes/${showtimeId}/holds`, randomUUID(), { seatIds })),
    );
    const statuses = responses.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 201).length, 1);
    assert.equal(statuses.filter((s) => s === 409).length, 29);

    const win = responses.find((r) => r.status === 201)!;
    const hold = HoldResponseSchema.parse(await win.json());
    assert.deepEqual(hold.seatIds, seatIds);
    assert.ok(hold.expiresInMs > SEAT_HOLD_TTL_MS - 5_000 && hold.expiresInMs <= SEAT_HOLD_TTL_MS);
    assert.ok(Math.abs(Date.parse(hold.expiresAt) - (Date.now() + hold.expiresInMs)) < 5_000);

    const lose = responses.find((r) => r.status === 409)!;
    const body = (await lose.json()) as { error: { code: string; seatIds: string[]; requestId: string } };
    assert.equal(body.error.code, 'seat_taken');
    assert.deepEqual(body.error.seatIds, seatIds);
  } finally {
    await stack.close();
  }
});

test('multi-seat holds are all-or-nothing: after a storm of overlapping requests no partial hold survives', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 6, stack.redis);
    const owners = Array.from({ length: 40 }, ownerId);
    const wanted = owners.map(() => [...seatIds].sort(() => Math.random() - 0.5).slice(0, 3));

    const results = await Promise.allSettled(
      owners.map((owner, i) => stack.bookings.acquireHolds({ showtimeId, ownerId: owner, seatIds: wanted[i]! })),
    );

    const winners = new Map<string, string[]>();
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') winners.set(owners[i]!, wanted[i]!);
      else assert.equal(refusal(result).code, 'seat_taken');
    });
    assert.ok(winners.size >= 1 && winners.size <= 2, `with 6 seats and 3 per request, at most 2 users can win (got ${winners.size})`);

    let held = 0;
    for (const seatId of seatIds) {
      const owner = await stack.redis.get(holdKey(showtimeId, seatId));
      if (owner === null) continue;
      held += 1;
      assert.ok(winners.has(owner), 'a seat is held only by a user whose whole request succeeded (no loser left a partial hold)');
      assert.ok(winners.get(owner)!.includes(seatId));
    }
    assert.equal(held, winners.size * 3, 'every winner holds exactly the seats it asked for');
  } finally {
    await stack.close();
  }
});

test('asking again for seats you already hold succeeds and does not extend the window', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 2, stack.redis);
    const owner = ownerId();
    const first = await stack.bookings.acquireHolds({ showtimeId, ownerId: owner, seatIds });
    const ttlBefore = await stack.redis.pttl(holdKey(showtimeId, seatIds[0]!));
    await sleep(60);
    const second = await stack.bookings.acquireHolds({ showtimeId, ownerId: owner, seatIds });
    const ttlAfter = await stack.redis.pttl(holdKey(showtimeId, seatIds[0]!));

    assert.ok(second.expiresInMs <= first.expiresInMs, 'the countdown is not restarted by a retry');
    assert.ok(ttlAfter < ttlBefore, 'the key kept counting down');
  } finally {
    await stack.close();
  }
});

test('release is owner-only: a stranger cannot free your seat, you can, and then someone else can take it', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 1, stack.redis);
    const [alice, mallory, bob] = [ownerId(), ownerId(), ownerId()];
    const key = holdKey(showtimeId, seatIds[0]!);
    await stack.bookings.acquireHolds({ showtimeId, ownerId: alice, seatIds });

    const attack = await call(stack, 'DELETE', `/showtimes/${showtimeId}/holds`, mallory, { seatIds });
    assert.equal(attack.status, 200);
    assert.deepEqual(ReleaseResponseSchema.parse(await attack.json()).released, [], 'nothing was released for the stranger');
    assert.equal(await stack.redis.get(key), alice, "Alice's hold is untouched");

    const own = await call(stack, 'DELETE', `/showtimes/${showtimeId}/holds`, alice, { seatIds });
    assert.deepEqual(ReleaseResponseSchema.parse(await own.json()).released, seatIds);
    assert.equal(await stack.redis.get(key), null);

    const again = await call(stack, 'DELETE', `/showtimes/${showtimeId}/holds`, alice, { seatIds });
    assert.equal(again.status, 200, 'releasing twice is not an error');
    assert.deepEqual(ReleaseResponseSchema.parse(await again.json()).released, []);

    await stack.bookings.acquireHolds({ showtimeId, ownerId: bob, seatIds });
    assert.equal(await stack.redis.get(key), bob, 'the freed seat can be held by someone else');
  } finally {
    await stack.close();
  }
});

test('confirm needs a hold you own: no hold, someone else\'s hold, and an expired hold are all refused and write nothing', { skip }, async () => {
  const stack = await openStack({ ttlMs: 400 });
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 2, stack.redis);
    const [alice, bob] = [ownerId(), ownerId()];
    const rows = () => stack.db.primary.booking.count({ where: { showtimeId } });

    const none = await stack.bookings.confirmBooking({ showtimeId, ownerId: alice, seatIds: [seatIds[0]!] }).catch((e: unknown) => e);
    assert.ok(none instanceof ApiError);
    assert.equal(none.code, 'seat_not_held');
    assert.deepEqual(none.seatIds, [seatIds[0]]);

    await stack.bookings.acquireHolds({ showtimeId, ownerId: alice, seatIds: [seatIds[0]!] });
    const stolen = await stack.bookings.confirmBooking({ showtimeId, ownerId: bob, seatIds: [seatIds[0]!] }).catch((e: unknown) => e);
    assert.ok(stolen instanceof ApiError);
    assert.equal(stolen.code, 'seat_not_held');

    // Alice holds seat 0 but asks to book seats 0 and 1: all or nothing, so nothing is booked.
    const partial = await stack.bookings.confirmBooking({ showtimeId, ownerId: alice, seatIds }).catch((e: unknown) => e);
    assert.ok(partial instanceof ApiError);
    assert.equal(partial.code, 'seat_not_held');
    assert.deepEqual(partial.seatIds, [seatIds[1]]);
    assert.equal(await rows(), 0);

    await sleep(550); // the 400 ms hold has expired
    const late = await stack.bookings.confirmBooking({ showtimeId, ownerId: alice, seatIds: [seatIds[0]!] }).catch((e: unknown) => e);
    assert.ok(late instanceof ApiError);
    assert.equal(late.code, 'seat_not_held');
    assert.equal(await rows(), 0, 'no booking was written by any refused confirm');
  } finally {
    await stack.close();
  }
});

test('confirm returns the server-priced booking, writes one row per seat, and leaves the hold to expire', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 3, stack.redis);
    const alice = ownerId();
    const hold = await call(stack, 'POST', `/showtimes/${showtimeId}/holds`, alice, { seatIds });
    assert.equal(hold.status, 201);

    const res = await call(stack, 'POST', `/showtimes/${showtimeId}/bookings`, alice, { seatIds });
    assert.equal(res.status, 201);
    const booking = BookingResponseSchema.parse(await res.json());
    assert.equal(booking.showtimeId, showtimeId);
    assert.equal(booking.priceCents, 1850, 'the per-seat price comes from the showtime');
    assert.equal(booking.totalCents, 3 * 1850);
    assert.equal(booking.totalFormatted, '£55.50');
    assert.deepEqual(booking.seats.map((s) => s.seatId).sort(), [...seatIds].sort());

    const rows = await stack.db.primary.booking.findMany({ where: { showtimeId } });
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.reference === booking.reference && r.ownerId === alice && r.priceCents === 1850));

    assert.equal(await stack.redis.get(holdKey(showtimeId, seatIds[0]!)), alice, 'confirm leaves the hold in place; it expires on its own');
  } finally {
    await stack.close();
  }
});

test('the database alone refuses a seat sold twice (the final guard)', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 1, stack.redis);
    const row = () => ({ reference: randomUUID(), showtimeId, seatId: seatIds[0]!, ownerId: ownerId(), priceCents: 1850 });
    await stack.db.primary.booking.create({ data: row() });
    await assert.rejects(stack.db.primary.booking.create({ data: row() }), (err: unknown) => (err as { code?: string }).code === 'P2002');
    assert.equal(await stack.db.primary.booking.count({ where: { showtimeId } }), 1);
  } finally {
    await stack.close();
  }
});

test('Redis checks bypassed entirely, 50 users confirming the same seat: the unique constraint lets exactly one through, nobody gets a 500', { skip }, async () => {
  const stack = await openStack({ wrapHolds: (real) => ({ ...real, heldBy: async (_s, _o, ids) => [...ids] }) });
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 1, stack.redis);
    const owners = Array.from({ length: 50 }, ownerId);
    const results = await Promise.allSettled(
      owners.map((owner) => stack.bookings.confirmBooking({ showtimeId, ownerId: owner, seatIds })),
    );

    const winners = owners.filter((_, i) => results[i]!.status === 'fulfilled');
    assert.equal(winners.length, 1);
    for (const result of results) {
      if (result.status === 'fulfilled') continue;
      const error = refusal(result);
      assert.equal(error.code, 'seat_taken');
      assert.deepEqual(error.seatIds, seatIds);
    }
    const rows = await stack.db.primary.booking.findMany({ where: { showtimeId, seatId: seatIds[0]! } });
    assert.equal(rows.length, 1, 'one row for the seat');
    assert.equal(rows[0]!.ownerId, winners[0]);
  } finally {
    await stack.close();
  }
});

test('multi-seat confirms are all-or-nothing even when only the database is deciding', { skip }, async () => {
  const stack = await openStack({ wrapHolds: (real) => ({ ...real, heldBy: async (_s, _o, ids) => [...ids] }) });
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 5, stack.redis);
    const owners = Array.from({ length: 30 }, ownerId);
    const wanted = owners.map(() => [...seatIds].sort(() => Math.random() - 0.5).slice(0, 2));
    const results = await Promise.allSettled(
      owners.map((owner, i) => stack.bookings.confirmBooking({ showtimeId, ownerId: owner, seatIds: wanted[i]! })),
    );
    const winners = owners.filter((_, i) => results[i]!.status === 'fulfilled');
    for (const result of results) if (result.status === 'rejected') assert.equal(refusal(result).code, 'seat_taken');

    const rows = await stack.db.primary.booking.findMany({ where: { showtimeId } });
    assert.equal(rows.length, winners.length * 2, 'each winner has both of its seats and no loser has any');
    assert.equal(new Set(rows.map((r) => r.seatId)).size, rows.length, 'no seat appears twice');
    assert.ok(rows.every((r) => winners.includes(r.ownerId)));
  } finally {
    await stack.close();
  }
});

test('a hold that expires between the check and the insert cannot double-book: the constraint stops the slower user', { skip }, async () => {
  const alice = ownerId();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const stack = await openStack({
    // Alice's confirm checks her hold, then waits at the gate before inserting.
    wrapHolds: (real) => ({
      ...real,
      heldBy: async (showtimeId, owner, ids) => {
        const held = await real.heldBy(showtimeId, owner, ids);
        if (owner === alice) await gate;
        return held;
      },
    }),
  });
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 1, stack.redis);
    const bob = ownerId();
    await stack.bookings.acquireHolds({ showtimeId, ownerId: alice, seatIds });

    const aliceConfirm = stack.bookings.confirmBooking({ showtimeId, ownerId: alice, seatIds });
    await sleep(100); // Alice has passed the hold check and is parked at the gate

    await stack.redis.del(holdKey(showtimeId, seatIds[0]!)); // her hold is gone (expiry, or Redis lost it)
    await stack.bookings.acquireHolds({ showtimeId, ownerId: bob, seatIds }); // Bob legitimately takes the seat
    await stack.bookings.confirmBooking({ showtimeId, ownerId: bob, seatIds }); // and books it

    release();
    const error = await aliceConfirm.catch((e: unknown) => e);
    assert.ok(error instanceof ApiError, 'Alice is refused with one of our errors, not a 500');
    assert.equal(error.code, 'seat_taken');

    const rows = await stack.db.primary.booking.findMany({ where: { showtimeId } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.ownerId, bob);
  } finally {
    release();
    await stack.close();
  }
});

test('a seat that was already sold cannot be held, and the failed attempt leaves no hold behind', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 2, stack.redis);
    const [alice, bob] = [ownerId(), ownerId()];
    await stack.bookings.acquireHolds({ showtimeId, ownerId: alice, seatIds: [seatIds[0]!] });
    await stack.bookings.confirmBooking({ showtimeId, ownerId: alice, seatIds: [seatIds[0]!] });
    await stack.redis.del(holdKey(showtimeId, seatIds[0]!)); // the hold has gone; only the booking remains

    const error = await stack.bookings.acquireHolds({ showtimeId, ownerId: bob, seatIds }).catch((e: unknown) => e);
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'seat_taken');
    assert.deepEqual(error.seatIds, [seatIds[0]]);
    assert.equal(await stack.redis.get(holdKey(showtimeId, seatIds[0]!)), null, 'no hold on the sold seat');
    assert.equal(await stack.redis.get(holdKey(showtimeId, seatIds[1]!)), null, 'the free seat in the same request is released too');
  } finally {
    await stack.close();
  }
});

test('one taken seat fails the whole request and the caller is left holding nothing', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 2, stack.redis);
    const [alice, bob] = [ownerId(), ownerId()];
    await stack.bookings.acquireHolds({ showtimeId, ownerId: alice, seatIds: [seatIds[1]!] });

    const res = await call(stack, 'POST', `/showtimes/${showtimeId}/holds`, bob, { seatIds });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: { code: string; seatIds: string[] } };
    assert.equal(body.error.code, 'seat_taken');
    assert.deepEqual(body.error.seatIds, [seatIds[1]]);
    assert.equal(await stack.redis.get(holdKey(showtimeId, seatIds[0]!)), null, 'the seat that was free is not left held');
    assert.equal(await stack.redis.get(holdKey(showtimeId, seatIds[1]!)), alice);
  } finally {
    await stack.close();
  }
});

test('GET /showtimes/:id/seats shows available, held and sold, and sold wins over a lingering hold', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 3, stack.redis);
    const alice = ownerId();
    const [held, sold, free] = seatIds as [string, string, string];

    let statuses = await seatStatuses(stack, showtimeId);
    assert.equal(statuses.get(held), 'available');

    await stack.bookings.acquireHolds({ showtimeId, ownerId: alice, seatIds: [held] });
    await stack.bookings.acquireHolds({ showtimeId, ownerId: alice, seatIds: [sold] });
    await stack.bookings.confirmBooking({ showtimeId, ownerId: alice, seatIds: [sold] }); // its hold is still there

    statuses = await seatStatuses(stack, showtimeId);
    assert.equal(statuses.get(held), 'held');
    assert.equal(statuses.get(sold), 'sold', 'a booked seat is sold even while its hold key still exists');
    assert.equal(statuses.get(free), 'available');
    const counts = [...statuses.values()].reduce<Record<string, number>>((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {});
    assert.deepEqual(counts, { held: 1, sold: 1, available: 318 });
  } finally {
    await stack.close();
  }
});

test('read-your-own-writes: for a few seconds after booking, the booker reads from the primary; everyone else reads the (lagging) replica', { skip }, async () => {
  const prep = await openStack();
  await ensureSeeded(prep.db);
  const lagging = await createLaggingReplica(prep.db);
  const stack = await openStack({ readUrl: lagging.url, ryowWindowMs: 700 });
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 1, stack.redis);
    const seatId = seatIds[0]!;
    const [alice, bob] = [ownerId(), ownerId()];

    await stack.bookings.acquireHolds({ showtimeId, ownerId: alice, seatIds });
    await stack.bookings.confirmBooking({ showtimeId, ownerId: alice, seatIds });
    await stack.redis.del(holdKey(showtimeId, seatId)); // the hold has expired; only the replica's view is left to read

    assert.equal((await seatStatuses(stack, showtimeId)).get(seatId), 'available', 'anonymous readers see the replica, which has not heard of the booking');
    assert.equal((await seatStatuses(stack, showtimeId, bob)).get(seatId), 'available', 'so does everyone else');
    assert.equal((await seatStatuses(stack, showtimeId, alice)).get(seatId), 'sold', 'the booker sees their own booking at once');

    // The stale read is harmless: the authoritative check is on the primary.
    const error = await stack.bookings.acquireHolds({ showtimeId, ownerId: bob, seatIds }).catch((e: unknown) => e);
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'seat_taken');

    await sleep(900); // the window is over
    assert.equal((await seatStatuses(stack, showtimeId, alice)).get(seatId), 'available', 'after the window the booker reads the replica again');
  } finally {
    await stack.close();
    await prep.close();
    await lagging.close();
  }
});

test('Redis not ready: every hold route fails closed with a retryable 503, the seat map too, and service resumes when Redis is back', { skip }, async () => {
  const prep = await openStack();
  const { showtimeId, seatIds } = await freshShowtime(prep.db, 1, prep.redis);
  const stack = await openStack({ connectRedis: false });
  try {
    const alice = ownerId();
    const hold = await call(stack, 'POST', `/showtimes/${showtimeId}/holds`, alice, { seatIds });
    assert.equal(hold.status, 503);
    assert.equal(hold.headers.get('retry-after'), '2');
    assert.equal(((await hold.json()) as { error: { code: string } }).error.code, 'holds_unavailable');

    const release = await call(stack, 'DELETE', `/showtimes/${showtimeId}/holds`, alice, { seatIds });
    assert.equal(release.status, 503);
    const book = await call(stack, 'POST', `/showtimes/${showtimeId}/bookings`, alice, { seatIds });
    assert.equal(book.status, 503);
    assert.equal(await stack.db.primary.booking.count({ where: { showtimeId } }), 0, 'nothing was booked while Redis was down');

    const map = await fetch(`${stack.base}/showtimes/${showtimeId}/seats`);
    assert.equal(map.status, 503, 'we do not present a seat map we cannot verify');

    await stack.redis.connect();
    const back = await call(stack, 'POST', `/showtimes/${showtimeId}/holds`, alice, { seatIds });
    assert.equal(back.status, 201);
  } finally {
    await stack.close();
    await prep.close();
  }
});

test('Redis connected but not answering: the hold times out into a 503 (never hangs, never falls open), and a retry is safe', { skip }, async () => {
  const stack = await openStack({ opTimeoutMs: 200 });
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 1, stack.redis);
    const alice = ownerId();
    await stack.redis.call('CLIENT', 'PAUSE', '1200', 'WRITE');

    const started = Date.now();
    const error = await stack.bookings.acquireHolds({ showtimeId, ownerId: alice, seatIds }).catch((e: unknown) => e);
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'holds_unavailable');
    assert.ok(Date.now() - started < 1000, 'it gave up at the deadline, not when the pause ended');

    await sleep(1500); // the pause is over; the command that was waiting has now run (a "ghost" hold)
    const retry = await stack.bookings.acquireHolds({ showtimeId, ownerId: alice, seatIds });
    assert.deepEqual(retry.seatIds, seatIds, 'asking again as the same user succeeds whether or not the ghost hold exists');
    assert.equal(await stack.redis.get(holdKey(showtimeId, seatIds[0]!)), alice);
  } finally {
    await sleep(1300); // never leave the shared Redis paused for the next test
    await stack.close();
  }
});

test('requests are validated before anything runs: ids, seat lists, header, and seats from another screen', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 2, stack.redis);
    const alice = ownerId();
    const path = `/showtimes/${showtimeId}/holds`;
    const codeOf = async (res: Response) => ((await res.json()) as { error: { code: string; details?: { path: string; code: string }[] } }).error;

    const foreign = await stack.db.primary.seat.findFirstOrThrow({ where: { screenId: { not: LOAD_TEST_SCREEN_ID } } });
    const wrongScreen = await call(stack, 'POST', path, alice, { seatIds: [foreign.id] });
    assert.equal(wrongScreen.status, 400);
    const wrongBody = await codeOf(wrongScreen);
    assert.equal(wrongBody.code, 'validation_failed');
    assert.deepEqual(wrongBody.details, [{ path: 'seatIds', code: 'not_in_screen' }]);

    const unknown = await call(stack, 'POST', `/showtimes/${randomUUID()}/holds`, alice, { seatIds });
    assert.equal(unknown.status, 404);
    assert.equal((await codeOf(unknown)).code, 'not_found');

    const badBodies: unknown[] = [
      {},
      { seatIds: [] },
      { seatIds: ['not-a-uuid'] },
      { seatIds: [seatIds[0], seatIds[0]] },
      { seatIds: Array.from({ length: 9 }, () => randomUUID()) },
      { seatIds, extra: true },
      { seatIds: 'x' },
    ];
    for (const body of badBodies) {
      const res = await call(stack, 'POST', path, alice, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((await codeOf(res)).code, 'validation_failed');
    }

    for (const [label, client] of [['missing', null], ['not a uuid', 'abc']] as const) {
      const res = await call(stack, 'POST', path, client, { seatIds });
      assert.equal(res.status, 400, `${label} X-Client-Id`);
      assert.ok((await codeOf(res)).details?.some((d) => d.path === 'header.x-client-id'));
    }
    const badId = await fetch(`${stack.base}/showtimes/not-a-uuid/holds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client-id': alice },
      body: JSON.stringify({ seatIds }),
    });
    assert.equal(badId.status, 400);
    assert.equal(await stack.redis.exists(holdKey(showtimeId, seatIds[0]!)), 0, 'no refused request left a hold behind');
  } finally {
    await stack.close();
  }
});
