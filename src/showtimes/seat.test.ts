import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  ShowtimeIdParamsSchema,
  ShowtimeSeatsResponseSchema,
  buildShowtimeSeatsResponse,
  groupSeatsIntoRows,
  type SeatRecord,
  type ShowtimeSeatsRow,
} from './seat.js';
import { SEED_SCREENS, buildSeedSeats } from './seedPlan.js';
import { formatPriceCents } from './showtime.js';

/** A showtime row as the seat service would read it, with seats built from the real seed layout. */
function showtimeFor(screenId: string, priceCents = 1850): ShowtimeSeatsRow {
  const screen = SEED_SCREENS.find((s) => s.id === screenId);
  assert.ok(screen, `unknown seeded screen ${screenId}`);
  return {
    id: randomUUID(),
    movieId: 900001,
    startsAt: new Date('2026-11-20T20:30:00.000Z'),
    priceCents,
    screen: {
      id: screen.id,
      name: screen.name,
      format: screen.format,
      totalSeats: screen.totalSeats,
      seats: buildSeedSeats([screen]).map((s) => ({ id: randomUUID(), row: s.row, number: s.number, kind: s.kind })),
    },
  };
}

test('response seat count equals the screen totalSeats for every seeded screen, and parses against the schema', () => {
  for (const screen of SEED_SCREENS) {
    const res = buildShowtimeSeatsResponse(showtimeFor(screen.id));
    const parsed = ShowtimeSeatsResponseSchema.parse(res);
    const seatCount = parsed.rows.reduce((sum, r) => sum + r.seats.length, 0);
    assert.equal(seatCount, screen.totalSeats, `${screen.id} seats in response`);
    assert.equal(parsed.screen.totalSeats, screen.totalSeats);
    assert.equal(parsed.rows.length, screen.layout.rows);
    assert.ok(parsed.rows.every((r) => r.seats.length === screen.layout.seatsPerRow));
  }
});

test('the 320-seat IMAX map has 16 rows, 2 wheelchair spaces, and every seat available', () => {
  const res = buildShowtimeSeatsResponse(showtimeFor('bfi-southbank-imax'));
  assert.equal(res.rows.map((r) => r.row).join(''), 'ABCDEFGHIJKLMNOP');
  const seats = res.rows.flatMap((r) => r.seats);
  assert.equal(seats.length, 320);
  assert.equal(seats.filter((s) => s.kind === 'wheelchair').length, 2);
  assert.ok(seats.every((s) => s.status === 'available'), 'no bookings exist yet, so every seat is available');
  assert.ok(res.rows.every((r) => r.seats.every((s) => s.row === r.row)), 'each seat repeats its row letter');
});

test('the price is a finished GBP string built from the stored pence, and showtime facts are carried over', () => {
  const showtime = showtimeFor('curzon-soho-1', 1550);
  const res = buildShowtimeSeatsResponse(showtime);
  assert.equal(res.priceCents, 1550);
  assert.equal(res.priceFormatted, '£15.50');
  assert.equal(res.priceFormatted, formatPriceCents(1550));
  assert.ok(res.priceFormatted.startsWith('£'));
  assert.equal(res.showtimeId, showtime.id);
  assert.equal(res.movieId, 900001);
  assert.equal(res.startsAt, '2026-11-20T20:30:00.000Z');
  assert.equal(res.time, '20:30');
  assert.deepEqual(res.screen, { id: 'curzon-soho-1', name: 'Screen 1', format: 'Standard', totalSeats: 120 });
});

test('groupSeatsIntoRows orders rows A first and seats by number, whatever order they arrive in', () => {
  const seats: SeatRecord[] = [
    { id: randomUUID(), row: 'B', number: 2, kind: 'standard' },
    { id: randomUUID(), row: 'A', number: 3, kind: 'standard' },
    { id: randomUUID(), row: 'B', number: 1, kind: 'wheelchair' },
    { id: randomUUID(), row: 'A', number: 1, kind: 'standard' },
    { id: randomUUID(), row: 'A', number: 2, kind: 'standard' },
  ];
  const rows = groupSeatsIntoRows(seats, () => 'available');
  assert.deepEqual(
    rows.map((r) => [r.row, r.seats.map((s) => s.number)]),
    [
      ['A', [1, 2, 3]],
      ['B', [1, 2]],
    ],
  );
  assert.equal(rows[1]?.seats[0]?.kind, 'wheelchair');
});

test('groupSeatsIntoRows returns no rows for a screen with no seats yet (e.g. before the seed has run)', () => {
  assert.deepEqual(groupSeatsIntoRows([], () => 'available'), []);
});

test('the status resolver is the seam: whatever it returns is what the response says', () => {
  const showtime = showtimeFor('curzon-soho-2');
  const first = showtime.screen.seats.find((s) => s.row === 'A' && s.number === 1);
  assert.ok(first);
  const res = buildShowtimeSeatsResponse(showtime, (seat) => (seat.id === first.id ? 'sold' : 'available'));
  const seats = res.rows.flatMap((r) => r.seats);
  assert.equal(seats.find((s) => s.id === first.id)?.status, 'sold');
  assert.equal(seats.filter((s) => s.status === 'sold').length, 1);
  assert.doesNotThrow(() => ShowtimeSeatsResponseSchema.parse(res), 'held/sold are valid contract values');
});

test('a seat with an unknown kind is refused rather than drawn as a standard seat', () => {
  const seats: SeatRecord[] = [{ id: randomUUID(), row: 'A', number: 1, kind: 'vip' }];
  assert.throws(() => groupSeatsIntoRows(seats, () => 'available'), /unknown kind "vip"/);
});

test('the schemas are strict: unknown keys and bad values are rejected', () => {
  const good = buildShowtimeSeatsResponse(showtimeFor('curzon-soho-2'));
  assert.throws(() => ShowtimeSeatsResponseSchema.parse({ ...good, extra: true }));
  const badStatus = structuredClone(good);
  (badStatus.rows[0]!.seats[0] as { status: string }).status = 'booked';
  assert.throws(() => ShowtimeSeatsResponseSchema.parse(badStatus));
  assert.throws(() => ShowtimeIdParamsSchema.parse({ id: 'not-a-uuid' }));
  assert.doesNotThrow(() => ShowtimeIdParamsSchema.parse({ id: randomUUID() }));
});
