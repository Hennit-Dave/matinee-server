import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DbClients } from '../db/clients.js';
import { SeatAlreadyBookedError, createBookingRepo, isUniqueViolation } from './bookingRepo.js';
import { BookingResponseSchema, HoldResponseSchema, MAX_SEATS_PER_REQUEST, SeatIdsBodySchema } from './booking.js';

test('a unique violation is recognised however the driver wraps it, and nothing else is', () => {
  assert.equal(isUniqueViolation({ code: 'P2002' }), true);
  assert.equal(isUniqueViolation({ code: '23505' }), true);
  assert.equal(isUniqueViolation({ code: 'P2025', cause: { code: '23505' } }), true);
  assert.equal(isUniqueViolation({ meta: { driverAdapterError: { cause: { code: '23505' } } } }), true);
  for (const other of [{ code: 'P2003' }, { code: '40001' }, new Error('boom'), null, undefined, 'P2002']) {
    assert.equal(isUniqueViolation(other), false);
  }
  const loop: { cause?: unknown } = {};
  loop.cause = loop;
  assert.equal(isUniqueViolation(loop), false, 'a self-referencing error cannot hang it');
});

function repoWhoseInsertFails(error: unknown) {
  const db = { primary: { booking: { createMany: async () => { throw error; } } } } as unknown as DbClients;
  return createBookingRepo(db);
}
const row = { reference: 'r', showtimeId: 's', seatId: 'x', ownerId: 'o', priceCents: 100 };

test('createBookings turns the database refusing a duplicate into SeatAlreadyBookedError, and lets other failures through untouched', async () => {
  await assert.rejects(repoWhoseInsertFails({ code: 'P2002' }).createBookings([row]), SeatAlreadyBookedError);
  const other = new Error('connection reset');
  await assert.rejects(repoWhoseInsertFails(other).createBookings([row]), (err) => err === other);
});

test('the request schema: 1 to 8 unique seat ids, nothing else', () => {
  const id = (n: number) => `aaaaaaa${n}-aaaa-4aaa-8aaa-aaaaaaaaaaa${n}`;
  assert.equal(MAX_SEATS_PER_REQUEST, 8);
  assert.ok(SeatIdsBodySchema.safeParse({ seatIds: [id(1)] }).success);
  assert.ok(SeatIdsBodySchema.safeParse({ seatIds: [1, 2, 3, 4, 5, 6, 7, 8].map(id) }).success);
  assert.ok(!SeatIdsBodySchema.safeParse({ seatIds: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(id) }).success);
  assert.ok(!SeatIdsBodySchema.safeParse({ seatIds: [] }).success);
  assert.ok(!SeatIdsBodySchema.safeParse({ seatIds: [id(1), id(1)] }).success);
  assert.ok(!SeatIdsBodySchema.safeParse({ seatIds: [id(1)], extra: true }).success);
});

test('the response schemas are strict, so a contract drift fails a test rather than the app', () => {
  assert.ok(!HoldResponseSchema.safeParse({ showtimeId: 'x' }).success);
  assert.ok(
    !BookingResponseSchema.safeParse({
      reference: '33333333-3333-4333-8333-333333333333',
      showtimeId: '11111111-1111-4111-8111-111111111111',
      seats: [],
      priceCents: 1,
      totalCents: 1,
      totalFormatted: '£0.01',
      surprise: true,
    }).success,
  );
});
