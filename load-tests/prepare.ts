// Prepares the throwaway data for the k6 load test (slice 5e) and writes `load-tests/params.json`.
//
// It seeds the REAL schema (cinemas, screens, showtimes, seats) with a fake movie id — no TMDB token,
// no real showtimes — then picks one showtime of the 320-seat IMAX screen and 50 of its standard seats,
// and leaves a clean slate (no bookings, an empty Redis) for the run.
//
// Run with `npx tsx load-tests/prepare.ts` after `stand-up.sh` has brought up the throwaway Postgres and
// Redis. It needs DATABASE_URL, DATABASE_READ_URL and REDIS_URL in the environment (stand-up.sh exports them).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { closeDbClients, createDbClients } from '../src/db/clients.js';
import { seedDatabase } from '../src/db/seed.js';
import { createLogger } from '../src/http/logger.js';
import { createRedisClient } from '../src/jobs/connection.js';
import { LOAD_TEST_SCREEN_ID } from '../src/showtimes/seedPlan.js';

/** The number of seats the headline scenario contends over (RULES D5.6: "the same 50 seats"). */
export const SEATS = 50;
/** A fixed anchor so re-running prepare is idempotent (no new showtimes each time). */
const ANCHOR = new Date('2026-12-01T00:00:00Z');
const FAKE_MOVIE_ID = 900001;

async function main(): Promise<void> {
  const logger = createLogger();
  const db = createDbClients();
  const redis = createRedisClient(logger);
  await redis.connect();

  await seedDatabase(db.primary, [FAKE_MOVIE_ID], ANCHOR);

  const showtime = await db.primary.showtime.findFirstOrThrow({
    where: { screenId: LOAD_TEST_SCREEN_ID },
    orderBy: { startsAt: 'asc' },
  });
  const seats = await db.primary.seat.findMany({
    where: { screenId: LOAD_TEST_SCREEN_ID, kind: 'standard' },
    orderBy: [{ row: 'asc' }, { number: 'asc' }],
    take: SEATS,
  });
  if (seats.length !== SEATS) throw new Error(`expected ${SEATS} standard seats, got ${seats.length}`);

  // A clean slate: no bookings for this showtime, and an empty (throwaway) Redis.
  await db.primary.booking.deleteMany({ where: { showtimeId: showtime.id } });
  await redis.flushall();

  const params = { showtimeId: showtime.id, seatIds: seats.map((s) => s.id) };
  writeFileSync(new URL('./params.json', import.meta.url), `${JSON.stringify(params, null, 2)}\n`);
  logger.info('loadtest_prepared', { showtimeId: showtime.id, seats: seats.length });

  redis.disconnect();
  await closeDbClients(db);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
