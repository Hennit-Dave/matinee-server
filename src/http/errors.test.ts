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

test('rate_limited is a 429 with a Retry-After of whole seconds (never below 1) and no word about which counter tripped', () => {
  assert.equal(new ApiError('rate_limited').status, 429);

  const handler = createErrorHandler(createLogger(() => {}));
  const retryAfter = (error: ApiError) => {
    const headers: Record<string, string> = {};
    const { res, state } = fakeRes();
    (res as unknown as { setHeader: (k: string, v: string) => void }).setHeader = (k, v) => {
      headers[k] = v;
    };
    handler(error, {} as never, res, (() => {}) as never);
    return { header: headers['Retry-After'], state };
  };

  assert.equal(retryAfter(new ApiError('rate_limited', { retryAfterSeconds: 5 })).header, '5');
  assert.equal(retryAfter(new ApiError('rate_limited', { retryAfterSeconds: 4.2 })).header, '5', 'rounded up, never down');
  assert.equal(retryAfter(new ApiError('rate_limited', { retryAfterSeconds: 0 })).header, '1', 'never 0');
  assert.equal(retryAfter(new ApiError('rate_limited')).header, '1', 'a missing value still gives a usable header');

  const { state } = retryAfter(new ApiError('rate_limited', { retryAfterSeconds: 5, reason: 'scope user+ip' }));
  assert.equal(state.status, 429);
  const body = state.body as { error: Record<string, unknown> };
  assert.equal(body.error.code, 'rate_limited');
  assert.ok(!('retryAfterSeconds' in body.error), 'the wait is the header, not a body field');
  assert.ok(!JSON.stringify(body).includes('user+ip'), 'the internal reason is not sent');
});

test('hold_limit_reached is a 409 that carries which cap, how high it is and how many seats are held, with no Retry-After', () => {
  assert.equal(new ApiError('hold_limit_reached').status, 409);
  const handler = createErrorHandler(createLogger(() => {}));
  const headers: Record<string, string> = {};
  const { res, state } = fakeRes();
  (res as unknown as { setHeader: (k: string, v: string) => void }).setHeader = (k, v) => {
    headers[k] = v;
  };
  handler(new ApiError('hold_limit_reached', { holdLimit: { scope: 'address', limit: 16, held: 16 } }), {} as never, res, (() => {}) as never);
  const { error } = state.body as { error: Record<string, unknown> };
  assert.equal(error.code, 'hold_limit_reached');
  assert.equal(error.scope, 'address');
  assert.equal(error.limit, 16);
  assert.equal(error.held, 16);
  assert.equal('seatIds' in error, false, 'it is about how many, not which seats');
  assert.deepEqual(headers, {}, 'waiting does not help a cap; releasing seats or the holds lapsing does');
});

test('the 5d codes: a 403 that says "join the line first", and two retryable 503s that carry a Retry-After', () => {
  assert.equal(new ApiError('waiting_room_required').status, 403);
  assert.equal(new ApiError('waiting_room_full').status, 503);
  assert.equal(new ApiError('server_busy').status, 503);

  const handler = createErrorHandler(createLogger(() => {}));
  const headers: Record<string, string> = {};
  const { res } = fakeRes();
  (res as unknown as { setHeader: (k: string, v: string) => void }).setHeader = (k, v) => {
    headers[k] = v;
  };
  handler(new ApiError('waiting_room_required'), {} as never, res, (() => {}) as never);
  assert.deepEqual(headers, {}, 'a 403 is not retried on a timer: the app joins the line');
  handler(new ApiError('server_busy'), {} as never, res, (() => {}) as never);
  assert.equal(headers['Retry-After'], '10', 'a default when none was chosen');
  handler(new ApiError('server_busy', { retryAfterSeconds: 14 }), {} as never, res, (() => {}) as never);
  assert.equal(headers['Retry-After'], '14', 'the jittered value a shed request chose');
  handler(new ApiError('waiting_room_full'), {} as never, res, (() => {}) as never);
  assert.equal(headers['Retry-After'], '10');
  handler(new ApiError('service_unavailable'), {} as never, res, (() => {}) as never);
  assert.equal(headers['Retry-After'], '5', 'the seat map\'s Redis-down 503 can now be counted down too');
});

test('a database that could not answer (pool timeout, unreachable) is a 503 server_busy, never a 500, and its message is not sent', () => {
  const handler = createErrorHandler(createLogger(() => {}));
  for (const code of ['P2024', 'P1001', 'P1002', 'P1008', 'P1017']) {
    const headers: Record<string, string> = {};
    const { res, state } = fakeRes();
    (res as unknown as { setHeader: (k: string, v: string) => void }).setHeader = (k, v) => {
      headers[k] = v;
    };
    const prismaLike = Object.assign(new Error('Timed out fetching a new connection from the connection pool at postgres://secret-host'), { code });
    handler(prismaLike, {} as never, res, (() => {}) as never);
    assert.equal(state.status, 503, code);
    assert.equal((state.body as { error: { code: string } }).error.code, 'server_busy', code);
    assert.equal(headers['Retry-After'], '10', code);
    assert.ok(!JSON.stringify(state.body).includes('secret-host'), `${code}: the message stays server-side`);
  }
  // Any other database error is a bug of ours: still a 500 internal_error.
  const { res, state } = fakeRes();
  handler(Object.assign(new Error('unique constraint'), { code: 'P2002' }), {} as never, res, (() => {}) as never);
  assert.equal(state.status, 500);
});
