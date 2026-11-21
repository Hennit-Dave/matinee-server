import { Worker } from 'bullmq';
import { createBookingRepo } from '../bookings/bookingRepo.js';
import { createBookingService } from '../bookings/bookingService.js';
import { readHoldCaps } from '../bookings/holdCaps.js';
import { createRedisHoldStore } from '../bookings/holdStore.js';
import { createRedisRyowStore } from '../bookings/ryow.js';
import { closeDbClients, createDbClients } from '../db/clients.js';
import { createLogger } from '../http/logger.js';
import { createStripeEventRepo } from '../payments/eventRepo.js';
import { createOrderRepo } from '../payments/orderRepo.js';
import { handlePaymentSucceeded, type PaymentJobPayload } from '../payments/processor.js';
import { settleCancelledShowtime, type CancelRefundPayload } from '../payments/cancelRefund.js';
import { createStripeGateway } from '../payments/stripe.js';
import { createShowtimeCancelRepo } from '../showtimes/cancelRepo.js';
import { createBullMqConnection, createRedisClient } from './connection.js';
import { JOB_PAYMENT_SUCCEEDED, JOB_SHOWTIME_CANCELLED, PAYMENT_QUEUE_NAME } from './queue.js';
import { captureException, initSentry } from '../observability/sentry.js';

/**
 * The payment worker (ADR 0019), a SEPARATE always-on process from the API: the webhook enqueues and returns
 * 200, and this process does the confirm/refund work with retries and backoff. It runs on the same Railway
 * Redis as the rest of the app (ADR 0008) — never the Upstash "Jobapplicationmanager" DB.
 *
 *   npm run worker            (built)       npm run dev:worker        (tsx watch)
 */

const logger = createLogger();

// Error tracking (observability slice). Fail-safe: without SENTRY_DSN this no-ops and the worker still boots.
initSentry();

// A bad or missing env var stops the worker before it starts, like main.ts. Only the secret's ABSENCE is
// reported, by name — the value is never logged.
function readStripeSecretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set.');
  return key;
}

let db: ReturnType<typeof createDbClients>;
let stripeSecretKey: string;
let holdCaps: ReturnType<typeof readHoldCaps>;
try {
  db = createDbClients();
  stripeSecretKey = readStripeSecretKey();
  holdCaps = readHoldCaps();
} catch (err) {
  logger.error('worker_start_failed', { reason: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}

// The hold store and read-your-own-writes share the regular Redis client; BullMQ gets its own (maxRetriesPerRequest: null).
const redis = createRedisClient(logger);
void redis.connect().catch(() => {});
const bullMq = createBullMqConnection(logger);

const holds = createRedisHoldStore(redis, { caps: holdCaps.caps });
const ryow = createRedisRyowStore(redis);
const bookingRepo = createBookingRepo(db);
const bookings = createBookingService({ repo: bookingRepo, holds, ryow, logger });

const gateway = createStripeGateway({ secretKey: stripeSecretKey });
const orderRepo = createOrderRepo(db);
const eventRepo = createStripeEventRepo(db);
const showtime = createShowtimeCancelRepo(db);

const worker = new Worker(
  PAYMENT_QUEUE_NAME,
  async (job) => {
    if (job.name === JOB_PAYMENT_SUCCEEDED) {
      await handlePaymentSucceeded({ repo: orderRepo, gateway, bookings, events: eventRepo, showtime, logger }, job.data as PaymentJobPayload);
    } else if (job.name === JOB_SHOWTIME_CANCELLED) {
      await settleCancelledShowtime({ repo: orderRepo, gateway, bookings: bookingRepo, holds, logger }, job.data as CancelRefundPayload);
    }
    // Any other job kind is acked (nothing to do).
  },
  { connection: bullMq },
);

worker.on('completed', (job) => {
  logger.info('job_completed', { jobId: String(job.id), ...(job.name ? { reason: job.name } : {}) });
});
worker.on('failed', (job, err) => {
  const jobId = String(job?.id ?? '');
  const attempt = job?.attemptsMade ?? 0;
  logger.error('job_failed', { jobId, attempt, reason: err.message });

  // Retries exhausted (attemptsMade reached the configured attempts): capture to Sentry with the payload ids so a
  // stuck payment/refund surfaces and can be traced. A mid-retry failure just logs (BullMQ will retry it).
  const attempts = job?.opts?.attempts ?? 1;
  if (job && job.attemptsMade >= attempts) {
    const data = job.data as Record<string, string>;
    captureException(err, {
      tags: {
        jobId,
        job: job.name,
        ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      },
    });
  }
});

logger.info('worker_started', { note: PAYMENT_QUEUE_NAME });

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info('worker_shutting_down', { reason: signal });
  await worker.close();
  bullMq.disconnect();
  redis.disconnect();
  await closeDbClients(db);
  logger.info('worker_closed');
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
