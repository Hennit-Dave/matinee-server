import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../api/app.js';
import { closeDbClients, createDbClients } from '../db/clients.js';
import { seedDatabase, seedSeats } from '../db/seed.js';
import { createLogger } from '../http/logger.js';
import { createRedisClient } from '../jobs/connection.js';
import { ShowtimeSeatsResponseSchema } from './seat.js';
import { createBookingRepo } from '../bookings/bookingRepo.js';
import { createRedisHoldStore } from '../bookings/holdStore.js';
import { createRedisRyowStore } from '../bookings/ryow.js';
import { createSeatService } from './seatService.js';
import { LOAD_TEST_SCREEN_ID, SEED_SCREENS } from './seedPlan.js';

const allowed = process.env.TEST_DATABASE_ALLOWED === 'true';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_DATABASE_READ_URL = process.env.TEST_DATABASE_READ_URL;
const skip =
  !allowed || !TEST_DATABASE_URL || !TEST_DATABASE_READ_URL
    ? 'set TEST_DATABASE_ALLOWED=true, TEST_DATABASE_URL, TEST_DATABASE_READ_URL to run'
    : false;

const FAKE_MOVIE_IDS = [900001, 900002, 900003];
const TOTAL_SEATS = SEED_SCREENS.reduce((sum, s) => sum + s.totalSeats, 0);

test('the seat seed is idempotent and GET /showtimes/:id/seats serves the real seat map from Postgres', { skip }, async () => {
  const logger = createLogger(() => {});
  const db = createDbClients({ primaryUrl: TEST_DATABASE_URL, readUrl: TEST_DATABASE_READ_URL });
  const redis = createRedisClient(logger, process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379');
  await redis.connect(); // seat state comes from Redis too, and a closed connection fails closed
  const seatService = createSeatService(db, {
    repo: createBookingRepo(db),
    holds: createRedisHoldStore(redis),
    ryow: createRedisRyowStore(redis),
  });
  const server = createApp({ logger, db, redis, seats: seatService }).listen(0);
  const emptyScreenId = `itest-empty-${randomUUID()}`;

  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const base = `http://127.0.0.1:${address.port}`;

    // --- The seed creates every seat once, and running it again creates none. -------------------
    const anchor = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const first = await seedDatabase(db.primary, FAKE_MOVIE_IDS, anchor);
    assert.equal(first.seats, TOTAL_SEATS);
    assert.equal(await db.primary.seat.count(), TOTAL_SEATS, 'every seat exists exactly once');
    await seedDatabase(db.primary, FAKE_MOVIE_IDS, anchor);
    await seedSeats(db.primary);
    assert.equal(await db.primary.seat.count(), TOTAL_SEATS, 're-seeding adds no duplicates');

    for (const screen of SEED_SCREENS) {
      const stored = await db.primary.seat.count({ where: { screenId: screen.id } });
      assert.equal(stored, screen.totalSeats, `${screen.id} stores totalSeats seats`);
    }
    assert.equal(await db.primary.seat.count({ where: { screenId: LOAD_TEST_SCREEN_ID, kind: 'wheelchair' } }), 2);

    // --- A drifted `kind` converges back on re-seed (the seed is keyed on the natural key). ------
    await db.primary.seat.updateMany({
      where: { screenId: LOAD_TEST_SCREEN_ID, row: 'P', number: 1 },
      data: { kind: 'standard' },
    });
    await db.primary.seat.updateMany({
      where: { screenId: LOAD_TEST_SCREEN_ID, row: 'A', number: 1 },
      data: { kind: 'wheelchair' },
    });
    await seedSeats(db.primary);
    const kindOf = async (row: string, number: number) =>
      (await db.primary.seat.findUniqueOrThrow({ where: { screenId_row_number: { screenId: LOAD_TEST_SCREEN_ID, row, number } } })).kind;
    assert.equal(await kindOf('P', 1), 'wheelchair', 'a missing wheelchair space is restored');
    assert.equal(await kindOf('A', 1), 'standard', 'a stray wheelchair flag is cleared');
    assert.equal(await db.primary.seat.count(), TOTAL_SEATS);

    // --- The endpoint, over the real tables. -----------------------------------------------------
    const imaxShowtime = await db.primary.showtime.findFirstOrThrow({
      where: { screenId: LOAD_TEST_SCREEN_ID, movieId: FAKE_MOVIE_IDS[0] },
    });
    const res = await fetch(`${base}/showtimes/${imaxShowtime.id}/seats`);
    assert.equal(res.status, 200);
    const body = ShowtimeSeatsResponseSchema.parse(await res.json());
    assert.equal(body.showtimeId, imaxShowtime.id);
    assert.equal(body.screen.id, LOAD_TEST_SCREEN_ID);
    assert.equal(body.screen.totalSeats, 320);
    assert.equal(body.rows.length, 16);
    assert.equal(body.rows.map((r) => r.row).join(''), 'ABCDEFGHIJKLMNOP');
    const seats = body.rows.flatMap((r) => r.seats);
    assert.equal(seats.length, body.screen.totalSeats, 'seat count equals totalSeats');
    assert.equal(new Set(seats.map((s) => s.id)).size, 320, 'every seat has its own id');
    assert.ok(seats.every((s) => s.status === 'available'));
    assert.equal(seats.filter((s) => s.kind === 'wheelchair').length, 2);
    assert.equal(body.priceFormatted, '£18.50');
    assert.ok(body.priceFormatted.startsWith('£'));

    // --- Unknown showtime: 404. A screen whose seats have not been seeded yet: honest empty map. --
    const missing = await fetch(`${base}/showtimes/${randomUUID()}/seats`);
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { error: { code: string } }).error.code, 'not_found');

    await db.primary.screen.create({
      data: { id: emptyScreenId, cinemaId: 'curzon-soho', name: emptyScreenId, format: 'Standard', totalSeats: 50 },
    });
    const unseeded = await db.primary.showtime.create({
      data: { movieId: FAKE_MOVIE_IDS[0]!, screenId: emptyScreenId, startsAt: new Date(Date.now() + 3600_000), priceCents: 1200 },
    });
    const emptyRes = await fetch(`${base}/showtimes/${unseeded.id}/seats`);
    assert.equal(emptyRes.status, 200);
    const emptyBody = ShowtimeSeatsResponseSchema.parse(await emptyRes.json());
    assert.deepEqual(emptyBody.rows, [], 'no seats yet is rows: [], with totalSeats still reported');
    assert.equal(emptyBody.screen.totalSeats, 50);
  } finally {
    await db.primary.screen.deleteMany({ where: { id: emptyScreenId } }); // cascades to its showtime
    await new Promise((resolve) => server.close(resolve));
    redis.disconnect();
    await closeDbClients(db);
  }
});
