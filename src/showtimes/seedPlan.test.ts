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
  isLoadTestShowtime,
  resolveSeedInserts,
  showtimeKey,
  uniqueMovieIds,
} from './seedPlan.js';

test('buildSeedPlan schedules every movieId, preserves unique (screenId, startsAt), and includes the 320-seat target', () => {
  const movieIds = Array.from({ length: 20 }, (_, i) => 1000 + i);
  const anchor = new Date('2026-11-15T10:00:00.000Z');
  const plan = buildSeedPlan(movieIds, anchor);

  // 30 days * 5 screens * 3 slots = 450 showtimes
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

const ANCHOR = new Date('2026-11-15T10:00:00.000Z');
const keysOf = (showtimes: readonly { screenId: string; startsAt: Date }[]) =>
  new Set(showtimes.map((s) => showtimeKey(s.screenId, s.startsAt)));

test('uniqueMovieIds deduplicates across now-playing and popular, keeping first-occurrence order', () => {
  assert.deepEqual(uniqueMovieIds([1, 2, 3], [3, 4, 5]), [1, 2, 3, 4, 5]);
  assert.deepEqual(uniqueMovieIds([5, 5, 1], [1, 2]), [5, 1, 2]);
  assert.deepEqual(uniqueMovieIds([], [9]), [9]);
});

test('the schedule spans 30 distinct UTC days, all 15 daily slots on the anchor day first', () => {
  const plan = buildSeedPlan([1, 2, 3], ANCHOR);
  const days = new Set(plan.showtimes.map((s) => s.startsAt.toISOString().slice(0, 10)));
  assert.equal(days.size, 30);
  const firstDay = new Set(plan.showtimes.slice(0, SEED_SCREENS.length * 3).map((s) => s.startsAt.toISOString().slice(0, 10)));
  assert.equal(firstDay.size, 1, 'the first 15 slots are all on the anchor day');
});

test('resolveSeedInserts on a fresh database returns the full schedule, no duplicate keys, every movie covered', () => {
  const movieIds = [1, 2, 3, 4, 5];
  const plan = buildSeedPlan(movieIds, ANCHOR);
  const inserts = resolveSeedInserts(movieIds, plan.showtimes, new Set(), new Set());
  assert.equal(inserts.length, plan.showtimes.length);
  assert.equal(keysOf(inserts).size, inserts.length, 'no duplicate (screenId, startsAt)');
  const covered = new Set(inserts.map((s) => s.movieId));
  for (const id of movieIds) assert.ok(covered.has(id), `movie ${id} is covered`);
});

test('resolveSeedInserts re-running a completed seed adds nothing (idempotent)', () => {
  const movieIds = [1, 2, 3];
  const plan = buildSeedPlan(movieIds, ANCHOR);
  const inserts = resolveSeedInserts(movieIds, plan.showtimes, keysOf(plan.showtimes), new Set(movieIds));
  assert.equal(inserts.length, 0);
});

test('resolveSeedInserts never overwrites an existing (screenId, startsAt)', () => {
  const old = [1, 2, 3];
  // Simulate the pre-existing state: a previous 7-day seed occupied the first 105 slots.
  const occupiedKeys = keysOf(buildSeedPlan(old, ANCHOR).showtimes.slice(0, 105));
  const newMovies = [1, 2, 3, 4, 5];
  const inserts = resolveSeedInserts(newMovies, buildSeedPlan(newMovies, ANCHOR).showtimes, occupiedKeys, new Set(old));
  for (const s of inserts) {
    assert.ok(!occupiedKeys.has(showtimeKey(s.screenId, s.startsAt)), 'an insert never collides with an existing screening');
  }
});

test('resolveSeedInserts gives newly added movies future showtimes even when earlier slots are occupied', () => {
  const old = [1, 2, 3];
  const occupiedKeys = keysOf(buildSeedPlan(old, ANCHOR).showtimes.slice(0, 105));
  const newMovies = [1, 2, 3, 4, 5, 6, 7];
  const inserts = resolveSeedInserts(newMovies, buildSeedPlan(newMovies, ANCHOR).showtimes, occupiedKeys, new Set(old));
  const covered = new Set([...old, ...inserts.map((s) => s.movieId)]);
  for (const id of newMovies) assert.ok(covered.has(id), `movie ${id} gets a future showtime`);
});

test('resolveSeedInserts keeps the IMAX 20:30 load-test slot on movieIds[0]', () => {
  const movieIds = [10, 11, 12, 13, 14, 15];
  const plan = buildSeedPlan(movieIds, ANCHOR);
  const occupiedKeys = keysOf(plan.showtimes.slice(0, 105));
  const inserts = resolveSeedInserts(movieIds, plan.showtimes, occupiedKeys, new Set([10]));
  for (const s of inserts) {
    if (isLoadTestShowtime(s)) assert.equal(s.movieId, movieIds[0], 'the load-test target is never reassigned');
  }
});
