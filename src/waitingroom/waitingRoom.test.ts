import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeHoldStore } from '../bookings/fakes.js';
import { ApiError } from '../http/errors.js';
import { createLogger } from '../http/logger.js';
import { HEARTBEAT_WINDOW_MS, type WaitingRoomConfig } from './config.js';
import { pollAfterMs, type RoomState, type WaitingRoomStore } from './store.js';
import { createWaitingRoom } from './waitingRoom.js';

const SHOWTIME = '11111111-1111-4111-8111-111111111111';
const ALICE = '0a11ce00-0000-4000-8000-000000000001';
const CONFIG: WaitingRoomConfig = { enabled: true, maxActive: 2, admitPerMinute: 12, maxActiveIsDefault: false };

function fakeStore(overrides: Partial<WaitingRoomStore> = {}) {
  const calls: string[] = [];
  const holderFlags: boolean[] = [];
  const store: WaitingRoomStore = {
    async join(_s, _o, { holder }) {
      calls.push('join');
      holderFlags.push(holder);
      return { status: 'waiting', ahead: 3, queueLength: 9, pollAfterMs: 3000 } satisfies RoomState;
    },
    async poll() {
      calls.push('poll');
      return { status: 'admitted', passExpiresInMs: 25_000 };
    },
    async touch() {
      calls.push('touch');
      return true;
    },
    async leave() {
      calls.push('leave');
    },
    ...overrides,
  };
  return { store, calls, holderFlags };
}

function setup(overrides: Partial<WaitingRoomStore> = {}, config: WaitingRoomConfig = CONFIG, now = () => 1_000_000) {
  const { store, calls, holderFlags } = fakeStore(overrides);
  const holds = createFakeHoldStore();
  const logs: Record<string, unknown>[] = [];
  const logger = createLogger((line) => logs.push(JSON.parse(line) as Record<string, unknown>));
  const room = createWaitingRoom({ store, holds, config, logger, opTimeoutMs: 30, clock: now });
  return { room, calls, holderFlags, holds, logs };
}

// ---- join and poll ---------------------------------------------------------------------------------

test('join reports the line without the queue length (the app shows only how many are ahead) and logs the outcome', async () => {
  const { room, logs } = setup();
  assert.deepEqual(await room.join(SHOWTIME, ALICE), { status: 'waiting', ahead: 3, pollAfterMs: 3000 });
  const line = logs.find((l) => l.msg === 'waiting_room_join');
  assert.deepEqual([line?.outcome, line?.ahead, line?.userId, line?.showtimeId], ['queued', 3, ALICE, SHOWTIME]);
});

test('a join of an owner who still HOLDS seats is flagged as a holder, so the store lets them back in ahead of the line', async () => {
  const { room, holds, holderFlags } = setup();
  await room.join(SHOWTIME, ALICE);
  await holds.acquire(SHOWTIME, ALICE, ['s1']);
  await room.join(SHOWTIME, ALICE);
  assert.deepEqual(holderFlags, [false, true]);
});

test('if the holder check itself fails, the owner is simply not a holder (and the join carries on)', async () => {
  const { room, holds, holderFlags } = setup();
  holds.down = true;
  assert.equal((await room.join(SHOWTIME, ALICE)).status, 'waiting');
  assert.deepEqual(holderFlags, [false]);
});

test('a "full" line from the store is passed on to the route, and a poll can never answer "full"', async () => {
  const { room } = setup({ join: async () => ({ status: 'full' }), poll: async () => ({ status: 'full' }) });
  assert.deepEqual(await room.join(SHOWTIME, ALICE), { status: 'full' });
  assert.deepEqual(await room.poll(SHOWTIME, ALICE), { status: 'not_queued' });
});

test('DISABLED: everyone is admitted, the store is never touched, and the gate lets everything through', async () => {
  const { room, calls } = setup({}, { ...CONFIG, enabled: false });
  assert.deepEqual(await room.join(SHOWTIME, ALICE), { status: 'admitted', passExpiresInMs: HEARTBEAT_WINDOW_MS });
  assert.deepEqual(await room.poll(SHOWTIME, ALICE), { status: 'admitted', passExpiresInMs: HEARTBEAT_WINDOW_MS });
  await room.leave(SHOWTIME, ALICE);
  let passed = false;
  await room.gate()({ params: { id: SHOWTIME } } as never, { locals: { clientId: ALICE } } as never, () => {
    passed = true;
  });
  assert.equal(passed, true);
  assert.deepEqual(calls, []);
});

// ---- fail open ------------------------------------------------------------------------------------

test('FAIL OPEN: a store that throws, hangs or rejects late lets the user in, and logs ONE warning per 10 s', async () => {
  for (const [label, broken] of [
    ['throws', async () => { throw new Error('redis not ready (end)'); }],
    ['hangs', () => new Promise<RoomState>(() => {})],
    ['rejects late', () => new Promise<RoomState>((_, reject) => setTimeout(() => reject(new Error('late')), 80))],
  ] as const) {
    let t = 1_000_000;
    const { room, logs } = setup({ join: broken, poll: broken }, CONFIG, () => t);
    const open = { status: 'admitted', passExpiresInMs: HEARTBEAT_WINDOW_MS };
    assert.deepEqual(await room.join(SHOWTIME, ALICE), open, `${label}: join`);
    assert.deepEqual(await room.poll(SHOWTIME, ALICE), open, `${label}: poll`);
    assert.equal(logs.filter((l) => l.msg === 'waiting_room_unavailable').length, 1, `${label}: one warning, not one per request`);
    t += 10_001;
    await room.poll(SHOWTIME, ALICE);
    assert.equal(logs.filter((l) => l.msg === 'waiting_room_unavailable').length, 2, `${label}: and another after 10 s`);
  }
});

test('leave is best effort: a failing store does not fail the request (a pass lapses on its own)', async () => {
  const { room, logs } = setup({ leave: async () => { throw new Error('down'); } });
  await room.leave(SHOWTIME, ALICE);
  assert.equal(logs.some((l) => l.msg === 'waiting_room_unavailable' && l.check === 'leave'), true);
});

// ---- the gate -------------------------------------------------------------------------------------

function runGate(room: ReturnType<typeof createWaitingRoom>, req: { params: Record<string, unknown> }, clientId: unknown) {
  return new Promise<unknown>((resolve) => {
    void room.gate()(req as never, { locals: { clientId } } as never, (err?: unknown) => resolve(err));
  });
}

test('GATE: a caller without a pass gets 403 waiting_room_required; with one they pass and the pass is renewed (touch)', async () => {
  const none = setup({ touch: async () => false });
  const refusal = await runGate(none.room, { params: { id: SHOWTIME } }, ALICE);
  assert.ok(refusal instanceof ApiError);
  assert.equal((refusal as ApiError).code, 'waiting_room_required');
  assert.equal((refusal as ApiError).status, 403);

  const has = setup();
  assert.equal(await runGate(has.room, { params: { id: SHOWTIME } }, ALICE), undefined);
  assert.deepEqual(has.calls, ['touch']);
});

test('GATE: an id that is not a UUID, or no client id, is passed on UNLOOKED (the route returns the 400), so junk never becomes a Redis key', async () => {
  const { room, calls } = setup({ touch: async () => false });
  assert.equal(await runGate(room, { params: { id: 'not-a-uuid' } }, ALICE), undefined);
  assert.equal(await runGate(room, { params: { id: SHOWTIME } }, undefined), undefined);
  assert.deepEqual(calls, []);
});

test('GATE FAILS OPEN: a store that errors lets the request through', async () => {
  const { room } = setup({ touch: async () => { throw new Error('boom'); } });
  assert.equal(await runGate(room, { params: { id: SHOWTIME } }, ALICE), undefined);
});

// ---- the pacing of the poll ------------------------------------------------------------------------

test('pollAfterMs: 3 s for the first 20, then 100 ms more per extra person, never over 15 s', () => {
  assert.equal(pollAfterMs(0), 3_000);
  assert.equal(pollAfterMs(20), 3_000);
  assert.equal(pollAfterMs(21), 3_100);
  assert.equal(pollAfterMs(70), 8_000);
  assert.equal(pollAfterMs(500), 15_000);
  assert.equal(pollAfterMs(100_000), 15_000);
});
