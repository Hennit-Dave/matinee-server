import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from './logger.js';

test('the logger keeps the cache and TMDB-attempt fields and drops anything not on the allowlist', () => {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line));
  logger.info('x', {
    cache: 'stale',
    attempt: 2,
    upstreamStatus: 503,
    // Not allowed: must vanish even though a caller passed it.
    token: 'tok-test-9d41c7e2a5',
    authorization: 'Bearer tok-test-9d41c7e2a5',
  } as never);
  const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
  assert.equal(entry.cache, 'stale');
  assert.equal(entry.attempt, 2);
  assert.equal(entry.upstreamStatus, 503);
  assert.ok(!lines[0]?.includes('tok-test-9d41c7e2a5'));
});

test('the logger keeps the traffic-slice fields: who (userId), which showtime, how many seats', () => {
  const lines: string[] = [];
  createLogger((line) => lines.push(line)).info('hold_acquired', {
    userId: '0a11ce00-0000-4000-8000-000000000001',
    showtimeId: '11111111-1111-4111-8111-111111111111',
    seatCount: 2,
    outcome: 'ok',
  });
  const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
  assert.equal(entry.userId, '0a11ce00-0000-4000-8000-000000000001');
  assert.equal(entry.showtimeId, '11111111-1111-4111-8111-111111111111');
  assert.equal(entry.seatCount, 2);
});
