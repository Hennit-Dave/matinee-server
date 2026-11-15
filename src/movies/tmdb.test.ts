import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLogger } from '../http/logger.js';
import { MovieDetailSchema, MovieSourceError, MoviesPageSchema, OVERVIEW_MAX_LENGTH } from './movie.js';
import { MAX_ATTEMPTS, RETRY_AFTER_CAP_MS, createTmdbMovieSource, mapTmdbMovieDetail, mapTmdbPage } from './tmdb.js';

// A TMDB now_playing response in TMDB's documented shape, saved as a fixture. It is SYNTHETIC
// (fictional titles, hand-written, not captured live: no agent touches the real token) and
// deliberately includes the awkward cases: a null poster, a blank/missing date, an empty/null
// overview, a very long overview, and fields we do not use. Swap in a real capture any time; the
// assertions on the awkward cases are what matter.
const fixture: unknown = JSON.parse(
  readFileSync(new URL('./fixtures/tmdb-now-playing.json', import.meta.url), 'utf8'),
);
const detailFixture: unknown = JSON.parse(
  readFileSync(new URL('./fixtures/tmdb-movie-detail.json', import.meta.url), 'utf8'),
);

// ---- Mapper: saved TMDB fixture -> our Movie type --------------------------------------------

test('maps a TMDB list into our MoviesPage and the result satisfies the contract schema', () => {
  const page = mapTmdbPage(fixture);
  assert.doesNotThrow(() => MoviesPageSchema.parse(page));
  assert.equal(page.page, 1);
  assert.equal(page.totalPages, 42);
  assert.equal(page.totalResults, 837);
  assert.equal(page.movies.length, 4);
});

test('maps a complete TMDB movie: id, title, a ready-to-load posterUrl, year, overview', () => {
  const [first] = mapTmdbPage(fixture).movies;
  assert.deepEqual(first, {
    id: 900001,
    title: 'The Last Projectionist',
    posterUrl: 'https://image.tmdb.org/t/p/w500/fxPosterOne.jpg',
    year: 2026,
    overview: 'A retired projectionist guards the final reel of a lost film.',
  });
});

test('a missing poster, blank date and empty overview become null, not empty strings', () => {
  const second = mapTmdbPage(fixture).movies[1];
  assert.deepEqual(second, { id: 900002, title: 'No Poster, No Date', posterUrl: null, year: null, overview: null });
});

test('fields that are absent or null in TMDB (not just empty) also map to null', () => {
  const sparse = mapTmdbPage(fixture).movies[3];
  assert.deepEqual(sparse, { id: 900004, title: 'Sparse Record', posterUrl: null, year: null, overview: null });
});

test('a long overview is tidied and cut on a word boundary with an ellipsis', () => {
  const third = mapTmdbPage(fixture).movies[2];
  assert.ok(third);
  const overview = third.overview;
  assert.ok(overview !== null);
  assert.ok(Array.from(overview).length <= OVERVIEW_MAX_LENGTH, 'within the contract limit');
  assert.ok(overview.endsWith('…'));
  assert.ok(!/\s{2,}|\n/.test(overview), 'whitespace collapsed');
  assert.ok(overview.startsWith('In the spring of a year nobody remembers'));
  // Cut on a word boundary: what is kept is a prefix of the tidied text, followed by a space there.
  const kept = overview.slice(0, -1);
  const tidied = (fixture as { results: Array<{ overview: string }> }).results[2]!.overview.trim().replace(/\s+/g, ' ');
  assert.ok(tidied.startsWith(kept));
  assert.equal(tidied[kept.length], ' ');
});

test('TMDB field names never leak into our Movie', () => {
  for (const movie of mapTmdbPage(fixture).movies) {
    assert.deepEqual(Object.keys(movie).sort(), ['id', 'overview', 'posterUrl', 'title', 'year']);
  }
  const json = JSON.stringify(mapTmdbPage(fixture));
  for (const tmdbField of ['poster_path', 'release_date', 'total_pages', 'vote_average', 'backdrop_path']) {
    assert.ok(!json.includes(tmdbField), `${tmdbField} must not appear in our output`);
  }
});

test('if TMDB changes a field we rely on, mapping fails loudly instead of returning garbage', () => {
  const body = fixture as { results: unknown[] };
  assert.throws(() => mapTmdbPage({ ...body, results: [{ id: 1 }] })); // title gone
  const renamed: Record<string, unknown> = { ...(fixture as Record<string, unknown>), totalPages: 42 };
  delete renamed.total_pages;
  assert.throws(() => mapTmdbPage(renamed)); // total_pages renamed
});

// ---- Client: auth, URLs, retry with backoff, timeouts ----------------------------------------

const TOKEN = 'tok-test-9d41c7e2a5';

type Step = () => Response | Error;
function harness(steps: Step[], opts: { advanceMsPerCall?: number } = {}) {
  const calls: Array<{ url: URL; authorization: string | null }> = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  let clock = 0;
  const fakeFetch = (async (input: URL | string, init?: RequestInit) => {
    calls.push({
      url: new URL(String(input)),
      authorization: new Headers(init?.headers).get('authorization'),
    });
    clock += opts.advanceMsPerCall ?? 0;
    const make = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (!make) throw new Error('harness needs at least one step');
    const step = make();
    if (step instanceof Error) throw step;
    return step;
  }) as typeof fetch;
  const source = createTmdbMovieSource({
    readToken: TOKEN,
    logger: createLogger((line) => logs.push(line)),
    fetch: fakeFetch,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0, // jitter at its minimum, so the delays below are exact
    now: () => clock,
  });
  return { source, calls, sleeps, logs };
}

// Each is a factory: every fake call gets its own fresh Response.
const ok: Step = () => Response.json(fixture);
const status =
  (code: number, headers?: Record<string, string>): Step =>
  () =>
    new Response('upstream said no', { status: code, headers });

test('sends the token as a Bearer header and builds the right TMDB URLs', async () => {
  const h = harness([ok]);
  await h.source.nowPlaying(2);
  await h.source.search('dune part two', 3);
  const [now, search] = h.calls;
  assert.ok(now && search);
  assert.equal(now.authorization, `Bearer ${TOKEN}`);
  assert.equal(now.url.pathname, '/3/movie/now_playing');
  assert.equal(now.url.searchParams.get('page'), '2');
  assert.equal(search.url.pathname, '/3/search/movie');
  assert.equal(search.url.searchParams.get('query'), 'dune part two');
  assert.equal(search.url.searchParams.get('page'), '3');
  assert.equal(search.url.searchParams.get('include_adult'), 'false');
  assert.ok(!now.url.toString().includes(TOKEN), 'the token is never put in the URL');
});

test('retries a transient 503 with exponential backoff, then succeeds', async () => {
  const h = harness([status(503), status(502), ok]);
  const page = await h.source.nowPlaying(1);
  assert.equal(page.movies.length, 4);
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.sleeps, [125, 250]); // 250/2 and 500/2 with jitter at 0: doubles each time
});

test('gives up after MAX_ATTEMPTS and reports a MovieSourceError', async () => {
  const h = harness([status(503)]);
  await assert.rejects(h.source.nowPlaying(1), (err: unknown) => {
    assert.ok(err instanceof MovieSourceError);
    assert.equal(err.reason, 'upstream_error');
    assert.equal(err.upstreamStatus, 503);
    return true;
  });
  assert.equal(h.calls.length, MAX_ATTEMPTS);
  assert.equal(h.sleeps.length, MAX_ATTEMPTS - 1);
});

test('does not retry a 401: repeating a rejected request cannot help', async () => {
  const h = harness([status(401)]);
  await assert.rejects(h.source.nowPlaying(1), (err: unknown) => {
    assert.ok(err instanceof MovieSourceError);
    assert.equal(err.reason, 'rejected');
    assert.equal(err.upstreamStatus, 401);
    return true;
  });
  assert.equal(h.calls.length, 1);
  assert.equal(h.sleeps.length, 0);
});

test('a 429 honours Retry-After, but never waits longer than the cap', async () => {
  const short = harness([status(429, { 'Retry-After': '1' }), ok]);
  await short.source.nowPlaying(1);
  assert.deepEqual(short.sleeps, [1000]);

  const long = harness([status(429, { 'Retry-After': '30' }), ok]);
  await long.source.nowPlaying(1);
  assert.deepEqual(long.sleeps, [RETRY_AFTER_CAP_MS]);
});

test('retries a network error and a timeout', async () => {
  const h = harness([() => new TypeError('fetch failed'), () => new DOMException('timed out', 'TimeoutError'), ok]);
  await h.source.nowPlaying(1);
  assert.equal(h.calls.length, 3);

  const timeouts = harness([() => new DOMException('timed out', 'TimeoutError')]);
  await assert.rejects(timeouts.source.nowPlaying(1), (err: unknown) => err instanceof MovieSourceError && err.reason === 'timeout');
  assert.equal(timeouts.calls.length, MAX_ATTEMPTS);
});

test('stops retrying once the total time budget is spent, so a request never hangs on TMDB', async () => {
  // Each call "takes" 5 s on the fake clock; the 8 s budget allows two attempts, not three.
  const h = harness([status(503)], { advanceMsPerCall: 5_000 });
  await assert.rejects(h.source.nowPlaying(1), MovieSourceError);
  assert.equal(h.calls.length, 2);
});

test('a 200 with a shape we do not recognise is not retried and says so', async () => {
  const h = harness([() => Response.json({ page: 1, results: [{ id: 1 }], total_pages: 1, total_results: 1 })]);
  await assert.rejects(h.source.nowPlaying(1), (err: unknown) => err instanceof MovieSourceError && err.reason === 'bad_shape');
  assert.equal(h.calls.length, 1);

  const notJson = harness([() => new Response('<html>oops</html>', { status: 200 })]);
  await assert.rejects(notJson.source.nowPlaying(1), (err: unknown) => err instanceof MovieSourceError && err.reason === 'invalid_json');
  assert.equal(notJson.calls.length, 1);
});

test('logs each failed attempt, and never the token, the response body or the search text', async () => {
  const h = harness([status(503)]);
  await assert.rejects(h.source.search('very private query', 1), MovieSourceError);
  assert.equal(h.logs.length, MAX_ATTEMPTS);
  const all = h.logs.join('\n');
  assert.ok(all.includes('tmdb_attempt_failed'));
  assert.ok(all.includes('"upstreamStatus":503'));
  assert.ok(!all.includes(TOKEN), 'token must never be logged');
  assert.ok(!all.includes('upstream said no'), 'response bodies must never be logged');
  assert.ok(!all.includes('very private query'), 'search text must never be logged');
});

// ---- Detail mapper & client ------------------------------------------------------------------

test('maps a TMDB movie detail into MovieDetail preserving full overview and rounding rating', () => {
  const detail = mapTmdbMovieDetail(detailFixture);
  assert.doesNotThrow(() => MovieDetailSchema.parse(detail));
  assert.equal(detail.id, 900001);
  assert.equal(detail.title, 'The Last Projectionist');
  assert.ok(detail.overview !== null && detail.overview.length > OVERVIEW_MAX_LENGTH);
  assert.ok(!/\n/.test(detail.overview), 'newlines collapsed to spaces');
  assert.equal(detail.posterUrl, 'https://image.tmdb.org/t/p/w500/fxPosterOne.jpg');
  assert.equal(detail.backdropUrl, 'https://image.tmdb.org/t/p/w780/fx-backdrop-detail.jpg');
  assert.equal(detail.year, 2026);
  assert.equal(detail.releaseDate, '2026-11-07');
  assert.equal(detail.runtimeMinutes, 128);
  assert.deepEqual(detail.genres, ['Drama', 'Thriller']);
  assert.equal(detail.rating, 7.8);
  assert.equal(detail.tagline, 'Every frame leaves a trace.');
  assert.equal(detail.certification, '12A');
  assert.equal(detail.language, 'English');
  assert.equal(detail.director, 'Arthur Vance');
  assert.deepEqual(detail.cast, ['First Billed', 'Second Billed', 'Third Billed', 'Fourth Billed', 'Fifth Billed']);
});

test('maps sparse/unrated TMDB movie detail fields to null or empty array', () => {
  const detail = mapTmdbMovieDetail({
    id: 900002,
    title: 'Unrated Film',
    overview: '   ',
    poster_path: null,
    backdrop_path: null,
    release_date: '',
    runtime: 0,
    genres: [],
    vote_average: 0,
    vote_count: 0,
    tagline: '',
  });
  assert.deepEqual(detail, {
    id: 900002,
    title: 'Unrated Film',
    overview: null,
    posterUrl: null,
    backdropUrl: null,
    year: null,
    releaseDate: null,
    runtimeMinutes: null,
    genres: [],
    rating: null,
    tagline: null,
    certification: null,
    language: null,
    director: null,
    cast: [],
  });
});

test('certification prefers GB, then US, then first non-empty country; director joins multiple; language falls back', () => {
  const usFallback = mapTmdbMovieDetail({
    id: 1,
    title: 'US Cert',
    original_language: 'ja',
    spoken_languages: [{ iso_639_1: 'fr', english_name: 'French' }],
    credits: {
      crew: [
        { name: 'Director One', job: 'Director' },
        { name: 'Director Two', job: 'Director' },
      ],
      cast: [{ name: 'Lead', order: 0 }],
    },
    release_dates: {
      results: [
        { iso_3166_1: 'FR', release_dates: [{ certification: '12' }] },
        { iso_3166_1: 'GB', release_dates: [{ certification: '  ' }] },
        { iso_3166_1: 'US', release_dates: [{ certification: 'PG-13' }] },
      ],
    },
  });
  assert.equal(usFallback.certification, 'PG-13');
  assert.equal(usFallback.language, 'French');
  assert.equal(usFallback.director, 'Director One, Director Two');

  const firstFallback = mapTmdbMovieDetail({
    id: 2,
    title: 'FR Cert',
    release_dates: {
      results: [
        { iso_3166_1: 'DE', release_dates: [{ certification: '' }] },
        { iso_3166_1: 'FR', release_dates: [{ certification: 'Tous publics' }] },
      ],
    },
  });
  assert.equal(firstFallback.certification, 'Tous publics');
});

test('detail(id) hits /3/movie/:id with append_to_response, returns null on 404 without retrying, and retries 503', async () => {
  const okDetail = harness([() => Response.json(detailFixture)]);
  const detail = await okDetail.source.detail(900001);
  assert.equal(detail?.id, 900001);
  assert.equal(okDetail.calls[0]?.url.pathname, '/3/movie/900001');
  assert.equal(okDetail.calls[0]?.url.searchParams.get('append_to_response'), 'credits,release_dates');

  const notFound = harness([status(404)]);
  const missing = await notFound.source.detail(999999);
  assert.equal(missing, null);
  assert.equal(notFound.calls.length, 1, '404 must not be retried');

  const flaky = harness([status(503), () => Response.json(detailFixture)]);
  const recovered = await flaky.source.detail(900001);
  assert.equal(recovered?.id, 900001);
  assert.equal(flaky.calls.length, 2);
});

test('source.genres() hits /3/genre/movie/list and maps { genres: [{ id, name }] }', async () => {
  const payload = { genres: [{ id: 28, name: 'Action' }, { id: 878, name: 'Science Fiction' }] };
  const h = harness([() => Response.json(payload)]);
  const genres = await h.source.genres();
  assert.deepEqual(genres, payload);
  assert.equal(h.calls[0]?.url.pathname, '/3/genre/movie/list');
});

test('source.discover() hits /3/discover/movie with with_genres, popularity.desc, include_adult=false, and page', async () => {
  const h = harness([ok]);
  const page = await h.source.discover(28, 2);
  assert.equal(page.movies.length, 4);
  const call = h.calls[0];
  assert.ok(call);
  assert.equal(call.url.pathname, '/3/discover/movie');
  assert.equal(call.url.searchParams.get('with_genres'), '28');
  assert.equal(call.url.searchParams.get('sort_by'), 'popularity.desc');
  assert.equal(call.url.searchParams.get('include_adult'), 'false');
  assert.equal(call.url.searchParams.get('page'), '2');
});

test('source.popular() hits /3/movie/popular with page and reuses mapTmdbPage', async () => {
  const h = harness([ok]);
  const page = await h.source.popular(2);
  assert.equal(page.movies.length, 4);
  const call = h.calls[0];
  assert.ok(call);
  assert.equal(call.url.pathname, '/3/movie/popular');
  assert.equal(call.url.searchParams.get('page'), '2');
});
