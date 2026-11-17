import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SEATS_PER_REQUEST } from './booking.js';
import { DEFAULT_HOLD_CAPS, readHoldCaps } from './holdCaps.js';

test('the defaults: one booking\'s worth per install (the same 8 a request may ask for) and 16 per address', () => {
  assert.deepEqual(DEFAULT_HOLD_CAPS, { perOwner: 8, perAddress: 16 });
  assert.equal(DEFAULT_HOLD_CAPS.perOwner, MAX_SEATS_PER_REQUEST, 'an install can always hold what one booking needs');
  assert.deepEqual(readHoldCaps({}), { caps: { perOwner: 8, perAddress: 16 }, profile: 'default' });
});

test('each cap can be set on its own, and 0 turns it off', () => {
  assert.deepEqual(readHoldCaps({ HOLD_CAP_PER_OWNER: '4' }).caps, { perOwner: 4, perAddress: 16 });
  assert.deepEqual(readHoldCaps({ HOLD_CAP_PER_ADDRESS: '40' }).caps, { perOwner: 8, perAddress: 40 });
  assert.deepEqual(readHoldCaps({ HOLD_CAP_PER_OWNER: '0', HOLD_CAP_PER_ADDRESS: '0' }).caps, { perOwner: 0, perAddress: 0 });
});

test('the load-test profile lifts the ADDRESS cap only (500 test users share one address); the install cap stays', () => {
  const lifted = readHoldCaps({ TRAFFIC_PROFILE: 'loadtest' });
  assert.deepEqual(lifted, { caps: { perOwner: 8, perAddress: 0 }, profile: 'loadtest' });
});

test('an explicit variable beats the profile', () => {
  assert.equal(readHoldCaps({ TRAFFIC_PROFILE: 'loadtest', HOLD_CAP_PER_ADDRESS: '32' }).caps.perAddress, 32);
});

test('a bad value stops the server at boot and names the variable', () => {
  for (const [name, value] of [['HOLD_CAP_PER_OWNER', '-1'], ['HOLD_CAP_PER_OWNER', 'eight'], ['HOLD_CAP_PER_ADDRESS', '10001'], ['HOLD_CAP_PER_ADDRESS', '1.5']] as const) {
    assert.throws(() => readHoldCaps({ [name]: value }), new RegExp(`${name} must be a whole number`), `${name}=${value}`);
  }
});
