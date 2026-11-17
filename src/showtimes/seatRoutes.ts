import { Router } from 'express';
import type { z } from 'zod';
import { clientIdHeader } from '../http/clientId.js';
import { ApiError } from '../http/errors.js';
import { recordRouteBase } from '../http/logger.js';
import { validateRequest } from '../http/validate.js';
import type { LimitFactory } from '../ratelimit/limiter.js';
import { ShowtimeIdParamsSchema, type SeatService } from './seat.js';

/**
 * Mounted at /showtimes. The id is validated as a UUID before anything runs, so a malformed id is a
 * 400 and a well-formed id that matches no showtime is a 404 `not_found`. `X-Client-Id` is optional here:
 * anyone can browse the map, and a caller who sends it gets read-your-own-writes for their own bookings.
 */
export function createShowtimesRouter(seats: SeatService, limit: LimitFactory): Router {
  const router = Router();
  router.use(recordRouteBase); // keeps "/showtimes" in the request log line (see logger.ts)

  // The map is what the app polls every ~5 s, so it has its own generous limit (`seatsPoll`, ADR 0016): far above a
  // focused app, well below a scraper.
  router.get(
    '/:id/seats',
    clientIdHeader({ required: false }),
    limit('seatsPoll'),
    validateRequest({ params: ShowtimeIdParamsSchema }),
    async (req, res) => {
      const { params } = req.validated as { params: z.output<typeof ShowtimeIdParamsSchema> };
      const viewerId = typeof res.locals.clientId === 'string' ? res.locals.clientId : undefined;
      const result = await seats.forShowtime(params.id, viewerId);
      if (!result) throw new ApiError('not_found');
      res.json(result);
    },
  );

  return router;
}
