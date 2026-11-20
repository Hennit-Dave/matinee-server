import { z } from 'zod';

/**
 * Cancelled-showtime API contract (ADR 0020). Admin-only: the route is mounted only when `ADMIN_API_KEY` is set and
 * every request must present it in `X-Admin-Key`. `alreadyCancelled` tells the caller whether this call marked the
 * showing or it was already cancelled (the action is idempotent; a re-cancel also re-enqueues the refund job, which
 * is itself a no-op on already-settled orders).
 */

export const CancelShowtimeResponseSchema = z.strictObject({
  showtimeId: z.uuid(),
  cancelled: z.literal(true),
  alreadyCancelled: z.boolean(),
});
export type CancelShowtimeResponse = z.infer<typeof CancelShowtimeResponseSchema>;
