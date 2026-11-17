import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../api/app.js';
import { noRateLimit } from '../ratelimit/limiter.js';
import { createLogger } from '../http/logger.js';
import { ShowtimeSeatsResponseSchema, buildShowtimeSeatsResponse, type SeatService } from './seat.js';
import { SEED_SCREENS, buildSeedSeats } from './seedPlan.js';

const KNOWN_ID = '22222222-2222-4222-8222-222222222222';

function knownShowtime() {
  const screen = SEED_SCREENS.find((s) => s.id === 'bfi-southbank-imax')!;
  return buildShowtimeSeatsResponse({
    id: KNOWN_ID,
    movieId: 7,
    startsAt: new Date('2026-11-20T20:30:00.000Z'),
    priceCents: 1850,
    screen: {
      id: screen.id,
      name: screen.name,
      format: screen.format,
      totalSeats: screen.totalSeats,
      seats: buildSeedSeats([screen]).map((s) => ({ id: randomUUID(), row: s.row, number: s.number, kind: s.kind })),
    },
  });
}

function boot() {
  const calls: string[] = [];
  const logs: string[] = [];
  const seats: SeatService = {
    async forShowtime(id) {
      calls.push(id);
      return id === KNOWN_ID ? knownShowtime() : null;
    },
  };
  const server = createApp({
    logger: createLogger((line) => logs.push(line)),
    db: {} as never,
    redis: {} as never,
    seats,
    rateLimiter: noRateLimit,
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

test('GET /showtimes/:id/seats returns the seat map: showtime, screen, GBP price, and rows of seats', async () => {
  const app = boot();
  try {
    const res = await fetch(`${app.base}/showtimes/${KNOWN_ID}/seats`);
    assert.equal(res.status, 200);
    const body = ShowtimeSeatsResponseSchema.parse(await res.json());
    assert.equal(body.showtimeId, KNOWN_ID);
    assert.equal(body.priceFormatted, '£18.50');
    assert.ok(body.priceFormatted.startsWith('£'));
    assert.equal(body.screen.totalSeats, 320);
    assert.equal(body.rows.reduce((n, r) => n + r.seats.length, 0), body.screen.totalSeats);
    assert.deepEqual(app.calls, [KNOWN_ID]);
  } finally {
    await app.close();
  }
});

test('GET /showtimes/:id/seats is a 404 not_found for a showtime that does not exist', async () => {
  const app = boot();
  try {
    const res = await fetch(`${app.base}/showtimes/${randomUUID()}/seats`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string; requestId: string } };
    assert.equal(body.error.code, 'not_found');
    assert.ok(body.error.requestId, 'the error carries a request id');
  } finally {
    await app.close();
  }
});

test('GET /showtimes/:id/seats is a 400 validation_failed for a malformed id, and never reaches the service', async () => {
  const app = boot();
  try {
    const res = await fetch(`${app.base}/showtimes/not-a-uuid/seats`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string; details: Array<{ path: string; code: string }> } };
    assert.equal(body.error.code, 'validation_failed');
    assert.deepEqual(body.error.details, [{ path: 'params.id', code: 'invalid_uuid' }]);
    assert.deepEqual(app.calls, []);
  } finally {
    await app.close();
  }
});

test('GET /showtimes/:id/seats rejects unexpected query parameters (strict validation)', async () => {
  const app = boot();
  try {
    const res = await fetch(`${app.base}/showtimes/${KNOWN_ID}/seats?seat=A1`);
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});

test('/showtimes is not mounted when no seat service is given', async () => {
  const server = createApp({ logger: createLogger(() => {}), db: {} as never, redis: {} as never, rateLimiter: noRateLimit }).listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const res = await fetch(`http://127.0.0.1:${address.port}/showtimes/${KNOWN_ID}/seats`);
    assert.equal(res.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
