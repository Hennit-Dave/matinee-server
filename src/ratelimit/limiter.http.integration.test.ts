import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshShowtime, openStack, skip, type Stack } from '../bookings/testkit.js';
import type { MovieService } from '../movies/service.js';
import { RATE_LIMIT_POLICIES, type PolicyName, type RateLimitPolicy } from './policies.js';

/**
 * The limiter on the REAL app: real Express, real Redis, real Postgres (a throwaway local one; the testkit refuses
 * any Redis that is not on this machine). The sliding-window arithmetic is proven in
 * `slidingWindow.integration.test.ts`; this proves it is wired to the right routes and behaves over HTTP.
 *
 * Every request names its caller's address in `X-Forwarded-For`: the test server's peer is loopback, which the
 * trust list treats as a proxy hop, so the header is honoured exactly as it is behind Railway's edge. That gives
 * each test an address of its own, so counters never leak from one test into the next.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const EMPTY_PAGE = { movies: [], page: 1, totalPages: 1, totalResults: 0 };
/** Enough of a movie service for the search route, and for a read that must never be limited. */
const movies = {
  search: async () => ({ page: EMPTY_PAGE, cache: 'hit' }),
  popular: async () => ({ page: EMPTY_PAGE, cache: 'hit' }),
} as unknown as MovieService;

let nextAddress = 1 + Math.floor(Math.random() * 100);
/** A public-looking address nobody else in the run is using. */
const newAddress = () => `203.0.113.${(nextAddress++ % 250) + 1}`;

interface Caller {
  client?: string;
  ip: string;
}

function send(stack: Stack, method: string, path: string, caller: Caller, body: unknown = {}) {
  const hasBody = method !== 'GET';
  return fetch(`${stack.base}${path}`, {
    method,
    headers: {
      'x-forwarded-for': caller.ip,
      ...(caller.client ? { 'x-client-id': caller.client } : {}),
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
    },
    body: hasBody ? JSON.stringify(body) : undefined,
  });
}

/** The production policies with some numbers replaced, so a test can reach a limit in a few requests. */
function policies(overrides: Partial<Record<PolicyName, Partial<RateLimitPolicy>>>): Record<PolicyName, RateLimitPolicy> {
  const out = { ...RATE_LIMIT_POLICIES };
  for (const name of Object.keys(overrides) as PolicyName[]) out[name] = { ...out[name], ...overrides[name] };
  return out;
}

const HOLDS = (showtimeId: string) => `/showtimes/${showtimeId}/holds`;

test('the 11th hold request in a minute from one install is refused with a 429 and a Retry-After (production policy)', { skip }, async () => {
  const stack = await openStack({ rateLimit: {} });
  try {
    const caller = { client: randomUUID(), ip: newAddress() };
    const showtime = randomUUID();
    // `{}` is a 400 from validation, and the limiter runs BEFORE validation, so these count without touching a seat.
    const statuses: number[] = [];
    for (let i = 0; i < 10; i += 1) statuses.push((await send(stack, 'POST', HOLDS(showtime), caller)).status);
    assert.deepEqual(statuses, Array<number>(10).fill(400), 'the first ten reach validation');

    const res = await send(stack, 'POST', HOLDS(showtime), caller);
    assert.equal(res.status, 429);
    const retryAfter = Number(res.headers.get('retry-after'));
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 66, `Retry-After ${retryAfter}: whole seconds, no longer than the window plus the fade`);
    const body = (await res.json()) as { error: { code: string; message: string; requestId: string } };
    assert.equal(body.error.code, 'rate_limited');
    assert.match(body.error.requestId, /^[0-9a-f-]{36}$/);
    assert.ok(!JSON.stringify(body).includes(caller.ip) && !JSON.stringify(body).includes(caller.client), 'the body repeats neither the address nor the id');

    await sleep(30);
    const line = stack.logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === 'request').at(-1)!;
    assert.deepEqual(
      { status: line.status, outcome: line.outcome, errorCode: line.errorCode, policy: line.policy, scope: line.scope, userId: line.userId },
      { status: 429, outcome: 'rejected', errorCode: 'rate_limited', policy: 'hold', scope: 'user', userId: caller.client },
    );
    assert.ok(!stack.logs.join('').includes(caller.ip), 'the address is never logged');
  } finally {
    await stack.close();
  }
});

test('hold, booking, search and the seat map each refuse past their own limit with Retry-After; release and other reads are never limited', { skip }, async () => {
  const stack = await openStack({
    rateLimit: { policies: policies({ hold: { user: 3 }, booking: { user: 3 }, search: { user: 3 }, seatsPoll: { user: 3 } }) },
    extraDeps: { movies },
  });
  try {
    const { showtimeId } = await freshShowtime(stack.db, 1, stack.redis);
    const caller = { client: randomUUID(), ip: newAddress() };
    const routes: [string, string, string][] = [
      ['hold', 'POST', HOLDS(showtimeId)],
      ['booking', 'POST', `/showtimes/${showtimeId}/bookings`],
      ['search', 'GET', '/movies/search?q=dune'],
      ['seat map', 'GET', `/showtimes/${showtimeId}/seats`],
    ];
    for (const [label, method, path] of routes) {
      for (let i = 0; i < 3; i += 1) assert.notEqual((await send(stack, method, path, caller)).status, 429, `${label} request ${i + 1} is under the limit`);
      const refused = await send(stack, method, path, caller);
      assert.equal(refused.status, 429, `${label}: the 4th request is refused`);
      assert.ok(Number(refused.headers.get('retry-after')) >= 1, `${label}: Retry-After`);
      assert.equal(((await refused.json()) as { error: { code: string } }).error.code, 'rate_limited');
    }

    // Policies are separate buckets: this caller is locked out of all four, and can still do everything else.
    for (let i = 0; i < 30; i += 1) {
      assert.notEqual((await send(stack, 'DELETE', HOLDS(showtimeId), caller, { seatIds: [randomUUID()] })).status, 429, 'release is the cleanup path and is never limited');
      assert.equal((await send(stack, 'GET', '/movies/popular', caller)).status, 200, 'other reads are never limited');
    }
  } finally {
    await stack.close();
  }
});

test('user and address are independent over HTTP: either can trip alone, and each is counted wherever the other goes', { skip }, async () => {
  const stack = await openStack({ rateLimit: { policies: policies({ hold: { user: 3, ip: 6 }, search: { user: 3, ip: 5 } }) }, extraDeps: { movies } });
  try {
    const showtime = randomUUID();
    const hold = (caller: Caller) => send(stack, 'POST', HOLDS(showtime), caller);
    const scopeOf = async () => {
      await sleep(30);
      return (JSON.parse(stack.logs.at(-1)!) as { scope?: string }).scope;
    };

    // The USER trips: three requests from one address, the fourth is refused (scope user), though the address has room.
    const [alice, ipA] = [randomUUID(), newAddress()];
    for (let i = 0; i < 3; i += 1) assert.equal((await hold({ client: alice, ip: ipA })).status, 400);
    assert.equal((await hold({ client: alice, ip: ipA })).status, 429);
    assert.equal(await scopeOf(), 'user');
    assert.equal((await hold({ client: randomUUID(), ip: ipA })).status, 400, 'someone else on the same address is unaffected');
    assert.equal((await hold({ client: alice, ip: newAddress() })).status, 429, 'alice is still limited from a different address: the user counter follows her');

    // The ADDRESS trips: six different installs from one address, the seventh is refused (scope ip), though each is far under their own limit.
    const ipB = newAddress();
    for (let i = 0; i < 6; i += 1) assert.equal((await hold({ client: randomUUID(), ip: ipB })).status, 400);
    const carol = randomUUID();
    assert.equal((await hold({ client: carol, ip: ipB })).status, 429);
    assert.equal(await scopeOf(), 'ip');
    assert.equal((await hold({ client: carol, ip: newAddress() })).status, 400, 'carol from another address is fine: she was not counted by the request that was refused');

    // Both at once.
    const [dave, ipC] = [randomUUID(), newAddress()];
    for (let i = 0; i < 3; i += 1) await hold({ client: dave, ip: ipC });
    for (let i = 0; i < 3; i += 1) await hold({ client: randomUUID(), ip: ipC });
    assert.equal((await hold({ client: dave, ip: ipC })).status, 429);
    assert.equal(await scopeOf(), 'user+ip');

    // Search does not require an id: a caller without one is counted by address ONLY (the user limit of 3 never applies).
    const ipD = newAddress();
    const anonymous = () => send(stack, 'GET', '/movies/search?q=dune', { ip: ipD });
    for (let i = 0; i < 5; i += 1) assert.equal((await anonymous()).status, 200, `anonymous search ${i + 1}`);
    assert.equal((await anonymous()).status, 429);
    assert.equal(await scopeOf(), 'ip');
  } finally {
    await stack.close();
  }
});

test('the window slides over HTTP: a burst at the end of one window and another just after the boundary is refused, and it opens when Retry-After says', { skip }, async () => {
  const clock = { now: 7_000 * 10_000 }; // the start of a 10 s window
  const stack = await openStack({
    rateLimit: { policies: policies({ hold: { windowMs: 10_000, user: 10, ip: 1_000 } }), clock: () => clock.now },
  });
  try {
    const caller = { client: randomUUID(), ip: newAddress() };
    const showtime = randomUUID();
    const hold = () => send(stack, 'POST', HOLDS(showtime), caller);

    clock.now += 9_500; // the end of the window
    for (let i = 0; i < 10; i += 1) assert.equal((await hold()).status, 400);

    clock.now += 1_000; // half a second into the next window. A fixed window would let ten more through right here.
    const refused = await hold();
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get('retry-after'), '1', 'est 9.5 fades to 9 in 0.5 s, rounded up to a whole second');

    clock.now += 500; // one second into the window: the blend is 9.0, so one more request fits
    assert.equal((await hold()).status, 400, 'admitted exactly when it said it would be');
    assert.equal((await hold()).status, 429, 'and then it is full again');
  } finally {
    await stack.close();
  }
});

test('a focused app is never blocked, a scraper is: realistic seat-map polling against the production limits', { skip }, async () => {
  const clock = { now: 9_000 * 60_000 };
  const stack = await openStack({ rateLimit: { clock: () => clock.now } });
  try {
    const { showtimeId } = await freshShowtime(stack.db, 1, stack.redis);
    const map = (caller: Caller) => send(stack, 'GET', `/showtimes/${showtimeId}/seats`, caller);
    const advance = (ms: number) => (clock.now += ms);
    /** Start the next scenario one second into a fresh window, so a count of exactly one limit is exact. */
    const startOfWindow = () => (clock.now = Math.ceil(clock.now / 60_000) * 60_000 + 1_000);
    const FASTEST_POLL_MS = 4_000; // 5 s with the app's 20 % jitter

    // One install polling at the fastest the app ever does, for ten minutes, plus a pull-to-refresh and a resume in one second.
    const focused = { client: randomUUID(), ip: newAddress() };
    const refused: number[] = [];
    for (let elapsed = 0; elapsed < 10 * 60_000; elapsed += FASTEST_POLL_MS) {
      advance(FASTEST_POLL_MS);
      if ((await map(focused)).status !== 200) refused.push(elapsed);
      if (elapsed === 5 * 60_000) for (let extra = 0; extra < 3; extra += 1) if ((await map(focused)).status !== 200) refused.push(elapsed);
    }
    assert.deepEqual(refused, [], 'not one of 153 requests over ten minutes was refused');

    // Ten devices on one address, each at the fastest poll, for five minutes: 150 a minute, half the address limit.
    const household = newAddress();
    const devices = Array.from({ length: 10 }, () => ({ client: randomUUID(), ip: household }));
    let householdRefused = 0;
    for (let elapsed = 0; elapsed < 5 * 60_000; elapsed += FASTEST_POLL_MS) {
      for (const device of devices) {
        advance(FASTEST_POLL_MS / devices.length); // staggered: each device still polls every 4 s
        if ((await map(device)).status !== 200) householdRefused += 1;
      }
    }
    assert.equal(householdRefused, 0, 'ten phones on one wifi are not blocked');

    // A scraper: one install, five requests a second.
    startOfWindow();
    const scraper = { client: randomUUID(), ip: newAddress() };
    const results: number[] = [];
    for (let i = 0; i < 150; i += 1) {
      advance(200);
      results.push((await map(scraper)).status);
    }
    assert.equal(results.filter((s) => s === 200).length, RATE_LIMIT_POLICIES.seatsPoll.user, 'it gets exactly one limit\'s worth, then nothing');
    assert.equal(results.indexOf(429), RATE_LIMIT_POLICIES.seatsPoll.user, 'refused from the 61st request on');
    assert.ok(results.slice(RATE_LIMIT_POLICIES.seatsPoll.user).every((s) => s === 429));

    // A scraper that makes up a new install id every time is stopped by its address instead.
    startOfWindow();
    const rotating = newAddress();
    const rotated: number[] = [];
    for (let i = 0; i < 400; i += 1) {
      advance(100);
      rotated.push((await map({ client: randomUUID(), ip: rotating })).status);
    }
    assert.equal(rotated.filter((s) => s === 200).length, RATE_LIMIT_POLICIES.seatsPoll.ip);
    assert.equal(rotated.indexOf(429), RATE_LIMIT_POLICIES.seatsPoll.ip);
  } finally {
    await stack.close();
  }
});

test('REDIS DOWN: the limiter fails open (nothing is limited, one warning), while holds and the seat map still fail closed on their own', { skip }, async () => {
  const prep = await openStack();
  const { showtimeId, seatIds } = await freshShowtime(prep.db, 1, prep.redis);
  const stack = await openStack({
    connectRedis: false,
    rateLimit: { policies: policies({ hold: { user: 3 }, search: { user: 3 }, seatsPoll: { user: 3 } }) },
    extraDeps: { movies },
  });
  try {
    const caller = { client: randomUUID(), ip: newAddress() };

    // Five holds against a limit of three: the limiter let every one through (a counter would have refused the 4th),
    // and each was then refused by the HOLD STORE, closed, with its own retryable 503.
    for (let i = 0; i < 5; i += 1) {
      const res = await send(stack, 'POST', HOLDS(showtimeId), caller, { seatIds });
      assert.equal(res.status, 503, `hold ${i + 1}: refused by the hold store, not by the limiter`);
      assert.equal(res.headers.get('retry-after'), '2');
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'holds_unavailable');
    }
    assert.equal((await send(stack, 'GET', `/showtimes/${showtimeId}/seats`, caller)).status, 503, 'the seat map still refuses to show what it cannot verify');
    assert.equal(await stack.db.primary.booking.count({ where: { showtimeId } }), 0);

    // Search has no other Redis dependency here: ten requests against a limit of three all succeed.
    for (let i = 0; i < 10; i += 1) assert.equal((await send(stack, 'GET', '/movies/search?q=dune', caller)).status, 200);

    const warnings = stack.logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === 'rate_limit_unavailable');
    assert.equal(warnings.length, 1, 'an outage is one warning, not one per request');
    assert.match(String(warnings[0]!.reason), /redis not ready/);

    // Redis comes back and the limits come back with it.
    await stack.redis.connect();
    const search = Array.from({ length: 5 }, () => send(stack, 'GET', '/movies/search?q=dune', { client: randomUUID(), ip: newAddress() }));
    assert.ok((await Promise.all(search)).every((r) => r.status === 200), 'fresh callers are under their limit');
    const same = { client: randomUUID(), ip: newAddress() };
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await send(stack, 'GET', '/movies/search?q=dune', same)).status);
    assert.deepEqual(statuses, [200, 200, 200, 429], 'limiting resumed');
  } finally {
    await stack.close();
    await prep.close();
  }
});

test('REDIS CONNECTED BUT NOT ANSWERING: the limiter gives up at its short deadline and lets the request through, never hanging', { skip }, async () => {
  const stack = await openStack({ rateLimit: { opTimeoutMs: 100 }, extraDeps: { movies } });
  try {
    await stack.redis.call('CLIENT', 'PAUSE', '1500', 'WRITE');
    const started = Date.now();
    const res = await send(stack, 'GET', '/movies/search?q=dune', { client: randomUUID(), ip: newAddress() });
    const waited = Date.now() - started;
    assert.equal(res.status, 200);
    assert.ok(waited >= 90 && waited < 800, `waited ${waited} ms: about the 100 ms deadline (a hold would have waited its full 1 s)`);
    const warning = stack.logs.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'rate_limit_unavailable');
    assert.match(String(warning?.reason), /did not answer within 100 ms/);
  } finally {
    await sleep(1600); // never leave the shared Redis paused for the next test
    await stack.close();
  }
});

test('a malformed X-Client-Id on search is a 400 before the limiter, and a valid one is accepted', { skip }, async () => {
  const stack = await openStack({ rateLimit: {}, extraDeps: { movies } });
  try {
    const ip = newAddress();
    const bad = await fetch(`${stack.base}/movies/search?q=dune`, { headers: { 'x-forwarded-for': ip, 'x-client-id': 'nope' } });
    assert.equal(bad.status, 400);
    const keys = await stack.redis.keys('rl:search:*');
    assert.equal(keys.length, 0, 'the refused request counted nowhere');
    assert.equal((await send(stack, 'GET', '/movies/search?q=dune', { client: randomUUID(), ip })).status, 200);
  } finally {
    await stack.close();
  }
});
