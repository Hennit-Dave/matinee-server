/**
 * BASELINE for slice 5c (run on `main` before any limiter exists):
 *
 *   source <env with TEST_DATABASE_* and TEST_REDIS_URL> && npx tsx docs/evidence/traffic-5c/before.ts
 *
 * Fires a burst at the three routes the limiter will guard, from ONE install and ONE address, against the
 * real app on a throwaway local Postgres and Redis (the testkit refuses any non-loopback Redis). The hold
 * requests carry an empty body, so each is a 400 before any seat is touched: free to repeat, nothing held.
 */
import { randomUUID } from 'node:crypto';
import { freshShowtime, openStack } from '../../../src/bookings/testkit.js';

const stack = await openStack();
try {
  const client = randomUUID();
  const { showtimeId } = await freshShowtime(stack.db, 1, stack.redis);

  async function burst(label: string, count: number, send: () => Promise<Response>) {
    const histogram = new Map<number, number>();
    let retryAfterSeen = false;
    const started = performance.now();
    for (let i = 0; i < count; i += 1) {
      const res = await send();
      histogram.set(res.status, (histogram.get(res.status) ?? 0) + 1);
      if (res.headers.get('retry-after') !== null) retryAfterSeen = true;
      await res.arrayBuffer();
    }
    const seconds = ((performance.now() - started) / 1000).toFixed(2);
    const counts = [...histogram].map(([status, n]) => `${status} x${n}`).join(', ');
    process.stdout.write(`${label}: ${count} requests in ${seconds}s -> ${counts}; Retry-After header seen: ${retryAfterSeen}\n`);
  }

  process.stdout.write(`one X-Client-Id, one loopback address, sequential\n`);
  await burst('POST /showtimes/:id/holds (empty body -> 400)', 200, () =>
    fetch(`${stack.base}/showtimes/${showtimeId}/holds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client-id': client },
      body: '{}',
    }),
  );
  await burst('POST /showtimes/:id/bookings (empty body -> 400)', 100, () =>
    fetch(`${stack.base}/showtimes/${showtimeId}/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client-id': client },
      body: '{}',
    }),
  );
  await burst('GET /showtimes/:id/seats (the map)', 400, () =>
    fetch(`${stack.base}/showtimes/${showtimeId}/seats`, { headers: { 'x-client-id': client } }),
  );
  process.stdout.write('no 429 anywhere: nothing limits how often one install or one address may call these routes\n');
} finally {
  await stack.close();
}
