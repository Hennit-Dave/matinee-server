import { z } from 'zod';
import type { MovieService } from '../movies/service.js';
import { formatPriceCents } from '../showtimes/showtime.js';
import type { Logger } from '../http/logger.js';
import type { OrderRepo } from './orderRepo.js';
import { TicketSchema } from './orderStatus.js';

/**
 * `GET /tickets` — the caller's orders that have ticket context, for the mobile Tickets tab. Includes `succeeded`
 * (app badges "Ready" / "Watched"), `refunded` ("Refunded") and in-flight `requires_payment` ("Confirming");
 * `failed` orders (no ticket) are excluded. Soonest upcoming show first, past shows after. NEVER CACHED (RULES C4)
 * and read from the PRIMARY, like `GET /orders/:reference`.
 */

export const TicketListItemSchema = z.strictObject({
  reference: z.uuid(),
  /** `failed` is absent: it has no ticket context and is excluded from the list. */
  status: z.enum(['requires_payment', 'succeeded', 'refunded']),
  ...TicketSchema.shape,
});
export const TicketsResponseSchema = z.array(TicketListItemSchema);
export type TicketsResponse = z.infer<typeof TicketsResponseSchema>;

export interface TicketsService {
  /** The caller's tickets (with status), soonest upcoming first. */
  list(ownerId: string): Promise<TicketsResponse>;
}

export interface TicketsServiceDeps {
  repo: OrderRepo;
  movies: Pick<MovieService, 'detail'>;
  logger?: Logger;
  /** Injectable for tests. */
  now?: () => number;
}

/**
 * Sorts tickets so the soonest UPCOMING show is first and past shows follow (most recent past first). Pure, so it
 * is unit-tested.
 */
export function orderTickets<T extends { startsAt: Date }>(tickets: readonly T[], now: number): T[] {
  return [...tickets].sort((a, b) => {
    const aPast = a.startsAt.getTime() < now;
    const bPast = b.startsAt.getTime() < now;
    if (aPast !== bPast) return aPast ? 1 : -1;
    return aPast ? b.startsAt.getTime() - a.startsAt.getTime() : a.startsAt.getTime() - b.startsAt.getTime();
  });
}

export function createTicketsService(deps: TicketsServiceDeps): TicketsService {
  const { repo, movies, logger } = deps;
  const now = deps.now ?? Date.now;

  /** Best-effort title: the ticket is listed whether or not TMDB can name the film. */
  async function titleFor(movieId: number): Promise<string> {
    try {
      return (await movies.detail(movieId)).movie.title;
    } catch (err) {
      logger?.warn('tickets_title_unavailable', { reason: err instanceof Error ? err.message : String(err) });
      return '';
    }
  }

  return {
    async list(ownerId) {
      const tickets = orderTickets(await repo.findTicketsByOwner(ownerId), now());

      // Resolve each film's title once, deduped by movieId — never one TMDB call per ticket.
      const titles = new Map<number, string>();
      await Promise.all([...new Set(tickets.map((t) => t.movieId))].map(async (id) => titles.set(id, await titleFor(id))));

      return tickets.map((t) => ({
        reference: t.reference,
        status: t.status,
        movieId: t.movieId,
        movieTitle: titles.get(t.movieId) ?? '',
        cinemaName: t.cinemaName,
        screenName: t.screenName,
        format: t.format,
        startsAt: t.startsAt.toISOString(),
        time: t.startsAt.toISOString().slice(11, 16),
        seats: t.seats,
        totalFormatted: formatPriceCents(t.totalCents),
      }));
    },
  };
}
