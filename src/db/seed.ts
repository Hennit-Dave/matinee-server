import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '../generated/prisma/client.js';
import { closeDbClients, createDbClients } from './clients.js';
import { createLogger } from '../http/logger.js';
import { createTmdbMovieSource } from '../movies/tmdb.js';
import { SEED_SCREENS, buildSeedPlan, buildSeedSeats, type SeedScreen } from '../showtimes/seedPlan.js';

/**
 * Idempotent seed for every seat of the given screens (the screens must already exist). Keyed on
 * `(screenId, row, number)`: missing seats are created, existing ones are left alone, and `kind` is
 * synced so a changed layout converges on re-run. Written as batched statements (a few per screen)
 * rather than one upsert per seat, because ~850 round trips to a hosted database is slow.
 *
 * It never deletes a seat: shrinking a layout is a deliberate migration, not a re-seed.
 */
export async function seedSeats(
  primary: PrismaClient,
  screens: readonly SeedScreen[] = SEED_SCREENS,
): Promise<{ seats: number }> {
  const seats = buildSeedSeats(screens);

  for (const screen of screens) {
    const grid = seats.filter((seat) => seat.screenId === screen.id);
    await primary.seat.createMany({ data: grid, skipDuplicates: true });

    const wheelchair = grid
      .filter((seat) => seat.kind === 'wheelchair')
      .map(({ row, number }) => ({ row, number }));
    if (wheelchair.length > 0) {
      await primary.seat.updateMany({
        where: { screenId: screen.id, OR: wheelchair, kind: { not: 'wheelchair' } },
        data: { kind: 'wheelchair' },
      });
      await primary.seat.updateMany({
        where: { screenId: screen.id, NOT: { OR: wheelchair }, kind: { not: 'standard' } },
        data: { kind: 'standard' },
      });
    } else {
      await primary.seat.updateMany({
        where: { screenId: screen.id, kind: { not: 'standard' } },
        data: { kind: 'standard' },
      });
    }
  }

  return { seats: seats.length };
}

/**
 * Repeatable, idempotent seed for cinemas, screens, showtimes and seats.
 * Uses natural keys (`id` for cinemas/screens, `(screenId, startsAt)` for showtimes,
 * `(screenId, row, number)` for seats) so re-running updates existing rows and never creates
 * duplicates.
 */
export async function seedDatabase(
  primary: PrismaClient,
  movieIds: readonly number[],
  anchorDate: Date = new Date(),
): Promise<{ cinemas: number; screens: number; showtimes: number; seats: number }> {
  const plan = buildSeedPlan(movieIds, anchorDate);

  for (const cinema of plan.cinemas) {
    await primary.cinema.upsert({
      where: { id: cinema.id },
      update: { name: cinema.name, address: cinema.address },
      create: { id: cinema.id, name: cinema.name, address: cinema.address },
    });
  }

  for (const screen of plan.screens) {
    await primary.screen.upsert({
      where: { id: screen.id },
      update: { cinemaId: screen.cinemaId, name: screen.name, format: screen.format, totalSeats: screen.totalSeats },
      create: {
        id: screen.id,
        cinemaId: screen.cinemaId,
        name: screen.name,
        format: screen.format,
        totalSeats: screen.totalSeats,
      },
    });
  }

  for (const st of plan.showtimes) {
    await primary.showtime.upsert({
      where: { screenId_startsAt: { screenId: st.screenId, startsAt: st.startsAt } },
      update: { movieId: st.movieId, priceCents: st.priceCents },
      create: {
        movieId: st.movieId,
        screenId: st.screenId,
        startsAt: st.startsAt,
        priceCents: st.priceCents,
      },
    });
  }

  const { seats } = await seedSeats(primary, plan.screens);

  return {
    cinemas: plan.cinemas.length,
    screens: plan.screens.length,
    showtimes: plan.showtimes.length,
    seats,
  };
}

async function main() {
  const logger = createLogger();
  // `--seats-only` seeds just the seats: it does not need TMDB and touches no cinema, screen, showtime
  // or price row, so it is safe to run against a database that already holds real showtimes.
  const seatsOnly = process.argv.includes('--seats-only');
  const readToken = process.env.TMDB_READ_TOKEN;
  if (!seatsOnly && !readToken) {
    logger.error('seed_failed', { reason: 'TMDB_READ_TOKEN is not set.' });
    process.exit(1);
  }

  const db = createDbClients();
  try {
    if (seatsOnly) {
      const { seats } = await seedSeats(db.primary);
      logger.info('seed_completed', { outcome: `${seats} seats (seats only)` });
      return;
    }
    const tmdb = createTmdbMovieSource({ readToken: readToken!, logger });
    const nowPlaying = await tmdb.nowPlaying(1);
    const movieIds = nowPlaying.movies.map((m) => m.id);
    const counts = await seedDatabase(db.primary, movieIds);
    logger.info('seed_completed', {
      outcome: `${counts.cinemas} cinemas, ${counts.screens} screens, ${counts.showtimes} showtimes, ${counts.seats} seats for ${movieIds.length} movies`,
    });
  } catch (err) {
    logger.error('seed_failed', { reason: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  } finally {
    await closeDbClients(db);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
