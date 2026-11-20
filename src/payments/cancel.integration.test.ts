import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshShowtime, openStack, ownerId, skip, type Stack } from '../bookings/testkit.js';
import { settleCancelledShowtime } from './cancelRefund.js';
import { createCheckoutService } from './checkoutService.js';
import { createStripeEventRepo } from './eventRepo.js';
import { createFakePaymentGateway } from './fakes.js';
import { createOrderRepo } from './orderRepo.js';
import { handlePaymentSucceeded } from './processor.js';
import { createWebhookService, WEBHOOK_EVENT_PAYMENT_SUCCEEDED } from './webhookService.js';
import { createShowtimeCancelRepo } from '../showtimes/cancelRepo.js';
import { createCancelShowtimeService } from '../showtimes/cancelService.js';

/**
 * The cancelled-showtime refund end to end over the REAL Postgres and Redis (a throwaway one), with only Stripe
 * faked: two confirmed bookings on one showing -> cancel -> the job refunds both in the ledger and releases the
 * seats; a re-cancel is a no-op; a new checkout on the cancelled showing is refused.
 */

function wire(stack: Stack) {
  const gateway = createFakePaymentGateway();
  const orderRepo = createOrderRepo(stack.db);
  const eventRepo = createStripeEventRepo(stack.db);
  const showtimeRepo = createShowtimeCancelRepo(stack.db);
  const enqueued: { name: string; data: Record<string, string>; jobId: string }[] = [];
  const checkout = createCheckoutService({ repo: orderRepo, gateway, bookings: stack.bookings });
  const webhook = createWebhookService({ gateway, events: eventRepo, enqueue: async (name, data, jobId) => { enqueued.push({ name, data, jobId }); } });
  const process = (eventId: string, paymentIntentId: string) =>
    handlePaymentSucceeded({ repo: orderRepo, gateway, bookings: stack.bookings, events: eventRepo, showtime: showtimeRepo }, { eventId, paymentIntentId });
  const cancel = createCancelShowtimeService({ repo: showtimeRepo, enqueue: async (name, data, jobId) => { enqueued.push({ name, data, jobId }); } });
  const settle = (showtimeId: string) => settleCancelledShowtime({ repo: orderRepo, gateway, bookings: stack.repo, holds: stack.holds }, { showtimeId });
  return { gateway, orderRepo, eventRepo, showtimeRepo, checkout, webhook, process, cancel, settle, enqueued };
}

async function bookAndConfirm(p: ReturnType<typeof wire>, stack: Stack, showtimeId: string, owner: string, seatIds: string[], key: string) {
  await stack.bookings.acquireHolds({ showtimeId, ownerId: owner, seatIds });
  await p.checkout.checkout({ showtimeId, ownerId: owner, seatIds, idempotencyKey: key });
  const order = (await p.orderRepo.findByOwnerIdempotencyKey(owner, key))!;
  p.gateway.nextEvent = { id: `evt_${key}`, type: WEBHOOK_EVENT_PAYMENT_SUCCEEDED, paymentIntentId: order.stripePaymentIntentId };
  await p.webhook.handle({ rawBody: Buffer.from('{}'), signatureHeader: 't=1,v1=x' });
  await p.process(`evt_${key}`, order.stripePaymentIntentId);
  return order;
}

test('cancel a showtime with two confirmed bookings: both refunded, seats released; re-cancel is a no-op; new checkout refused', { skip }, async () => {
  const stack = await openStack();
  let showtimeId = '';
  try {
    const fresh = await freshShowtime(stack.db, 4, stack.redis);
    showtimeId = fresh.showtimeId;
    const seatIds = fresh.seatIds;
    const p = wire(stack);

    const alice = ownerId();
    const bob = ownerId();
    const aliceOrder = await bookAndConfirm(p, stack, showtimeId, alice, seatIds.slice(0, 2), 'alice-1');
    const bobOrder = await bookAndConfirm(p, stack, showtimeId, bob, seatIds.slice(2), 'bob-1');

    assert.equal(await stack.db.primary.booking.count({ where: { showtimeId } }), 4, 'two bookings, two seats each');
    assert.equal((await p.orderRepo.findByReference(aliceOrder.reference))!.status, 'succeeded');
    assert.equal((await p.orderRepo.findByReference(bobOrder.reference))!.status, 'succeeded');

    // Cancel: mark the showing and run the job (as the worker would, using the enqueued payload).
    const cancelled = await p.cancel.cancel(showtimeId, 'req-cancel');
    assert.deepEqual(cancelled, { showtimeId, cancelled: true, alreadyCancelled: false });
    await p.settle(showtimeId);

    // Every succeeded order is refunded, with a charge + a showtime_cancelled_refund row, and the seats are gone.
    for (const order of [aliceOrder, bobOrder]) {
      assert.equal((await p.orderRepo.findByReference(order.reference))!.status, 'refunded');
      const ledger = await p.orderRepo.ledgerFor(order.id);
      assert.deepEqual(ledger.map((l) => l.kind), ['charge', 'refund']);
      assert.equal(ledger[1]!.reason, 'showtime_cancelled_refund');
    }
    assert.equal(await stack.db.primary.booking.count({ where: { showtimeId } }), 0, 'every seat was released');
    assert.equal(p.gateway.refunds.length, 2);

    // Re-cancel: alreadyCancelled, and the settle is a no-op (no new Stripe refunds, no new refund rows).
    assert.deepEqual(await p.cancel.cancel(showtimeId, 'req-cancel-again'), { showtimeId, cancelled: true, alreadyCancelled: true });
    await p.settle(showtimeId);
    assert.equal(p.gateway.refunds.length, 2);
    assert.equal((await p.orderRepo.ledgerFor(aliceOrder.id)).filter((l) => l.kind === 'refund').length, 1);
    assert.equal((await p.orderRepo.ledgerFor(bobOrder.id)).filter((l) => l.kind === 'refund').length, 1);

    // A new checkout on the cancelled showing is refused before any PaymentIntent is created.
    await assert.rejects(
      p.checkout.checkout({ showtimeId, ownerId: ownerId(), seatIds: seatIds.slice(0, 1), idempotencyKey: 'after-cancel' }),
      (e: unknown) => (e as { code?: string }).code === 'showtime_cancelled',
    );
  } finally {
    // The testkit clears bookings and hold keys but not orders/ledger or the cancellation flag: reset those so a
    // rerun (or another test file reusing this seeded showtime) starts clean.
    const orderIds = (await stack.db.primary.order.findMany({ where: { showtimeId }, select: { id: true } })).map((o) => o.id);
    if (orderIds.length > 0) await stack.db.primary.ledgerEntry.deleteMany({ where: { orderId: { in: orderIds } } });
    await stack.db.primary.order.deleteMany({ where: { showtimeId } });
    await stack.db.primary.showtime.updateMany({ where: { id: showtimeId }, data: { cancelledAt: null } });
    await stack.close();
  }
});
