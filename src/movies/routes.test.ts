import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../api/app.js';
import { ApiError } from '../http/errors.js';
import { createLogger } from '../http/logger.js';
import { MAX_QUERY_LENGTH, type MoviesPage } from './movie.js';
import type { MovieService, MoviesResult } from './service.js';

const PAGE: MoviesPage = {
  movies: [
    { id: 7, title: 'Dune', posterUrl: 'https://image.tmdb.org/t/p/w500/d.jpg', year: 2021, overview: 'Spice.' },
  ],
  page: 1,
  totalPages: 1,
  totalResults: 1,
};

/** Boots the REAL app (middleware, validation, error handler, logging) around a fake MovieService. */
async function boot(handler: { nowPlaying?: () => Promise<MoviesResult>; search?: () => Promise<MoviesResult> } = {}) {
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
  };
  const server = createApp({
    logger: createLogger((line) => logs.push(line)),
    db: {} as never,
    redis: {} as never,
    movies: service,
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
