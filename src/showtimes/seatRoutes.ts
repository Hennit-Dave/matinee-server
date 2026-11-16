import { Router } from 'express';
import type { z } from 'zod';
import { ApiError } from '../http/errors.js';
import { recordRouteBase } from '../http/logger.js';
import { validateRequest } from '../http/validate.js';
import { ShowtimeIdParamsSchema, type SeatService } from './seat.js';

/**
 * Mounted at /showtimes. The id is validated as a UUID before anything runs, so a malformed id is a
 * 400 and a well-formed id that matches no showtime is a 404 `not_found`.
 */
export function createShowtimesRouter(seats: SeatService): Router {
  const router = Router();
  router.use(recordRouteBase); // keeps "/showtimes" in the request log line (see logger.ts)

  router.get('/:id/seats', validateRequest({ params: ShowtimeIdParamsSchema }), async (req, res) => {
    const { params } = req.validated as { params: z.output<typeof ShowtimeIdParamsSchema> };
    const result = await seats.forShowtime(params.id);
    if (!result) throw new ApiError('not_found');
    res.json(result);
  });

  return router;
}
