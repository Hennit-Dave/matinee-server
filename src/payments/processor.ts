import type { BookingService } from '../bookings/bookingService.js';
import { ApiError } from '../http/errors.js';
import type { Logger } from '../http/logger.js';
import type { StripeEventRepo } from './eventRepo.js';
import type { OrderRepo } from './orderRepo.js';
import type { PaymentGateway } from './stripe.js';

/**
 * The payment job processor (ADR 0019): for a succeeded Stripe payment, turn the hold into a booking via the
 * existing `confirmBooking`, record the charge in the append-only ledger, and — if the hold expired in the
 * meantime — refund the PaymentIntent so the money is never kept without a booking. It is a pure function, so
 * it is unit-tested with fakes; the BullMQ Worker is a thin shell over it.
 *
 * Idempotency across BullMQ retries (the three guards, in order): the order's status, the ledger's unique
 * `stripeObjectId`, and `confirmBooking`'s reference replay. A retry at any point converges, never double-charges
 * and never double-books.
 */

export interface PaymentJobPayload {
  eventId: string;
  paymentIntentId: string;
}

export interface PaymentProcessorDeps {
  repo: OrderRepo;
  gateway: PaymentGateway;
  bookings: Pick<BookingService, 'confirmBooking'>;
  events: StripeEventRepo;
  logger?: Logger;
}

export const REFUND_REASON_SEAT_TAKEN = 'hold_expired_refund';
export const REFUND_REASON_NOT_HELD = 'hold_lapsed_refund';

export async function handlePaymentSucceeded(deps: PaymentProcessorDeps, payload: PaymentJobPayload): Promise<void> {
  const { repo, gateway, bookings, events, logger } = deps;

  const order = await repo.findByPaymentIntentId(payload.paymentIntentId);
  if (!order) {
    // A Stripe event for a PaymentIntent we do not know (or one created before this code shipped): ack, don't retry.
    logger?.warn('payment_order_unknown', { eventId: payload.eventId, paymentIntentId: payload.paymentIntentId });
    await events.markProcessed(payload.eventId);
    return;
  }
  if (order.status !== 'requires_payment') {
    await events.markProcessed(payload.eventId);
    return; // already handled — the idempotency short-circuit
  }

  // The charge is a fact the moment Stripe says "succeeded"; record it first, whatever follows.
  await repo.appendLedger({
    orderId: order.id,
    kind: 'charge',
    amountCents: order.totalCents,
    stripeObjectId: order.stripePaymentIntentId,
    stripeEventId: payload.eventId,
    reason: 'payment_succeeded',
  });

  try {
    await bookings.confirmBooking(
      { showtimeId: order.showtimeId, ownerId: order.ownerId, seatIds: order.seatIds },
      { reference: order.reference },
    );
    await repo.setStatus(order.id, 'succeeded');
    logger?.info('payment_confirmed', {
      reference: order.reference,
      eventId: payload.eventId,
      paymentIntentId: payload.paymentIntentId,
      amountCents: order.totalCents,
    });
  } catch (err) {
    if (err instanceof ApiError && (err.code === 'seat_taken' || err.code === 'seat_not_held')) {
      // Paid, but the hold is gone: refund. Never double-book, never silently keep the money.
      const reason = err.code === 'seat_taken' ? REFUND_REASON_SEAT_TAKEN : REFUND_REASON_NOT_HELD;
      const refund = await gateway.refund(order.stripePaymentIntentId, `refund_${order.stripePaymentIntentId}`);
      await repo.appendLedger({
        orderId: order.id,
        kind: 'refund',
        amountCents: order.totalCents,
        stripeObjectId: refund.id,
        stripeEventId: payload.eventId,
        reason,
      });
      await repo.setStatus(order.id, 'refunded');
      logger?.info('refund_issued', {
        reference: order.reference,
        eventId: payload.eventId,
        paymentIntentId: payload.paymentIntentId,
        amountCents: order.totalCents,
        reason,
      });
    } else {
      throw err; // transient (DB / Redis / Stripe): let BullMQ retry with exponential backoff
    }
  }

  await events.markProcessed(payload.eventId);
}
