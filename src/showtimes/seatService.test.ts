import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DbClients } from '../db/clients.js';
import { createFakeHoldStore, createFakeRepo, createFakeRyowStore } from '../bookings/fakes.js';
import { ApiError } from '../http/errors.js';
import { ShowtimeSeatsResponseSchema } from './seat.js';
import { createSeatService } from './seatService.js';

const SHOWTIME = '11111111-1111-4111-8111-111111111111';
const [S1, S2, S3] = ['aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3'];
const ALICE = '0a11ce00-0000-4000-8000-000000000001';
const BOB = '0b0b0000-0000-4000-8000-000000000002';

const seats = [
  { id: S1, row: 'A', number: 1 },
  { id: S2, row: 'A', number: 2 },
  { id: S3, row: 'A', number: 3 },
];

function setup(layoutSeats = seats) {
  const showtime = {
    id: SHOWTIME,
    movieId: 7,
    startsAt: new Date('2026-11-20T20:30:00.000Z'),
    priceCents: 1850,
    screen: { id: 'screen-1', name: 'Screen 1', format: 'Standard', totalSeats: 3, seats: layoutSeats.map((s) => ({ ...s, kind: 'standard' })) },
  };
  // The layout comes from the replica client; everything else goes through the repo fake.
  const db = { reader: { $replica: () => ({ showtime: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === SHOWTIME ? showtime : null) } }) } } as unknown as DbClients;
  const repo = createFakeRepo({ showtimes: { [SHOWTIME]: { screenId: 'screen-1', priceCents: 1850 } }, screens: { 'screen-1': seats } });
  const holds = createFakeHoldStore();
  const ryow = createFakeRyowStore();
  return { repo, holds, ryow, service: createSeatService(db, { repo, holds, ryow }) };
}

const statusOf = (body: { rows: { seats: { id: string; status: string }[] }[] } | null) =>
  Object.fromEntries((body?.rows ?? []).flatMap((r) => r.seats).map((s) => [s.id, s.status]));

test('the seat map shows sold from bookings, held from Redis, and sold wins when a seat is both', async () => {
  const { service, repo, holds } = setup();
  repo.bookings.push({ reference: 'r', showtimeId: SHOWTIME, seatId: S1, ownerId: ALICE, priceCents: 1850 });
  await holds.acquire(SHOWTIME, ALICE, [S1, S2]); // S1 was booked and its hold has not expired yet

  const body = await service.forShowtime(SHOWTIME);
  ShowtimeSeatsResponseSchema.parse(body);
  assert.deepEqual(statusOf(body), { [S1]: 'sold', [S2]: 'held', [S3]: 'available' });
});

test('an unknown showtime is null (a 404 upstream) and touches neither Redis nor the bookings', async () => {
  const { service, holds, repo } = setup();
  assert.equal(await service.forShowtime('00000000-0000-4000-8000-00000000dead'), null);
  assert.deepEqual(holds.calls, []);
  assert.deepEqual(repo.reads, []);
});

test('read-your-own-writes: bookings are read from the replica, but from the primary for a user inside the window', async () => {
  const { service, repo, ryow } = setup();

  await service.forShowtime(SHOWTIME); // anonymous
  await service.forShowtime(SHOWTIME, BOB); // has a client id but has not booked
  ryow.active.add(ALICE);
  await service.forShowtime(SHOWTIME, ALICE); // booked a moment ago

  const sources = repo.reads.filter((r) => r.method === 'soldSeatIdsForShowtime').map((r) => r.source);
  assert.deepEqual(sources, ['replica', 'replica', 'primary']);
  assert.ok(!ryow.calls.some((c) => c === 'isActive:undefined'), 'an anonymous read never asks Redis about a user');
});

test('Redis down: the map is not served (503), because held seats cannot be verified', async () => {
  const { service, holds } = setup();
  holds.down = true;
  const error = await service.forShowtime(SHOWTIME).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, 'service_unavailable');

  holds.down = false;
  const { service: s2, ryow } = setup();
  ryow.down = true;
  const ryowError = await s2.forShowtime(SHOWTIME, ALICE).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(ryowError instanceof ApiError && ryowError.code === 'service_unavailable');
});

test('a screen with no seats yet is an honest empty map and never sends an empty key list to Redis', async () => {
  const { service, holds } = setup([]);
  const body = await service.forShowtime(SHOWTIME);
  assert.deepEqual(body?.rows, []);
  assert.deepEqual(holds.calls, ['heldAmong'], 'asked once, with no seats (the real store answers an empty set without a call)');
});
