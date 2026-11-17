import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Client } from 'pg';
import type { Redis } from 'ioredis';
import { createApp, type AppDeps } from '../api/app.js';
import { closeDbClients, createDbClients, type DbClients } from '../db/clients.js';
import { seedDatabase } from '../db/seed.js';
import { createLogger } from '../http/logger.js';
import { createRedisClient } from '../jobs/connection.js';
import { createRateLimiter, noRateLimit, type RateLimiterOptions } from '../ratelimit/limiter.js';
import { RATE_LIMIT_POLICIES } from '../ratelimit/policies.js';
import { createRedisRateLimitStore } from '../ratelimit/slidingWindow.js';
import { createSeatService } from '../showtimes/seatService.js';
import { LOAD_TEST_SCREEN_ID } from '../showtimes/seedPlan.js';
import { createBookingRepo, type BookingRepo } from './bookingRepo.js';
import { createBookingService, type BookingService } from './bookingService.js';
import { createRedisHoldStore, holdKey, type HoldStore } from './holdStore.js';
import { createRedisRyowStore, type RyowStore } from './ryow.js';

/**
 * Support for the seat-hold integration tests: real Postgres, real Redis, never the app's own
 * DATABASE_URL / REDIS_URL (no test reads those; ADR 0007 / 0008). The gate is the same as the other
 * integration tests (`TEST_DATABASE_ALLOWED=true` plus the TEST_* URLs), with one more rule: the Redis
 * under test must be on this machine. A hold test deletes keys and pauses the server, so it must never
 * be pointed at Railway or at any shared Redis.
 */
const allowed = process.env.TEST_DATABASE_ALLOWED === 'true';
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const TEST_DATABASE_READ_URL = process.env.TEST_DATABASE_READ_URL;
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL;

export const skip: string | false =
  !allowed || !TEST_DATABASE_URL || !TEST_DATABASE_READ_URL || !TEST_REDIS_URL
    ? 'set TEST_DATABASE_ALLOWED=true, TEST_DATABASE_URL, TEST_DATABASE_READ_URL, TEST_REDIS_URL to run'
    : false;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Refuses any Redis that is not on this machine. Exported so a test can prove the guard. */
export function assertLoopbackRedis(url: string): void {
  const host = new URL(url).hostname;
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`Refusing to run hold tests against a non-local Redis (${host}).`);
  }
}

const FAKE_MOVIE_IDS = [900001, 900002, 900003];
let seeded: Promise<void> | undefined;

/** Seeds cinemas, screens, showtimes and seats once per test file (idempotent). */
export function ensureSeeded(db: DbClients): Promise<void> {
  seeded ??= seedDatabase(db.primary, FAKE_MOVIE_IDS, new Date(Date.now() + 24 * 60 * 60 * 1000)).then(() => undefined);
  return seeded;
}

export interface StackOptions {
  ttlMs?: number;
  ryowWindowMs?: number;
  opTimeoutMs?: number;
  /** A different "replica" database (the lagging-replica test). Defaults to TEST_DATABASE_READ_URL. */
  readUrl?: string;
  /** Leave the Redis client unconnected (the Redis-down test). */
  connectRedis?: boolean;
  /** Hold caps for this stack's real hold store (ADR 0018). Defaults to the production caps. */
  holdCaps?: { perOwner?: number; perAddress?: number };
  /** Wrap the real hold store (to bypass or interleave its checks in a test). */
  wrapHolds?: (real: HoldStore) => HoldStore;
  /**
   * Turn the real rate limiter ON, on this stack's Redis. Off by default: the hold tests send storms from one
   * address, which is exactly what the limiter exists to refuse. Pass `{}` for the production policies.
   */
  rateLimit?: Partial<Pick<RateLimiterOptions, 'policies' | 'clock' | 'opTimeoutMs'>>;
  /** More of the app to mount (a fake `movies` service, for the search route). */
  extraDeps?: Partial<Omit<AppDeps, 'logger' | 'db' | 'redis' | 'rateLimiter'>>;
}

export interface Stack {
  db: DbClients;
  redis: Redis;
  holds: HoldStore;
  ryow: RyowStore;
  repo: BookingRepo;
  bookings: BookingService;
  base: string;
  logs: string[];
  server: Server;
  close(): Promise<void>;
}

export async function openStack(options: StackOptions = {}): Promise<Stack> {
  if (!TEST_DATABASE_URL || !TEST_DATABASE_READ_URL || !TEST_REDIS_URL) throw new Error('test env is not set');
  assertLoopbackRedis(TEST_REDIS_URL);

  const logs: string[] = [];
  const logger = createLogger((line) => logs.push(line));
  const db = createDbClients({ primaryUrl: TEST_DATABASE_URL, readUrl: options.readUrl ?? TEST_DATABASE_READ_URL });
  const redis = createRedisClient(logger, TEST_REDIS_URL);
  if (options.connectRedis !== false) await redis.connect();

  const realHolds = createRedisHoldStore(redis, { ttlMs: options.ttlMs, opTimeoutMs: options.opTimeoutMs, caps: options.holdCaps });
  const holds = options.wrapHolds ? options.wrapHolds(realHolds) : realHolds;
  const ryow = createRedisRyowStore(redis, { windowMs: options.ryowWindowMs });
  const repo = createBookingRepo(db);
  const seats = createSeatService(db, { repo, holds, ryow });
  const bookings = createBookingService({ repo, holds, ryow, logger });

  const rateLimiter = options.rateLimit
    ? createRateLimiter({
        store: createRedisRateLimitStore(redis),
        logger,
        policies: RATE_LIMIT_POLICIES,
        ...options.rateLimit,
      })
    : noRateLimit;

  const server = createApp({ logger, db, redis, seats, bookings, rateLimiter, ...options.extraDeps }).listen(0);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');

  return {
    db,
    redis,
    holds,
    ryow,
    repo,
    bookings,
    base: `http://127.0.0.1:${address.port}`,
    logs,
    server,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await clearTouched(db, redis.status === 'ready' ? redis : undefined);
      if (options.rateLimit && redis.status === 'ready') await clearRateLimitKeys(redis);
      redis.disconnect();
      await closeDbClients(db);
    },
  };
}

let showtimeCursor = 0;

/** Showtimes a test has used and not yet cleaned up. Every stack clears them on close, so no test file leaves seats booked or held. */
const touchedShowtimes = new Set<string>();

async function clearTouched(db: DbClients, redis: Redis | undefined): Promise<void> {
  for (const showtimeId of [...touchedShowtimes]) {
    if (!redis) {
      await db.primary.booking.deleteMany({ where: { showtimeId } });
      continue; // its Redis keys are cleared by whichever stack closes with a connected Redis
    }
    await clearShowtime(db, redis, showtimeId);
    touchedShowtimes.delete(showtimeId);
  }
}

/** A showtime of the 320-seat room that no other test has used, with up to `seatCount` of its seats. */
export async function freshShowtime(
  db: DbClients,
  seatCount: number,
  redis: Redis,
): Promise<{ showtimeId: string; seatIds: string[] }> {
  await ensureSeeded(db);
  const showtimes = await db.primary.showtime.findMany({
    where: { screenId: LOAD_TEST_SCREEN_ID },
    orderBy: { startsAt: 'asc' },
    take: 40,
  });
  const showtime = showtimes[showtimeCursor++];
  if (!showtime) throw new Error('ran out of seeded showtimes');
  const seats = await db.primary.seat.findMany({
    where: { screenId: LOAD_TEST_SCREEN_ID, kind: 'standard' },
    orderBy: [{ row: 'asc' }, { number: 'asc' }],
    take: seatCount,
  });
  await clearShowtime(db, redis, showtime.id);
  touchedShowtimes.add(showtime.id);
  return { showtimeId: showtime.id, seatIds: seats.map((s) => s.id) };
}

/** Removes the rate-limit counters a test left behind (they expire in two windows on their own; this keeps a rerun clean). */
export async function clearRateLimitKeys(redis: Redis): Promise<void> {
  const keys = await redis.keys('rl:*');
  if (keys.length > 0) await redis.del(...keys);
}

/** Removes everything a test left for one showtime: its bookings and its hold keys. */
export async function clearShowtime(db: DbClients, redis: Redis, showtimeId: string): Promise<void> {
  await db.primary.booking.deleteMany({ where: { showtimeId } });
  const keys = [
    ...(await redis.keys(holdKey(showtimeId, '*'))),
    // The hold-cap indexes (ADR 0018) live next to the holds and share their hash tag.
    ...(await redis.keys(`hold-owner:{${showtimeId}}:*`)),
    ...(await redis.keys(`hold-addr:{${showtimeId}}:*`)),
  ];
  if (keys.length > 0) await redis.del(...keys);
}

export function ownerId(): string {
  return randomUUID();
}

export interface LaggingReplica {
  url: string;
  close(): Promise<void>;
}

/**
 * A second database standing in for a replica that is permanently behind: it gets the same cinemas,
 * screens, seats and showtimes (same ids) but never receives a booking. Real replication lag is a
 * matter of milliseconds and cannot be made to happen on demand; an unreachably-lagging copy makes the
 * read-your-own-writes routing observable.
 */
export async function createLaggingReplica(primary: DbClients): Promise<LaggingReplica> {
  if (!TEST_DATABASE_URL) throw new Error('test env is not set');
  const name = `lag_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';
  const lagUrl = new URL(TEST_DATABASE_URL);
  lagUrl.pathname = `/${name}`;

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);

  try {
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_DIRECT_URL: lagUrl.toString() },
      stdio: 'pipe',
    });
    const lag = createDbClients({ primaryUrl: lagUrl.toString(), readUrl: lagUrl.toString() });
    try {
      await lag.primary.cinema.createMany({ data: await primary.primary.cinema.findMany() });
      await lag.primary.screen.createMany({ data: await primary.primary.screen.findMany() });
      await lag.primary.showtime.createMany({ data: await primary.primary.showtime.findMany() });
      const seats = await primary.primary.seat.findMany();
      for (let i = 0; i < seats.length; i += 500) {
        await lag.primary.seat.createMany({ data: seats.slice(i, i + 500) });
      }
    } finally {
      await closeDbClients(lag);
    }
  } catch (err) {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
    throw err;
  }

  return {
    url: lagUrl.toString(),
    async close() {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    },
  };
}
