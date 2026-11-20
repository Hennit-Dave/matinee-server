import type { BookingService } from '../bookings/bookingService.js';
import { ApiError } from '../http/errors.js';
import type { Logger } from '../http/logger.js';
import type { ShowtimeCancelRepo } from '../showtimes/cancelRepo.js';
import type { StripeEventRepo } from './eventRepo.js';
import type { OrderRecord, OrderRepo } from './orderRepo.js';
import type { PaymentGateway } from './stripe.js';

/**
 * The payment job processor (ADR 0019): for a succeeded Stripe payment, turn the hold into a booking via the
 * existing `confirmBooking`, record the charge in the append-only ledger, and — if the hold expired in the
 * meantime, or the showtime has been cancelled (ADR 0020) — refund the PaymentIntent so the money is never kept
 * without a booking. It is a pure function, so it is unit-tested with fakes; the BullMQ Worker is a thin shell
 * over it.
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
  showtime: Pick<ShowtimeCancelRepo, 'isCancelled'>;
  logger?: Logger;
}

export const REFUND_REASON_SEAT_TAKEN = 'hold_expired_refund';
export const REFUND_REASON_NOT_HELD = 'hold_lapsed_refund';
export const REFUND_REASON_SHOWTIME_CANCELLED = 'showtime_cancelled_refund';

/** The one refund path: Stripe refund (deterministic key) + ledger + terminal status + log. */
async function issueRefund(
  deps: { repo: OrderRepo; gateway: PaymentGateway; logger?: Logger },
  order: OrderRecord,
  reason: string,
  stripeEventId: string,
): Promise<void> {
  const { repo, gateway, logger } = deps;
  const refund = await gateway.refund(order.stripePaymentIntentId, `refund_${order.stripePaymentIntentId}`);
  await repo.appendLedger({
    orderId: order.id,
    kind: 'refund',
    amountCents: order.totalCents,
    stripeObjectId: refund.id,
    stripeEventId,
    reason,
  });
  await repo.setStatus(order.id, 'refunded');
  logger?.info('refund_issued', {
    reference: order.reference,
    eventId: stripeEventId,
    paymentIntentId: order.stripePaymentIntentId,
    amountCents: order.totalCents,
    reason,
  });
}

export async function handlePaymentSucceeded(deps: PaymentProcessorDeps, payload: PaymentJobPayload): Promise<void> {
  const { repo, gateway, bookings, events, logger, showtime } = deps;

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
    // Cancelled showtime (ADR 0020): the money must never be kept on a dead showing. This pre-check skips the
    // confirm attempt entirely; the catch below is the backstop for the narrow window where the flag reads false
    // here but the cancel lands before `confirmBooking`'s own seat check throws `showtime_cancelled`.
    if (await showtime.isCancelled(order.showtimeId)) {
      await issueRefund({ repo, gateway, logger }, order, REFUND_REASON_SHOWTIME_CANCELLED, payload.eventId);
      await events.markProcessed(payload.eventId);
      return;
    }

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
    if (err instanceof ApiError && (err.code === 'seat_taken' || err.code === 'seat_not_held' || err.code === 'showtime_cancelled')) {
      // Paid, but no booking can stand: refund. Never double-book, never keep the money, and never confirm on a
      // cancelled showing. The three causes share one path with distinct ledger reasons.
      const reason =
        err.code === 'seat_taken'
          ? REFUND_REASON_SEAT_TAKEN
          : err.code === 'seat_not_held'
            ? REFUND_REASON_NOT_HELD
            : REFUND_REASON_SHOWTIME_CANCELLED;
      await issueRefund({ repo, gateway, logger }, order, reason, payload.eventId);
    } else {
      throw err; // transient (DB / Redis / Stripe): let BullMQ retry with exponential backoff
    }
  }

  await events.markProcessed(payload.eventId);
}
