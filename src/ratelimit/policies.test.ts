import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RATE_LIMIT_POLICIES, type PolicyName } from './policies.js';

const names = Object.keys(RATE_LIMIT_POLICIES) as PolicyName[];

test('every policy is usable: a window of at least a second, whole numbers, and an address limit at least the user limit', () => {
  assert.deepEqual([...names].sort(), ['booking', 'hold', 'search', 'seatsPoll']);
  for (const name of names) {
    const { windowMs, user, ip } = RATE_LIMIT_POLICIES[name];
    assert.ok(Number.isInteger(windowMs) && windowMs >= 1_000, `${name}: window`);
    assert.ok(Number.isInteger(user) && user >= 1, `${name}: user`);
    assert.ok(Number.isInteger(ip) && ip >= 1, `${name}: ip`);
    // The address is shared by everyone behind it (a household, a venue), the install is one person.
    assert.ok(ip >= user, `${name}: the address limit may not be tighter than one install's`);
  }
});

/**
 * The seat-map poll is every 5 s +/- 20 % (matinee-mobile `seatsPolling.ts`): 4 s at the fastest, so 15 a
 * minute. The brief: a focused app is never blocked, a scraper still is.
 */
const FASTEST_POLL_PER_MINUTE = 60_000 / 4_000;

test('the seat-map limit is comfortably above the real polling cadence (4x for one install, 20 devices for one address)', () => {
  const { windowMs, user, ip } = RATE_LIMIT_POLICIES.seatsPoll;
  const perWindow = (windowMs / 60_000) * FASTEST_POLL_PER_MINUTE;
  assert.ok(user >= 4 * perWindow, `user ${user} vs peak ${perWindow}`);
  assert.ok(ip >= 20 * perWindow, `ip ${ip} vs 20 devices at ${perWindow}`);
});

test('the write routes are strictly tighter than the poll, and booking is tighter than hold', () => {
  const { seatsPoll, hold, booking } = RATE_LIMIT_POLICIES;
  assert.ok(hold.user < seatsPoll.user && hold.ip < seatsPoll.ip);
  assert.ok(booking.user < hold.user && booking.ip < hold.ip);
});
