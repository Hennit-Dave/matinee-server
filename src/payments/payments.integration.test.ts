import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshShowtime, openStack, ownerId, skip, type Stack } from '../bookings/testkit.js';
import { createCheckoutService } from './checkoutService.js';
import { createStripeEventRepo } from './eventRepo.js';
import { createFakePaymentGateway } from './fakes.js';
import { createOrderRepo } from './orderRepo.js';
import { createOrderStatusService } from './orderStatus.js';
import { handlePaymentSucceeded } from './processor.js';
import { createWebhookService, WEBHOOK_EVENT_PAYMENT_SUCCEEDED } from './webhookService.js';
import { createShowtimeCancelRepo } from '../showtimes/cancelRepo.js';

/**
 * The payment engine end to end over the REAL Postgres and Redis (a throwaway one; the testkit refuses any
 * non-local Redis), with only Stripe faked: hold -> checkout -> webhook -> worker -> booking + ledger, and the
 * refund when the hold has lapsed. The BullMQ Worker shell over `handlePaymentSucceeded` is trivial; the queue
 * wiring is exercised by the worker's own smoke in the deploy slice.
 */

function wire(db: Stack['db'], bookings: Stack['bookings']) {
  const gateway = createFakePaymentGateway();
  const orderRepo = createOrderRepo(db);
  const eventRepo = createStripeEventRepo(db);
  const enqueued: { name: string; data: Record<string, string>; jobId: string }[] = [];
  const checkout = createCheckoutService({ repo: orderRepo, gateway, bookings });
  const webhook = createWebhookService({ gateway, events: eventRepo, enqueue: async (name, data, jobId) => { enqueued.push({ name, data, jobId }); } });
  const process = (eventId: string, paymentIntentId: string) => handlePaymentSucceeded({ repo: orderRepo, gateway, bookings, events: eventRepo, showtime: createShowtimeCancelRepo(db) }, { eventId, paymentIntentId });
  const orderStatus = createOrderStatusService({ repo: orderRepo, movies: { detail: async () => ({ movie: { title: 'Dune' } as never, cache: 'hit' }) } });
  return { gateway, orderRepo, eventRepo, enqueued, checkout, webhook, process, orderStatus };
}

test('hold -> checkout -> webhook -> worker: the booking is confirmed and the charge is in the ledger', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 2, stack.redis);
    const alice = ownerId();
    await stack.bookings.acquireHolds({ showtimeId, ownerId: alice, seatIds });

    const p = wire(stack.db, stack.bookings);
    const result = await p.checkout.checkout({ showtimeId, ownerId: alice, seatIds, idempotencyKey: 'key-1' });
    assert.equal(result.created, true);

    const order = await p.orderRepo.findByOwnerIdempotencyKey(alice, 'key-1');
    assert.ok(order);
    assert.equal(order.totalCents, order.seatTotalCents + order.feeCents);

    // Stripe delivers payment_intent.succeeded for the PaymentIntent we just created.
    p.gateway.nextEvent = { id: 'evt_1', type: WEBHOOK_EVENT_PAYMENT_SUCCEEDED, paymentIntentId: order.stripePaymentIntentId };
    await p.webhook.handle({ rawBody: Buffer.from('{}'), signatureHeader: 't=1,v1=x' });
    assert.deepEqual(p.enqueued, [{ name: 'payment.succeeded', data: { eventId: 'evt_1', paymentIntentId: order.stripePaymentIntentId }, jobId: 'evt_1' }]);

    await p.process('evt_1', order.stripePaymentIntentId);

    assert.equal(await stack.db.primary.booking.count({ where: { reference: order.reference } }), seatIds.length);
    assert.equal((await p.orderRepo.findByPaymentIntentId(order.stripePaymentIntentId))!.status, 'succeeded');
    const ledger = await p.orderRepo.ledgerFor(order.id);
    assert.deepEqual(ledger.map((l) => l.kind), ['charge']);
    assert.equal(ledger[0]!.amountCents, order.totalCents);
  } finally {
    await stack.close();
  }
});

test('paid but the hold lapsed: the order is refunded, no booking, the ledger shows charge then refund', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 1, stack.redis);
    const alice = ownerId();
    await stack.bookings.acquireHolds({ showtimeId, ownerId: alice, seatIds });

    const p = wire(stack.db, stack.bookings);
    const result = await p.checkout.checkout({ showtimeId, ownerId: alice, seatIds, idempotencyKey: 'key-2' });
    assert.equal(result.created, true);
    const order = (await p.orderRepo.findByOwnerIdempotencyKey(alice, 'key-2'))!;

    // The hold lapses before the payment lands (the J5 scenario): the caller no longer holds the seat.
    await stack.bookings.releaseHolds({ showtimeId, ownerId: alice, seatIds });

    p.gateway.nextEvent = { id: 'evt_2', type: WEBHOOK_EVENT_PAYMENT_SUCCEEDED, paymentIntentId: order.stripePaymentIntentId };
    await p.webhook.handle({ rawBody: Buffer.from('{}'), signatureHeader: 't=1,v1=x' });
    await p.process('evt_2', order.stripePaymentIntentId);

    assert.equal(await stack.db.primary.booking.count({ where: { reference: order.reference } }), 0, 'no booking: never double-book');
    assert.equal((await p.orderRepo.findByPaymentIntentId(order.stripePaymentIntentId))!.status, 'refunded');
    const ledger = await p.orderRepo.ledgerFor(order.id);
    assert.deepEqual(ledger.map((l) => l.kind), ['charge', 'refund']);
    assert.equal(ledger[1]!.reason, 'hold_lapsed_refund');
    assert.equal(p.gateway.refunds.length, 1);
  } finally {
    await stack.close();
  }
});

test('a re-delivered webhook enqueues the job once (event-id dedup, not the checkout key)', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 1, stack.redis);
    const alice = ownerId();
    await stack.bookings.acquireHolds({ showtimeId, ownerId: alice, seatIds });

    const p = wire(stack.db, stack.bookings);
    await p.checkout.checkout({ showtimeId, ownerId: alice, seatIds, idempotencyKey: 'key-3' });
    const order = (await p.orderRepo.findByOwnerIdempotencyKey(alice, 'key-3'))!;

    p.gateway.nextEvent = { id: 'evt_3', type: WEBHOOK_EVENT_PAYMENT_SUCCEEDED, paymentIntentId: order.stripePaymentIntentId };
    await p.webhook.handle({ rawBody: Buffer.from('{}'), signatureHeader: 't=1,v1=x' });
    await p.webhook.handle({ rawBody: Buffer.from('{}'), signatureHeader: 't=1,v1=x' });

    assert.equal(p.enqueued.length, 1, 'the same Stripe event is enqueued exactly once');
  } finally {
    await stack.close();
  }
});

test('the confirmation poll: after the worker confirms, GET /orders/:reference is succeeded with the ticket, scoped to the owner', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 2, stack.redis);
    const alice = ownerId();
    await stack.bookings.acquireHolds({ showtimeId, ownerId: alice, seatIds });

    const p = wire(stack.db, stack.bookings);
    await p.checkout.checkout({ showtimeId, ownerId: alice, seatIds, idempotencyKey: 'key-4' });
    const order = (await p.orderRepo.findByOwnerIdempotencyKey(alice, 'key-4'))!;

    // Before the webhook lands: still requires_payment.
    assert.deepEqual(await p.orderStatus.status(order.reference, alice), { reference: order.reference, status: 'requires_payment' });

    p.gateway.nextEvent = { id: 'evt_4', type: WEBHOOK_EVENT_PAYMENT_SUCCEEDED, paymentIntentId: order.stripePaymentIntentId };
    await p.webhook.handle({ rawBody: Buffer.from('{}'), signatureHeader: 't=1,v1=x' });
    await p.process('evt_4', order.stripePaymentIntentId);

    const status = await p.orderStatus.status(order.reference, alice);
    assert.equal(status!.status, 'succeeded');
    assert.equal(status!.ticket!.movieTitle, 'Dune');
    assert.equal(status!.ticket!.totalFormatted, '£38.50'); // 2 x 1850 + 150
    assert.equal(status!.ticket!.seats.length, 2);

    // A different caller cannot read someone else's order.
    assert.equal(await p.orderStatus.status(order.reference, ownerId()), null);
  } finally {
    await stack.close();
  }
});

test('the confirmation poll on the refund path: refunded with the reason', { skip }, async () => {
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 1, stack.redis);
    const alice = ownerId();
    await stack.bookings.acquireHolds({ showtimeId, ownerId: alice, seatIds });

    const p = wire(stack.db, stack.bookings);
    await p.checkout.checkout({ showtimeId, ownerId: alice, seatIds, idempotencyKey: 'key-5' });
    const order = (await p.orderRepo.findByOwnerIdempotencyKey(alice, 'key-5'))!;
    await stack.bookings.releaseHolds({ showtimeId, ownerId: alice, seatIds }); // the hold lapses

    p.gateway.nextEvent = { id: 'evt_5', type: WEBHOOK_EVENT_PAYMENT_SUCCEEDED, paymentIntentId: order.stripePaymentIntentId };
    await p.webhook.handle({ rawBody: Buffer.from('{}'), signatureHeader: 't=1,v1=x' });
    await p.process('evt_5', order.stripePaymentIntentId);

    assert.deepEqual(await p.orderStatus.status(order.reference, alice), {
      reference: order.reference,
      status: 'refunded',
      refundReason: 'hold_lapsed_refund',
    });
  } finally {
    await stack.close();
  }
});
