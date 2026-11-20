import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeOrderRepo, createFakePaymentGateway, type FakeOrderRepo } from './fakes.js';
import { settleCancelledShowtime, type CancelRefundDeps } from './cancelRefund.js';
import { REFUND_REASON_SHOWTIME_CANCELLED } from './processor.js';

const SHOWTIME = '11111111-1111-4111-8111-111111111111';
const A1 = 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const OWNER = '0A11CE00-0000-4000-8000-000000000001';

let refCounter = 0;

function makeOrder(repo: FakeOrderRepo, overrides: Partial<Parameters<FakeOrderRepo['createOrder']>[0]> = {}) {
  refCounter += 1;
  return repo.createOrder({
    reference: `33333333-3333-4333-8333-3333333333${String(refCounter).padStart(2, '0')}`,
    ownerId: OWNER,
    showtimeId: SHOWTIME,
    seatIds: [A1],
    seatTotalCents: 1850,
    feeCents: 150,
    totalCents: 2000,
    currency: 'gbp',
    stripePaymentIntentId: `pi_${refCounter}`,
    idempotencyKey: `key-${refCounter}`,
    ...overrides,
  });
}

function boot() {
  const repo = createFakeOrderRepo();
  const gateway = createFakePaymentGateway();
  const deleted: string[] = [];
  const released: { showtimeId: string; ownerId: string; seatIds: readonly string[] }[] = [];
  const deps: CancelRefundDeps = {
    repo,
    gateway,
    bookings: { deleteBookingsByReference: async (reference) => (deleted.push(reference), 1) },
    holds: { release: async (showtimeId, ownerId, seatIds) => (released.push({ showtimeId, ownerId, seatIds }), [...seatIds]) },
  };
  return { repo, gateway, deleted, released, deps };
}

test('a succeeded order is refunded: Stripe refund, ledger row, status refunded, bookings released', async () => {
  const { repo, gateway, deleted, deps } = boot();
  const order = await makeOrder(repo, { stripePaymentIntentId: 'pi_succeeded' });
  await repo.setStatus(order.id, 'succeeded');

  const result = await settleCancelledShowtime(deps, { showtimeId: SHOWTIME });

  assert.deepEqual(result, { refunded: 1, cancelled: 0, deferred: 0, skipped: 0 });
  assert.equal(gateway.refunds.length, 1);
  assert.equal(gateway.refunds[0]!.paymentIntentId, 'pi_succeeded');
  const refund = repo.ledger.filter((l) => l.kind === 'refund');
  assert.equal(refund.length, 1);
  assert.equal(refund[0]!.reason, REFUND_REASON_SHOWTIME_CANCELLED);
  assert.equal(refund[0]!.amountCents, 2000);
  assert.equal(order.status, 'refunded');
  assert.deepEqual(deleted, [order.reference]);
});

test('a requires_payment order is cancelled, holds released, marked failed — no refund', async () => {
  const { repo, gateway, released, deps } = boot();
  const order = await makeOrder(repo, { stripePaymentIntentId: 'pi_unpaid' });

  const result = await settleCancelledShowtime(deps, { showtimeId: SHOWTIME });

  assert.deepEqual(result, { refunded: 0, cancelled: 1, deferred: 0, skipped: 0 });
  assert.deepEqual(gateway.cancelled, ['pi_unpaid']);
  assert.equal(gateway.refunds.length, 0, 'no charge means no refund');
  assert.deepEqual(repo.ledger, []);
  assert.equal(order.status, 'failed');
  assert.deepEqual(released, [{ showtimeId: SHOWTIME, ownerId: OWNER, seatIds: [A1] }]);
});

test('a requires_payment order whose intent can no longer be cancelled is deferred (left for the webhook processor)', async () => {
  const { repo, gateway, deps } = boot();
  const order = await makeOrder(repo, { stripePaymentIntentId: 'pi_succeeded_late' });
  gateway.cancelFails.add('pi_succeeded_late');

  const result = await settleCancelledShowtime(deps, { showtimeId: SHOWTIME });

  assert.deepEqual(result, { refunded: 0, cancelled: 0, deferred: 1, skipped: 0 });
  assert.equal(order.status, 'requires_payment', 'the money is moving: the webhook processor refunds it');
  assert.equal(gateway.refunds.length, 0);
});

test('refunded and failed orders are skipped', async () => {
  const { repo, gateway, deps } = boot();
  const refunded = await makeOrder(repo, { stripePaymentIntentId: 'pi_refunded' });
  await repo.setStatus(refunded.id, 'refunded');
  const failed = await makeOrder(repo, { stripePaymentIntentId: 'pi_failed' });
  await repo.setStatus(failed.id, 'failed');

  const result = await settleCancelledShowtime(deps, { showtimeId: SHOWTIME });

  assert.deepEqual(result, { refunded: 0, cancelled: 0, deferred: 0, skipped: 2 });
  assert.equal(gateway.refunds.length, 0);
  assert.equal(gateway.cancelled.length, 0);
});

test('re-running the job is a no-op: no second refund, no second booking delete', async () => {
  const { repo, gateway, deleted, deps } = boot();
  const order = await makeOrder(repo, { stripePaymentIntentId: 'pi_rerun' });
  await repo.setStatus(order.id, 'succeeded');

  await settleCancelledShowtime(deps, { showtimeId: SHOWTIME });
  const second = await settleCancelledShowtime(deps, { showtimeId: SHOWTIME });

  assert.deepEqual(second, { refunded: 0, cancelled: 0, deferred: 0, skipped: 1 });
  assert.equal(gateway.refunds.length, 1, 'one Stripe refund');
  assert.equal(repo.ledger.filter((l) => l.kind === 'refund').length, 1, 'one refund ledger row');
  assert.deepEqual(deleted, [order.reference], 'bookings deleted once');
});
