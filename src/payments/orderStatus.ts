import { z } from 'zod';
import type { MovieService } from '../movies/service.js';
import { formatPriceCents } from '../showtimes/showtime.js';
import type { Logger } from '../http/logger.js';
import type { OrderRepo } from './orderRepo.js';

/**
 * `GET /orders/:reference` — the confirmation poll for payments P2 (ADR 0019). The app presents the
 * PaymentSheet, then polls this until the order resolves: `succeeded` -> the ticket, `refunded` -> "seats
 * released", `failed` -> "payment didn't go through".
 *
 * NEVER CACHED (RULES C4: payment status is Postgres-only) and read from the PRIMARY: the status is written by
 * the worker's primary write and the app polls it immediately after, so a replica read could lag. It is also
 * exempt from load-shedding (loadShed.ts) and from the waiting room (a top-level route, not under /showtimes),
 * because a caller who has already paid must always be able to learn their outcome.
 */

export const OrderStatusResponseSchema = z.strictObject({
  reference: z.uuid(),
  status: z.enum(['requires_payment', 'succeeded', 'refunded', 'failed']),
  /** Present only when `status === 'succeeded'`: everything the QR ticket screen shows. */
  ticket: z
    .strictObject({
      movieId: z.number().int().positive(),
      /** Best-effort: empty when TMDB could not be reached. The app falls back to the route param / movie detail. */
      movieTitle: z.string(),
      cinemaName: z.string(),
      screenName: z.string(),
      format: z.string(),
      startsAt: z.iso.datetime(),
      /** UTC HH:MM, the same as the seat map's `time`. */
      time: z.string().regex(/^\d{2}:\d{2}$/),
      seats: z.array(z.strictObject({ row: z.string().regex(/^[A-Z]$/), number: z.number().int().positive() })),
      /** Server-formatted total (e.g. "£38.50"); the app never computes money. */
      totalFormatted: z.string(),
    })
    .optional(),
  /** Present only when `status === 'refunded'`: why the money came back, for the app's copy. */
  refundReason: z.string().optional(),
});
export type OrderStatusResponse = z.infer<typeof OrderStatusResponseSchema>;

export interface OrderStatusService {
  /** The order's status (+ ticket / refund reason), or `null` for an unknown or foreign reference (a 404). */
  status(reference: string, ownerId: string): Promise<OrderStatusResponse | null>;
}

export interface OrderStatusServiceDeps {
  repo: OrderRepo;
  movies: Pick<MovieService, 'detail'>;
  logger?: Logger;
}

export function createOrderStatusService(deps: OrderStatusServiceDeps): OrderStatusService {
  const { repo, movies, logger } = deps;

  /** The title is best-effort: the booking is confirmed whether or not TMDB can say the film's name. */
  async function resolveTitle(movieId: number): Promise<string> {
    try {
      return (await movies.detail(movieId)).movie.title;
    } catch (err) {
      logger?.warn('order_ticket_title_unavailable', { reason: err instanceof Error ? err.message : String(err) });
      return '';
    }
  }

  return {
    async status(reference, ownerId) {
      const order = await repo.findByReference(reference);
      // A reference owned by someone else is indistinguishable from one that does not exist (it is a bearer id).
      if (!order || order.ownerId !== ownerId) return null;

      const base = { reference: order.reference, status: order.status };

      if (order.status === 'succeeded') {
        const ticket = await repo.findTicketByReference(reference);
        return {
          ...base,
          ...(ticket
            ? {
                ticket: {
                  movieId: ticket.movieId,
                  movieTitle: await resolveTitle(ticket.movieId),
                  cinemaName: ticket.cinemaName,
                  screenName: ticket.screenName,
                  format: ticket.format,
                  startsAt: ticket.startsAt.toISOString(),
                  time: ticket.startsAt.toISOString().slice(11, 16),
                  seats: ticket.seats,
                  totalFormatted: formatPriceCents(order.totalCents),
                },
              }
            : {}),
        };
      }

      if (order.status === 'refunded') {
        const reason = await repo.refundReason(order.id);
        return { ...base, ...(reason ? { refundReason: reason } : {}) };
      }

      return base;
    },
  };
}
