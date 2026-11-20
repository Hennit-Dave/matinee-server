import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withSslModeVerifyFull } from './clients.js';

// A realistic Neon pooled URL, with and without an existing sslmode.
const NEON = 'postgresql://user:pass@ep-fancy-pooler.eu-west-2.aws.neon.tech/neondb';

test('a Neon URL without sslmode gets verify-full appended', () => {
  assert.equal(withSslModeVerifyFull(NEON), `${NEON}?sslmode=verify-full`);
});

test('an existing sslmode=require is replaced with verify-full, other params are kept', () => {
  assert.equal(
    withSslModeVerifyFull(`${NEON}?sslmode=require`),
    `${NEON}?sslmode=verify-full`
  );
  assert.equal(
    withSslModeVerifyFull(`${NEON}?schema=public&sslmode=require`),
    `${NEON}?schema=public&sslmode=verify-full`
  );
});

test('pinning is idempotent: verify-full stays verify-full', () => {
  assert.equal(withSslModeVerifyFull(`${NEON}?sslmode=verify-full`), `${NEON}?sslmode=verify-full`);
});

test('a percent-encoded password survives the round-trip unchanged', () => {
  const url = 'postgresql://user:p%40ss%2Fword@ep-fancy-pooler.eu-west-2.aws.neon.tech/neondb';
  assert.equal(withSslModeVerifyFull(url), `${url}?sslmode=verify-full`);
});

test('loopback hosts (local dev / CI) are left alone: no TLS to pin', () => {
  for (const url of [
    'postgresql://matinee@localhost:5432/matinee',
    'postgresql://ci:ci@127.0.0.1:5432/ci',
    'postgresql://user@[::1]:5432/db',
    'postgresql://user@localhost/db?sslmode=disable',
  ]) {
    assert.equal(withSslModeVerifyFull(url), url, url);
  }
});

test('an unparseable or hostless URL is returned as given', () => {
  assert.equal(withSslModeVerifyFull('postgresql:///db?host=/var/run/postgres'), 'postgresql:///db?host=/var/run/postgres');
});
