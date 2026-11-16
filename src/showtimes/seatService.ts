import type { DbClients } from '../db/clients.js';
import type { BookingRepo } from '../bookings/bookingRepo.js';
import { HoldsUnavailableError, type HoldStore } from '../bookings/holdStore.js';
import type { RyowStore } from '../bookings/ryow.js';
import { ApiError } from '../http/errors.js';
import { buildShowtimeSeatsResponse, seatStatusResolver, type SeatService } from './seat.js';

export interface SeatServiceDeps {
  repo: BookingRepo;
  holds: HoldStore;
  ryow: RyowStore;
}

/**
 * Seat-map read service. Where each part of the answer comes from (ADR 0014, amended by ADR 0015):
 *
 * - The seat LAYOUT never changes, so it is read from the Postgres read replica and is not cached.
 * - SOLD seats are bookings. They are read from the replica too, except for the few seconds after the caller's
 *   own booking, when they come from the primary so the caller sees their own seat as sold (read-your-own-writes).
 *   A stale replica can only ever show a just-sold seat as free, never the reverse (bookings are insert-only),
 *   and every authoritative check (taking a hold, confirming) uses the primary, so the worst case is a tap that
 *   is refused with 409.
 * - HELD seats come from Redis, fresh on every request. Never cached (RULES C4).
 *
 * If Redis cannot be reached the map is not served (503): we do not present seat state we cannot verify.
 */
export function createSeatService(db: DbClients, deps: SeatServiceDeps): SeatService {
  return {
    async forShowtime(showtimeId, viewerId) {
      const showtime = await db.reader.$replica().showtime.findUnique({
        where: { id: showtimeId },
        include: {
          screen: {
            include: {
              seats: { orderBy: [{ row: 'asc' }, { number: 'asc' }] },
            },
          },
        },
      });
      if (!showtime) return null;

      try {
        const source = viewerId && (await deps.ryow.isActive(viewerId)) ? 'primary' : 'replica';
        const [sold, held] = await Promise.all([
          deps.repo.soldSeatIdsForShowtime(source, showtimeId),
          deps.holds.heldAmong(
            showtimeId,
            showtime.screen.seats.map((seat) => seat.id),
          ),
        ]);
        return buildShowtimeSeatsResponse(showtime, seatStatusResolver(new Set(sold), held));
      } catch (err) {
        if (err instanceof HoldsUnavailableError) throw new ApiError('service_unavailable', { reason: err.message });
        throw err;
      }
    },
  };
}
