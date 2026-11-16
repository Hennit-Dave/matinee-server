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

test('upstream_unavailable is a retryable 503 and its internal reason is not sent', () => {
  assert.equal(new ApiError('upstream_unavailable').status, 503);
  const handler = createErrorHandler(createLogger(() => {}));
  const { res, state } = fakeRes();
  handler(new ApiError('upstream_unavailable', { reason: 'movie source: rejected' }), {} as never, res, (() => {}) as never);
  const body = state.body as { error: { code: string } };
  assert.equal(state.status, 503);
  assert.equal(body.error.code, 'upstream_unavailable');
  assert.ok(!JSON.stringify(body).includes('rejected'));
});

test('the traffic-slice codes: two 409s that name the seats, and a retryable 503 with Retry-After', () => {
  assert.equal(new ApiError('seat_taken').status, 409);
  assert.equal(new ApiError('seat_not_held').status, 409);
  assert.equal(new ApiError('holds_unavailable').status, 503);

  const handler = createErrorHandler(createLogger(() => {}));
  const headers: Record<string, string> = {};
  const { res, state } = fakeRes();
  (res as unknown as { setHeader: (k: string, v: string) => void }).setHeader = (k, v) => {
    headers[k] = v;
  };
  handler(new ApiError('seat_taken', { seatIds: ['s1'] }), {} as never, res, (() => {}) as never);
  assert.deepEqual((state.body as { error: { seatIds: string[] } }).error.seatIds, ['s1']);
  assert.deepEqual(headers, {}, 'no Retry-After on a 409');

  handler(new ApiError('holds_unavailable', { reason: 'redis not ready (end)' }), {} as never, res, (() => {}) as never);
  assert.equal(headers['Retry-After'], '2');
  assert.ok(!JSON.stringify(state.body).includes('redis'), 'the internal reason is not sent');
});
