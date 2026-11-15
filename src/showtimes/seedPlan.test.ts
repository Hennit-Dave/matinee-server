import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOAD_TEST_SCREEN_ID,
  PRICE_IMAX_CENTS,
  PRICE_MATINEE_CENTS,
  PRICE_STANDARD_CENTS,
  SEED_DAYS,
  SEED_SCREENS,
  buildSeedPlan,
} from './seedPlan.js';

test('buildSeedPlan schedules every movieId, preserves unique (screenId, startsAt), and includes the 320-seat target', () => {
  const movieIds = Array.from({ length: 20 }, (_, i) => 1000 + i);
  const anchor = new Date('2026-11-15T10:00:00.000Z');
  const plan = buildSeedPlan(movieIds, anchor);

  // 7 days * 5 screens * 3 slots = 105 showtimes
  assert.equal(plan.showtimes.length, SEED_DAYS * SEED_SCREENS.length * 3);

  const uniqueKeys = new Set(plan.showtimes.map((s) => `${s.screenId}|${s.startsAt.toISOString()}`));
  assert.equal(uniqueKeys.size, plan.showtimes.length, 'every (screenId, startsAt) is unique');

  const scheduledMovieIds = new Set(plan.showtimes.map((s) => s.movieId));
  for (const id of movieIds) {
    assert.ok(scheduledMovieIds.has(id), `movieId ${id} must have at least one showtime`);
  }

  const imaxShowtimes = plan.showtimes.filter((s) => s.screenId === LOAD_TEST_SCREEN_ID);
  assert.ok(imaxShowtimes.length > 0);
  assert.ok(imaxShowtimes.every((s) => s.priceCents === PRICE_IMAX_CENTS));
  assert.ok(imaxShowtimes.some((s) => s.movieId === movieIds[0] && s.startsAt.getUTCHours() === 20));

  const matinee = plan.showtimes.find((s) => s.screenId !== LOAD_TEST_SCREEN_ID && s.startsAt.getUTCHours() === 14);
  const evening = plan.showtimes.find((s) => s.screenId !== LOAD_TEST_SCREEN_ID && s.startsAt.getUTCHours() === 20);
  assert.equal(matinee?.priceCents, PRICE_MATINEE_CENTS);
  assert.equal(evening?.priceCents, PRICE_STANDARD_CENTS);
});

test('buildSeedPlan rejects an empty movieIds list', () => {
  assert.throws(() => buildSeedPlan([]));
});

test('SEED_SCREENS assigns expected projection/audio formats', () => {
  const byId = new Map(SEED_SCREENS.map((s) => [s.id, s.format]));
  assert.equal(byId.get('curzon-soho-1'), 'Standard');
  assert.equal(byId.get('curzon-soho-2'), 'Standard');
  assert.equal(byId.get('bfi-southbank-imax'), 'IMAX');
  assert.equal(byId.get('bfi-southbank-nft1'), 'Dolby Atmos');
  assert.equal(byId.get('prince-charles-main'), 'Standard');
});
