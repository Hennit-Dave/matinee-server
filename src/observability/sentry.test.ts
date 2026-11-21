import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Event } from '@sentry/node';
import { ApiError, shouldReportToSentry } from '../http/errors.js';
import { scrubSentryEvent } from './sentry.js';

test('shouldReportToSentry: only unexpected exceptions are reported, never the known vocabulary', () => {
  // Unexpected -> report (becomes 500 internal_error).
  assert.equal(shouldReportToSentry(new Error('boom')), true);
  assert.equal(shouldReportToSentry(new TypeError('bad arg')), true);
  // A non-transient database error (e.g. a real constraint bug) -> report.
  assert.equal(shouldReportToSentry({ code: 'P2003' }), true);

  // Expected 4xx ApiErrors -> never report.
  for (const code of ['not_found', 'validation_failed', 'seat_taken', 'seat_not_held', 'hold_limit_reached', 'rate_limited', 'waiting_room_required', 'idempotency_mismatch', 'showtime_cancelled', 'invalid_admin_key'] as const) {
    assert.equal(shouldReportToSentry(new ApiError(code)), false, code);
  }
  // The designed 503s -> never report (fail-closed / overload / third-party-down working as designed).
  for (const code of ['server_busy', 'holds_unavailable', 'service_unavailable', 'upstream_unavailable', 'payment_unavailable', 'waiting_room_full'] as const) {
    assert.equal(shouldReportToSentry(new ApiError(code)), false, code);
  }

  // Body-parser errors (mapped to a 4xx) -> never report.
  assert.equal(shouldReportToSentry({ type: 'entity.parse.failed' }), false);
  // Transient database errors (mapped to 503 server_busy) -> never report.
  assert.equal(shouldReportToSentry({ code: 'P1001' }), false);
  assert.equal(shouldReportToSentry({ code: 'P2024' }), false);
});

test('scrubSentryEvent drops the whole request and keeps everything else', () => {
  const event = {
    request: { url: 'https://api/movies/search?q=secret', method: 'POST', body: { seatIds: ['x'] }, headers: { authorization: 'Bearer x' } },
    tags: { requestId: 'req-1', route: '/movies/search' },
    message: 'boom',
  } as Event;
  const out = scrubSentryEvent(event);
  assert.equal('request' in out, false, 'the request (body/headers/query) never rides along');
  assert.equal(out.message, 'boom');
  assert.deepEqual(out.tags, { requestId: 'req-1', route: '/movies/search' });
});

test('scrubSentryEvent is a no-op when there is no request', () => {
  const event = { message: 'boom', tags: { a: 'b' } } as Event;
  assert.deepEqual(scrubSentryEvent(event), event);
});
