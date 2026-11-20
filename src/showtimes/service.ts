import type { DbClients } from '../db/clients.js';
import { groupShowtimesByCinemaAndDate, type ShowtimeService } from './showtime.js';

/**
 * Showtime read service. Routes reads to the Postgres read replica (`db.reader.$replica()`).
 * Results are NOT cached in Redis so upcoming live seat-availability slices never serve stale
 * showtime state (ADR 0010).
 */
export function createShowtimeService(db: DbClients): ShowtimeService {
  return {
    async forMovie(movieId, from = new Date()) {
      const rows = await db.reader.$replica().showtime.findMany({
        where: {
          movieId,
          startsAt: { gte: from },
          cancelledAt: null, // a cancelled showing never appears in the list (ADR 0020)
        },
        orderBy: { startsAt: 'asc' },
        include: {
          screen: {
            include: {
              cinema: true,
            },
          },
        },
      });
      return groupShowtimesByCinemaAndDate(movieId, rows);
    },
  };
}
