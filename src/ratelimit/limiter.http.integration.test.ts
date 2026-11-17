import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openStack, skip } from '../bookings/testkit.js';

/**
 * Slice 5c baseline: today nothing limits how often one install may hit the hold route, so this fails.
 * (A `{}` body is a 400 before any seat is touched, which makes the request free to repeat. The limiter will
 * sit BEFORE validation, so a refused-by-validation request still counts.)
 */
test('BASELINE: the 11th hold request inside a minute from one install is refused with 429 and Retry-After', { skip }, async () => {
  const stack = await openStack();
  try {
    const client = randomUUID();
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 11; i += 1) {
      const res = await fetch(`${stack.base}/showtimes/${randomUUID()}/holds`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-client-id': client },
        body: '{}',
      });
      statuses.push(res.status);
      retryAfter = res.headers.get('retry-after');
    }
    assert.equal(statuses[10], 429, `expected the 11th request to be limited, got statuses ${statuses.join(',')}`);
    assert.ok(retryAfter !== null && Number(retryAfter) >= 1, 'a 429 carries Retry-After');
  } finally {
    await stack.close();
  }
});
