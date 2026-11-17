import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTrafficProfile, readWholeNumber } from './profile.js';

test('the profile is "default" unless it is explicitly "loadtest"', () => {
  assert.equal(readTrafficProfile({}), 'default');
  assert.equal(readTrafficProfile({ TRAFFIC_PROFILE: '' }), 'default');
  assert.equal(readTrafficProfile({ TRAFFIC_PROFILE: 'default' }), 'default');
  assert.equal(readTrafficProfile({ TRAFFIC_PROFILE: ' loadtest ' }), 'loadtest');
});

test('an unknown profile stops the server instead of silently meaning "default"', () => {
  for (const bad of ['prod', 'LOADTEST', 'true', '1']) {
    assert.throws(() => readTrafficProfile({ TRAFFIC_PROFILE: bad }), /TRAFFIC_PROFILE must be/, bad);
  }
});

test('readWholeNumber: unset is undefined; a number in range is returned; anything else names the variable and stops', () => {
  const range = { min: 0, max: 100 };
  assert.equal(readWholeNumber({}, 'X', range), undefined);
  assert.equal(readWholeNumber({ X: '' }, 'X', range), undefined);
  assert.equal(readWholeNumber({ X: '0' }, 'X', range), 0);
  assert.equal(readWholeNumber({ X: ' 16 ' }, 'X', range), 16);
  for (const bad of ['-1', '1.5', 'ten', '101', '1e3', '0x10', '99999999999']) {
    assert.throws(() => readWholeNumber({ X: bad }, 'X', range), /X must be a whole number from 0 to 100/, bad);
  }
});
