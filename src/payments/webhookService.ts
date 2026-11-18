import { ApiError } from '../http/errors.js';
import type { Logger } from '../http/logger.js';
import { JOB_PAYMENT_SUCCEEDED } from '../jobs/queue.js';
import type { StripeEventRepo } from './eventRepo.js';
import type { PaymentGateway } from './stripe.js';

/**
 * The Stripe webhook (ADR 0019, AGENTS.md §8): verify the signature against the RAW body, record the event id
 * durably first, then enqueue the job and ack 200 — it never confirms a booking inline. Re-delivered events are
 * skipped by the event store's primary key.
 */

export const WEBHOOK_EVENT_PAYMENT_SUCCEEDED = 'payment_intent.succeeded';

export interface WebhookInput {
  rawBody: Buffer;
  signatureHeader: string;
}

export interface WebhookService {
  handle(input: WebhookInput): Promise<{ received: true }>;
}

export interface WebhookServiceDeps {
  gateway: PaymentGateway;
  events: StripeEventRepo;
  /** Enqueue a BullMQ job. `jobId` is the Stripe event id, so a re-enqueue of the same event is a no-op. */
  enqueue: (name: string, data: Record<string, string>, jobId: string) => Promise<void>;
  logger?: Logger;
}

export function createWebhookService(deps: WebhookServiceDeps): WebhookService {
  const { gateway, events, enqueue, logger } = deps;

  return {
    async handle({ rawBody, signatureHeader }) {
      // Verify the signature. A bad or stale signature is a 400, never processed.
      let event;
      try {
        event = gateway.constructEvent(rawBody, signatureHeader);
      } catch (err) {
        logger?.warn('webhook_signature_invalid', { reason: err instanceof Error ? err.message : String(err) });
        throw new ApiError('validation_failed', { details: [{ path: 'header.stripe-signature', code: 'invalid_signature' }] });
      }

      // Record the event id durably FIRST, then ack. A duplicate means we already saw it: skip.
      // (The window between this insert and the enqueue below is the one place a crash could strand an event as
      // 'received'; it is visible in the store for reconciliation, and BullMQ's own jobId dedup keeps a re-add safe.)
      const recorded = await events.recordEvent({ eventId: event.id, type: event.type, paymentIntentId: event.paymentIntentId });
      if (recorded === 'duplicate') {
        logger?.info('webhook_skipped', { eventId: event.id, eventType: event.type });
        return { received: true };
      }

      logger?.info('webhook_received', { eventId: event.id, eventType: event.type, ...(event.paymentIntentId ? { paymentIntentId: event.paymentIntentId } : {}) });

      // Only a succeeded payment moves the flow forward; every other event type is recorded and acked.
      if (event.type === WEBHOOK_EVENT_PAYMENT_SUCCEEDED && event.paymentIntentId) {
        await enqueue(JOB_PAYMENT_SUCCEEDED, { eventId: event.id, paymentIntentId: event.paymentIntentId }, event.id);
      }

      return { received: true };
    },
  };
}
