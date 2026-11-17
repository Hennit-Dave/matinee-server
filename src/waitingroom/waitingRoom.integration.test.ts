import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshShowtime, openStack, ownerId, skip, type Stack } from '../bookings/testkit.js';
import { QueueStateSchema, type QueueState } from './queue.js';

/**
 * The waiting room over HTTP, on the full real stack: real Postgres, real Redis, the real gate in front of the real seat map and holds
 * (ADR 0017). Timings are shortened where a test has to wait for a pass to lapse.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function api(stack: Stack, showtimeId: string) {
  const send = (method: string, path: string, client: string | null, body?: unknown) =>
    fetch(`${stack.base}/showtimes/${showtimeId}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(client ? { 'x-client-id': client } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    join: async (client: string) => ({ status: (await send('POST', '/queue', client)).status, res: send }),
    joinState: async (client: string): Promise<QueueState> => QueueStateSchema.parse(await (await send('POST', '/queue', client)).json()),
    pollState: async (client: string): Promise<QueueState> => QueueStateSchema.parse(await (await send('GET', '/queue', client)).json()),
    leave: (client: string) => send('DELETE', '/queue', client),
    map: (client: string | null) => send('GET', '/seats', client),
    hold: (client: string, seatIds: string[]) => send('POST', '/holds', client, { seatIds }),
    release: (client: string, seatIds: string[]) => send('DELETE', '/holds', client, { seatIds }),
    book: (client: string, seatIds: string[]) => send('POST', '/bookings', client, { seatIds }),
  };
}

const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

test('WITHOUT a pass the seat map and holds are refused 403 waiting_room_required; after joining (instant when there is room) both work', { skip }, async () => {
  const stack = await openStack({ waitingRoom: { maxActive: 5 } });
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 4, stack.redis);
    const a = api(stack, showtimeId);
    const me = ownerId();

    const map = await a.map(me);
    assert.equal(map.status, 403);
    assert.equal(await code(map), 'waiting_room_required');
    const hold = await a.hold(me, [seatIds[0]!]);
    assert.equal(hold.status, 403);
    assert.equal(await code(hold), 'waiting_room_required');

    assert.equal((await a.joinState(me)).status, 'admitted');
    assert.equal((await a.map(me)).status, 200);
    assert.equal((await a.hold(me, [seatIds[0]!])).status, 201);
  } finally {
    await stack.close();
  }
});

test('releasing seats and booking are NOT gated: the cleanup path and the purchase path never need a pass', { skip }, async () => {
  const stack = await openStack({ waitingRoom: { maxActive: 5 } });
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 4, stack.redis);
    const a = api(stack, showtimeId);
    const me = ownerId();
    await a.joinState(me);
    assert.equal((await a.hold(me, [seatIds[0]!])).status, 201);
    await a.leave(me); // gives the pass up
    assert.equal((await a.map(me)).status, 403, 'no pass any more');

    assert.equal((await a.release(me, [seatIds[0]!])).status, 200, 'releasing still works');
    assert.equal((await a.book(me, [seatIds[1]!])).status, 409, 'booking reached the booking service (seat_not_held), not the gate');
  } finally {
    await stack.close();
  }
});

test('the line, end to end: a full room queues the next user ("0 people ahead"), they are refused the map, and let in when a slot frees', { skip }, async () => {
  const stack = await openStack({ waitingRoom: { maxActive: 1, admitPerMinute: 6_000 } }); // one admission per 10 ms
  try {
    const { showtimeId } = await freshShowtime(stack.db, 2, stack.redis);
    const a = api(stack, showtimeId);
    const [first, second] = [ownerId(), ownerId()];

    assert.equal((await a.joinState(first)).status, 'admitted');
    const queued = await a.joinState(second);
    assert.deepEqual(queued, { status: 'waiting', ahead: 0, pollAfterMs: 3_000 });
    assert.equal((await a.map(second)).status, 403, 'a waiter has no pass');

    await a.leave(first);
    await sleep(30);
    assert.equal((await a.pollState(second)).status, 'admitted');
    assert.equal((await a.map(second)).status, 200);
  } finally {
    await stack.close();
  }
});

test('THE SEAT-MAP POLL IS THE HEARTBEAT: polling keeps a pass past the window; going quiet loses it and frees the slot', { skip }, async () => {
  const stack = await openStack({ waitingRoom: { maxActive: 1, admitPerMinute: 6_000, timing: { heartbeatWindowMs: 1_000 } } });
  try {
    const { showtimeId } = await freshShowtime(stack.db, 2, stack.redis);
    const a = api(stack, showtimeId);
    const [active, waiting] = [ownerId(), ownerId()];
    await a.joinState(active);
    await a.joinState(waiting);

    for (let i = 0; i < 5; i += 1) {
      await sleep(300);
      assert.equal((await a.map(active)).status, 200, `poll ${i + 1}: 1.5 s in, well past the 1 s window, still admitted`);
    }
    await sleep(1_300); // the "app" closes: no more polls
    assert.equal((await a.map(active)).status, 403, 'the quiet pass lapsed');
    assert.equal((await a.pollState(waiting)).status, 'admitted', 'and the slot went to the person waiting');
  } finally {
    await stack.close();
  }
});

test('a HOLDER whose pass lapsed is let back in AHEAD of the line, so seats they hold are not stranded behind it', { skip }, async () => {
  const stack = await openStack({ waitingRoom: { maxActive: 1, admitPerMinute: 60, timing: { heartbeatWindowMs: 600 } } });
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 4, stack.redis);
    const a = api(stack, showtimeId);
    const [holder, other] = [ownerId(), ownerId()];
    await a.joinState(holder);
    assert.equal((await a.hold(holder, [seatIds[0]!])).status, 201);
    assert.equal((await a.joinState(other)).status, 'waiting');

    await sleep(900); // the holder takes a phone call: their pass lapses, the room's slot is free, someone is waiting
    assert.equal((await a.joinState(holder)).status, 'admitted', 'the holder skips the line');
    assert.equal((await a.pollState(other)).status, 'waiting', 'and the person waiting is still waiting');
  } finally {
    await stack.close();
  }
});

test('200 users arrive over HTTP at a room of 5: exactly 5 are let in and nobody is let in twice', { skip }, async () => {
  const stack = await openStack({ waitingRoom: { maxActive: 5 } });
  try {
    const { showtimeId } = await freshShowtime(stack.db, 2, stack.redis);
    const a = api(stack, showtimeId);
    const states = await Promise.all(Array.from({ length: 100 }, () => a.joinState(ownerId())));
    assert.equal(states.filter((s) => s.status === 'admitted').length, 5);
    assert.equal(states.filter((s) => s.status === 'waiting').length, 95);
  } finally {
    await stack.close();
  }
});

test('X-Client-Id is required on the queue and on the seat map; a showing that does not exist is a 404 and creates no keys', { skip }, async () => {
  const stack = await openStack({ waitingRoom: { maxActive: 5 } });
  try {
    const { showtimeId } = await freshShowtime(stack.db, 2, stack.redis);
    const a = api(stack, showtimeId);
    assert.equal((await a.map(null)).status, 400);
    assert.equal((await a.join('') as { status: number }).status, 400);

    const ghost = '99999999-9999-4999-8999-999999999999';
    const res = await fetch(`${stack.base}/showtimes/${ghost}/queue`, { method: 'POST', headers: { 'x-client-id': ownerId() } });
    assert.equal(res.status, 404);
    assert.deepEqual(await stack.redis.keys(`wr:*:{${ghost}}`), []);
  } finally {
    await stack.close();
  }
});

test('DISABLED: nothing is gated and joining is simply "admitted"', { skip }, async () => {
  const stack = await openStack({ waitingRoom: { enabled: false, maxActive: 1 } });
  try {
    const { showtimeId } = await freshShowtime(stack.db, 2, stack.redis);
    const a = api(stack, showtimeId);
    assert.equal((await a.map(ownerId())).status, 200, 'no pass needed');
    assert.equal((await a.joinState(ownerId())).status, 'admitted');
    assert.deepEqual(await stack.redis.keys(`wr:*:{${showtimeId}}`), [], 'and the room wrote nothing');
  } finally {
    await stack.close();
  }
});

// ---- FAIL OPEN ------------------------------------------------------------------------------------

test('FAIL OPEN, a store that throws: the seat map and holds still work for someone with no pass, and joining says "admitted"', { skip }, async () => {
  const stack = await openStack({
    waitingRoom: {
      maxActive: 1,
      wrapStore: (real) => ({
        ...real,
        join: async () => { throw new Error('redis not ready (end)'); },
        poll: async () => { throw new Error('redis not ready (end)'); },
        touch: async () => { throw new Error('redis not ready (end)'); },
      }),
    },
  });
  try {
    const { showtimeId, seatIds } = await freshShowtime(stack.db, 2, stack.redis);
    const a = api(stack, showtimeId);
    const me = ownerId();
    assert.equal((await a.map(me)).status, 200, 'no pass, and still served');
    assert.equal((await a.hold(me, [seatIds[0]!])).status, 201);
    assert.equal((await a.joinState(me)).status, 'admitted');
    assert.equal(stack.logs.filter((l) => JSON.parse(l).msg === 'waiting_room_unavailable').length, 1, 'one warning, not one per request');
  } finally {
    await stack.close();
  }
});

test('FAIL OPEN, a store that never answers: the request waits only the 150 ms-class deadline, then goes through', { skip }, async () => {
  const stack = await openStack({
    waitingRoom: { maxActive: 1, opTimeoutMs: 80, wrapStore: (real) => ({ ...real, touch: () => new Promise<boolean>(() => {}) }) },
  });
  try {
    const { showtimeId } = await freshShowtime(stack.db, 2, stack.redis);
    const started = Date.now();
    assert.equal((await api(stack, showtimeId).map(ownerId())).status, 200);
    const took = Date.now() - started;
    assert.ok(took >= 70 && took < 2_500, `waited about the deadline, not forever (${took} ms)`);
  } finally {
    await stack.close();
  }
});

test('FAIL OPEN, a REAL Redis stall: the gate gives up at its deadline and lets the request through; the seat map\'s own read then waits the stall out (one connection), under its 1 s limit', { skip }, async () => {
  const stack = await openStack({ waitingRoom: { maxActive: 1, opTimeoutMs: 100 } });
  try {
    const { showtimeId } = await freshShowtime(stack.db, 2, stack.redis);
    const a = api(stack, showtimeId);
    const me = ownerId();
    assert.equal((await a.map(me)).status, 403, 'before the stall: no pass, refused');

    // CLIENT PAUSE ... WRITE holds back every write, including the room's Lua script.
    await stack.redis.call('CLIENT', 'PAUSE', '700', 'WRITE');
    const started = Date.now();
    const during = await a.map(me);
    const took = Date.now() - started;
    assert.equal(during.status, 200, 'during the stall: the gate failed open, so no one is refused because the line-tracker is stuck');
    assert.equal(stack.logs.some((l) => JSON.parse(l).msg === 'waiting_room_unavailable'), true, 'and it said so');
    // WHAT THIS DOES NOT BUY, recorded so nobody expects it (ADR 0017): the app has ONE Redis connection, so the seat map's read queues behind the
    // blocked script and waits the stall out too. Failing open stops the room from REFUSING people; it does not make a stalled Redis fast.
    assert.ok(took >= 500 && took < 1_900, `the request took about the stall (${took} ms), not forever`);

    await sleep(100); // let the pause end before the next test
    assert.equal((await a.map(me)).status, 403, 'after the stall the gate is back');
  } finally {
    await stack.close();
  }
});
