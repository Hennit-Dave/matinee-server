import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { validateRequest } from './validate.js';
import { ApiError } from './errors.js';

function run(handler: ReturnType<typeof validateRequest>, req: { params?: unknown; query?: unknown; body?: unknown }) {
  let nextArg: unknown;
  const fullReq = { params: {}, query: {}, body: undefined, ...req } as never;
  handler(fullReq, {} as never, (arg?: unknown) => {
    nextArg = arg;
  });
  return { req: fullReq as { validated?: unknown }, nextArg };
}

test('passes through and sets req.validated on success', () => {
  const handler = validateRequest({ body: z.strictObject({ name: z.string() }) });
  const { req, nextArg } = run(handler, { body: { name: 'Dave' } });
  assert.equal(nextArg, undefined);
  assert.deepEqual(req.validated, { params: {}, query: {}, body: { name: 'Dave' } });
});

test('rejects an unknown body key as validation_failed with no echoed value', () => {
  const handler = validateRequest({ body: z.strictObject({ name: z.string() }) });
  const { nextArg } = run(handler, { body: { name: 'Dave', extra: 'secret-value' } });
  assert.ok(nextArg instanceof ApiError);
  assert.equal(nextArg.code, 'validation_failed');
  const json = JSON.stringify(nextArg.details);
  assert.ok(!json.includes('secret-value'));
});

test('treats a missing body as an empty object when no body schema is given', () => {
  const handler = validateRequest({});
  const { nextArg } = run(handler, { body: undefined });
  assert.equal(nextArg, undefined);
});

test('rejects a body when no schema is given but one was sent', () => {
  const handler = validateRequest({});
  const { nextArg } = run(handler, { body: { unexpected: true } });
  assert.ok(nextArg instanceof ApiError);
  assert.equal(nextArg.code, 'validation_failed');
});
