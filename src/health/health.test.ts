import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHealthHandler, type HealthReport } from './health.js';
import type { DbClients } from '../db/clients.js';

function queryRaw(ok: boolean) {
  return async () => {
    if (!ok) throw new Error('connection refused');
    return [{ '1': 1 }];
  };
}

function fakeDb(primaryOk: boolean, replicaOk: boolean): DbClients {
  return {
    primary: { $queryRaw: queryRaw(primaryOk) } as never,
    reader: { $replica: () => ({ $queryRaw: queryRaw(replicaOk) }) } as never,
  };
}

function fakeRedis(ok: boolean) {
  return { ping: ok ? async () => 'PONG' : async () => { throw new Error('ECONNREFUSED'); } } as never;
}

async function runHandler(db: DbClients, redis: ReturnType<typeof fakeRedis>): Promise<{ status: number; body: HealthReport }> {
  return new Promise((resolve) => {
    const handler = createHealthHandler(db, redis);
    const res = {
      status(code: number) {
        return {
          json(body: HealthReport) {
            resolve({ status: code, body });
          },
        };
      },
    };
    handler({} as never, res as never, (() => {}) as never);
  });
}

test('200 and ok:true when every dependency answers', async () => {
  const { status, body } = await runHandler(fakeDb(true, true), fakeRedis(true));
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.checks.postgresPrimary.status, 'ok');
  assert.equal(body.checks.postgresReplica.status, 'ok');
  assert.equal(body.checks.redis.status, 'ok');
});

test('503 when the primary is unreachable, with the reason reported', async () => {
  const { status, body } = await runHandler(fakeDb(false, true), fakeRedis(true));
  assert.equal(status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.checks.postgresPrimary.status, 'error');
  assert.match(body.checks.postgresPrimary.reason ?? '', /connection refused/);
});

test('503 when only Redis is unreachable', async () => {
  const { status, body } = await runHandler(fakeDb(true, true), fakeRedis(false));
  assert.equal(status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.checks.redis.status, 'error');
  assert.equal(body.checks.postgresPrimary.status, 'ok');
});

test('503 when only the replica is unreachable', async () => {
  const { status, body } = await runHandler(fakeDb(true, false), fakeRedis(true));
  assert.equal(status, 503);
  assert.equal(body.checks.postgresReplica.status, 'error');
});
