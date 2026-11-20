import { Router } from 'express';
import type { z } from 'zod';
import { adminKeyHeader } from '../http/adminKey.js';
import { recordRouteBase } from '../http/logger.js';
import { validateRequest } from '../http/validate.js';
import type { CancelShowtimeService } from './cancelService.js';
import { ShowtimeIdParamsSchema } from './seat.js';

/**
 * The admin cancel route (ADR 0020), mounted at `/admin` only when `ADMIN_API_KEY` is set. `X-Admin-Key` is checked
 * BEFORE the body/params are even parsed: a caller without the key learns nothing about the route. The id is Zod-
 * validated like every other request; a missing key, a wrong key or a missing env value is a single 403.
 */
export function createAdminCancelRouter(service: CancelShowtimeService, adminKey: string | undefined): Router {
  const router = Router();
  router.use(recordRouteBase); // keeps "/admin" in the request log line

  router.post(
    '/showtimes/:id/cancel',
    adminKeyHeader(adminKey),
    validateRequest({ params: ShowtimeIdParamsSchema }),
    async (req, res) => {
      const { params } = req.validated as { params: z.output<typeof ShowtimeIdParamsSchema> };
      const result = await service.cancel(params.id, String(res.locals.requestId ?? ''));
      res.json(result);
    },
  );

  return router;
}
