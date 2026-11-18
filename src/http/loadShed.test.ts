import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { createErrorHandler } from './errors.js';
import { createLoadShedder, readMaxInFlight } from './loadShed.js';
import { createLogger } from './logger.js';
import { testFetch } from './testFetch.js';

function boot(maxInFlight: number, random = () => 0) {
  const logs: Record<string, unknown>[] = [];
  const logger = createLogger((line) => logs.push(JSON.parse(line) as Record<string, unknown>));
  const gates: (() => void)[] = [];
  const app = express();
  const shed = createLoadShedder({ maxInFlight, logger, random });
  app.use(shed);
  app.get('/health', (_req, res) => void res.json({ ok: true }));
  app.get('/slow', (_req, res) => {
    gates.push(() => res.json({ ok: true }));
  });
  app.delete('/holds', (_req, res) => void res.json({ released: [] }));
  app.use(createErrorHandler(logger));
  const server: Server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    shed,
    logs,
    gates,
    release: () => gates.splice(0).forEach((open) => open()),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** Waits for a condition instead of a fixed time: a slower machine (CI) just takes longer, it does not fail. */
async function until(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

test('past the limit a request is refused AT ONCE with 503 server_busy and a Retry-After, while the others still finish', async () => {
  const app = boot(2);
  try {
    const first = testFetch(`${app.base}/slow`);
    const second = testFetch(`${app.base}/slow`);
    await until(() => app.shed.inFlight() === 2, 'two requests in flight');

    const shed = await testFetch(`${app.base}/slow`);
    assert.equal(shed.status, 503);
    assert.equal(shed.headers.get('retry-after'), '5', 'random() = 0 gives the shortest wait');
    const body = (await shed.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'server_busy');
    assert.equal(app.logs.filter((l) => l.msg === 'load_shed').length, 1);

    app.release();
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
  } finally {
    await app.close();
  }
});

test('the Retry-After is JITTERED between 5 and 15 s, so refused clients do not all come back in the same second', async () => {
  for (const [random, expected] of [[0, '5'], [0.5, '10'], [0.999, '15']] as const) {
    const app = boot(1, () => random);
    try {
      const held = testFetch(`${app.base}/slow`);
      await until(() => app.shed.inFlight() === 1, 'one request in flight');
      assert.equal((await testFetch(`${app.base}/slow`)).headers.get('retry-after'), expected);
      app.release();
      await held;
    } finally {
      await app.close();
    }
  }
});

test('the count goes back down: once the slow requests finish, new ones are served again', async () => {
  const app = boot(1);
  try {
    const held = testFetch(`${app.base}/slow`);
    await until(() => app.shed.inFlight() === 1, 'one request in flight');
    app.release();
    await held;
    await until(() => app.shed.inFlight() === 0, 'the slot to be freed');
    const next = testFetch(`${app.base}/slow`);
    await until(() => app.shed.inFlight() === 1, 'the next request in flight');
    app.release();
    assert.equal((await next).status, 200);
  } finally {
    await app.close();
  }
});

test('a client that goes away mid-request does not leak a slot', async () => {
  const app = boot(1);
  try {
    const controller = new AbortController();
    const aborted = testFetch(`${app.base}/slow`, { signal: controller.signal }).catch(() => undefined);
    await until(() => app.shed.inFlight() === 1, 'one request in flight');
    controller.abort();
    await aborted;
    await until(() => app.shed.inFlight() === 0, 'the abort to free the slot');
  } finally {
    await app.close();
  }
});

test('NEVER shed: /health and every DELETE (the cleanup paths), even when full', async () => {
  const app = boot(1);
  try {
    const held = testFetch(`${app.base}/slow`);
    await until(() => app.shed.inFlight() === 1, 'one request in flight');
    assert.equal((await testFetch(`${app.base}/slow`)).status, 503, 'the room is full');
    assert.equal((await testFetch(`${app.base}/health`)).status, 200);
    assert.equal((await testFetch(`${app.base}/holds`, { method: 'DELETE' })).status, 200);
    app.release();
    await held;
  } finally {
    await app.close();
  }
});

test('a limit of 0 means no shedding at all', async () => {
  const app = boot(0);
  try {
    const many = Array.from({ length: 6 }, () => testFetch(`${app.base}/slow`));
    await until(() => app.gates.length === 6, 'six requests waiting');
    app.release();
    assert.ok((await Promise.all(many)).every((r) => r.status === 200));
  } finally {
    await app.close();
  }
});

test('readMaxInFlight: 250 by default, 0 for the load test, an explicit value beats the profile, a bad value stops the server', () => {
  assert.deepEqual(readMaxInFlight({}), { maxInFlight: 250, profile: 'default' });
  assert.equal(readMaxInFlight({ TRAFFIC_PROFILE: 'loadtest' }).maxInFlight, 0);
  assert.equal(readMaxInFlight({ TRAFFIC_PROFILE: 'loadtest', MAX_IN_FLIGHT: '800' }).maxInFlight, 800);
  assert.equal(readMaxInFlight({ MAX_IN_FLIGHT: '0' }).maxInFlight, 0);
  assert.throws(() => readMaxInFlight({ MAX_IN_FLIGHT: '-1' }), /MAX_IN_FLIGHT must be a whole number/);
});
