import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { BookingService } from '../bookings/bookingService.js';
import { ApiError } from '../http/errors.js';
import { createLogger } from '../http/logger.js';
import type { MovieService } from '../movies/service.js';
import type { RateLimiter } from '../ratelimit/limiter.js';
import type { SeatService } from '../showtimes/seat.js';
import type { ShowtimeService } from '../showtimes/showtime.js';
import { createApp } from './app.js';

/**
 * WHICH route gets WHICH limit, on the real app (ADR 0016). A spy stands in for the limiter and records every
 * policy a route asks for; every service refuses with a 404 so no route does any work. This is the test that
 * would catch a limit being dropped from a route, put on the wrong one, or added to a read it should not touch.
 */

/** Every method of the service answers 404: the routes run their middleware, then stop. */
function refusing<T extends object>(): T {
  return new Proxy({}, { get: () => async () => Promise.reject(new ApiError('not_found')) }) as T;
}

test('the four limited routes ask for their own policy, and nothing else is limited', async () => {
  const seen: string[] = [];
  const spy: RateLimiter = {
    limit: (name) => (req, _res, next) => {
      seen.push(`${req.method} ${req.baseUrl}${String(req.route?.path)} -> ${name}`);
      next();
    },
  };
  const server = createApp({
    logger: createLogger(() => {}),
    db: {} as never,
    redis: {} as never,
    movies: refusing<MovieService>(),
    showtimes: refusing<ShowtimeService>(),
    seats: refusing<SeatService>(),
    bookings: refusing<BookingService>(),
    rateLimiter: spy,
  }).listen(0);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const base = `http://127.0.0.1:${address.port}`;

  const showtime = randomUUID();
  const body = JSON.stringify({ seatIds: [randomUUID()] });
  const headers = { 'content-type': 'application/json', 'x-client-id': randomUUID() };
  const send = (method: string, path: string, withBody = false) =>
    fetch(`${base}${path}`, { method, headers: withBody ? headers : { 'x-client-id': headers['x-client-id'] }, body: withBody ? body : undefined });

  try {
    // Limited.
    await send('GET', '/movies/search?q=dune');
    await send('GET', `/showtimes/${showtime}/seats`);
    await send('POST', `/showtimes/${showtime}/holds`, true);
    await send('POST', `/showtimes/${showtime}/bookings`, true);
    assert.deepEqual(seen, [
      'GET /movies/search -> search',
      'GET /showtimes/:id/seats -> seatsPoll',
      'POST /showtimes/:id/holds -> hold',
      'POST /showtimes/:id/bookings -> booking',
    ]);

    // Not limited: letting go of seats (a 429 there would leave seats held for 10 minutes), health, and every other read.
    seen.length = 0;
    await send('DELETE', `/showtimes/${showtime}/holds`, true);
    await send('GET', '/health');
    await send('GET', '/movies/popular');
    await send('GET', '/movies/now-playing');
    await send('GET', '/movies/discover?genreId=28');
    await send('GET', '/movies/7');
    await send('GET', '/movies/7/showtimes');
    await send('GET', '/genres');
    assert.deepEqual(seen, [], 'none of these asked the limiter for anything');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('search accepts an optional X-Client-Id and refuses a malformed one before the limiter runs', async () => {
  const seen: string[] = [];
  const server = createApp({
    logger: createLogger(() => {}),
    db: {} as never,
    redis: {} as never,
    movies: refusing<MovieService>(),
    rateLimiter: { limit: (name) => (_req, res, next) => { seen.push(`${name}:${String(res.locals.clientId)}`); next(); } },
  }).listen(0);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const id = randomUUID();
    await fetch(`${base}/movies/search?q=dune`, { headers: { 'x-client-id': id.toUpperCase() } });
    await fetch(`${base}/movies/search?q=dune`);
    assert.deepEqual(seen, [`search:${id}`, 'search:undefined'], 'a valid id is lower-cased and handed to the limiter; none is fine');

    seen.length = 0;
    const bad = await fetch(`${base}/movies/search?q=dune`, { headers: { 'x-client-id': 'not-a-uuid' } });
    assert.equal(bad.status, 400);
    assert.deepEqual(seen, [], 'a malformed id never reaches the limiter');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
