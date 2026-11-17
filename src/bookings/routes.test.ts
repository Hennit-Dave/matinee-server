import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../api/app.js';
import { noRateLimit } from '../ratelimit/limiter.js';
import { ApiError } from '../http/errors.js';
import { createLogger } from '../http/logger.js';
import type { BookingService } from './bookingService.js';

const SHOWTIME = '11111111-1111-4111-8111-111111111111';
const SEAT_1 = 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const SEAT_2 = 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const CLIENT = '0A11CE00-0000-4000-8000-000000000001'; // upper case on purpose

function boot(overrides: Partial<BookingService> = {}) {
  const calls: { method: string; request: unknown }[] = [];
  const logs: Record<string, unknown>[] = [];
  const bookings: BookingService = {
    async acquireHolds(request) {
      calls.push({ method: 'acquire', request });
      return { showtimeId: request.showtimeId, seatIds: [...request.seatIds], expiresAt: '2026-11-20T20:10:00.000Z', expiresInMs: 600_000 };
    },
    async releaseHolds(request) {
      calls.push({ method: 'release', request });
      return { released: [...request.seatIds] };
    },
    async confirmBooking(request) {
      calls.push({ method: 'confirm', request });
      return {
        reference: '33333333-3333-4333-8333-333333333333',
        showtimeId: request.showtimeId,
        seats: [{ seatId: SEAT_1, row: 'A', number: 1 }],
        priceCents: 1850,
        totalCents: 1850,
        totalFormatted: '£18.50',
      };
    },
    ...overrides,
  };
  const server = createApp({
    logger: createLogger((line) => logs.push(JSON.parse(line) as Record<string, unknown>)),
    db: {} as never,
    redis: {} as never,
    bookings,
    rateLimiter: noRateLimit,
  }).listen(0);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    calls,
    logs,
    send: (method: string, path: string, headers: Record<string, string> | null, body?: unknown) =>
      fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(headers ?? {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const withClient = { 'x-client-id': CLIENT };
type ErrorBody = { error: { code: string; seatIds?: string[]; details?: { path: string; code: string }[]; requestId: string } };

test('POST /showtimes/:id/holds takes a hold for the caller (id lower-cased) and answers 201', async () => {
  const app = boot();
  try {
    const res = await app.send('POST', `/showtimes/${SHOWTIME}/holds`, withClient, { seatIds: [SEAT_1, SEAT_2] });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { expiresInMs: number };
    assert.equal(body.expiresInMs, 600_000);
    const request = app.calls[0]!.request as { showtimeId: string; ownerId: string; seatIds: string[] };
    assert.equal(request.showtimeId, SHOWTIME);
    assert.equal(request.ownerId, CLIENT.toLowerCase());
    assert.deepEqual(request.seatIds, [SEAT_1, SEAT_2]);
  } finally {
    await app.close();
  }
});

test('DELETE /holds answers 200 and POST /bookings answers 201', async () => {
  const app = boot();
  try {
    const release = await app.send('DELETE', `/showtimes/${SHOWTIME}/holds`, withClient, { seatIds: [SEAT_1] });
    assert.equal(release.status, 200);
    assert.deepEqual(await release.json(), { released: [SEAT_1] });

    const book = await app.send('POST', `/showtimes/${SHOWTIME}/bookings`, withClient, { seatIds: [SEAT_1] });
    assert.equal(book.status, 201);
    assert.equal(((await book.json()) as { totalFormatted: string }).totalFormatted, '£18.50');
    assert.deepEqual(app.calls.map((c) => c.method), ['release', 'confirm']);
  } finally {
    await app.close();
  }
});

test('every route needs a valid X-Client-Id, and nothing reaches the service without one', async () => {
  const app = boot();
  try {
    for (const [method, path] of [['POST', 'holds'], ['DELETE', 'holds'], ['POST', 'bookings']] as const) {
      for (const headers of [null, { 'x-client-id': 'not-a-uuid' }]) {
        const res = await app.send(method, `/showtimes/${SHOWTIME}/${path}`, headers, { seatIds: [SEAT_1] });
        assert.equal(res.status, 400, `${method} ${path}`);
        const { error } = (await res.json()) as ErrorBody;
        assert.equal(error.code, 'validation_failed');
        assert.deepEqual(error.details?.map((d) => d.path), ['header.x-client-id']);
      }
    }
    assert.equal(app.calls.length, 0);
  } finally {
    await app.close();
  }
});

test('bodies and ids are validated: 0, 9 or duplicate seats, non-uuids, unknown keys, a bad showtime id', async () => {
  const app = boot();
  try {
    const path = `/showtimes/${SHOWTIME}/holds`;
    const nine = Array.from({ length: 9 }, (_, i) => `aaaaaaa${i + 1}-aaaa-4aaa-8aaa-aaaaaaaaaaa${i + 1}`);
    const bad: unknown[] = [{}, { seatIds: [] }, { seatIds: nine }, { seatIds: ['nope'] }, { seatIds: [SEAT_1, SEAT_1] }, { seatIds: [SEAT_1], extra: 1 }];
    for (const body of bad) {
      const res = await app.send('POST', path, withClient, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    const dup = await app.send('POST', path, withClient, { seatIds: [SEAT_1, SEAT_1] });
    assert.deepEqual(((await dup.json()) as ErrorBody).error.details, [{ path: 'seatIds', code: 'duplicate_seat' }]);

    const badId = await app.send('POST', '/showtimes/not-a-uuid/holds', withClient, { seatIds: [SEAT_1] });
    assert.equal(badId.status, 400);
    assert.equal(app.calls.length, 0, 'nothing invalid reached the service');
  } finally {
    await app.close();
  }
});

test('a seat_taken carries the seat ids in the error body, with the usual envelope', async () => {
  const app = boot({
    async acquireHolds() {
      throw new ApiError('seat_taken', { seatIds: [SEAT_2] });
    },
  });
  try {
    const res = await app.send('POST', `/showtimes/${SHOWTIME}/holds`, withClient, { seatIds: [SEAT_1, SEAT_2] });
    assert.equal(res.status, 409);
    const { error } = (await res.json()) as ErrorBody;
    assert.equal(error.code, 'seat_taken');
    assert.deepEqual(error.seatIds, [SEAT_2]);
    assert.ok(error.requestId.length > 0);
  } finally {
    await app.close();
  }
});

test('holds_unavailable is a 503 with Retry-After, and a plain 503 does not get one', async () => {
  const app = boot({
    async acquireHolds() {
      throw new ApiError('holds_unavailable', { reason: 'redis not ready (end)' });
    },
    async releaseHolds() {
      throw new ApiError('service_unavailable');
    },
  });
  try {
    const down = await app.send('POST', `/showtimes/${SHOWTIME}/holds`, withClient, { seatIds: [SEAT_1] });
    assert.equal(down.status, 503);
    assert.equal(down.headers.get('retry-after'), '2');
    assert.equal(((await down.json()) as ErrorBody).error.code, 'holds_unavailable');

    const other = await app.send('DELETE', `/showtimes/${SHOWTIME}/holds`, withClient, { seatIds: [SEAT_1] });
    assert.equal(other.headers.get('retry-after'), null);
  } finally {
    await app.close();
  }
});

test('the request log line names the user, so "what happened to this user?" can be answered from logs', async () => {
  const app = boot();
  try {
    await app.send('POST', `/showtimes/${SHOWTIME}/holds`, withClient, { seatIds: [SEAT_1] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const line = app.logs.find((l) => l.msg === 'request')!;
    assert.equal(line.userId, CLIENT.toLowerCase());
    assert.equal(line.route, '/showtimes/:id/holds');
    assert.equal(line.status, 201);
  } finally {
    await app.close();
  }
});

test('without a BookingService the hold routes are simply not mounted', async () => {
  const server = createApp({ logger: createLogger(() => {}), db: {} as never, redis: {} as never, rateLimiter: noRateLimit }).listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const res = await fetch(`http://127.0.0.1:${address.port}/showtimes/${SHOWTIME}/holds`, { method: 'POST' });
    assert.equal(res.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
