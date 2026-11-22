import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshShowtime, openStack, ownerId, skip, type Stack } from '../bookings/testkit.js';
import type { MovieService } from '../movies/service.js';
import type { OrderStatus } from './orderRepo.js';
import { createOrderRepo } from './orderRepo.js';
import { TicketsResponseSchema, createTicketsService } from './tickets.js';

const movies: Pick<MovieService, 'detail'> = {
  detail: async (id: number) => ({ movie: { title: `Film ${id}` } as never, cache: 'hit' }),
};

async function makeOrder(
  db: Stack['db'],
  input: { reference: string; owner: string; showtimeId: string; seatId: string; status: OrderStatus },
): Promise<void> {
  await db.primary.order.create({
    data: {
      reference: input.reference,
      ownerId: input.owner,
      showtimeId: input.showtimeId,
      seatIds: [input.seatId],
      seatTotalCents: 1850,
      feeCents: 150,
      totalCents: 2000,
      currency: 'gbp',
      stripePaymentIntentId: `pi_${input.reference}`,
      idempotencyKey: `key-${input.reference}`,
      status: input.status,
    },
  });
}

test('the tickets list is owner-scoped, includes every ticket-bearing status, excludes failed, and orders upcoming-first', { skip }, async () => {
  const stack = await openStack();
  try {
    // Four different showtimes, in startsAt order (freshShowtime returns them ascending), so ordering is deterministic.
    const s1 = await freshShowtime(stack.db, 1, stack.redis);
    const s2 = await freshShowtime(stack.db, 1, stack.redis);
    const s3 = await freshShowtime(stack.db, 1, stack.redis);
    const s4 = await freshShowtime(stack.db, 1, stack.redis);

    const alice = ownerId();
    const bob = ownerId();
    const refs = {
      aliceS1: randomUUID(), // succeeded, soonest
      aliceS2: randomUUID(), // succeeded
      aliceRefunded: randomUUID(), // refunded
      aliceConfirming: randomUUID(), // requires_payment
      aliceFailed: randomUUID(), // failed (excluded)
      bobTicket: randomUUID(), // succeeded, other owner
    };

    await makeOrder(stack.db, { reference: refs.aliceS1, owner: alice, showtimeId: s1.showtimeId, seatId: s1.seatIds[0]!, status: 'succeeded' });
    await makeOrder(stack.db, { reference: refs.aliceS2, owner: alice, showtimeId: s2.showtimeId, seatId: s2.seatIds[0]!, status: 'succeeded' });
    await makeOrder(stack.db, { reference: refs.aliceRefunded, owner: alice, showtimeId: s3.showtimeId, seatId: s3.seatIds[0]!, status: 'refunded' });
    await makeOrder(stack.db, { reference: refs.aliceConfirming, owner: alice, showtimeId: s4.showtimeId, seatId: s4.seatIds[0]!, status: 'requires_payment' });
    await makeOrder(stack.db, { reference: refs.aliceFailed, owner: alice, showtimeId: s1.showtimeId, seatId: s1.seatIds[0]!, status: 'failed' });
    await makeOrder(stack.db, { reference: refs.bobTicket, owner: bob, showtimeId: s4.showtimeId, seatId: s4.seatIds[0]!, status: 'succeeded' });

    const service = createTicketsService({ repo: createOrderRepo(stack.db), movies });

    const alices = await service.list(alice);
    TicketsResponseSchema.parse(alices);
    assert.deepEqual(
      alices.map((t) => t.reference),
      [refs.aliceS1, refs.aliceS2, refs.aliceRefunded, refs.aliceConfirming],
      'soonest upcoming first; failed excluded',
    );
    assert.deepEqual(alices.map((t) => t.status), ['succeeded', 'succeeded', 'refunded', 'requires_payment']);
    assert.ok(alices.every((t) => t.seats.length === 1), 'each item resolves its seat from the order snapshot');
    assert.ok(alices.every((t) => t.movieTitle === `Film ${t.movieId}`), 'the title is resolved');

    const bobs = await service.list(bob);
    assert.deepEqual(bobs.map((t) => t.reference), [refs.bobTicket], "bob sees only his own ticket, never alice's");
  } finally {
    await stack.close();
  }
});
