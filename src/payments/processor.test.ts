import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BookingResponse } from '../bookings/booking.js';
import { ApiError } from '../http/errors.js';
import { createFakeOrderRepo, createFakePaymentGateway, createFakeStripeEventRepo, type FakeOrderRepo } from './fakes.js';
import { handlePaymentSucceeded, REFUND_REASON_NOT_HELD, REFUND_REASON_SEAT_TAKEN, REFUND_REASON_SHOWTIME_CANCELLED, type PaymentProcessorDeps } from './processor.js';

const SHOWTIME = '11111111-1111-4111-8111-111111111111';
const A1 = 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const OWNER = '0A11CE00-0000-4000-8000-000000000001';
const PI = 'pi_test_1';
const EVENT = 'evt_1';

function makeOrder(repo: FakeOrderRepo, overrides: Partial<Parameters<FakeOrderRepo['createOrder']>[0]> = {}) {
  const order = {
    reference: '33333333-3333-4333-8333-333333333333',
    ownerId: OWNER,
    showtimeId: SHOWTIME,
    seatIds: [A1],
    seatTotalCents: 1850,
    feeCents: 150,
    totalCents: 2000,
    currency: 'gbp',
    stripePaymentIntentId: PI,
    idempotencyKey: 'key-1',
    ...overrides,
  };
  return repo.createOrder(order);
}

function boot(confirm: () => Promise<BookingResponse>, cancelled = false) {
  const repo = createFakeOrderRepo();
  const gateway = createFakePaymentGateway();
  const events = createFakeStripeEventRepo();
  // The webhook records the event id before it enqueues, so by the time the processor runs it is always there.
  void events.recordEvent({ eventId: EVENT, type: 'payment_intent.succeeded', paymentIntentId: PI });
  const deps: PaymentProcessorDeps = {
    repo,
    gateway,
    bookings: { confirmBooking: async () => confirm() },
    events,
    showtime: { isCancelled: async () => cancelled },
  };
  return { repo, gateway, events, deps };
}

test('a succeeded payment confirms the booking, records the charge, and marks the event processed', async () => {
  const { repo, events, deps } = boot(async () => ({ reference: 'r', showtimeId: SHOWTIME, seats: [], priceCents: 1850, totalCents: 2000, totalFormatted: '£20.00' }));
  const order = await makeOrder(repo);
  await handlePaymentSucceeded(deps, { eventId: EVENT, paymentIntentId: PI });
  assert.equal(order.status, 'succeeded');
  assert.deepEqual(repo.ledger.map((l) => l.kind), ['charge']);
  assert.equal(repo.ledger[0]!.amountCents, 2000);
  assert.equal(events.events.get(EVENT)?.status, 'processed');
});

test('seat_taken after payment is refunded (never double-book, never keep the money)', async () => {
  const { repo, gateway, deps } = boot(async () => {
    throw new ApiError('seat_taken', { seatIds: [A1] });
  });
  const order = await makeOrder(repo);
  await handlePaymentSucceeded(deps, { eventId: EVENT, paymentIntentId: PI });
  assert.equal(order.status, 'refunded');
  assert.deepEqual(repo.ledger.map((l) => l.kind), ['charge', 'refund']);
  assert.equal(repo.ledger[1]!.reason, REFUND_REASON_SEAT_TAKEN);
  assert.equal(repo.ledger[1]!.amountCents, 2000);
  assert.equal(gateway.refunds.length, 1);
});

test('seat_not_held after payment is also refunded, with its own ledger reason', async () => {
  const { repo, deps } = boot(async () => {
    throw new ApiError('seat_not_held', { seatIds: [A1] });
  });
  const order = await makeOrder(repo);
  await handlePaymentSucceeded(deps, { eventId: EVENT, paymentIntentId: PI });
  assert.equal(order.status, 'refunded');
  assert.deepEqual(repo.ledger.map((l) => l.kind), ['charge', 'refund']);
  assert.equal(repo.ledger[1]!.reason, REFUND_REASON_NOT_HELD);
});

test('a retry after success is a no-op: no second charge, no second booking, no spurious refund', async () => {
  let confirms = 0;
  const { repo, deps } = boot(async () => {
    confirms += 1;
    return { reference: 'r', showtimeId: SHOWTIME, seats: [], priceCents: 1850, totalCents: 2000, totalFormatted: '£20.00' };
  });
  const order = await makeOrder(repo);
  await handlePaymentSucceeded(deps, { eventId: EVENT, paymentIntentId: PI });
  await handlePaymentSucceeded(deps, { eventId: EVENT, paymentIntentId: PI }); // BullMQ re-delivered the same job
  assert.equal(confirms, 1, 'confirm ran once');
  assert.equal(repo.ledger.filter((l) => l.kind === 'charge').length, 1, 'the charge was recorded once');
  assert.equal(order.status, 'succeeded');
});

test('a payment for an unknown PaymentIntent is acked and marked processed, not retried', async () => {
  let confirms = 0;
  const { repo, events, deps } = boot(async () => {
    confirms += 1;
    return { reference: 'r', showtimeId: SHOWTIME, seats: [], priceCents: 1850, totalCents: 2000, totalFormatted: '£20.00' };
  });
  await handlePaymentSucceeded(deps, { eventId: EVENT, paymentIntentId: 'pi_unknown' });
  assert.equal(confirms, 0);
  assert.equal(repo.ledger.length, 0);
  assert.equal(events.events.get(EVENT)?.status, 'processed');
});

test('a transient error is re-thrown so BullMQ retries', async () => {
  const { repo, deps } = boot(async () => {
    throw new Error('database busy');
  });
  await makeOrder(repo);
  await assert.rejects(handlePaymentSucceeded(deps, { eventId: EVENT, paymentIntentId: PI }), /database busy/);
  // The charge was recorded first (the money moved), so a retry will replay from there.
  assert.deepEqual(repo.ledger.map((l) => l.kind), ['charge']);
});

test('a succeeded payment on a cancelled showtime is refunded with the cancellation reason, never booked', async () => {
  let confirms = 0;
  const { repo, gateway, deps } = boot(async () => {
    confirms += 1;
    return { reference: 'r', showtimeId: SHOWTIME, seats: [], priceCents: 1850, totalCents: 2000, totalFormatted: '£20.00' };
  }, /* cancelled */ true);
  const order = await makeOrder(repo);
  await handlePaymentSucceeded(deps, { eventId: EVENT, paymentIntentId: PI });
  assert.equal(confirms, 0, 'no booking is confirmed on a cancelled showing');
  assert.equal(order.status, 'refunded');
  assert.deepEqual(repo.ledger.map((l) => l.kind), ['charge', 'refund']);
  assert.equal(repo.ledger[1]!.reason, REFUND_REASON_SHOWTIME_CANCELLED);
  assert.equal(gateway.refunds.length, 1);
});

test('confirmBooking throwing showtime_cancelled (the TOCTOU window) is still refunded in one pass', async () => {
  const { repo, gateway, deps } = boot(async () => {
    throw new ApiError('showtime_cancelled');
  }); // the pre-check read false; the cancel landed before confirmBooking's own check threw
  const order = await makeOrder(repo);
  await handlePaymentSucceeded(deps, { eventId: EVENT, paymentIntentId: PI });
  assert.equal(order.status, 'refunded');
  assert.deepEqual(repo.ledger.map((l) => l.kind), ['charge', 'refund']);
  assert.equal(repo.ledger[1]!.reason, REFUND_REASON_SHOWTIME_CANCELLED);
  assert.equal(gateway.refunds.length, 1);
});
