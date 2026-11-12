import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestIdMiddleware } from './requestId.js';

function fakeReqRes(headers: Record<string, string> = {}) {
  const sent: Record<string, string> = {};
  const req = { get: (name: string) => headers[name.toLowerCase()] } as never;
  const res = {
    locals: {} as Record<string, unknown>,
    setHeader: (name: string, value: string) => {
      sent[name] = value;
    },
  } as never;
  return { req, res: res as { locals: Record<string, unknown> }, sent };
}

test('generates a UUID when no X-Request-Id is sent', () => {
  const { req, res } = fakeReqRes();
  requestIdMiddleware(req, res as never, () => {});
  assert.match(String(res.locals.requestId), /^[0-9a-f-]{36}$/);
});

test('accepts a canonical UUID sent by the caller', () => {
  const incoming = '123e4567-e89b-12d3-a456-426614174000';
  const { req, res } = fakeReqRes({ 'x-request-id': incoming });
  requestIdMiddleware(req, res as never, () => {});
  assert.equal(res.locals.requestId, incoming);
});

test('replaces a non-UUID X-Request-Id instead of trusting it', () => {
  const { req, res } = fakeReqRes({ 'x-request-id': 'not-a-uuid; drop table logs' });
  requestIdMiddleware(req, res as never, () => {});
  assert.notEqual(res.locals.requestId, 'not-a-uuid; drop table logs');
  assert.match(String(res.locals.requestId), /^[0-9a-f-]{36}$/);
});
