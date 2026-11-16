import { randomUUID } from 'node:crypto';
import { ApiError } from '../http/errors.js';
import type { Logger } from '../http/logger.js';
import { formatPriceCents } from '../showtimes/showtime.js';
import type { BookingResponse, HoldResponse, ReleaseResponse } from './booking.js';
import { SeatAlreadyBookedError, type BookingRepo, type ReadSource, type ShowtimeSeats } from './bookingRepo.js';
import { HoldsUnavailableError, type HoldStore } from './holdStore.js';
import type { RyowStore } from './ryow.js';

/**
 * Seat holds and the hold-to-booking commit (ADR 0015). The two layers of the no-double-booking guarantee
 * meet here:
 *
 *   1. Redis (`HoldStore`): the fast path. One atomic call decides who may TRY to book a seat.
 *   2. Postgres `UNIQUE (showtime_id, seat_id)`: the final guard. Whatever Redis said, the database refuses a
 *      second row for the same seat, and that refusal is a clean 409 `seat_taken`, never a 500.
 */

export interface SeatRequest {
  showtimeId: string;
  /** The caller's client id (`X-Client-Id`), the owner of the hold or booking. */
  ownerId: string;
  /** Already validated: 1 to 8 unique uuids. */
  seatIds: readonly string[];
  /** For the log line only. */
  requestId?: string;
}

export interface BookingService {
  acquireHolds(request: SeatRequest): Promise<HoldResponse>;
  releaseHolds(request: SeatRequest): Promise<ReleaseResponse>;
  /**
   * Turns the caller's holds into bookings. THE durable unit of the booking flow: today an HTTP route calls
   * it directly; when payments land, the verified-webhook job calls the same function and the route goes.
   */
  confirmBooking(request: SeatRequest): Promise<BookingResponse>;
}

export interface BookingServiceDeps {
  repo: BookingRepo;
  holds: HoldStore;
  ryow: RyowStore;
  logger?: Logger;
  /** Injectable for tests. */
  now?: () => number;
}

export function createBookingService(deps: BookingServiceDeps): BookingService {
  const { repo, holds, ryow, logger } = deps;
  const now = deps.now ?? Date.now;

  /** Redis trouble becomes the one retryable 503 for every hold route; anything else is left alone. */
  function unavailable(err: unknown, request: SeatRequest): unknown {
    if (!(err instanceof HoldsUnavailableError)) return err;
    logger?.warn('redis_unavailable', {
      requestId: request.requestId,
      userId: request.ownerId,
      showtimeId: request.showtimeId,
      reason: err.message,
    });
    return new ApiError('holds_unavailable', { reason: err.message });
  }

  function log(event: string, request: SeatRequest, error?: ApiError) {
    const fields = {
      requestId: request.requestId,
      userId: request.ownerId,
      showtimeId: request.showtimeId,
      seatCount: request.seatIds.length,
    };
    if (error) logger?.warn(event, { ...fields, outcome: 'rejected', errorCode: error.code });
    else logger?.info(event, { ...fields, outcome: 'ok' });
  }

  /** The showtime must exist and every seat must really be in its screen (never trust the client's ids). */
  async function checkSeats(source: ReadSource, request: SeatRequest): Promise<ShowtimeSeats> {
    const found = await repo.findShowtimeSeats(source, request.showtimeId, request.seatIds);
    if (!found) throw new ApiError('not_found');
    if (found.seats.length !== new Set(request.seatIds).size) {
      throw new ApiError('validation_failed', { details: [{ path: 'seatIds', code: 'not_in_screen' }] });
    }
    return found;
  }

  async function tryRelease(request: SeatRequest) {
    try {
      await holds.release(request.showtimeId, request.ownerId, request.seatIds);
    } catch (err) {
      // Best effort: if this fails the hold simply runs out its TTL.
      logger?.warn('hold_release_failed', {
        requestId: request.requestId,
        userId: request.ownerId,
        showtimeId: request.showtimeId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function logged<T>(events: { ok: string; rejected: string }, request: SeatRequest, run: () => Promise<T>): Promise<T> {
    try {
      const result = await run();
      log(events.ok, request);
      return result;
    } catch (err) {
      if (err instanceof ApiError) log(events.rejected, request, err);
      throw err;
    }
  }

  async function finish(request: SeatRequest, reference: string, found: ShowtimeSeats): Promise<BookingResponse> {
    // Read-your-own-writes: for a few seconds this user's seat reads go to the primary. If Redis is
    // unreachable here the booking is already committed and must not be reported as failed.
    try {
      await ryow.mark(request.ownerId);
    } catch (err) {
      logger?.warn('ryow_mark_failed', {
        requestId: request.requestId,
        userId: request.ownerId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    // The hold is left to expire on its own. The seat is `sold` from now on whatever the hold says (sold wins),
    // and while the replica catches up the lingering hold keeps other users' maps showing "held", not "free".
    const seats = [...found.seats]
      .sort((a, b) => (a.row === b.row ? a.number - b.number : a.row < b.row ? -1 : 1))
      .map((s) => ({ seatId: s.id, row: s.row, number: s.number }));
    const totalCents = found.priceCents * seats.length;
    return {
      reference,
      showtimeId: request.showtimeId,
      seats,
      priceCents: found.priceCents,
      totalCents,
      totalFormatted: formatPriceCents(totalCents),
    };
  }

  return {
    acquireHolds: (request) =>
      logged({ ok: 'hold_acquired', rejected: 'hold_rejected' }, request, async () => {
        const { showtimeId, ownerId, seatIds } = request;
        await checkSeats('replica', request);

        let acquired;
        try {
          acquired = await holds.acquire(showtimeId, ownerId, seatIds);
        } catch (err) {
          throw unavailable(err, request);
        }
        if (!acquired.ok) throw new ApiError('seat_taken', { seatIds: acquired.takenSeatIds });

        // Authoritative sold-check, AFTER the hold is ours. The order matters: checking first and holding
        // second would leave a gap in which a booking could commit and its hold lapse, and we would then
        // hold a sold seat. Holding first closes it: a sold seat is found here and the hold is given back.
        let sold: string[];
        try {
          sold = await repo.soldSeatIds(showtimeId, seatIds);
        } catch (err) {
          await tryRelease(request);
          throw err;
        }
        if (sold.length > 0) {
          await tryRelease(request);
          throw new ApiError('seat_taken', { seatIds: sold });
        }

        const expiresInMs = acquired.expiresInMs;
        return { showtimeId, seatIds: [...seatIds], expiresAt: new Date(now() + expiresInMs).toISOString(), expiresInMs };
      }),

    releaseHolds: (request) =>
      logged({ ok: 'hold_released', rejected: 'hold_release_rejected' }, request, async () => {
        await checkSeats('replica', request);
        try {
          return { released: await holds.release(request.showtimeId, request.ownerId, request.seatIds) };
        } catch (err) {
          throw unavailable(err, request);
        }
      }),

    confirmBooking: (request) =>
      logged({ ok: 'booking_confirmed', rejected: 'booking_rejected' }, request, async () => {
        const { showtimeId, ownerId, seatIds } = request;
        const found = await checkSeats('primary', request);

        // Fast check: the caller must hold every seat. This is NOT what makes double booking impossible (a
        // hold can lapse a millisecond after this check); the unique key below is. It makes the common
        // failure, "your hold ran out", a clear 409 instead of a race.
        let held: Set<string>;
        try {
          held = new Set(await holds.heldBy(showtimeId, ownerId, seatIds));
        } catch (err) {
          throw unavailable(err, request);
        }
        const notHeld = seatIds.filter((id) => !held.has(id));
        if (notHeld.length > 0) throw new ApiError('seat_not_held', { seatIds: notHeld });

        const reference = randomUUID();
        try {
          // One INSERT for every seat: all of them or none.
          await repo.createBookings(
            seatIds.map((seatId) => ({ reference, showtimeId, seatId, ownerId, priceCents: found.priceCents })),
          );
        } catch (err) {
          if (!(err instanceof SeatAlreadyBookedError)) throw err;
          // The final guard fired: someone else's booking for one of these seats committed first.
          const sold = await repo.soldSeatIds(showtimeId, seatIds);
          throw new ApiError('seat_taken', { seatIds: sold.length > 0 ? sold : [...seatIds] });
        }
        return finish(request, reference, found);
      }),
  };
}
