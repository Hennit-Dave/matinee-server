import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../api/app.js';
import { closeDbClients, createDbClients } from '../db/clients.js';
import { createLogger } from '../http/logger.js';
import { createRedisClient } from '../jobs/connection.js';

/**
 * Real connections, never the app's own DATABASE_URL/DATABASE_READ_URL/REDIS_URL (no agent or
 * test reads those — ADR 0007/0008). CI's service containers set TEST_DATABASE_ALLOWED=true and
 * the TEST_* URLs below; without them these tests are skipped rather than failing a machine that
 * has no disposable Postgres/Redis to point at.
 */
const allowed = process.env.TEST_DATABASE_ALLOWED === 'true';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_DATABASE_READ_URL = process.env.TEST_DATABASE_READ_URL;
const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
const skip =
  !allowed || !TEST_DATABASE_URL || !TEST_DATABASE_READ_URL || !TEST_REDIS_URL
    ? 'set TEST_DATABASE_ALLOWED=true, TEST_DATABASE_URL, TEST_DATABASE_READ_URL, TEST_REDIS_URL to run'
    : false;

async function fetchHealth(server: import('node:http').Server): Promise<{ status: number; body: unknown }> {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server has no port');
  const res = await fetch(`http://127.0.0.1:${address.port}/health`);
  return { status: res.status, body: await res.json() };
}

test('GET /health is 200 against real Postgres and Redis', { skip }, async () => {
  const logger = createLogger(() => {});
  const db = createDbClients({ primaryUrl: TEST_DATABASE_URL, readUrl: TEST_DATABASE_READ_URL });
  const redis = createRedisClient(logger, TEST_REDIS_URL);
  const server = createApp({ logger, db, redis }).listen(0);
  try {
    const { status, body } = await fetchHealth(server);
    assert.equal(status, 200);
    assert.equal((body as { ok: boolean }).ok, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    redis.disconnect();
    await closeDbClients(db);
  }
});

test('GET /health is 503 when Redis is unreachable', { skip }, async () => {
  const logger = createLogger(() => {});
  const db = createDbClients({ primaryUrl: TEST_DATABASE_URL, readUrl: TEST_DATABASE_READ_URL });
  // Nothing listens on this port: proves the real 503 path, not just the unit-test fakes.
  const redis = createRedisClient(logger, 'redis://127.0.0.1:9');
  const server = createApp({ logger, db, redis }).listen(0);
  try {
    const { status, body } = await fetchHealth(server);
    assert.equal(status, 503);
    assert.equal((body as { checks: { redis: { status: string } } }).checks.redis.status, 'error');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    redis.disconnect();
    await closeDbClients(db);
  }
});
