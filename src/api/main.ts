import { createBookingRepo } from '../bookings/bookingRepo.js';
import { createBookingService } from '../bookings/bookingService.js';
import { readHoldCaps } from '../bookings/holdCaps.js';
import { createRedisHoldStore } from '../bookings/holdStore.js';
import { createRedisRyowStore } from '../bookings/ryow.js';
import { closeDbClients, createDbClients } from '../db/clients.js';
import { readMaxInFlight } from '../http/loadShed.js';
import { createLogger } from '../http/logger.js';
import { createBullMqConnection, createRedisClient } from '../jobs/connection.js';
import { createPaymentQueue, type PaymentQueue } from '../jobs/queue.js';
import { createMovieCache, createRedisStore } from '../movies/cache.js';
import { createMovieService } from '../movies/service.js';
import { createCheckoutService, type CheckoutService } from '../payments/checkoutService.js';
import { createStripeEventRepo } from '../payments/eventRepo.js';
import { createOrderRepo } from '../payments/orderRepo.js';
import { createOrderStatusService, type OrderStatusService } from '../payments/orderStatus.js';
import { createStripeGateway } from '../payments/stripe.js';
import { createWebhookService, type WebhookService } from '../payments/webhookService.js';
import { createRateLimiter } from '../ratelimit/limiter.js';
import { policiesForProfile } from '../ratelimit/policies.js';
import { createRedisRateLimitStore } from '../ratelimit/slidingWindow.js';
import { createTmdbMovieSource } from '../movies/tmdb.js';
import { createSeatService } from '../showtimes/seatService.js';
import { createShowtimeService } from '../showtimes/service.js';
import { readWaitingRoomConfig } from '../waitingroom/config.js';
import { createRedisWaitingRoomStore } from '../waitingroom/store.js';
import { createWaitingRoom } from '../waitingroom/waitingRoom.js';
import { createApp } from './app.js';
import type { Redis } from 'ioredis';

// Local-development default only; a host injects its own PORT.
const DEFAULT_PORT = 3000;

function readPort(): number {
  const raw = process.env.PORT;
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535, got "${raw}"`);
  }
  return port;
}

// Never logged or echoed: only its absence is reported, by name.
function readTmdbToken(): string {
  const token = process.env.TMDB_READ_TOKEN;
  if (!token) throw new Error('TMDB_READ_TOKEN is not set.');
  return token;
}

// Stripe is optional at boot: without both keys the checkout and webhook routes are simply not mounted, so a
// partially-configured server still serves the rest of the app. The values are never logged.
function readStripeConfig(): { secretKey?: string; webhookSecret?: string } {
  return {
    secretKey: process.env.STRIPE_SECRET_KEY?.trim() || undefined,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET?.trim() || undefined,
  };
}

const logger = createLogger();

// A bad or missing env var stops the server before it listens: never start weaker. Every boot
// and shutdown line goes through the logger — no console.log/console.error anywhere (AGENTS.md).
let port: number;
let db: ReturnType<typeof createDbClients>;
let tmdbReadToken: string;
let holdCaps: ReturnType<typeof readHoldCaps>;
let roomSettings: ReturnType<typeof readWaitingRoomConfig>;
let overload: ReturnType<typeof readMaxInFlight>;
try {
  port = readPort();
  db = createDbClients();
  tmdbReadToken = readTmdbToken();
  holdCaps = readHoldCaps();
  roomSettings = readWaitingRoomConfig();
  overload = readMaxInFlight();
} catch (err) {
  logger.error('api_start_failed', { reason: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}

const redis = createRedisClient(logger);
void redis.connect().catch(() => {
  // Already reported through the 'error' event handler in createRedisClient; ioredis keeps
  // retrying in the background.
});

const movies = createMovieService({
  source: createTmdbMovieSource({ readToken: tmdbReadToken, logger }),
  cache: createMovieCache({ store: createRedisStore(redis), logger }),
  logger,
});
const showtimes = createShowtimeService(db);
const bookingRepo = createBookingRepo(db);
// The hold caps (ADR 0018): how many seats of one showing an install, and an address, may hold at once.
logger.info('hold_caps', { perOwner: holdCaps.caps.perOwner, perAddress: holdCaps.caps.perAddress, profile: holdCaps.profile });
if (holdCaps.profile === 'loadtest') {
  logger.warn('traffic_profile_loadtest', { note: 'relaxed traffic limits for a load test; never run production like this' });
}
const holds = createRedisHoldStore(redis, { caps: holdCaps.caps });

// The waiting room (ADR 0017) and load shedding. The numbers are logged at boot so a deploy shows what it is running.
const { config: roomConfig } = roomSettings;
logger.info('waiting_room_config', {
  enabled: roomConfig.enabled,
  maxActive: roomConfig.maxActive,
  admitPerMinute: roomConfig.admitPerMinute,
  maxInFlight: overload.maxInFlight,
  profile: roomSettings.profile,
});
if (roomConfig.enabled && roomConfig.maxActiveIsDefault) {
  // The default (2) exists so the queue can be shown on two or three phones. It is far too low for production: raise it before deploying.
  logger.warn('waiting_room_demo_defaults', {
    maxActive: roomConfig.maxActive,
    note: 'WAITING_ROOM_MAX_ACTIVE is not set, so the DEMO value is in use: every showing queues everyone behind this many people. Set it for production (ADR 0017).',
  });
}
const waitingRoom = createWaitingRoom({
  store: createRedisWaitingRoomStore(redis, { policy: { maxActive: roomConfig.maxActive, admitPerMinute: roomConfig.admitPerMinute } }),
  holds,
  config: roomConfig,
  logger,
});
const showtimeExists = async (id: string) => (await db.reader.$replica().showtime.findUnique({ where: { id }, select: { id: true } })) !== null;
const ryow = createRedisRyowStore(redis);
const seats = createSeatService(db, { repo: bookingRepo, holds, ryow });
const bookings = createBookingService({ repo: bookingRepo, holds, ryow, logger });

// Payments (ADR 0019): checkout and the webhook, mounted only when both Stripe keys are present. The BullMQ
// producer uses its own Redis connection (maxRetriesPerRequest: null) on the same Railway Redis (ADR 0008).
const stripeConfig = readStripeConfig();
let checkout: CheckoutService | undefined;
let webhook: WebhookService | undefined;
let orderStatus: OrderStatusService | undefined;
let paymentQueue: PaymentQueue | undefined;
let bullMq: Redis | undefined;
if (stripeConfig.secretKey && stripeConfig.webhookSecret) {
  const gateway = createStripeGateway({ secretKey: stripeConfig.secretKey, webhookSecret: stripeConfig.webhookSecret });
  const orderRepo = createOrderRepo(db);
  const eventRepo = createStripeEventRepo(db);
  bullMq = createBullMqConnection(logger);
  paymentQueue = createPaymentQueue(bullMq);
  checkout = createCheckoutService({ repo: orderRepo, gateway, bookings, logger });
  webhook = createWebhookService({ gateway, events: eventRepo, enqueue: (name, data, jobId) => paymentQueue!.add(name, data, jobId), logger });
  orderStatus = createOrderStatusService({ repo: orderRepo, movies, logger });
} else {
  logger.warn('payments_disabled', { note: 'STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are not both set; checkout, the webhook and the order status are not mounted.' });
}

// Fails open if Redis is down (limiter.ts); the hold store above is the part that fails closed.
// TRAFFIC_PROFILE=loadtest lifts the per-ADDRESS limits (the k6 test sends 500 users from one address) and
// keeps the per-install limits (policies.ts, ADR 0016's open item).
const rateLimiter = createRateLimiter({ store: createRedisRateLimitStore(redis), logger, policies: policiesForProfile(holdCaps.profile) });

const app = createApp({ logger, db, redis, movies, showtimes, seats, bookings, checkout, webhook, orderStatus, rateLimiter, waitingRoom, showtimeExists, maxInFlight: overload.maxInFlight });

const server = app.listen(port, () => {
  logger.info('api_listening', { port });
});

async function shutdown(signal: NodeJS.Signals) {
  logger.info('api_shutting_down', { reason: signal });
  server.closeIdleConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await paymentQueue?.close();
  bullMq?.disconnect();
  redis.disconnect();
  await closeDbClients(db);
  logger.info('api_closed');
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
