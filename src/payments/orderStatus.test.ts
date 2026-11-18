import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MovieService } from '../movies/service.js';
import { createFakeOrderRepo, type FakeOrderRepo } from './fakes.js';
import { createOrderStatusService } from './orderStatus.js';

const REF = '33333333-3333-4333-8333-333333333333';
const OWNER = '0A11CE00-0000-4000-8000-000000000001';

async function makeOrder(repo: FakeOrderRepo, status: Parameters<FakeOrderRepo['setStatus']>[1] = 'requires_payment') {
  const order = await repo.createOrder({
    reference: REF,
    ownerId: OWNER,
    showtimeId: '11111111-1111-4111-8111-111111111111',
    seatIds: ['aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1'],
    seatTotalCents: 1850,
    feeCents: 150,
    totalCents: 2000,
    currency: 'gbp',
    stripePaymentIntentId: 'pi_test_1',
    idempotencyKey: 'key-1',
  });
  await repo.setStatus(order.id, status);
  return order;
}

const movies = (title: string | null): Pick<MovieService, 'detail'> => ({
  detail: async () => {
    if (title === null) throw new Error('tmdb down');
    return { movie: { title } as never, cache: 'hit' };
  },
});

test('an unknown reference, or one owned by someone else, is a 404 (no leak)', async () => {
  const repo = createFakeOrderRepo();
  await makeOrder(repo);
  const service = createOrderStatusService({ repo, movies: movies('Dune') });
  assert.equal(await service.status('99999999-9999-4999-8999-999999999999', OWNER), null);
  assert.equal(await service.status(REF, 'someone-else'), null);
});

test('a payment still in flight is requires_payment, nothing more', async () => {
  const repo = createFakeOrderRepo();
  await makeOrder(repo, 'requires_payment');
  const service = createOrderStatusService({ repo, movies: movies('Dune') });
  assert.deepEqual(await service.status(REF, OWNER), { reference: REF, status: 'requires_payment' });
});

test('a succeeded order returns the ticket with the title, the seats and the server-formatted total', async () => {
  const repo = createFakeOrderRepo();
  await makeOrder(repo, 'succeeded');
  repo.ticketByReference.set(REF, {
    movieId: 42,
    cinemaName: 'BFI Southbank',
    screenName: 'IMAX',
    format: 'IMAX',
    startsAt: new Date('2026-12-01T20:30:00.000Z'),
    seats: [
      { row: 'B', number: 2 },
      { row: 'A', number: 1 },
    ],
  });
  const service = createOrderStatusService({ repo, movies: movies('Dune') });
  const result = await service.status(REF, OWNER);
  assert.deepEqual(result, {
    reference: REF,
    status: 'succeeded',
    ticket: {
      movieId: 42,
      movieTitle: 'Dune',
      cinemaName: 'BFI Southbank',
      screenName: 'IMAX',
      format: 'IMAX',
      startsAt: '2026-12-01T20:30:00.000Z',
      time: '20:30',
      seats: [
        { row: 'A', number: 1 },
        { row: 'B', number: 2 },
      ],
      totalFormatted: '£20.00',
    },
  });
});

test('the title is best-effort: TMDB down still returns the ticket, with an empty title', async () => {
  const repo = createFakeOrderRepo();
  await makeOrder(repo, 'succeeded');
  repo.ticketByReference.set(REF, { movieId: 42, cinemaName: 'BFI', screenName: 'IMAX', format: 'IMAX', startsAt: new Date('2026-12-01T20:30:00.000Z'), seats: [{ row: 'A', number: 1 }] });
  const service = createOrderStatusService({ repo, movies: movies(null) });
  const result = await service.status(REF, OWNER);
  assert.equal(result!.status, 'succeeded');
  assert.equal(result!.ticket!.movieTitle, '');
  assert.equal(result!.ticket!.totalFormatted, '£20.00');
});

test('a refunded order returns its refund reason for the app\'s copy', async () => {
  const repo = createFakeOrderRepo();
  const order = await makeOrder(repo, 'refunded');
  await repo.appendLedger({ orderId: order.id, kind: 'charge', amountCents: 2000, stripeObjectId: 'pi_test_1', stripeEventId: 'evt_1', reason: 'payment_succeeded' });
  await repo.appendLedger({ orderId: order.id, kind: 'refund', amountCents: 2000, stripeObjectId: 're_1', stripeEventId: 'evt_1', reason: 'hold_expired_refund' });
  const service = createOrderStatusService({ repo, movies: movies('Dune') });
  assert.deepEqual(await service.status(REF, OWNER), { reference: REF, status: 'refunded', refundReason: 'hold_expired_refund' });
});

test('a failed order is a terminal state, reported as such', async () => {
  const repo = createFakeOrderRepo();
  await makeOrder(repo, 'failed');
  const service = createOrderStatusService({ repo, movies: movies('Dune') });
  assert.deepEqual(await service.status(REF, OWNER), { reference: REF, status: 'failed' });
});
