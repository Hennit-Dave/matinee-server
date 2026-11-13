import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../http/errors.js';
import { createLogger } from '../http/logger.js';
import { createMovieCache, type CacheStore } from './cache.js';
import { MovieSourceError, type MoviesPage, type MovieSource } from './movie.js';
import {
  NOW_PLAYING_FRESH_TTL_SECONDS,
  NOW_PLAYING_STALE_GRACE_SECONDS,
  SEARCH_FRESH_TTL_SECONDS,
  SEARCH_STALE_GRACE_SECONDS,
  createMovieService,
  nowPlayingKey,
  searchKey,
} from './service.js';

const pageOf = (label: string, page = 1): MoviesPage => ({
  movies: [{ id: 1, title: label, posterUrl: null, year: 2026, overview: null }],
  page,
  totalPages: 3,
  totalResults: 50,
});

function setup() {
  const clock = { now: 1_700_000_000_000 };
  const now = () => clock.now;
  const logs: string[] = [];
  const logger = createLogger((line) => logs.push(line));

  // An in-memory stand-in for Redis that records the TTL of every write.
  const data = new Map<string, string>();
  const writes: Array<{ key: string; ttlSeconds: number }> = [];
  const redis = { down: false };
  const store: CacheStore = {
    async get(key) {
      if (redis.down) throw new Error('redis not ready (reconnecting)');
      return data.get(key) ?? null;
    },
    async set(key, value, ttlSeconds) {
      if (redis.down) throw new Error('redis not ready (reconnecting)');
      writes.push({ key, ttlSeconds });
      data.set(key, value);
    },
  };

  // A fake TMDB with a "down" switch and a call counter.
  const tmdb = { down: false, nowPlayingCalls: 0, searchCalls: 0, label: 'v1' };
  const source: MovieSource = {
    async nowPlaying(page) {
      tmdb.nowPlayingCalls++;
      if (tmdb.down) throw new MovieSourceError('upstream_error', 503);
      return pageOf(`now-playing ${tmdb.label}`, page);
    },
    async search(query, page) {
      tmdb.searchCalls++;
      if (tmdb.down) throw new MovieSourceError('upstream_error', 503);
      return pageOf(`search ${query} ${tmdb.label}`, page);
    },
  };

  const cache = createMovieCache({ store, logger, now });
  const service = createMovieService({ source, cache, logger, now });
  return { service, clock, logs, data, writes, redis, tmdb };
}

test('cache MISS: calls TMDB once and stores the page; the next call is a HIT with no TMDB call', async () => {
  const t = setup();

  const first = await t.service.nowPlaying(1);
  assert.equal(first.cache, 'miss');
  assert.equal(first.page.movies[0]?.title, 'now-playing v1');
  assert.equal(t.tmdb.nowPlayingCalls, 1);
  assert.ok(t.data.has('movies:v1:now-playing:page:1'));

  t.tmdb.label = 'v2'; // if TMDB were called again we would see this
  const second = await t.service.nowPlaying(1);
  assert.equal(second.cache, 'hit');
  assert.equal(second.page.movies[0]?.title, 'now-playing v1');
  assert.equal(t.tmdb.nowPlayingCalls, 1, 'a HIT must not touch TMDB');
});

test('every cached item gets a TTL: fresh TTL plus stale grace, per the documented policy', async () => {
  const t = setup();
  await t.service.nowPlaying(1);
  await t.service.nowPlaying(2);
  await t.service.search('dune', 1);

  assert.equal(t.writes.length, 3);
  for (const w of t.writes) assert.ok(Number.isInteger(w.ttlSeconds) && w.ttlSeconds > 0, `${w.key} has a TTL`);

  const ttl = (key: string) => t.writes.find((w) => w.key === key)?.ttlSeconds;
  assert.equal(ttl(nowPlayingKey(1)), NOW_PLAYING_FRESH_TTL_SECONDS + NOW_PLAYING_STALE_GRACE_SECONDS);
  assert.equal(ttl(searchKey('dune', 1)), SEARCH_FRESH_TTL_SECONDS + SEARCH_STALE_GRACE_SECONDS);
  assert.ok(SEARCH_FRESH_TTL_SECONDS < NOW_PLAYING_FRESH_TTL_SECONDS, 'search is cached for less time than now-playing');
});

test('cache keys are readable, versioned, and tell queries and pages apart', () => {
  assert.equal(nowPlayingKey(2), 'movies:v1:now-playing:page:2');
  assert.equal(searchKey('dune part two', 1), 'movies:v1:search:dune%20part%20two:page:1');
  assert.notEqual(searchKey('dune', 1), searchKey('dune', 2));
  assert.notEqual(searchKey('dune', 1), searchKey('dune messiah', 1));
  // A query containing ":page:" cannot be confused with a page number.
  assert.notEqual(searchKey('x:page:2', 1), searchKey('x', 2));
});

test('once the fresh TTL passes, the entry is refreshed from TMDB (a MISS again)', async () => {
  const t = setup();
  await t.service.nowPlaying(1);
  t.clock.now += (NOW_PLAYING_FRESH_TTL_SECONDS + 1) * 1000;
  t.tmdb.label = 'v2';

  const refreshed = await t.service.nowPlaying(1);
  assert.equal(refreshed.cache, 'miss');
  assert.equal(refreshed.page.movies[0]?.title, 'now-playing v2');
  assert.equal(t.tmdb.nowPlayingCalls, 2);
});

test('TMDB DOWN + a cached (stale) copy: serves the stale copy instead of failing', async () => {
  const t = setup();
  await t.service.nowPlaying(1);
  t.clock.now += (NOW_PLAYING_FRESH_TTL_SECONDS + 60) * 1000; // past fresh, still inside the stale grace
  t.tmdb.down = true;

  const result = await t.service.nowPlaying(1);
  assert.equal(result.cache, 'stale');
  assert.equal(result.page.movies[0]?.title, 'now-playing v1');
  assert.equal(t.tmdb.nowPlayingCalls, 2, 'it did try TMDB first');
  assert.ok(t.logs.some((l) => l.includes('movies_served_stale')));
});

test('TMDB DOWN + nothing cached: a clean 503 upstream_unavailable, with no internals leaked', async () => {
  const t = setup();
  t.tmdb.down = true;

  await assert.rejects(t.service.nowPlaying(1), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.code, 'upstream_unavailable');
    assert.equal(err.status, 503);
    assert.ok(!err.message.includes('upstream_error') && !err.message.includes('503'));
    return true;
  });
});

test('a stale copy is kept per page and per query: another key does not borrow it', async () => {
  const t = setup();
  await t.service.nowPlaying(1);
  t.clock.now += (NOW_PLAYING_FRESH_TTL_SECONDS + 60) * 1000;
  t.tmdb.down = true;

  await assert.rejects(t.service.nowPlaying(2), ApiError); // page 2 was never cached
  await assert.rejects(t.service.search('dune', 1), ApiError); // nor was this search
});

test('Redis DOWN: movie data fails OPEN to TMDB (a cache miss), it does not fail the request', async () => {
  const t = setup();
  t.redis.down = true;

  const result = await t.service.nowPlaying(1);
  assert.equal(result.cache, 'miss');
  assert.equal(result.page.movies[0]?.title, 'now-playing v1');
  assert.ok(t.logs.some((l) => l.includes('movies_cache_read_failed')));
});

test('a corrupt or old-shape cache entry is treated as a miss and rewritten', async () => {
  const t = setup();
  t.data.set(nowPlayingKey(1), 'not json at all');
  assert.equal((await t.service.nowPlaying(1)).cache, 'miss');

  // Valid JSON, but the page is in a shape the current contract does not allow.
  t.data.set(nowPlayingKey(1), JSON.stringify({ freshUntil: t.clock.now + 1e9, page: { results: [], page: 1 } }));
  const result = await t.service.nowPlaying(1);
  assert.equal(result.cache, 'miss');
  assert.equal(result.page.movies[0]?.title, 'now-playing v1');
  assert.ok(t.logs.some((l) => l.includes('movies_cache_entry_invalid')));
});

test('concurrent requests for the same expired key share ONE TMDB call', async () => {
  const t = setup();
  const [a, b, c] = await Promise.all([t.service.nowPlaying(1), t.service.nowPlaying(1), t.service.nowPlaying(1)]);
  assert.equal(t.tmdb.nowPlayingCalls, 1);
  assert.deepEqual(a.page, b.page);
  assert.deepEqual(b.page, c.page);
});

test('an unexpected error (a bug, not an outage) is not disguised as "TMDB is down"', async () => {
  const logger = createLogger(() => {});
  const service = createMovieService({
    source: {
      async nowPlaying() {
        throw new TypeError('bug in the mapper');
      },
      async search() {
        throw new TypeError('bug in the mapper');
      },
    },
    cache: createMovieCache({ store: { get: async () => null, set: async () => {} }, logger }),
    logger,
  });
  await assert.rejects(service.nowPlaying(1), TypeError);
});
