import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from './errors.js';
import { clientIdHeader } from './clientId.js';

const ID = '0A11CE00-0000-4000-8000-000000000001';

function run(options: { required: boolean }, header: string | undefined) {
  const res = { locals: {} as Record<string, unknown> };
  let forwarded: unknown = 'not called';
  clientIdHeader(options)({ get: () => header } as never, res as never, (err?: unknown) => {
    forwarded = err;
  });
  return { res, forwarded };
}

test('a valid id is accepted, lower-cased, and left for handlers and the request log', () => {
  const { res, forwarded } = run({ required: true }, ID);
  assert.equal(forwarded, undefined);
  assert.equal(res.locals.clientId, ID.toLowerCase());
  assert.equal(res.locals.userId, ID.toLowerCase());
});

test('required: a missing id and a malformed id are both a 400 naming the header, never its value', () => {
  for (const [header, code] of [[undefined, 'required'], ['abc', 'invalid_uuid'], ['', 'invalid_uuid'], [`${ID},${ID}`, 'invalid_uuid']] as const) {
    const { forwarded } = run({ required: true }, header);
    assert.ok(forwarded instanceof ApiError);
    assert.equal(forwarded.status, 400);
    assert.deepEqual(forwarded.details, [{ path: 'header.x-client-id', code }]);
  }
});

test('optional: absent is fine and anonymous, but a malformed id is still refused', () => {
  const absent = run({ required: false }, undefined);
  assert.equal(absent.forwarded, undefined);
  assert.equal(absent.res.locals.clientId, undefined);

  const bad = run({ required: false }, 'abc');
  assert.ok(bad.forwarded instanceof ApiError);
});
