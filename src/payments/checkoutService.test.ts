import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../http/errors.js';
import { createCheckoutService, type CheckoutService } from './checkoutService.js';
import { SERVICE_FEE_CENTS } from './config.js';
import { createFakeOrderRepo, createFakePaymentGateway, type FakePaymentGateway } from './fakes.js';

const SHOWTIME = '11111111-1111-4111-8111-111111111111';
const A1 = 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const A2 = 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const OWNER = '0A11CE00-0000-4000-8000-000000000001';

function boot(priceCents = 1850, gateway?: FakePaymentGateway) {
  const repo = createFakeOrderRepo();
  const gw = gateway ?? createFakePaymentGateway();
  const verifyCalls: string[][] = [];
  const service = createCheckoutService({
    repo,
    gateway: gw,
    bookings: {
      verifyHolds: async (req) => {
        verifyCalls.push([...req.seatIds]);
        return { showtimeId: req.showtimeId, priceCents, seats: req.seatIds.map((id, i) => ({ id, row: 'A', number: i + 1 })) };
      },
    },
  });
  return { service, repo, gateway: gw, verifyCalls };
}

const checkout = (service: CheckoutService, seatIds: string[], idempotencyKey = 'key-1') =>
  service.checkout({ showtimeId: SHOWTIME, ownerId: OWNER, seatIds, idempotencyKey });

test('checkout prices the order server-side (seats + one flat fee) and returns a client_secret', async () => {
  const { service, repo, gateway, verifyCalls } = boot(1850);
  const result = await checkout(service, [A1, A2]);
  assert.equal(result.created, true);
  assert.equal(result.seatTotalCents, 3700);
  assert.equal(result.feeCents, SERVICE_FEE_CENTS);
  assert.equal(result.totalCents, 3850);
  assert.equal(result.totalFormatted, '£38.50');
  assert.equal(result.currency, 'gbp');
  assert.match(result.clientSecret ?? '', /_secret$/);
  assert.equal(gateway.intents.size, 1);
  assert.equal([...gateway.intents.values()][0]!.amountCents, 3850);
  assert.deepEqual(verifyCalls, [[A1, A2]]);
  assert.equal(repo.orders.size, 1);
  const order = [...repo.orders.values()][0]!;
  assert.equal(order.reference, result.reference);
  assert.equal(order.status, 'requires_payment');
  assert.deepEqual(order.seatIds, [A1, A2]);
});

test('an idempotent replay returns the SAME order and PaymentIntent (no second charge)', async () => {
  const { service, gateway, verifyCalls } = boot(1850);
  const first = await checkout(service, [A1]);
  const second = await checkout(service, [A1]);
  assert.equal(second.created, false);
  assert.equal(second.reference, first.reference);
  assert.equal(second.clientSecret, first.clientSecret);
  assert.equal(gateway.intents.size, 1, 'no second PaymentIntent was created');
  assert.equal(verifyCalls.length, 1, 'the hold was verified only the first time');
});

test('an idempotency key reused with DIFFERENT seats is a 409, never a silent wrong answer', async () => {
  const { service } = boot(1850);
  await checkout(service, [A1], 'key-1');
  await assert.rejects(checkout(service, [A2], 'key-1'), (err) => err instanceof ApiError && err.code === 'idempotency_mismatch');
});

test('a caller who no longer holds the seats is refused before any PaymentIntent is made', async () => {
  const gateway = createFakePaymentGateway();
  const strict = createCheckoutService({
    repo: createFakeOrderRepo(),
    gateway,
    bookings: { verifyHolds: async () => Promise.reject(new ApiError('seat_not_held', { seatIds: [A1] })) },
  });
  await assert.rejects(strict.checkout({ showtimeId: SHOWTIME, ownerId: OWNER, seatIds: [A1], idempotencyKey: 'k' }), (err) => err instanceof ApiError && err.code === 'seat_not_held');
  assert.equal(gateway.intents.size, 0);
});

test('Stripe being down is a retryable 503 payment_unavailable, not a 500', async () => {
  const gateway = createFakePaymentGateway();
  gateway.down = true;
  const { service } = boot(1850, gateway);
  await assert.rejects(checkout(service, [A1]), (err) => err instanceof ApiError && err.code === 'payment_unavailable');
});
