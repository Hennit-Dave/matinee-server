import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MovieService } from '../movies/service.js';
import type { OrderStatus } from './orderRepo.js';
import { createFakeOrderRepo, type FakeOrderRepo } from './fakes.js';
import type { TicketData } from './orderRepo.js';
import { TicketsResponseSchema, createTicketsService, orderTickets } from './tickets.js';

const OWNER = '0A11CE00-0000-4000-8000-000000000001';
const NOW = Date.parse('2026-11-25T00:00:00.000Z');

const ticket = (movieId: number, startsAt: string): TicketData => ({
  movieId,
  cinemaName: 'Curzon Soho',
  screenName: 'Screen 1',
  format: 'Standard',
  startsAt: new Date(startsAt),
  seats: [
    { row: 'B', number: 2 },
    { row: 'A', number: 1 },
  ],
});

async function addTicket(
  repo: FakeOrderRepo,
  reference: string,
  t: TicketData,
  status: OrderStatus,
  totalCents = 2000,
): Promise<void> {
  const order = await repo.createOrder({
    reference,
    ownerId: OWNER,
    showtimeId: '11111111-1111-4111-8111-111111111111',
    seatIds: ['aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1'],
    seatTotalCents: 1850,
    feeCents: 150,
    totalCents,
    currency: 'gbp',
    stripePaymentIntentId: `pi_${reference}`,
    idempotencyKey: `key-${reference}`,
  });
  await repo.setStatus(order.id, status);
  repo.ticketByReference.set(reference, t);
}

function recordingMovies(): { movies: Pick<MovieService, 'detail'>; calls: number[] } {
  const calls: number[] = [];
  const movies: Pick<MovieService, 'detail'> = {
    detail: async (id: number) => {
      calls.push(id);
      return { movie: { title: `Film ${id}` } as never, cache: 'hit' };
    },
  };
  return { movies, calls };
}

test('the tickets service assembles items: fields, status, sorted seats, formatted total, UTC time', async () => {
  const repo = createFakeOrderRepo();
  await addTicket(repo, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', ticket(42, '2026-12-01T20:30:00.000Z'), 'succeeded', 2000);

  const service = createTicketsService({ repo, movies: recordingMovies().movies, now: () => NOW });
  const result = await service.list(OWNER);
  TicketsResponseSchema.parse(result);

  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    reference: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    status: 'succeeded',
    movieId: 42,
    movieTitle: 'Film 42',
    cinemaName: 'Curzon Soho',
    screenName: 'Screen 1',
    format: 'Standard',
    startsAt: '2026-12-01T20:30:00.000Z',
    time: '20:30',
    seats: [
      { row: 'A', number: 1 },
      { row: 'B', number: 2 },
    ],
    totalFormatted: '£20.00',
  });
});

test('every ticket-bearing status maps through with its own status', async () => {
  const repo = createFakeOrderRepo();
  await addTicket(repo, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', ticket(1, '2026-12-01T20:30:00.000Z'), 'succeeded');
  await addTicket(repo, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', ticket(2, '2026-12-02T20:30:00.000Z'), 'refunded');
  await addTicket(repo, 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', ticket(3, '2026-12-03T20:30:00.000Z'), 'requires_payment');
  await addTicket(repo, 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1', ticket(4, '2026-12-04T20:30:00.000Z'), 'failed');

  const service = createTicketsService({ repo, movies: recordingMovies().movies, now: () => NOW });
  const result = await service.list(OWNER);

  // failed is excluded (no ticket); the other three are present with their status.
  assert.deepEqual(result.map((t) => [t.reference.slice(0, 1), t.status]), [
    ['a', 'succeeded'],
    ['b', 'refunded'],
    ['c', 'requires_payment'],
  ]);
});

test('movie titles are resolved once per distinct movie, never once per ticket', async () => {
  const repo = createFakeOrderRepo();
  await addTicket(repo, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', ticket(42, '2026-12-01T20:30:00.000Z'), 'succeeded', 2000);
  await addTicket(repo, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', ticket(42, '2026-12-05T20:30:00.000Z'), 'succeeded', 1850);
  await addTicket(repo, 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', ticket(7, '2026-12-10T20:30:00.000Z'), 'refunded', 3000);

  const { movies, calls } = recordingMovies();
  const service = createTicketsService({ repo, movies, now: () => NOW });
  await service.list(OWNER);

  assert.deepEqual([...new Set(calls)].sort((a, b) => a - b), [7, 42], 'two distinct movies -> two TMDB calls, even for three tickets');
});

test('a TMDB failure yields an empty title, never fails the list', async () => {
  const repo = createFakeOrderRepo();
  await addTicket(repo, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', ticket(42, '2026-12-01T20:30:00.000Z'), 'succeeded', 2000);

  const movies: Pick<MovieService, 'detail'> = { detail: async () => { throw new Error('tmdb down'); } };
  const service = createTicketsService({ repo, movies, now: () => NOW });
  const result = await service.list(OWNER);

  assert.equal(result[0]!.movieTitle, '');
  assert.equal(result[0]!.totalFormatted, '£20.00');
});

test('orderTickets puts the soonest upcoming show first and past shows after (most recent past first)', () => {
  const tickets = [
    { reference: 'past-old', startsAt: new Date('2026-11-20T20:30:00.000Z') },
    { reference: 'upcoming-later', startsAt: new Date('2026-12-10T20:30:00.000Z') },
    { reference: 'upcoming-soon', startsAt: new Date('2026-12-02T20:30:00.000Z') },
    { reference: 'past-recent', startsAt: new Date('2026-11-24T20:30:00.000Z') },
  ];
  const ordered = orderTickets(tickets, NOW);
  assert.deepEqual(ordered.map((t) => t.reference), ['upcoming-soon', 'upcoming-later', 'past-recent', 'past-old']);
});
