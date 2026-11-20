import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../http/errors.js';
import { createLogger } from '../http/logger.js';
import { BookingResponseSchema, HoldResponseSchema } from './booking.js';
import { createBookingService } from './bookingService.js';
import { createFakeHoldStore, createFakeRepo, createFakeRyowStore } from './fakes.js';

const SHOWTIME = '11111111-1111-4111-8111-111111111111';
const OTHER_SHOWTIME = '99999999-9999-4999-8999-999999999999';
const [A1, A2, B1] = [
  'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  'bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
];
const FOREIGN_SEAT = 'ccccccc1-cccc-4ccc-8ccc-ccccccccccc1'; // in another screen
const ALICE = '0a11ce00-0000-4000-8000-000000000001';
const BOB = '0b0b0000-0000-4000-8000-000000000002';

function setup() {
  const repo = createFakeRepo({
    showtimes: { [SHOWTIME]: { screenId: 'screen-1', priceCents: 1850 }, [OTHER_SHOWTIME]: { screenId: 'screen-2', priceCents: 900 } },
    screens: {
      'screen-1': [
        { id: A1, row: 'A', number: 1 },
        { id: A2, row: 'A', number: 2 },
        { id: B1, row: 'B', number: 1 },
      ],
      'screen-2': [{ id: FOREIGN_SEAT, row: 'A', number: 1 }],
    },
  });
  const holds = createFakeHoldStore();
  const ryow = createFakeRyowStore();
  const logs: Record<string, unknown>[] = [];
  const logger = createLogger((line) => logs.push(JSON.parse(line) as Record<string, unknown>));
  const service = createBookingService({ repo, holds, ryow, logger, now: () => Date.parse('2026-11-20T20:00:00.000Z') });
  return { repo, holds, ryow, logs, service };
}

const req = (ownerId: string, seatIds: string[], showtimeId = SHOWTIME) => ({ showtimeId, ownerId, seatIds, requestId: 'req-1' });

async function refused(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(error instanceof ApiError, `expected an ApiError, got ${String(error)}`);
  return error;
}

test('taking a hold returns when it expires, counted from the server clock and the remaining time', async () => {
  const { service, holds } = setup();
  const hold = HoldResponseSchema.parse(await service.acquireHolds(req(ALICE, [A1, A2])));
  assert.deepEqual(hold.seatIds, [A1, A2]);
  assert.equal(hold.expiresInMs, 600_000, 'the window is 10 minutes');
  assert.equal(hold.expiresAt, '2026-11-20T20:10:00.000Z');
  assert.deepEqual([...holds.held(SHOWTIME).keys()].sort(), [A1, A2]);
});

test('an unknown showtime is not_found, and a seat from another screen is a validation error, before Redis is touched', async () => {
  const { service, holds } = setup();
  assert.equal((await refused(service.acquireHolds(req(ALICE, [A1], '00000000-0000-4000-8000-00000000dead')))).code, 'not_found');

  const wrong = await refused(service.acquireHolds(req(ALICE, [A1, FOREIGN_SEAT])));
  assert.equal(wrong.code, 'validation_failed');
  assert.deepEqual(wrong.details, [{ path: 'seatIds', code: 'not_in_screen' }]);
  assert.deepEqual(holds.calls, [], 'a request that fails validation never reaches Redis');
});

test('a seat someone else holds fails the whole request with that seat named, and the caller holds nothing', async () => {
  const { service, holds } = setup();
  await service.acquireHolds(req(BOB, [A2]));
  const error = await refused(service.acquireHolds(req(ALICE, [A1, A2])));
  assert.equal(error.code, 'seat_taken');
  assert.equal(error.status, 409);
  assert.deepEqual(error.seatIds, [A2]);
  assert.deepEqual([...holds.held(SHOWTIME)], [[A2, BOB]], 'Alice was not left holding A1');
});

test('a sold seat cannot be held: the hold is given back and the sold seat is named', async () => {
  const { service, repo, holds } = setup();
  repo.bookings.push({ reference: 'r', showtimeId: SHOWTIME, seatId: A1, ownerId: BOB, priceCents: 1850 });
  const error = await refused(service.acquireHolds(req(ALICE, [A1, A2])));
  assert.equal(error.code, 'seat_taken');
  assert.deepEqual(error.seatIds, [A1]);
  assert.equal(holds.held(SHOWTIME).size, 0, 'neither seat is left held');
});

test('the sold check happens AFTER the hold is taken, and Postgres failing then still releases the hold', async () => {
  const { service, repo, holds } = setup();
  repo.failNextSoldCheck = true;
  await assert.rejects(service.acquireHolds(req(ALICE, [A1])), /postgres went away/);
  assert.equal(holds.held(SHOWTIME).size, 0, 'the hold was given back, not stranded for 10 minutes');
  assert.deepEqual(holds.calls, ['acquire', 'release'], 'hold first, then check, then release');
});

test('Redis down: holds, releases and confirms all fail with the one retryable error, and nothing is booked', async () => {
  const { service, holds, repo } = setup();
  holds.down = true;
  for (const attempt of [service.acquireHolds(req(ALICE, [A1])), service.releaseHolds(req(ALICE, [A1])), service.confirmBooking(req(ALICE, [A1]))]) {
    const error = await refused(attempt);
    assert.equal(error.code, 'holds_unavailable');
    assert.equal(error.status, 503);
  }
  assert.equal(repo.bookings.length, 0);
});

test('release frees only the caller\'s own seats and reports which', async () => {
  const { service, holds } = setup();
  await service.acquireHolds(req(ALICE, [A1]));
  await service.acquireHolds(req(BOB, [A2]));
  assert.deepEqual(await service.releaseHolds(req(ALICE, [A1, A2])), { released: [A1] });
  assert.deepEqual([...holds.held(SHOWTIME)], [[A2, BOB]], "Bob's hold survives");
  assert.deepEqual(await service.releaseHolds(req(ALICE, [A1])), { released: [] }, 'releasing again is not an error');
});

test('confirm books the held seats at the showtime price, totals them on the server, and starts the read-your-own-writes window', async () => {
  const { service, repo, ryow } = setup();
  await service.acquireHolds(req(ALICE, [B1, A2, A1]));
  const booking = BookingResponseSchema.parse(await service.confirmBooking(req(ALICE, [B1, A2, A1])));

  assert.deepEqual(booking.seats.map((s) => `${s.row}${s.number}`), ['A1', 'A2', 'B1'], 'seats come back in row order');
  assert.equal(booking.priceCents, 1850);
  assert.equal(booking.totalCents, 5550);
  assert.equal(booking.totalFormatted, '£55.50');
  assert.equal(repo.bookings.length, 3);
  assert.ok(repo.bookings.every((b) => b.reference === booking.reference && b.ownerId === ALICE && b.priceCents === 1850));
  assert.deepEqual(ryow.calls, [`mark:${ALICE}`]);
});

test('confirm needs ALL the seats to be the caller\'s: nothing held, someone else\'s hold, or only some of them', async () => {
  const { service, repo } = setup();
  const none = await refused(service.confirmBooking(req(ALICE, [A1])));
  assert.equal(none.code, 'seat_not_held');
  assert.deepEqual(none.seatIds, [A1]);

  await service.acquireHolds(req(BOB, [A1]));
  assert.equal((await refused(service.confirmBooking(req(ALICE, [A1])))).code, 'seat_not_held');

  await service.acquireHolds(req(ALICE, [A2]));
  const partial = await refused(service.confirmBooking(req(ALICE, [A1, A2])));
  assert.deepEqual(partial.seatIds, [A1]);
  assert.equal(repo.bookings.length, 0, 'a refused confirm writes nothing');
});

test('when the database refuses a seat (sold first), confirm answers 409 seat_taken with the sold seats, not a 500', async () => {
  const { service, repo } = setup();
  await service.acquireHolds(req(ALICE, [A1, A2]));
  // Bob's booking for A2 committed after Alice's hold check (her hold had lapsed and Bob took the seat).
  repo.bookings.push({ reference: 'r', showtimeId: SHOWTIME, seatId: A2, ownerId: BOB, priceCents: 1850 });

  const error = await refused(service.confirmBooking(req(ALICE, [A1, A2])));
  assert.equal(error.code, 'seat_taken');
  assert.deepEqual(error.seatIds, [A2]);
  assert.equal(repo.bookings.length, 1, 'all or nothing: Alice got neither seat');
});

test('a failure to start the read-your-own-writes window does not undo a committed booking', async () => {
  const { service, repo, ryow } = setup();
  await service.acquireHolds(req(ALICE, [A1]));
  ryow.down = true;
  const booking = await service.confirmBooking(req(ALICE, [A1]));
  assert.equal(booking.seats.length, 1);
  assert.equal(repo.bookings.length, 1);
});

test('every outcome is logged with the user and showtime, so a booking can be traced from the logs alone', async () => {
  const { service, logs } = setup();
  await service.acquireHolds(req(ALICE, [A1, A2]));
  await refused(service.acquireHolds(req(BOB, [A2])));
  await service.confirmBooking(req(ALICE, [A1, A2]));

  const events = logs.map((l) => [l.msg, l.outcome, l.errorCode ?? null]);
  assert.deepEqual(events, [
    ['hold_acquired', 'ok', null],
    ['hold_rejected', 'rejected', 'seat_taken'],
    ['booking_confirmed', 'ok', null],
  ]);
  assert.equal(logs[1]!.userId, BOB);
  assert.equal(logs[1]!.showtimeId, SHOWTIME);
  assert.equal(logs[1]!.seatCount, 1);
  assert.equal(logs[1]!.requestId, 'req-1');
});

// ---- Cancelled showtimes (ADR 0020) ---------------------------------------------------------------

function setupCancelled() {
  const repo = createFakeRepo({
    showtimes: { [SHOWTIME]: { screenId: 'screen-1', priceCents: 1850, cancelledAt: new Date('2026-11-20T19:00:00.000Z') } },
    screens: {
      'screen-1': [
        { id: A1, row: 'A', number: 1 },
        { id: A2, row: 'A', number: 2 },
        { id: B1, row: 'B', number: 1 },
      ],
    },
  });
  const holds = createFakeHoldStore();
  const ryow = createFakeRyowStore();
  const service = createBookingService({ repo, holds, ryow, now: () => Date.parse('2026-11-20T20:00:00.000Z') });
  return { repo, holds, service };
}

test('a cancelled showtime refuses holds, confirm and verify with showtime_cancelled, never touching Redis', async () => {
  const { service, holds } = setupCancelled();
  for (const attempt of [
    service.acquireHolds(req(ALICE, [A1])),
    service.confirmBooking(req(ALICE, [A1])),
    service.verifyHolds(req(ALICE, [A1])),
  ]) {
    const error = await refused(attempt);
    assert.equal(error.code, 'showtime_cancelled');
    assert.equal(error.status, 410);
  }
  assert.deepEqual(holds.calls, [], 'a dead showing is refused before any seat is touched');
});

// ---- The hold caps (ADR 0018) ---------------------------------------------------------------------

function capped(caps: { perOwner?: number; perAddress?: number }) {
  const base = setup();
  const holds = createFakeHoldStore(undefined, caps);
  const service = createBookingService({
    repo: base.repo,
    holds,
    ryow: base.ryow,
    logger: createLogger((line) => base.logs.push(JSON.parse(line) as Record<string, unknown>)),
    now: () => Date.parse('2026-11-20T20:00:00.000Z'),
  });
  return { ...base, holds, service };
}

test('past the per-owner cap: hold_limit_reached naming the scope, the cap and what is held, and NOTHING more is held', async () => {
  const { service, holds, logs } = capped({ perOwner: 2 });
  await service.acquireHolds(req(ALICE, [A1, A2]));
  const error = await refused(service.acquireHolds(req(ALICE, [B1])));
  assert.equal(error.code, 'hold_limit_reached');
  assert.equal(error.status, 409);
  assert.deepEqual(error.holdLimit, { scope: 'owner', limit: 2, held: 2 });
  assert.deepEqual([...holds.held(SHOWTIME).keys()].sort(), [A1, A2], 'the refused request held nothing');
  const line = logs.find((l) => l.msg === 'hold_rejected');
  assert.deepEqual([line?.errorCode, line?.scope, line?.limit, line?.held], ['hold_limit_reached', 'owner', 2, 2], 'the log can say which cap');
});

test('asking again for seats you already hold is not "new": it succeeds at the cap', async () => {
  const { service } = capped({ perOwner: 2 });
  await service.acquireHolds(req(ALICE, [A1, A2]));
  assert.deepEqual((await service.acquireHolds(req(ALICE, [A1, A2]))).seatIds, [A1, A2]);
});

test('releasing frees slots, and one person\'s holds never count against another', async () => {
  const { service } = capped({ perOwner: 2 });
  await service.acquireHolds(req(ALICE, [A1, A2]));
  await service.acquireHolds(req(BOB, [B1])); // Bob is not limited by Alice
  await service.releaseHolds(req(ALICE, [A1]));
  assert.deepEqual((await service.acquireHolds(req(ALICE, [A1]))).seatIds, [A1], 'a released seat frees a slot');
});

test('the address reaches the store, and the per-address cap refuses a second install on the same address', async () => {
  const { service, holds } = capped({ perAddress: 2 });
  await service.acquireHolds({ ...req(ALICE, [A1, A2]), address: '203.0.113.9' });
  assert.deepEqual(holds.addressesSeen, ['203.0.113.9']);
  const error = await refused(service.acquireHolds({ ...req(BOB, [B1]), address: '203.0.113.9' }));
  assert.deepEqual(error.holdLimit, { scope: 'address', limit: 2, held: 2 });
  assert.deepEqual((await service.acquireHolds({ ...req(BOB, [B1]), address: '198.51.100.7' })).seatIds, [B1], 'another address is fine');
});

test('an address that could not be resolved skips the address cap (off, loudly, never everyone refused)', async () => {
  const { service, holds } = capped({ perAddress: 1 });
  await service.acquireHolds(req(ALICE, [A1]));
  await service.acquireHolds(req(BOB, [A2]));
  assert.deepEqual(holds.addressesSeen, [undefined, undefined]);
});

test('the cap does not turn a Redis outage into anything but the usual retryable 503', async () => {
  const { service, holds } = capped({ perOwner: 2 });
  holds.down = true;
  assert.equal((await refused(service.acquireHolds(req(ALICE, [A1])))).code, 'holds_unavailable');
});
