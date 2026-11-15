import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '../generated/prisma/client.js';
import { closeDbClients, createDbClients } from './clients.js';
import { createLogger } from '../http/logger.js';
import { createTmdbMovieSource } from '../movies/tmdb.js';
import { buildSeedPlan } from '../showtimes/seedPlan.js';

/**
 * Repeatable, idempotent seed for cinemas, screens, and showtimes.
 * Uses natural keys (`id` for cinemas/screens, `(screenId, startsAt)` for showtimes) so
 * re-running updates existing rows and never creates duplicates.
 */
export async function seedDatabase(
  primary: PrismaClient,
  movieIds: readonly number[],
  anchorDate: Date = new Date(),
): Promise<{ cinemas: number; screens: number; showtimes: number }> {
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

  return {
    cinemas: plan.cinemas.length,
    screens: plan.screens.length,
    showtimes: plan.showtimes.length,
  };
}

async function main() {
  const logger = createLogger();
  const readToken = process.env.TMDB_READ_TOKEN;
  if (!readToken) {
    logger.error('seed_failed', { reason: 'TMDB_READ_TOKEN is not set.' });
    process.exit(1);
  }

  const db = createDbClients();
  try {
    const tmdb = createTmdbMovieSource({ readToken, logger });
    const nowPlaying = await tmdb.nowPlaying(1);
    const movieIds = nowPlaying.movies.map((m) => m.id);
    const counts = await seedDatabase(db.primary, movieIds);
    logger.info('seed_completed', {
      outcome: `${counts.cinemas} cinemas, ${counts.screens} screens, ${counts.showtimes} showtimes for ${movieIds.length} movies`,
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
