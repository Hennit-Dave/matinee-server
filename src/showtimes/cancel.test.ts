import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../api/app.js';
import { createLogger } from '../http/logger.js';
import { testFetch } from '../http/testFetch.js';
import { noRateLimit } from '../ratelimit/limiter.js';
import { createCancelShowtimeService, type CancelShowtimeService } from './cancelService.js';
import type { ShowtimeCancelRepo } from './cancelRepo.js';

const SHOWTIME = '11111111-1111-4111-8111-111111111111';
const ADMIN_KEY = 'a-real-admin-secret';

function fakeRepo(): ShowtimeCancelRepo & { marked: number } {
  let cancelledAt: Date | null = null; // null = live (exists, not cancelled)
  const repo: ShowtimeCancelRepo & { marked: number } = {
    marked: 0,
    async state(showtimeId) {
      return showtimeId === SHOWTIME ? { cancelledAt } : null;
    },
    async markCancelled() {
      repo.marked += 1;
      cancelledAt = new Date('2026-11-20T19:00:00.000Z');
      return true;
    },
    async isCancelled() {
      return cancelledAt != null;
    },
  };
  return repo;
}

// ---- The service (mark idempotent + always enqueue) -----------------------------------------------

test('cancelling marks the showtime and enqueues the refund job; a second call is alreadyCancelled but still enqueues', async () => {
  const repo = fakeRepo();
  const enqueued: { name: string; data: Record<string, string> }[] = [];
  const service = createCancelShowtimeService({ repo, enqueue: async (name, data) => { enqueued.push({ name, data }); } });

  const first = await service.cancel(SHOWTIME, 'req-1');
  assert.deepEqual(first, { showtimeId: SHOWTIME, cancelled: true, alreadyCancelled: false });
  assert.equal(repo.marked, 1);

  const second = await service.cancel(SHOWTIME, 'req-2');
  assert.deepEqual(second, { showtimeId: SHOWTIME, cancelled: true, alreadyCancelled: true });
  assert.equal(repo.marked, 1, 'the mark write ran once: re-cancel is idempotent');

  assert.equal(enqueued.length, 2, 'every cancel enqueues the job (re-run is the reconciliation path)');
  assert.deepEqual(enqueued[0], { name: 'showtime.cancelled', data: { showtimeId: SHOWTIME } });
});

test('cancelling an unknown showtime is not_found and enqueues nothing', async () => {
  const repo = fakeRepo();
  const enqueued: unknown[] = [];
  const service = createCancelShowtimeService({ repo, enqueue: async (name, data) => { enqueued.push({ name, data }); } });
  await assert.rejects(service.cancel('00000000-0000-4000-8000-00000000dead'), (e: unknown) => (e as { code?: string }).code === 'not_found');
  assert.equal(enqueued.length, 0);
});

// ---- The route (admin key gate) --------------------------------------------------------------------

function bootRoute(adminKey?: string) {
  const calls: { showtimeId: string; requestId: string }[] = [];
  const service: CancelShowtimeService = {
    async cancel(showtimeId, requestId) {
      calls.push({ showtimeId, requestId: requestId ?? '' });
      return { showtimeId, cancelled: true, alreadyCancelled: false };
    },
  };
  const server = createApp({
    logger: createLogger(() => {}),
    db: {} as never,
    redis: {} as never,
    rateLimiter: noRateLimit,
    cancel: service,
    adminKey,
  }).listen(0);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    calls,
    send: (headers: Record<string, string> | null) =>
      testFetch(`${base}/admin/showtimes/${SHOWTIME}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json', ...(headers ?? {}) } }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('the correct X-Admin-Key cancels; a wrong or missing key is a 403 and never reaches the service', async () => {
  const app = bootRoute(ADMIN_KEY);
  try {
    const ok = await app.send({ 'x-admin-key': ADMIN_KEY });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { showtimeId: SHOWTIME, cancelled: true, alreadyCancelled: false });

    const wrong = await app.send({ 'x-admin-key': 'nope' });
    assert.equal(wrong.status, 403);
    assert.equal(((await wrong.json()) as { error: { code: string } }).error.code, 'invalid_admin_key');

    const missing = await app.send(null);
    assert.equal(missing.status, 403);

    assert.equal(app.calls.length, 1, 'only the authorised request reached the service');
  } finally {
    await app.close();
  }
});

test('without ADMIN_API_KEY the cancel route is not mounted at all', async () => {
  const app = bootRoute(undefined);
  try {
    const res = await app.send({ 'x-admin-key': ADMIN_KEY });
    assert.equal(res.status, 404);
    assert.equal(app.calls.length, 0);
  } finally {
    await app.close();
  }
});
