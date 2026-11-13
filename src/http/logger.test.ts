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
