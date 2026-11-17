import { Router, type Response } from 'express';
import type { z } from 'zod';
import { clientIdHeader } from '../http/clientId.js';
import { resolveClientAddress } from '../http/clientIp.js';
import { jsonBody } from '../http/json.js';
import { recordRouteBase } from '../http/logger.js';
import { validateRequest } from '../http/validate.js';
import type { LimitFactory } from '../ratelimit/limiter.js';
import { ShowtimeIdParamsSchema } from '../showtimes/seat.js';
import { SeatIdsBodySchema } from './booking.js';
import type { BookingService, SeatRequest } from './bookingService.js';

/**
 * Seat holds and bookings, mounted at /showtimes next to the seat map (ADR 0015):
 *
 *   POST   /showtimes/:id/holds     take a hold on the seats, all or nothing
 *   DELETE /showtimes/:id/holds     give back the caller's own holds
 *   POST   /showtimes/:id/bookings  turn the caller's holds into bookings
 *
 * Every route needs `X-Client-Id` (the caller's identity until real auth exists) and a JSON body of
 * `{ seatIds }`. Params, header and body are validated before any handler runs.
 *
 * The bookings route is a TEMPORARY direct commit with no payment step. Booking is confirmed only by a verified
 * payment webhook (AGENTS.md section 4); when payments land, that job calls `confirmBooking` and this route is
 * removed. It is mounted only when a `BookingService` is provided.
 */
export function createBookingsRouter(service: BookingService, limit: LimitFactory): Router {
  const router = Router();
  router.use(recordRouteBase); // keeps "/showtimes" in the request log line (see logger.ts)

  // The order is the point (ADR 0016): who is calling, THEN the rate limit, then the body is parsed and validated.
  // A flood is refused before it costs a JSON parse or a Zod run.
  const callerId = clientIdHeader({ required: true });
  const parsedInput = [jsonBody(), validateRequest({ params: ShowtimeIdParamsSchema, body: SeatIdsBodySchema })];

  /** What every handler needs, read only from validated input (never req.body / req.params). */
  function seatRequest(req: { validated?: unknown; ip: string | undefined }, res: Response): SeatRequest {
    const { params, body } = req.validated as {
      params: z.output<typeof ShowtimeIdParamsSchema>;
      body: z.output<typeof SeatIdsBodySchema>;
    };
    // The same address the rate limiter counts (ADR 0016). When it cannot be told (a proxy hop showing through), the
    // per-address hold cap is skipped for this request, exactly like the address rate limit is: "off, loudly", not "everyone refused".
    const address = resolveClientAddress(req);
    return {
      showtimeId: params.id,
      ownerId: String(res.locals.clientId),
      address: address.resolved ? address.key : undefined,
      seatIds: body.seatIds,
      requestId: String(res.locals.requestId ?? ''),
    };
  }

  router.post('/:id/holds', callerId, limit('hold'), ...parsedInput, async (req, res) => {
    res.status(201).json(await service.acquireHolds(seatRequest(req, res)));
  });

  // Deliberately NOT limited: letting go of seats is the cleanup path (the app releases when the user leaves the
  // screen), and a 429 here would leave seats held for the full 10 minutes. Owner-only and cheap.
  router.delete('/:id/holds', callerId, ...parsedInput, async (req, res) => {
    res.json(await service.releaseHolds(seatRequest(req, res)));
  });

  router.post('/:id/bookings', callerId, limit('booking'), ...parsedInput, async (req, res) => {
    res.status(201).json(await service.confirmBooking(seatRequest(req, res)));
  });

  return router;
}
