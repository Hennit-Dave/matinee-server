import { randomUUID } from 'node:crypto';
import type { BookingService } from '../bookings/bookingService.js';
import { ApiError } from '../http/errors.js';
import type { Logger } from '../http/logger.js';
import { formatPriceCents } from '../showtimes/showtime.js';
import { CURRENCY, SERVICE_FEE_CENTS } from './config.js';
import { IdempotencyKeyConflictError, type OrderRecord, type OrderRepo } from './orderRepo.js';
import type { CheckoutResponse } from './payments.js';
import type { PaymentGateway } from './stripe.js';

/**
 * Checkout initiation (ADR 0019): verify the caller still holds every seat, price the order on the server
 * (seats + one flat fee), create the Stripe PaymentIntent, and return its client_secret. Idempotent on the
 * `Idempotency-Key` header: a repeated key returns the SAME order/PaymentIntent, never a second charge.
 */

export interface CheckoutInput {
  showtimeId: string;
  ownerId: string;
  seatIds: readonly string[];
  idempotencyKey: string;
  requestId?: string;
}

export interface CheckoutResult extends CheckoutResponse {
  /** false on an idempotent replay (the same order, returned again). */
  created: boolean;
}

export interface CheckoutService {
  checkout(input: CheckoutInput): Promise<CheckoutResult>;
}

export interface CheckoutServiceDeps {
  repo: OrderRepo;
  gateway: PaymentGateway;
  bookings: Pick<BookingService, 'verifyHolds'>;
  logger?: Logger;
}

const sameSeats = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

export function createCheckoutService(deps: CheckoutServiceDeps): CheckoutService {
  const { repo, gateway, bookings, logger } = deps;

  function toResponse(order: OrderRecord, clientSecret: string | null): CheckoutResponse {
    return {
      reference: order.reference,
      showtimeId: order.showtimeId,
      seatIds: order.seatIds,
      seatTotalCents: order.seatTotalCents,
      feeCents: order.feeCents,
      totalCents: order.totalCents,
      totalFormatted: formatPriceCents(order.totalCents),
      currency: order.currency,
      clientSecret,
      status: order.status,
    };
  }

  /** Any Stripe call that fails is "payment is down right now", not a 500. */
  function asUnavailable(err: unknown): never {
    throw new ApiError('payment_unavailable', { reason: err instanceof Error ? err.message : String(err) });
  }

  async function replay(order: OrderRecord): Promise<CheckoutResult> {
    let clientSecret: string | null;
    try {
      clientSecret = (await gateway.retrievePaymentIntent(order.stripePaymentIntentId)).clientSecret;
    } catch (err) {
      return asUnavailable(err);
    }
    return { created: false, ...toResponse(order, clientSecret) };
  }

  return {
    async checkout(input) {
      // Idempotency first: a repeated key returns the stored order (same PaymentIntent), not a second charge.
      const existing = await repo.findByOwnerIdempotencyKey(input.ownerId, input.idempotencyKey);
      if (existing) {
        if (!sameSeats(existing.seatIds, input.seatIds)) throw new ApiError('idempotency_mismatch');
        logger?.info('checkout_replayed', {
          reference: existing.reference,
          userId: input.ownerId,
          showtimeId: input.showtimeId,
          seatCount: input.seatIds.length,
        });
        return replay(existing);
      }

      // The "you may pay" gate: the caller must still hold every seat (throws seat_not_held / not_found / holds_unavailable).
      const found = await bookings.verifyHolds({
        showtimeId: input.showtimeId,
        ownerId: input.ownerId,
        seatIds: input.seatIds,
        requestId: input.requestId,
      });

      const seatTotalCents = found.priceCents * input.seatIds.length;
      const totalCents = seatTotalCents + SERVICE_FEE_CENTS;
      const reference = randomUUID();

      let pi;
      try {
        pi = await gateway.createPaymentIntent({
          amountCents: totalCents,
          currency: CURRENCY,
          metadata: { reference, showtimeId: input.showtimeId, seatIds: JSON.stringify(input.seatIds), ownerId: input.ownerId },
          idempotencyKey: `${input.ownerId}:${input.idempotencyKey}`,
        });
      } catch (err) {
        return asUnavailable(err);
      }

      let order: OrderRecord;
      try {
        order = await repo.createOrder({
          reference,
          ownerId: input.ownerId,
          showtimeId: input.showtimeId,
          seatIds: input.seatIds,
          seatTotalCents,
          feeCents: SERVICE_FEE_CENTS,
          totalCents,
          currency: CURRENCY,
          stripePaymentIntentId: pi.id,
          idempotencyKey: input.idempotencyKey,
        });
      } catch (err) {
        if (!(err instanceof IdempotencyKeyConflictError)) throw err;
        // Lost the idempotency race: another request with this key won. Return its order. The PaymentIntent we
        // just created is never confirmed, so Stripe expires it harmlessly.
        const winner = await repo.findByOwnerIdempotencyKey(input.ownerId, input.idempotencyKey);
        if (winner) return replay(winner);
        throw err;
      }

      logger?.info('checkout_initiated', {
        reference: order.reference,
        userId: input.ownerId,
        showtimeId: input.showtimeId,
        seatCount: input.seatIds.length,
        amountCents: totalCents,
        paymentIntentId: pi.id,
      });
      return { created: true, ...toResponse(order, pi.clientSecret) };
    },
  };
}
