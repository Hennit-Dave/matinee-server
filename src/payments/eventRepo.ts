import type { DbClients } from '../db/clients.js';
import { isUniqueViolation } from '../bookings/bookingRepo.js';

/**
 * The webhook idempotency store (ADR 0019): every Stripe event id is recorded durably FIRST, before the 200,
 * so a re-delivered event is skipped by its primary key. `status` tracks processing ('received' -> 'processed' or
 * 'failed') and is metadata, not money.
 */

export interface StripeEventRepo {
  /** Insert-first dedup. Returns 'duplicate' when the event id was already recorded. */
  recordEvent(input: { eventId: string; type: string; paymentIntentId: string | null }): Promise<'inserted' | 'duplicate'>;
  markProcessed(eventId: string): Promise<void>;
  markFailed(eventId: string): Promise<void>;
}

export function createStripeEventRepo(db: DbClients): StripeEventRepo {
  return {
    async recordEvent(input) {
      try {
        await db.primary.processedStripeEvent.create({
          data: { eventId: input.eventId, type: input.type, paymentIntentId: input.paymentIntentId },
        });
        return 'inserted';
      } catch (err) {
        if (isUniqueViolation(err)) return 'duplicate';
        throw err;
      }
    },

    async markProcessed(eventId) {
      await db.primary.processedStripeEvent.update({ where: { eventId }, data: { status: 'processed', processedAt: new Date() } });
    },

    async markFailed(eventId) {
      await db.primary.processedStripeEvent.update({ where: { eventId }, data: { status: 'failed', processedAt: new Date() } });
    },
  };
}
