import { Router } from 'express';
import type { z } from 'zod';
import { clientIdHeader } from '../http/clientId.js';
import { ApiError } from '../http/errors.js';
import { recordRouteBase } from '../http/logger.js';
import { validateRequest } from '../http/validate.js';
import type { LimitFactory } from '../ratelimit/limiter.js';
import { ShowtimeIdParamsSchema } from '../showtimes/seat.js';
import type { WaitingRoom } from './waitingRoom.js';

/**
 * The waiting room's routes, mounted at /showtimes next to the seat map (ADR 0017):
 *
 *   POST   /showtimes/:id/queue   join the line, or be let straight in when there is room. Idempotent: joining again keeps your place.
 *   GET    /showtimes/:id/queue   where you stand (and a heartbeat for your place). Never joins.
 *   DELETE /showtimes/:id/queue   give up a pass or a place. Idempotent; not rate limited (like releasing seats, it is the cleanup path).
 *
 * Every route needs `X-Client-Id`: the line is made of installs. The order is the one every route uses (ADR 0016): who is calling, then
 * the rate limit, then the validated params. A showing that does not exist is a 404, so junk ids never become Redis keys.
 */
export function createQueueRouter(room: WaitingRoom, limit: LimitFactory, showtimeExists: (showtimeId: string) => Promise<boolean>): Router {
  const router = Router();
  router.use(recordRouteBase); // keeps "/showtimes" in the request log line (see logger.ts)

  const callerId = clientIdHeader({ required: true });
  const params = validateRequest({ params: ShowtimeIdParamsSchema });
  const showtimeOf = (req: { validated?: unknown }) => (req.validated as { params: z.output<typeof ShowtimeIdParamsSchema> }).params.id;
  const ownerOf = (res: { locals: Record<string, unknown> }) => String(res.locals.clientId);

  router.post('/:id/queue', callerId, limit('queue'), params, async (req, res) => {
    const showtimeId = showtimeOf(req);
    if (!(await showtimeExists(showtimeId))) throw new ApiError('not_found');
    const state = await room.join(showtimeId, ownerOf(res));
    if (state.status === 'full') throw new ApiError('waiting_room_full');
    res.json(state);
  });

  router.get('/:id/queue', callerId, limit('queue'), params, async (req, res) => {
    res.json(await room.poll(showtimeOf(req), ownerOf(res)));
  });

  router.delete('/:id/queue', callerId, params, async (req, res) => {
    await room.leave(showtimeOf(req), ownerOf(res));
    res.json({ status: 'not_queued' });
  });

  return router;
}
