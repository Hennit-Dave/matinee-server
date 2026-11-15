import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../api/app.js';
import { closeDbClients, createDbClients } from '../db/clients.js';
import { seedDatabase } from '../db/seed.js';
import { createLogger } from '../http/logger.js';
import { createRedisClient } from '../jobs/connection.js';
import { MovieShowtimesResponseSchema } from './showtime.js';
import { createShowtimeService } from './service.js';
import type { MovieService } from '../movies/service.js';

const allowed = process.env.TEST_DATABASE_ALLOWED === 'true';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_DATABASE_READ_URL = process.env.TEST_DATABASE_READ_URL;
const skip =
  !allowed || !TEST_DATABASE_URL || !TEST_DATABASE_READ_URL
    ? 'set TEST_DATABASE_ALLOWED=true, TEST_DATABASE_URL, TEST_DATABASE_READ_URL to run'
    : false;

const FAKE_MOVIE_IDS = [900001, 900002, 900003];

const noopMovies: MovieService = {
  nowPlaying: async () => {
    throw new Error('not used');
  },
  search: async () => {
    throw new Error('not used');
  },
  detail: async () => {
    throw new Error('not used');
  },
};

test('seedDatabase is idempotent and GET /movies/:id/showtimes reads from Postgres via replica', { skip }, async () => {
  const logger = createLogger(() => {});
  const db = createDbClients({ primaryUrl: TEST_DATABASE_URL, readUrl: TEST_DATABASE_READ_URL });
  const redis = createRedisClient(logger, process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379');
  const showtimes = createShowtimeService(db);
  const server = createApp({ logger, db, redis, movies: noopMovies, showtimes }).listen(0);

  try {
    const anchor = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await seedDatabase(db.primary, FAKE_MOVIE_IDS, anchor);
    const secondRun = await seedDatabase(db.primary, FAKE_MOVIE_IDS, anchor);
    assert.equal(secondRun.cinemas, 3);
    assert.equal(secondRun.screens, 5);

    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');

    const res = await fetch(`http://127.0.0.1:${address.port}/movies/${FAKE_MOVIE_IDS[0]}/showtimes`);
    assert.equal(res.status, 200);
    const body = MovieShowtimesResponseSchema.parse(await res.json());
    assert.equal(body.movieId, FAKE_MOVIE_IDS[0]);
    assert.ok(body.cinemas.length > 0, 'seeded movie has showtimes');
    const formats = new Set(
      body.cinemas.flatMap((c) => c.dates.flatMap((d) => d.showtimes.map((s) => s.format))),
    );
    assert.ok(formats.has('Standard') || formats.has('IMAX') || formats.has('Dolby Atmos'));

    const emptyRes = await fetch(`http://127.0.0.1:${address.port}/movies/99999999/showtimes`);
    assert.equal(emptyRes.status, 200);
    assert.deepEqual(await emptyRes.json(), { movieId: 99999999, cinemas: [] });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    redis.disconnect();
    await closeDbClients(db);
  }
});
