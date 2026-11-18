import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from '../api/app.js';
import type { BookingService } from '../bookings/bookingService.js';
import { ApiError } from '../http/errors.js';
import { createLogger } from '../http/logger.js';
import type { RateLimiter } from '../ratelimit/limiter.js';
import type { SeatService } from '../showtimes/seat.js';
import { QueueStateSchema, type QueueState } from './queue.js';
import type { RoomState, WaitingRoomStore } from './store.js';
import { createWaitingRoom, type WaitingRoom } from './waitingRoom.js';
import { testFetch } from '../http/testFetch.js';

const SHOWTIME = '11111111-1111-4111-8111-111111111111';
const SEAT = 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const CLIENT = { 'x-client-id': '0a11ce00-0000-4000-8000-000000000001' };

function fakeRoom(state: QueueState | { status: 'full' } = { status: 'admitted', passExpiresInMs: 30_000 }) {
  const calls: string[] = [];
  const room: WaitingRoom = {
    enabled: true,
    async join(showtimeId, ownerId) {
      calls.push(`join ${showtimeId} ${ownerId}`);
      return state;
    },
    async poll(showtimeId, ownerId) {
      calls.push(`poll ${showtimeId} ${ownerId}`);
      return state.status === 'full' ? { status: 'not_queued' } : state;
    },
    async leave(showtimeId, ownerId) {
      calls.push(`leave ${showtimeId} ${ownerId}`);
    },
    gate: () => (_req, _res, next) => next(),
  };
  return { room, calls };
}

function serve(app: ReturnType<typeof createApp>) {
  const server: Server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { base: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

function bootQueue(state?: QueueState | { status: 'full' }, exists = async (id: string) => id === SHOWTIME) {
  const { room, calls } = fakeRoom(state);
  const policies: string[] = [];
  const rateLimiter: RateLimiter = { limit: (name) => (_req, _res, next) => { policies.push(name); next(); } };
  const app = createApp({ logger: createLogger(() => {}), db: {} as never, redis: {} as never, rateLimiter, waitingRoom: room, showtimeExists: exists });
  return { ...serve(app), calls, policies };
}

const call = (base: string, method: string, path: string, headers: Record<string, string> | null = CLIENT) => testFetch(`${base}${path}`, { method, headers: headers ?? {} });

test('POST /showtimes/:id/queue answers 200 with a state the schema accepts: admitted, or waiting with people ahead and a poll interval', async () => {
  for (const state of [{ status: 'admitted', passExpiresInMs: 30_000 }, { status: 'waiting', ahead: 4, pollAfterMs: 3000 }] as const) {
    const app = bootQueue(state);
    try {
      const res = await call(app.base, 'POST', `/showtimes/${SHOWTIME}/queue`);
      assert.equal(res.status, 200);
      assert.deepEqual(QueueStateSchema.parse(await res.json()), state);
      assert.deepEqual(app.calls, [`join ${SHOWTIME} ${CLIENT['x-client-id']}`]);
    } finally {
      await app.close();
    }
  }
});

test('there is no estimated wait anywhere in a waiting answer: people ahead and nothing else', async () => {
  const app = bootQueue({ status: 'waiting', ahead: 128, pollAfterMs: 15000 });
  try {
    const body = (await (await call(app.base, 'GET', `/showtimes/${SHOWTIME}/queue`)).json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['ahead', 'pollAfterMs', 'status']);
  } finally {
    await app.close();
  }
});

test('a full line is 503 waiting_room_full with a Retry-After', async () => {
  const app = bootQueue({ status: 'full' });
  try {
    const res = await call(app.base, 'POST', `/showtimes/${SHOWTIME}/queue`);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), '10');
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'waiting_room_full');
  } finally {
    await app.close();
  }
});

test('a showing that does not exist is a 404 and the room is never asked, so junk ids never become Redis keys', async () => {
  const app = bootQueue();
  try {
    const res = await call(app.base, 'POST', `/showtimes/22222222-2222-4222-8222-222222222222/queue`);
    assert.equal(res.status, 404);
    assert.deepEqual(app.calls, []);
  } finally {
    await app.close();
  }
});

test('GET reports where you stand without joining, and DELETE leaves (idempotent)', async () => {
  const app = bootQueue({ status: 'waiting', ahead: 2, pollAfterMs: 3000 });
  try {
    assert.equal((await call(app.base, 'GET', `/showtimes/${SHOWTIME}/queue`)).status, 200);
    for (let i = 0; i < 2; i += 1) {
      const left = await call(app.base, 'DELETE', `/showtimes/${SHOWTIME}/queue`);
      assert.equal(left.status, 200);
      assert.deepEqual(await left.json(), { status: 'not_queued' });
    }
    assert.deepEqual(app.calls.map((c) => c.split(' ')[0]), ['poll', 'leave', 'leave']);
  } finally {
    await app.close();
  }
});

test('every route needs a valid X-Client-Id and a UUID showing id (400), and nothing reaches the room without them', async () => {
  const app = bootQueue();
  try {
    for (const method of ['POST', 'GET', 'DELETE']) {
      assert.equal((await call(app.base, method, `/showtimes/${SHOWTIME}/queue`, null)).status, 400, `${method} without a client id`);
      assert.equal((await call(app.base, method, `/showtimes/not-a-uuid/queue`)).status, 400, `${method} with a bad id`);
    }
    assert.deepEqual(app.calls, []);
  } finally {
    await app.close();
  }
});

test('join and poll are rate limited with the "queue" policy; leaving is NOT (it is the cleanup path, like releasing seats)', async () => {
  const app = bootQueue({ status: 'waiting', ahead: 1, pollAfterMs: 3000 });
  try {
    await call(app.base, 'POST', `/showtimes/${SHOWTIME}/queue`);
    await call(app.base, 'GET', `/showtimes/${SHOWTIME}/queue`);
    assert.deepEqual(app.policies, ['queue', 'queue']);
    await call(app.base, 'DELETE', `/showtimes/${SHOWTIME}/queue`);
    assert.deepEqual(app.policies, ['queue', 'queue'], 'the DELETE added no limit');
  } finally {
    await app.close();
  }
});

test('the queue routes are not mounted without a waiting room (same convention as the seat routes)', async () => {
  const server = serve(createApp({ logger: createLogger(() => {}), db: {} as never, redis: {} as never, rateLimiter: { limit: () => (_q, _s, n) => n() } }));
  try {
    assert.equal((await call(server.base, 'POST', `/showtimes/${SHOWTIME}/queue`)).status, 404);
  } finally {
    await server.close();
  }
});

// ---- the order: who is calling, THEN the rate limit, THEN the gate, THEN the body --------------------

function bootGated(hasPass: boolean, refuseWith?: ApiError) {
  const touched: string[] = [];
  const store: WaitingRoomStore = {
    async join() { return { status: 'admitted', passExpiresInMs: 1 } satisfies RoomState; },
    async poll() { return { status: 'admitted', passExpiresInMs: 1 } satisfies RoomState; },
    async touch(showtimeId, ownerId) { touched.push(`${showtimeId} ${ownerId}`); return hasPass; },
    async leave() {},
  };
  const holds = { heldCount: async () => 0 };
  const room = createWaitingRoom({ store, holds, config: { enabled: true, maxActive: 2, admitPerMinute: 12, maxActiveIsDefault: false } });
  const served: string[] = [];
  const seats = { async forShowtime() { served.push('seats'); return null; } } as unknown as SeatService;
  const bookings: BookingService = {
    async acquireHolds(r) { served.push('hold'); return { showtimeId: r.showtimeId, seatIds: [...r.seatIds], expiresAt: '2026-11-20T20:10:00.000Z', expiresInMs: 600_000 }; },
    async releaseHolds(r) { served.push('release'); return { released: [...r.seatIds] }; },
    async confirmBooking() { served.push('book'); throw new ApiError('seat_not_held', { seatIds: [SEAT] }); },
  };
  const rateLimiter: RateLimiter = { limit: () => (_req, _res, next) => next(refuseWith) };
  const app = createApp({ logger: createLogger(() => {}), db: {} as never, redis: {} as never, rateLimiter, seats, bookings, waitingRoom: room, showtimeExists: async () => true });
  return { ...serve(app), touched, served };
}

const post = (base: string, path: string, body: string) => testFetch(`${base}${path}`, { method: 'POST', headers: { ...CLIENT, 'content-type': 'application/json' }, body });

test('GATED: the seat map and taking a hold need a pass; without one the answer is 403 and the service is never asked', async () => {
  const app = bootGated(false);
  try {
    const map = await call(app.base, 'GET', `/showtimes/${SHOWTIME}/seats`);
    assert.equal(map.status, 403);
    assert.equal(((await map.json()) as { error: { code: string } }).error.code, 'waiting_room_required');
    assert.equal((await post(app.base, `/showtimes/${SHOWTIME}/holds`, JSON.stringify({ seatIds: [SEAT] }))).status, 403);
    assert.deepEqual(app.served, []);
  } finally {
    await app.close();
  }
});

test('the gate runs BEFORE the body is parsed: a flood without a pass is refused for the price of a header read (403, not a JSON error)', async () => {
  const app = bootGated(false);
  try {
    const res = await post(app.base, `/showtimes/${SHOWTIME}/holds`, '{ this is not json');
    assert.equal(res.status, 403);
  } finally {
    await app.close();
  }
});

test('NOT gated: releasing seats and booking (you already hold the seats, which needed the pass)', async () => {
  const app = bootGated(false);
  try {
    const release = await testFetch(`${app.base}/showtimes/${SHOWTIME}/holds`, { method: 'DELETE', headers: { ...CLIENT, 'content-type': 'application/json' }, body: JSON.stringify({ seatIds: [SEAT] }) });
    assert.equal(release.status, 200);
    const book = await post(app.base, `/showtimes/${SHOWTIME}/bookings`, JSON.stringify({ seatIds: [SEAT] }));
    assert.equal(book.status, 409, 'it reached the booking service, which said seat_not_held');
    assert.deepEqual(app.served, ['release', 'book']);
    assert.deepEqual(app.touched, [], 'neither route even looked at the room');
  } finally {
    await app.close();
  }
});

test('WITH a pass the map is served, and the gate is what renewed the pass (the seat-map poll is the heartbeat)', async () => {
  const app = bootGated(true);
  try {
    assert.equal((await call(app.base, 'GET', `/showtimes/${SHOWTIME}/seats`)).status, 404, 'the stub service returns no showing, which is a 404: it was reached');
    assert.deepEqual(app.touched, [`${SHOWTIME} ${CLIENT['x-client-id']}`]);
    assert.deepEqual(app.served, ['seats']);
  } finally {
    await app.close();
  }
});

test('the RATE LIMIT runs before the gate: a refused request costs the room nothing', async () => {
  const app = bootGated(true, new ApiError('rate_limited', { retryAfterSeconds: 7 }));
  try {
    assert.equal((await call(app.base, 'GET', `/showtimes/${SHOWTIME}/seats`)).status, 429);
    assert.equal((await post(app.base, `/showtimes/${SHOWTIME}/holds`, JSON.stringify({ seatIds: [SEAT] }))).status, 429);
    assert.deepEqual(app.touched, []);
  } finally {
    await app.close();
  }
});

test('a showing id that is not a UUID is a 400 from the route, not a 403 and not a Redis lookup', async () => {
  const app = bootGated(false);
  try {
    assert.equal((await call(app.base, 'GET', `/showtimes/not-a-uuid/seats`)).status, 400);
    assert.deepEqual(app.touched, []);
  } finally {
    await app.close();
  }
});
