import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeDbClients, createDbClients } from './clients.js';
import { seedDatabase } from './seed.js';

const allowed = process.env.TEST_DATABASE_ALLOWED === 'true';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_DATABASE_READ_URL = process.env.TEST_DATABASE_READ_URL;
const skip =
  !allowed || !TEST_DATABASE_URL || !TEST_DATABASE_READ_URL
    ? 'set TEST_DATABASE_ALLOWED=true, TEST_DATABASE_URL, TEST_DATABASE_READ_URL to run'
    : false;

const FAKE_MOVIE_IDS = [900001, 900002, 900003];

test('re-seeding preserves an existing screening: movieId, priceCents and cancellation stay', { skip }, async () => {
  const db = createDbClients({ primaryUrl: TEST_DATABASE_URL, readUrl: TEST_DATABASE_READ_URL });
  try {
    const anchor = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await seedDatabase(db.primary, FAKE_MOVIE_IDS, anchor);

    // Simulate a real screening that was repriced and then cancelled by an admin (ADR 0020).
    const target = await db.primary.showtime.findFirstOrThrow({ orderBy: { startsAt: 'asc' } });
    const cancelledAt = new Date();
    await db.primary.showtime.update({
      where: { id: target.id },
      data: { movieId: 999999, priceCents: 999, cancelledAt },
    });

    // Re-seed the same window: nothing is overwritten, nothing new is added for a completed schedule.
    const second = await seedDatabase(db.primary, FAKE_MOVIE_IDS, anchor);
    assert.equal(second.showtimes, 0, 'a completed schedule re-seeds to zero new showtimes');

    const after = await db.primary.showtime.findUniqueOrThrow({ where: { id: target.id } });
    assert.equal(after.movieId, 999999, 'movieId is preserved, not overwritten by the re-seed');
    assert.equal(after.priceCents, 999, 'priceCents is preserved');
    assert.equal(after.cancelledAt?.getTime(), cancelledAt.getTime(), 'cancellation status is preserved');
  } finally {
    await closeDbClients(db);
  }
});

test('re-seeding with an added movie gives it future showtimes without deleting existing ones', { skip }, async () => {
  const db = createDbClients({ primaryUrl: TEST_DATABASE_URL, readUrl: TEST_DATABASE_READ_URL });
  try {
    const anchor = new Date(Date.UTC(2027, 0, 1)); // deterministic, midnight UTC
    await seedDatabase(db.primary, FAKE_MOVIE_IDS, anchor);
    const fullCount = await db.primary.showtime.count();
    assert.ok(fullCount > 0);

    // Simulate the pre-change state: the older seed only covered the first 7 days.
    await db.primary.showtime.deleteMany({ where: { startsAt: { gte: new Date(Date.UTC(2027, 0, 8)) } } });
    const trimmedCount = await db.primary.showtime.count();
    assert.ok(trimmedCount < fullCount, 'the tail of the schedule was removed');

    // Re-seed with a newly added popular movie.
    const withNewMovie = [...FAKE_MOVIE_IDS, 900004];
    await seedDatabase(db.primary, withNewMovie, anchor);

    assert.ok((await db.primary.showtime.count({ where: { movieId: 900004 } })) > 0, 'the added movie got future showtimes');
    assert.ok((await db.primary.showtime.count()) >= trimmedCount, 'existing showtimes were not deleted');
  } finally {
    await closeDbClients(db);
  }
});
