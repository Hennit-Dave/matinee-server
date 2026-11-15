import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../api/app.js';
import { ApiError } from '../http/errors.js';
import { createLogger } from '../http/logger.js';
import { MAX_QUERY_LENGTH, type MovieDetail, type MoviesPage } from './movie.js';
import type { MovieDetailResult, MovieService, MoviesResult } from './service.js';
import type { MovieShowtimesResponse, ShowtimeService } from '../showtimes/showtime.js';

const PAGE: MoviesPage = {
  movies: [
    { id: 7, title: 'Dune', posterUrl: 'https://image.tmdb.org/t/p/w500/d.jpg', year: 2021, overview: 'Spice.' },
  ],
  page: 1,
  totalPages: 1,
  totalResults: 1,
};

const DETAIL: MovieDetail = {
  id: 7,
  title: 'Dune',
  overview: 'A noble family becomes embroiled in a war for control over the galaxy’s most valuable asset.',
  posterUrl: 'https://image.tmdb.org/t/p/w500/d.jpg',
  backdropUrl: 'https://image.tmdb.org/t/p/w780/bd.jpg',
  year: 2021,
  releaseDate: '2021-10-22',
  runtimeMinutes: 155,
  genres: ['Science Fiction', 'Adventure'],
  rating: 7.8,
  tagline: 'Beyond fear, destiny awaits.',
};

const SHOWTIMES: MovieShowtimesResponse = {
  movieId: 7,
  cinemas: [
    {
      cinemaId: 'curzon-soho',
      cinemaName: 'Curzon Soho',
      cinemaAddress: '99 Shaftesbury Ave, London',
      dates: [
        {
          date: '2026-11-15',
          showtimes: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              startsAt: '2026-11-15T17:45:00.000Z',
              time: '17:45',
              screenId: 'curzon-soho-1',
              screenName: 'Screen 1',
              format: 'Standard',
              totalSeats: 120,
              priceCents: 1550,
              priceFormatted: '$15.50',
            },
          ],
        },
      ],
    },
  ],
};

/** Boots the REAL app (middleware, validation, error handler, logging) around a fake MovieService. */
async function boot(
  handler: {
    nowPlaying?: () => Promise<MoviesResult>;
    search?: () => Promise<MoviesResult>;
    detail?: (id: number) => Promise<MovieDetailResult>;
    showtimes?: (id: number) => Promise<MovieShowtimesResponse>;
  } = {},
) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const logs: string[] = [];
  const service: MovieService = {
    async nowPlaying(page) {
      calls.push({ method: 'nowPlaying', args: [page] });
      return handler.nowPlaying ? handler.nowPlaying() : { page: PAGE, cache: 'hit' };
    },
    async search(query, page) {
      calls.push({ method: 'search', args: [query, page] });
      return handler.search ? handler.search() : { page: PAGE, cache: 'miss' };
    },
    async detail(id) {
      calls.push({ method: 'detail', args: [id] });
      return handler.detail ? handler.detail(id) : { movie: DETAIL, cache: 'hit' };
    },
  };
  const showtimes: ShowtimeService = {
    async forMovie(id) {
      calls.push({ method: 'showtimes', args: [id] });
      return handler.showtimes ? handler.showtimes(id) : SHOWTIMES;
    },
  };
  const server = createApp({
    logger: createLogger((line) => logs.push(line)),
    db: {} as never,
    redis: {} as never,
    movies: service,
    showtimes,
  }).listen(0);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    base: `http://127.0.0.1:${address.port}`,
    calls,
    logs,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function waitForRequestLog(logs: string[]) {
  for (let i = 0; i < 200 && !logs.some((l) => l.includes('"msg":"request"')); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('GET /movies/now-playing returns the page as JSON and defaults to page 1', async () => {
  const app = await boot();
  try {
    const res = await fetch(`${app.base}/movies/now-playing`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), PAGE);
    assert.equal(res.headers.get('x-cache'), 'HIT');
    assert.deepEqual(app.calls, [{ method: 'nowPlaying', args: [1] }]);
  } finally {
    await app.close();
  }
});

test('GET /movies/now-playing?page=3 asks the service for page 3', async () => {
  const app = await boot();
  try {
    await (await fetch(`${app.base}/movies/now-playing?page=3`)).text();
    assert.deepEqual(app.calls, [{ method: 'nowPlaying', args: [3] }]);
  } finally {
    await app.close();
  }
});

test('GET /movies/search normalises q before it reaches the service', async () => {
  const app = await boot();
  try {
    const res = await fetch(`${app.base}/movies/search?q=%20%20Dune%20%20PART%20Two&page=2`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-cache'), 'MISS');
    assert.deepEqual(app.calls, [{ method: 'search', args: ['dune part two', 2] }]);
  } finally {
    await app.close();
  }
});

const BAD_REQUESTS = [
  '/movies/now-playing?page=0',
  '/movies/now-playing?page=-2',
  '/movies/now-playing?page=abc',
  '/movies/now-playing?page=501',
  '/movies/now-playing?page=1&page=2',
  '/movies/now-playing?foo=bar',
  '/movies/search',
  '/movies/search?q=',
  '/movies/search?q=%20%20%20',
  `/movies/search?q=${'a'.repeat(MAX_QUERY_LENGTH + 1)}`,
  '/movies/search?q=dune&page=0',
  '/movies/search?q=dune&extra=1',
  '/movies/0',
  '/movies/-5',
  '/movies/abc',
  '/movies/7?foo=1',
  '/movies/0/showtimes',
  '/movies/abc/showtimes',
  '/movies/7/showtimes?foo=1',
];

test('bad input returns the standard error shape (400 validation_failed) and never reaches the service', async () => {
  const app = await boot();
  try {
    for (const path of BAD_REQUESTS) {
      const res = await fetch(`${app.base}${path}`);
      const body = (await res.json()) as { error: { code: string; message: string; requestId: string; details?: unknown[] } };
      assert.equal(res.status, 400, path);
      assert.equal(body.error.code, 'validation_failed', path);
      assert.match(body.error.requestId, /^[0-9a-f-]{36}$/, path);
      assert.ok(Array.isArray(body.error.details) && body.error.details.length > 0, `${path} explains what was wrong`);
      assert.ok(!JSON.stringify(body).includes('at '), 'no stack trace');
    }
    assert.equal(app.calls.length, 0, 'the service is never called with invalid input');
  } finally {
    await app.close();
  }
});

test('validation errors do not echo the submitted value back', async () => {
  const app = await boot();
  try {
    const res = await fetch(`${app.base}/movies/search?q=zzmarker&page=0`);
    assert.ok(!(await res.text()).includes('zzmarker'));
  } finally {
    await app.close();
  }
});

test('TMDB down with nothing cached is a clean 503 the app can show: no stack trace, no internals', async () => {
  const app = await boot({
    nowPlaying: async () => {
      throw new ApiError('upstream_unavailable', { reason: 'movie source: upstream_error' });
    },
  });
  try {
    const res = await fetch(`${app.base}/movies/now-playing`);
    const text = await res.text();
    assert.equal(res.status, 503);
    const body = JSON.parse(text) as { error: { code: string; message: string; requestId: string } };
    assert.equal(body.error.code, 'upstream_unavailable');
    assert.ok(body.error.message.length > 0);
    assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message', 'requestId']);
    assert.ok(!text.includes('upstream_error'), 'the internal reason is logged, not sent');
    assert.ok(!text.includes('    at '), 'no stack trace');
  } finally {
    await app.close();
  }
});

test('the request log line carries the route template and where the data came from', async () => {
  const app = await boot();
  try {
    await (await fetch(`${app.base}/movies/search?q=privatequerytext`)).text();
    await waitForRequestLog(app.logs);
    const line = JSON.parse(app.logs.find((l) => l.includes('"msg":"request"')) ?? '{}') as Record<string, unknown>;
    assert.equal(line.route, '/movies/search');
    assert.equal(line.status, 200);
    assert.equal(line.cache, 'miss');
    assert.ok(typeof line.requestId === 'string' && typeof line.durationMs === 'number');
    assert.ok(!app.logs.join('\n').includes('privatequerytext'), 'the search text is never logged');
  } finally {
    await app.close();
  }
});

test('GET /movies/:id returns MovieDetail, sets X-Cache, and logs /movies/:id template', async () => {
  const app = await boot();
  try {
    const res = await fetch(`${app.base}/movies/7`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-cache'), 'HIT');
    assert.deepEqual(await res.json(), DETAIL);
    assert.deepEqual(app.calls, [{ method: 'detail', args: [7] }]);

    await waitForRequestLog(app.logs);
    const line = JSON.parse(app.logs.find((l) => l.includes('"msg":"request"')) ?? '{}') as Record<string, unknown>;
    assert.equal(line.route, '/movies/:id');
    assert.equal(line.status, 200);
    assert.equal(line.cache, 'hit');
  } finally {
    await app.close();
  }
});

test('GET /movies/:id returns 404 not_found for unknown movie and 503 upstream_unavailable when uncached + TMDB down', async () => {
  const notFoundApp = await boot({
    detail: async () => {
      throw new ApiError('not_found');
    },
  });
  try {
    const res = await fetch(`${notFoundApp.base}/movies/999999`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string; requestId: string } };
    assert.equal(body.error.code, 'not_found');
  } finally {
    await notFoundApp.close();
  }

  const downApp = await boot({
    detail: async () => {
      throw new ApiError('upstream_unavailable', { reason: 'movie source: upstream_error' });
    },
  });
  try {
    const res = await fetch(`${downApp.base}/movies/7`);
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: { code: string; requestId: string } };
    assert.equal(body.error.code, 'upstream_unavailable');
  } finally {
    await downApp.close();
  }
});

test('GET /movies/:id/showtimes returns grouped showtimes (and 200 empty list when none)', async () => {
  const app = await boot();
  try {
    const res = await fetch(`${app.base}/movies/7/showtimes`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), SHOWTIMES);
    assert.deepEqual(app.calls, [{ method: 'showtimes', args: [7] }]);
  } finally {
    await app.close();
  }

  const emptyApp = await boot({ showtimes: async (id) => ({ movieId: id, cinemas: [] }) });
  try {
    const res = await fetch(`${emptyApp.base}/movies/999/showtimes`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { movieId: 999, cinemas: [] });
  } finally {
    await emptyApp.close();
  }
});
