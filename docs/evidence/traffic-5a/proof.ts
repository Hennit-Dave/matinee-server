// A narrated run of the seat-hold guarantee against the real HTTP app, a real Postgres and a real Redis.
// It prints real responses, Redis keys and database rows. Throwaway local services only (it refuses
// anything else, and it cleans up the showtimes it uses).
//
//   source <env with TEST_DATABASE_URL, TEST_DATABASE_READ_URL, TEST_REDIS_URL>
//   npx tsx docs/evidence/traffic-5a/proof.ts
import { randomUUID } from 'node:crypto';
import { holdKey } from '../../../src/bookings/holdStore.js';
import { createLaggingReplica, ensureSeeded, freshShowtime, openStack, ownerId, TEST_DATABASE_URL, type Stack } from '../../../src/bookings/testkit.js';

if (!TEST_DATABASE_URL || !['127.0.0.1', 'localhost'].includes(new URL(TEST_DATABASE_URL).hostname)) {
  throw new Error('refusing to run against a non-local database');
}

const say = (line = '') => console.log(line);
const section = (title: string) => say(`\n## ${title}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tally = (values: (string | number)[]) =>
  JSON.stringify(values.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {}));

function call(stack: Stack, method: string, path: string, client: string | null, body?: unknown) {
  return fetch(`${stack.base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(client ? { 'x-client-id': client } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function seatStatus(stack: Stack, showtimeId: string, seatId: string, client?: string) {
  const res = await fetch(`${stack.base}/showtimes/${showtimeId}/seats`, client ? { headers: { 'x-client-id': client } } : undefined);
  if (res.status !== 200) return `HTTP ${res.status}`;
  const body = (await res.json()) as { rows: { seats: { id: string; status: string }[] }[] };
  return body.rows.flatMap((r) => r.seats).find((s) => s.id === seatId)?.status ?? 'missing';
}

say(`# Seat holds: a narrated run. ${new Date().toISOString()}`);
say('# Real HTTP app + real Postgres + real (local, throwaway) Redis. 10-minute holds, 5 s read-your-own-writes.');

// ---------------------------------------------------------------------------------------------------------
{
  const stack = await openStack();
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 1, stack.redis);
    const seatId = seatIds[0]!;
    const users = Array.from({ length: 100 }, ownerId);

    section('1. 100 users ask for the same seat at the same moment, over HTTP (POST /showtimes/:id/holds)');
    const responses = await Promise.all(users.map((u) => call(stack, 'POST', `/showtimes/${showtimeId}/holds`, u, { seatIds: [seatId] })));
    say(`HTTP statuses: ${tally(responses.map((r) => r.status))}`);
    const winnerIndex = responses.findIndex((r) => r.status === 201);
    const winner = users[winnerIndex]!;
    say(`winning response:  ${JSON.stringify(await responses[winnerIndex]!.json())}`);
    say(`a losing response: ${JSON.stringify(await responses.find((r) => r.status === 409)!.json())}`);
    say(`redis  GET ${holdKey(showtimeId, seatId)}`);
    say(`       -> ${await stack.redis.get(holdKey(showtimeId, seatId))}   (the winner is ${winner}: ${(await stack.redis.get(holdKey(showtimeId, seatId))) === winner})`);
    say(`redis  PTTL -> ${await stack.redis.pttl(holdKey(showtimeId, seatId))} ms   (the window is 600000 ms = 10:00)`);
    say(`seat map says: ${await seatStatus(stack, showtimeId, seatId)}`);

    section('2. The winner books it (POST /showtimes/:id/bookings)');
    const book = await call(stack, 'POST', `/showtimes/${showtimeId}/bookings`, winner, { seatIds: [seatId] });
    say(`HTTP ${book.status}  ${JSON.stringify(await book.json())}`);
    const rows = await stack.db.primary.booking.findMany({ where: { showtimeId } });
    say(`bookings table: ${rows.length} row(s)`);
    for (const r of rows) say(`  seat ${r.seatId}  owner ${r.ownerId}  price_cents ${r.priceCents}  reference ${r.reference}`);
    say(`seat map says: ${await seatStatus(stack, showtimeId, seatId)}   (sold, even though the hold key still exists: ${await stack.redis.exists(holdKey(showtimeId, seatId))})`);
    const loser = users.find((u) => u !== winner)!;
    const late = await call(stack, 'POST', `/showtimes/${showtimeId}/bookings`, loser, { seatIds: [seatId] });
    say(`a loser tries to book it anyway: HTTP ${late.status} ${JSON.stringify(((await late.json()) as { error: { code: string } }).error.code)}`);

    section('3. The database alone refuses a second booking for the same seat');
    try {
      await stack.db.primary.booking.create({ data: { reference: randomUUID(), showtimeId, seatId, ownerId: ownerId(), priceCents: 1850 } });
      say('!! a second row was accepted');
    } catch (err) {
      const e = err as { code?: string; message?: string };
      say(`insert refused. Prisma code: ${e.code}`);
      say(`  ${(e.message ?? '').split('\n').filter((l) => l.trim()).slice(-2).join(' | ').slice(0, 220)}`);
    }
    say(`rows for the seat afterwards: ${await stack.db.primary.booking.count({ where: { showtimeId, seatId } })}`);
  } finally {
    await stack.close();
  }
}

// ---------------------------------------------------------------------------------------------------------
{
  const stack = await openStack({ wrapHolds: (real) => ({ ...real, heldBy: async (_s, _o, ids) => [...ids] }) });
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 1, stack.redis);
    section('4. Redis taken out of the picture: 50 users confirm the same seat, no hold check at all');
    const results = await Promise.allSettled(Array.from({ length: 50 }, () => stack.bookings.confirmBooking({ showtimeId, ownerId: ownerId(), seatIds })));
    say(`outcomes: ${tally(results.map((r) => (r.status === 'fulfilled' ? 'booked' : (r.reason as { code?: string }).code ?? 'ERROR (not one of ours)')))}`);
    say(`rows for the seat: ${await stack.db.primary.booking.count({ where: { showtimeId, seatId: seatIds[0]! } })}   <- the unique key alone, still exactly one`);
  } finally {
    await stack.close();
  }
}

// ---------------------------------------------------------------------------------------------------------
{
  const prep = await openStack();
  const { showtimeId, seatIds } = await freshShowtime(prep.db, 1, prep.redis);
  const stack = await openStack({ connectRedis: false });
  try {
    section('5. Redis is down (connection not ready): every route fails closed');
    const user = ownerId();
    for (const [label, method, path] of [
      ['take a hold   ', 'POST', 'holds'],
      ['release       ', 'DELETE', 'holds'],
      ['confirm       ', 'POST', 'bookings'],
    ] as const) {
      const res = await call(stack, method, `/showtimes/${showtimeId}/${path}`, user, { seatIds });
      say(`${label} HTTP ${res.status}  Retry-After: ${res.headers.get('retry-after')}  ${JSON.stringify(((await res.json()) as { error: { code: string } }).error.code)}`);
    }
    const map = await fetch(`${stack.base}/showtimes/${showtimeId}/seats`);
    say(`seat map       HTTP ${map.status}  ${JSON.stringify(((await map.json()) as { error: { code: string } }).error.code)}`);
    say(`bookings written while Redis was down: ${await stack.db.primary.booking.count({ where: { showtimeId } })}`);
    await stack.redis.connect();
    const back = await call(stack, 'POST', `/showtimes/${showtimeId}/holds`, user, { seatIds });
    say(`Redis back     take a hold -> HTTP ${back.status}`);
  } finally {
    await stack.close();
    await prep.close();
  }
}

// ---------------------------------------------------------------------------------------------------------
{
  const alice = ownerId();
  const bob = ownerId();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const stack = await openStack({
    wrapHolds: (real) => ({
      ...real,
      heldBy: async (showtimeId, owner, ids) => {
        const held = await real.heldBy(showtimeId, owner, ids);
        if (owner === alice) await gate;
        return held;
      },
    }),
  });
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 1, stack.redis);
    section("6. Redis loses Alice's hold between her check and her insert (expiry, a restart, a flush)");
    await stack.bookings.acquireHolds({ showtimeId, ownerId: alice, seatIds });
    say('Alice holds the seat and presses Confirm: her hold check passes, then she is paused before the INSERT.');
    const aliceConfirm = stack.bookings.confirmBooking({ showtimeId, ownerId: alice, seatIds });
    await sleep(100);
    await stack.redis.del(holdKey(showtimeId, seatIds[0]!));
    say("Her hold key is deleted. Bob takes the seat and books it.");
    await stack.bookings.acquireHolds({ showtimeId, ownerId: bob, seatIds });
    await stack.bookings.confirmBooking({ showtimeId, ownerId: bob, seatIds });
    release();
    const outcome = await aliceConfirm.then(
      () => 'BOOKED (double booking!)',
      (e: unknown) => `refused: ${(e as { code?: string }).code ?? String(e)}`,
    );
    say(`Alice's INSERT now runs: ${outcome}`);
    const rows = await stack.db.primary.booking.findMany({ where: { showtimeId } });
    say(`rows for the seat: ${rows.length}, owned by ${rows[0]?.ownerId === bob ? 'Bob' : 'someone else'}`);
  } finally {
    release();
    await stack.close();
  }
}

// ---------------------------------------------------------------------------------------------------------
{
  const prep = await openStack();
  await ensureSeeded(prep.db);
  const lagging = await createLaggingReplica(prep.db);
  const stack = await openStack({ readUrl: lagging.url, ryowWindowMs: 1500 });
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 1, stack.redis);
    const seatId = seatIds[0]!;
    const [alice, bob] = [ownerId(), ownerId()];
    section('7. Read-your-own-writes, with a replica that never hears about the booking (1.5 s window here)');
    await stack.bookings.acquireHolds({ showtimeId, ownerId: alice, seatIds });
    await stack.bookings.confirmBooking({ showtimeId, ownerId: alice, seatIds });
    await stack.redis.del(holdKey(showtimeId, seatId)); // the hold has expired; the replica is the only view left
    say(`Alice booked the seat. The "replica" has no booking row; the primary has ${await stack.db.primary.booking.count({ where: { showtimeId } })}.`);
    say(`  an anonymous reader sees   ${await seatStatus(stack, showtimeId, seatId)}   (stale replica)`);
    say(`  Bob (has an id) sees       ${await seatStatus(stack, showtimeId, seatId, bob)}   (stale replica)`);
    say(`  Alice (just booked) sees   ${await seatStatus(stack, showtimeId, seatId, alice)}   (read from the primary)`);
    const bobHold = await call(stack, 'POST', `/showtimes/${showtimeId}/holds`, bob, { seatIds });
    say(`  Bob taps it anyway: HTTP ${bobHold.status} ${JSON.stringify(((await bobHold.json()) as { error: { code: string } }).error.code)}   (the authoritative check is on the primary)`);
    await sleep(1700);
    say(`  after the window, Alice sees ${await seatStatus(stack, showtimeId, seatId, alice)}   (back on the replica)`);
  } finally {
    await stack.close();
    await prep.close();
    await lagging.close();
  }
}
