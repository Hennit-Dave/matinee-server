import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createErrorHandler, notFoundHandler } from './errors.js';
import { createLogger } from './logger.js';

function fakeRes() {
  const state = { status: 0, body: undefined as unknown, locals: {} as Record<string, unknown> };
  const res = {
    locals: state.locals,
    headersSent: false,
    status(code: number) {
      state.status = code;
      return this;
    },
    json(body: unknown) {
      state.body = body;
      return this;
    },
  };
  return { res: res as never, state };
}

test('ApiError carries the right status for each code', () => {
  assert.equal(new ApiError('not_found').status, 404);
  assert.equal(new ApiError('validation_failed').status, 400);
  assert.equal(new ApiError('service_unavailable').status, 503);
});

test('notFoundHandler forwards a not_found ApiError', () => {
  let forwarded: unknown;
  notFoundHandler({} as never, {} as never, (err?: unknown) => {
    forwarded = err;
  });
  assert.ok(forwarded instanceof ApiError);
  assert.equal(forwarded.code, 'not_found');
});

test('error handler responds with the error envelope and never a stack trace', () => {
  const logger = createLogger(() => {});
  const handler = createErrorHandler(logger);
  const { res, state } = fakeRes();
  handler(new ApiError('not_found'), {} as never, res, (() => {}) as never);
  assert.equal(state.status, 404);
  const body = state.body as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'not_found');
  assert.ok(!JSON.stringify(body).includes('at ')); // no stack trace lines
});

test('an unexpected error becomes internal_error without leaking its message', () => {
  const logger = createLogger(() => {});
  const handler = createErrorHandler(logger);
  const { res, state } = fakeRes();
  handler(new Error('db password is wrong'), {} as never, res, (() => {}) as never);
  assert.equal(state.status, 500);
  const body = state.body as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'internal_error');
  assert.ok(!JSON.stringify(body).includes('db password'));
});
