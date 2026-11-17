import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ADMIT_PER_MINUTE, DEFAULT_MAX_ACTIVE, DEFAULT_TIMING, readWaitingRoomConfig } from './config.js';

test('the defaults are the DEMO values (2 active, 12 a minute) and the config says so', () => {
  const { config, profile } = readWaitingRoomConfig({});
  assert.deepEqual(config, { enabled: true, maxActive: 2, admitPerMinute: 12, maxActiveIsDefault: true });
  assert.equal(profile, 'default');
  assert.equal(DEFAULT_MAX_ACTIVE, 2);
  assert.equal(DEFAULT_ADMIT_PER_MINUTE, 12);
});

test('setting MAX_ACTIVE (production) clears the "demo default" flag, so the boot warning goes away', () => {
  const { config } = readWaitingRoomConfig({ WAITING_ROOM_MAX_ACTIVE: '200', WAITING_ROOM_ADMIT_PER_MINUTE: '120' });
  assert.deepEqual(config, { enabled: true, maxActive: 200, admitPerMinute: 120, maxActiveIsDefault: false });
});

test('the load-test profile turns the room off (500 users at one showing is what it measures); an explicit setting beats the profile', () => {
  assert.equal(readWaitingRoomConfig({ TRAFFIC_PROFILE: 'loadtest' }).config.enabled, false);
  assert.equal(readWaitingRoomConfig({ TRAFFIC_PROFILE: 'loadtest', WAITING_ROOM_ENABLED: 'true' }).config.enabled, true);
  assert.equal(readWaitingRoomConfig({ WAITING_ROOM_ENABLED: 'false' }).config.enabled, false);
});

test('a bad value stops the server at boot and names the variable', () => {
  for (const [name, value, message] of [
    ['WAITING_ROOM_ENABLED', 'yes', /WAITING_ROOM_ENABLED must be "true" or "false"/],
    ['WAITING_ROOM_MAX_ACTIVE', '0', /WAITING_ROOM_MAX_ACTIVE must be a whole number from 1 to 100000/],
    ['WAITING_ROOM_MAX_ACTIVE', 'many', /WAITING_ROOM_MAX_ACTIVE must be a whole number/],
    ['WAITING_ROOM_ADMIT_PER_MINUTE', '0', /WAITING_ROOM_ADMIT_PER_MINUTE must be a whole number from 1 to 6000/],
    ['WAITING_ROOM_ADMIT_PER_MINUTE', '6001', /WAITING_ROOM_ADMIT_PER_MINUTE/],
  ] as const) {
    assert.throws(() => readWaitingRoomConfig({ [name]: value }), message, `${name}=${value}`);
  }
});

test('the timing constants keep their documented relationships', () => {
  const t = DEFAULT_TIMING;
  assert.ok(t.claimWindowMs < t.heartbeatWindowMs, 'a pass let in from the queue starts with a SHORTER window than a heard-from one');
  assert.ok(t.heartbeatWindowMs > 5_000 * 1.2 * 3, 'the window outlasts three of the slowest seat-map polls (5 s +20 %)');
  assert.ok(t.waiterPatienceMs > t.heartbeatWindowMs, 'a waiter is forgiven more than a seat chooser (a locked phone)');
  assert.ok(t.passMaxMs > 10 * 60_000, 'a pass outlasts one 10-minute seat hold');
});
