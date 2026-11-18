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
import { createStripeGateway } from '../payments/stripe.js';
import { createBullMqConnection, createRedisClient } from './connection.js';
import { JOB_PAYMENT_SUCCEEDED, PAYMENT_QUEUE_NAME } from './queue.js';

/**
 * The payment worker (ADR 0019), a SEPARATE always-on process from the API: the webhook enqueues and returns
 * 200, and this process does the confirm/refund work with retries and backoff. It runs on the same Railway
 * Redis as the rest of the app (ADR 0008) — never the Upstash "Jobapplicationmanager" DB.
 *
 *   npm run worker            (built)       npm run dev:worker        (tsx watch)
 */

const logger = createLogger();

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
const bookings = createBookingService({ repo: createBookingRepo(db), holds, ryow, logger });

const gateway = createStripeGateway({ secretKey: stripeSecretKey });
const orderRepo = createOrderRepo(db);
const eventRepo = createStripeEventRepo(db);

const worker = new Worker(
  PAYMENT_QUEUE_NAME,
  async (job) => {
    if (job.name === JOB_PAYMENT_SUCCEEDED) {
      await handlePaymentSucceeded({ repo: orderRepo, gateway, bookings, events: eventRepo, logger }, job.data as PaymentJobPayload);
    }
    // Any other job kind is acked (nothing to do).
  },
  { connection: bullMq },
);

worker.on('completed', (job) => {
  logger.info('job_completed', { jobId: String(job.id), ...(job.name ? { reason: job.name } : {}) });
});
worker.on('failed', (job, err) => {
  logger.error('job_failed', { jobId: String(job?.id ?? ''), attempt: job?.attemptsMade ?? 0, reason: err.message });
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
