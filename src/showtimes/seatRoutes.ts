import { Router, type RequestHandler } from 'express';
import type { z } from 'zod';
import { clientIdHeader } from '../http/clientId.js';
import { ApiError } from '../http/errors.js';
import { recordRouteBase } from '../http/logger.js';
import { validateRequest } from '../http/validate.js';
import type { LimitFactory } from '../ratelimit/limiter.js';
import { ShowtimeIdParamsSchema, type SeatService } from './seat.js';

/**
 * Mounted at /showtimes. The id is validated as a UUID before anything runs, so a malformed id is a
 * 400 and a well-formed id that matches no showtime is a 404 `not_found`.
 *
 * `X-Client-Id` is REQUIRED (slice 5d, ADR 0017): the waiting room admits installs, so the map cannot be read without saying who is
 * asking. (It used to be optional; the app has always sent it.) The same id gives read-your-own-writes for the caller's own bookings.
 * `gate` is the waiting room's pass check: entry to seat selection needs a pass, and each map poll is the pass's heartbeat.
 */
export function createShowtimesRouter(seats: SeatService, limit: LimitFactory, gate: RequestHandler = (_req, _res, next) => next()): Router {
  const router = Router();
  router.use(recordRouteBase); // keeps "/showtimes" in the request log line (see logger.ts)

  // The map is what the app polls every ~5 s, so it has its own generous limit (`seatsPoll`, ADR 0016): far above a
  // focused app, well below a scraper.
  router.get(
    '/:id/seats',
    clientIdHeader({ required: true }),
    limit('seatsPoll'),
    gate,
    validateRequest({ params: ShowtimeIdParamsSchema }),
    async (req, res) => {
      const { params } = req.validated as { params: z.output<typeof ShowtimeIdParamsSchema> };
      const viewerId = String(res.locals.clientId);
      const result = await seats.forShowtime(params.id, viewerId);
      if (!result) throw new ApiError('not_found');
      res.json(result);
    },
  );

  return router;
}
