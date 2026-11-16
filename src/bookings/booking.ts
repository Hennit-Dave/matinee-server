import { z } from 'zod';

/**
 * Seat-hold and booking API contract (ADR 0015), under `/showtimes/:id`:
 *
 *   POST   /holds     { seatIds }  ->  201 HoldResponse         409 seat_taken { seatIds }
 *   DELETE /holds     { seatIds }  ->  200 ReleaseResponse
 *   POST   /bookings  { seatIds }  ->  201 BookingResponse      409 seat_not_held | seat_taken { seatIds }
 *
 * Every route needs `X-Client-Id` (see `http/clientId.ts`). Money is whole pence and the server formats the
 * total, so the app never does money maths (AGENTS.md section 4, RULES A3). The mobile app mirrors these
 * types by hand.
 */

/** The most seats one request may name. The app caps a selection at 8; the server does not trust the app. */
export const MAX_SEATS_PER_REQUEST = 8;

const SeatIdsSchema = z
  .array(z.uuid())
  .min(1)
  .max(MAX_SEATS_PER_REQUEST)
  .superRefine((ids, ctx) => {
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', message: 'A seat can only be named once.', params: { matinee: 'duplicate_seat' } });
    }
  });

/** The body of all three routes. */
export const SeatIdsBodySchema = z.strictObject({ seatIds: SeatIdsSchema });
export type SeatIdsBody = z.output<typeof SeatIdsBodySchema>;

export const HoldResponseSchema = z.strictObject({
  showtimeId: z.uuid(),
  seatIds: z.array(z.uuid()),
  /** When the soonest-expiring seat of this hold lapses (server clock). */
  expiresAt: z.iso.datetime(),
  /**
   * Milliseconds left at the moment the server answered. A countdown should run from THIS plus the time the
   * response arrived, not from `expiresAt`, so a phone with a wrong clock still counts down honestly.
   */
  expiresInMs: z.number().int().positive(),
});
export type HoldResponse = z.infer<typeof HoldResponseSchema>;

export const ReleaseResponseSchema = z.strictObject({
  /** The seats this call actually freed. Seats the caller did not hold (expired, or someone else's) are simply absent. */
  released: z.array(z.uuid()),
});
export type ReleaseResponse = z.infer<typeof ReleaseResponseSchema>;

export const BookedSeatSchema = z.strictObject({
  seatId: z.uuid(),
  row: z.string().regex(/^[A-Z]$/),
  number: z.number().int().positive(),
});

export const BookingResponseSchema = z.strictObject({
  /** Groups the seats confirmed together. */
  reference: z.uuid(),
  showtimeId: z.uuid(),
  seats: z.array(BookedSeatSchema),
  /** Per-seat price in pence, as stored with the booking. */
  priceCents: z.number().int().nonnegative(),
  /** `priceCents` times the number of seats, computed on the server. */
  totalCents: z.number().int().nonnegative(),
  /** Server-formatted total (e.g. "£55.50"). */
  totalFormatted: z.string(),
});
export type BookingResponse = z.infer<typeof BookingResponseSchema>;
