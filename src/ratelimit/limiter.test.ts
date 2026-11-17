import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { TRUSTED_PROXY_RANGES } from '../http/clientIp.js';
import { clientIdHeader } from '../http/clientId.js';
import { createErrorHandler } from '../http/errors.js';
import { createLogger, requestLogger } from '../http/logger.js';
import { requestIdMiddleware } from '../http/requestId.js';
import { WARN_EVERY_MS, createRateLimiter } from './limiter.js';
import { RATE_LIMIT_POLICIES } from './policies.js';
import type { CheckResult, RateLimitStore, ScopeCheck } from './slidingWindow.js';

/**
 * The middleware around a FAKE store: what it asks the store, how it turns the answer into a response, and what
 * it does when the store fails. The sliding-window arithmetic itself is Lua, proven against a real Redis in
 * `slidingWindow.integration.test.ts`; nothing here pretends to test it.
 */

const CLIENT = '0A11CE00-0000-4000-8000-000000000001'; // upper case on purpose: the id is lower-cased before it is counted
const CALLER_IP = '203.0.113.7';

interface Call {
  policy: string;
  windowMs: number;
  scopes: ScopeCheck[];
  nowMs: number;
}

function boot(check: (call: Call) => Promise<CheckResult>, options: { opTimeoutMs?: number } = {}) {
  const calls: Call[] = [];
  const logs: Record<string, unknown>[] = [];
  const logger = createLogger((line) => logs.push(JSON.parse(line) as Record<string, unknown>));
  const clock = { now: 5_000_000 };
  const store: RateLimitStore = {
    check: (policy, windowMs, scopes, nowMs) => {
      const call = { policy, windowMs, scopes: [...scopes], nowMs };
      calls.push(call);
      return check(call);
    },
  };
  const limiter = createRateLimiter({
    store,
    logger,
    policies: RATE_LIMIT_POLICIES,
    clock: () => clock.now,
    opTimeoutMs: options.opTimeoutMs ?? 40,
  });

  const app = express();
  app.set('trust proxy', [...TRUSTED_PROXY_RANGES]);
  app.use(requestIdMiddleware);
  app.use(requestLogger(logger));
  let reached = 0;
  app.get('/holds', clientIdHeader({ required: false }), limiter.limit('hold'), (_req, res) => {
    reached += 1;
    res.json({ reached: true });
  });
  app.use(createErrorHandler(logger));

  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    calls,
    logs,
    clock,
    reached: () => reached,
    get: (headers: Record<string, string> = {}) => fetch(`${base}/holds`, { headers: { 'x-forwarded-for': CALLER_IP, ...headers } }),
    // The request line is written when the response closes, a moment after the client has read it.
    requestLine: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return logs.find((l) => l.msg === 'request');
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const allow = async (): Promise<CheckResult> => ({ allowed: true });

test('a request that is allowed reaches the route, and the store is asked about the user AND the address, with the policy numbers', async () => {
  const app = boot(allow);
  try {
    const res = await app.get({ 'x-client-id': CLIENT });
    assert.equal(res.status, 200);
    assert.equal(app.reached(), 1);
    assert.equal(app.calls.length, 1);
    assert.deepEqual(app.calls[0], {
      policy: 'hold',
      windowMs: RATE_LIMIT_POLICIES.hold.windowMs,
      scopes: [
        { kind: 'user', id: CLIENT.toLowerCase(), max: RATE_LIMIT_POLICIES.hold.user },
        { kind: 'ip', id: CALLER_IP, max: RATE_LIMIT_POLICIES.hold.ip },
      ],
      nowMs: app.clock.now,
    });
    assert.equal(res.headers.get('retry-after'), null);
  } finally {
    await app.close();
  }
});

test('without a client id only the address is counted; the address of an IPv6 caller is its /64', async () => {
  const app = boot(allow);
  try {
    await app.get();
    assert.deepEqual(app.calls[0]!.scopes, [{ kind: 'ip', id: CALLER_IP, max: RATE_LIMIT_POLICIES.hold.ip }]);
    await app.get({ 'x-forwarded-for': '2001:db8:abcd:12::77' });
    assert.deepEqual(app.calls[1]!.scopes, [{ kind: 'ip', id: '2001:db8:abcd:12::/64', max: RATE_LIMIT_POLICIES.hold.ip }]);
  } finally {
    await app.close();
  }
});

test('an address that is only a proxy hop is NOT counted (the safety net): the user counter still applies, and it is logged once', async () => {
  const app = boot(allow);
  try {
    const hopOnly = { 'x-forwarded-for': '100.64.7.7' };
    const withClient = await app.get({ ...hopOnly, 'x-client-id': CLIENT });
    assert.equal(withClient.status, 200);
    assert.deepEqual(app.calls[0]!.scopes, [{ kind: 'user', id: CLIENT.toLowerCase(), max: RATE_LIMIT_POLICIES.hold.user }]);

    const nobody = await app.get(hopOnly); // no id and no usable address: nothing to count, and we do not guess
    assert.equal(nobody.status, 200);
    assert.equal(app.calls.length, 1, 'the store was not asked about a request with nothing to count');

    const warnings = app.logs.filter((l) => l.msg === 'client_ip_unresolved');
    assert.equal(warnings.length, 1, 'one warning, not one per request');
    assert.equal(warnings[0]!.reason, 'infrastructure_address');
    assert.equal(warnings[0]!.policy, 'hold');
  } finally {
    await app.close();
  }
});

test('a refusal is a 429 in the usual envelope with Retry-After in whole seconds, and the route never runs', async () => {
  const app = boot(async () => ({ allowed: false, retryAfterMs: 4_200, deniedScopes: ['user'] }));
  try {
    const res = await app.get({ 'x-client-id': CLIENT });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '5', '4.2 s is rounded UP: a retry after 4 s would still be refused');
    const body = (await res.json()) as { error: { code: string; message: string; requestId: string } };
    assert.equal(body.error.code, 'rate_limited');
    assert.match(body.error.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(app.reached(), 0);

    const tiny = boot(async () => ({ allowed: false, retryAfterMs: 1, deniedScopes: ['ip'] }));
    try {
      assert.equal((await tiny.get()).headers.get('retry-after'), '1', 'never below one second');
    } finally {
      await tiny.close();
    }
  } finally {
    await app.close();
  }
});

test('the log line says which policy and which counter tripped, and never the address or the client id', async () => {
  for (const [denied, expected] of [
    [['user'], 'user'],
    [['ip'], 'ip'],
    [['ip', 'user'], 'user+ip'],
  ] as const) {
    const app = boot(async () => ({ allowed: false, retryAfterMs: 1_000, deniedScopes: [...denied] }));
    try {
      const res = await app.get({ 'x-client-id': CLIENT });
      assert.equal(res.status, 429);
      const line = await app.requestLine();
      assert.ok(line);
      assert.equal(line.status, 429);
      assert.equal(line.outcome, 'rejected');
      assert.equal(line.errorCode, 'rate_limited');
      assert.equal(line.policy, 'hold');
      assert.equal(line.scope, expected);
      const everything = JSON.stringify(app.logs);
      assert.ok(!everything.includes(CALLER_IP), 'an address is personal data and is not logged');
    } finally {
      await app.close();
    }
  }
});

test('FAIL OPEN: a store that throws lets the request through, and an outage is one warning per interval, not one per request', async () => {
  const app = boot(async () => {
    throw new Error('redis not ready (end)');
  });
  try {
    for (let i = 0; i < 5; i += 1) assert.equal((await app.get({ 'x-client-id': CLIENT })).status, 200);
    assert.equal(app.reached(), 5);

    const warnings = () => app.logs.filter((l) => l.msg === 'rate_limit_unavailable');
    assert.equal(warnings().length, 1);
    assert.equal(warnings()[0]!.reason, 'redis not ready (end)');
    assert.equal(warnings()[0]!.policy, 'hold');

    app.clock.now += WARN_EVERY_MS;
    await app.get({ 'x-client-id': CLIENT });
    assert.equal(warnings().length, 2, 'still down after the interval: said again');
  } finally {
    await app.close();
  }
});

test('FAIL OPEN: a store that never answers is given up on at the deadline, not waited for', async () => {
  const app = boot(() => new Promise<CheckResult>(() => {}), { opTimeoutMs: 40 });
  try {
    const started = Date.now();
    const res = await app.get({ 'x-client-id': CLIENT });
    const waited = Date.now() - started;
    assert.equal(res.status, 200);
    assert.ok(waited >= 35 && waited < 500, `waited ${waited} ms: about the 40 ms deadline, nowhere near a hang`);
    assert.equal(app.logs.filter((l) => l.msg === 'rate_limit_unavailable').length, 1);
  } finally {
    await app.close();
  }
});

test('a store that fails AFTER its deadline does not crash the process (no unhandled rejection)', async () => {
  const app = boot(() => new Promise<CheckResult>((_, reject) => setTimeout(() => reject(new Error('late failure')), 80)), { opTimeoutMs: 20 });
  try {
    assert.equal((await app.get({ 'x-client-id': CLIENT })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 150)); // the late rejection has now happened; the test run would fail on it
  } finally {
    await app.close();
  }
});
