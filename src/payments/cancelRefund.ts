import type { BookingRepo } from '../bookings/bookingRepo.js';
import type { HoldStore } from '../bookings/holdStore.js';
import type { Logger } from '../http/logger.js';
import type { OrderRecord, OrderRepo } from './orderRepo.js';
import type { PaymentGateway } from './stripe.js';
import { REFUND_REASON_SHOWTIME_CANCELLED } from './processor.js';

/**
 * The cancelled-showtime refund job (ADR 0020): walk a showtime's orders and settle each by its state, idempotently.
 * Pure and unit-tested with fakes; the BullMQ Worker is a thin shell over it.
 *
 * Per-order state machine:
 *   - `succeeded`            -> the money moved and the seats are booked: refund the PaymentIntent (deterministic
 *                               `refund_<pi>` key), append a `refund` ledger row, mark `refunded`, and delete the
 *                               booking rows so the seats are released.
 *   - `requires_payment`     -> no charge to refund: cancel the PaymentIntent (the PaymentSheet can no longer
 *                               complete) and release the holds, then mark `failed`. If the intent can no longer be
 *                               cancelled (it already succeeded), leave it `requires_payment` so the webhook's
 *                               cancellation-aware processor refunds it.
 *   - `refunded` / `failed`  -> skip.
 *
 * Idempotency: the Stripe refund idempotency key (`refund_<pi>`) and the ledger's unique `stripeObjectId` make a
 * re-run of a `succeeded` order a no-op (one refund object, one refund row); the order's status short-circuits the
 * rest. A second run finds every order terminal and does nothing.
 */

export interface CancelRefundDeps {
  repo: OrderRepo;
  gateway: PaymentGateway;
  bookings: Pick<BookingRepo, 'deleteBookingsByReference'>;
  holds: Pick<HoldStore, 'release'>;
  logger?: Logger;
}

export interface CancelRefundPayload {
  showtimeId: string;
}

export interface CancelRefundResult {
  /** Succeeded orders refunded (charge + refund, seats released). */
  refunded: number;
  /** Unpaid orders cancelled and marked `failed`. */
  cancelled: number;
  /** Unpaid orders whose PaymentIntent could no longer be cancelled — money is moving, the webhook processor refunds them. */
  deferred: number;
  /** Orders already `refunded` or `failed`, left alone. */
  skipped: number;
}

async function refundSucceeded(deps: CancelRefundDeps, order: OrderRecord): Promise<void> {
  const { repo, gateway, bookings, logger } = deps;
  const refund = await gateway.refund(order.stripePaymentIntentId, `refund_${order.stripePaymentIntentId}`);
  await repo.appendLedger({
    orderId: order.id,
    kind: 'refund',
    amountCents: order.totalCents,
    stripeObjectId: refund.id,
    stripeEventId: null, // not webhook-triggered: an admin/ops cancellation (ADR 0020)
    reason: REFUND_REASON_SHOWTIME_CANCELLED,
  });
  await repo.setStatus(order.id, 'refunded');
  await bookings.deleteBookingsByReference(order.reference);
  logger?.info('refund_issued', {
    reference: order.reference,
    paymentIntentId: order.stripePaymentIntentId,
    amountCents: order.totalCents,
    reason: REFUND_REASON_SHOWTIME_CANCELLED,
  });
}

/** True when the order was cancelled and marked `failed`; false when it was left for the webhook processor. */
async function cancelUnpaid(deps: CancelRefundDeps, order: OrderRecord): Promise<boolean> {
  const { repo, gateway, holds, logger } = deps;
  try {
    await gateway.cancelPaymentIntent(order.stripePaymentIntentId);
  } catch (err) {
    // The PaymentIntent can no longer be cancelled (it succeeded): the charge is moving, and the webhook's
    // cancellation-aware processor will refund it. Leave the order requires_payment — never strand the money.
    logger?.info('cancel_intent_unavailable', {
      reference: order.reference,
      paymentIntentId: order.stripePaymentIntentId,
      reason: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  await holds.release(order.showtimeId, order.ownerId, order.seatIds);
  await repo.setStatus(order.id, 'failed');
  return true;
}

export async function settleCancelledShowtime(deps: CancelRefundDeps, payload: CancelRefundPayload): Promise<CancelRefundResult> {
  const { repo, logger } = deps;
  const orders = await repo.ordersForShowtime(payload.showtimeId);
  const result: CancelRefundResult = { refunded: 0, cancelled: 0, deferred: 0, skipped: 0 };

  for (const order of orders) {
    switch (order.status) {
      case 'succeeded':
        await refundSucceeded(deps, order);
        result.refunded += 1;
        break;
      case 'requires_payment':
        if (await cancelUnpaid(deps, order)) result.cancelled += 1;
        else result.deferred += 1;
        break;
      case 'refunded':
      case 'failed':
        result.skipped += 1;
        break;
    }
  }

  logger?.info('showtime_cancelled_settled', {
    showtimeId: payload.showtimeId,
    refunded: result.refunded,
    cancelled: result.cancelled,
    deferred: result.deferred,
    skipped: result.skipped,
  });
  return result;
}
