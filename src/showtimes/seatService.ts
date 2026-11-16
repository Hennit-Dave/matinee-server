import type { DbClients } from '../db/clients.js';
import { buildShowtimeSeatsResponse, type SeatService } from './seat.js';

/**
 * Seat-map read service. The seat LAYOUT is static per screen, so it is read from the Postgres read
 * replica (`db.reader.$replica()`). It is NOT cached in Redis. When bookings and holds land, availability
 * must be read from the primary and Redis, never from the replica and never from a cache, because a
 * stale answer there could sell a seat twice (RULES C4, ADR 0014).
 */
export function createSeatService(db: DbClients): SeatService {
  return {
    async forShowtime(showtimeId) {
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
      return showtime ? buildShowtimeSeatsResponse(showtime) : null;
    },
  };
}
