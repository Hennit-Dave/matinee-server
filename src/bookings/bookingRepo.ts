import type { DbClients } from '../db/clients.js';

/** Which Postgres to read from: the primary (always current) or the read replica (may lag). */
export type ReadSource = 'primary' | 'replica';

export interface ShowtimeSeats {
  showtimeId: string;
  /** Per-seat price in pence. */
  priceCents: number;
  /** Those of the requested seat ids that are physically in this showtime's screen. */
  seats: { id: string; row: string; number: number }[];
}

export interface NewBooking {
  reference: string;
  showtimeId: string;
  seatId: string;
  ownerId: string;
  priceCents: number;
}

/** Thrown by `createBookings` when the unique key (showtime, seat) refuses a row: a seat was sold first. */
export class SeatAlreadyBookedError extends Error {
  constructor() {
    super('a seat in this booking is already booked');
    this.name = 'SeatAlreadyBookedError';
  }
}

/**
 * Everything the hold and booking services need from Postgres, behind one seam so the logic can be unit
 * tested without a database. The real implementation is `createBookingRepo`.
 */
export interface BookingRepo {
  /**
   * `null` when the showtime does not exist. Only `seats` that really belong to its screen are returned, so
   * a caller checks `seats.length` against what it asked for. Reads the layout, which never changes, so the
   * replica is fine for holds; confirm reads the primary because it also needs the current price.
   */
  findShowtimeSeats(source: ReadSource, showtimeId: string, seatIds: readonly string[]): Promise<ShowtimeSeats | null>;
  /** Which of these seats are sold. ALWAYS the primary: this is the authoritative check, never the replica. */
  soldSeatIds(showtimeId: string, seatIds: readonly string[]): Promise<string[]>;
  /** Every sold seat of a showtime, for the seat map. The replica unless read-your-own-writes says otherwise. */
  soldSeatIdsForShowtime(source: ReadSource, showtimeId: string): Promise<string[]>;
  /** One INSERT for all the rows: all of them or none. Throws `SeatAlreadyBookedError` on a unique violation. */
  createBookings(rows: readonly NewBooking[]): Promise<void>;
  /**
   * The seats already booked under one reference, or `null` when none are. This is how a retried webhook job
   * makes `confirmBooking` idempotent: if the reference already produced bookings, it returns them instead of
   * re-inserting (which the unique key would turn into a spurious `seat_taken`).
   */
  findBookingByReference(reference: string): Promise<ShowtimeSeats | null>;
}

/**
 * True when `err` is Postgres refusing a duplicate key. Prisma reports it as `P2002` (and with a driver
 * adapter it can arrive wrapped), and the raw SQLSTATE is `23505`; accept any of those, a few levels deep.
 */
export function isUniqueViolation(err: unknown, depth = 0): boolean {
  if (typeof err !== 'object' || err === null || depth > 3) return false;
  const e = err as { code?: unknown; cause?: unknown; meta?: { driverAdapterError?: unknown } };
  if (e.code === 'P2002' || e.code === '23505') return true;
  return isUniqueViolation(e.cause, depth + 1) || isUniqueViolation(e.meta?.driverAdapterError, depth + 1);
}

export function createBookingRepo(db: DbClients): BookingRepo {
  const client = (source: ReadSource) => (source === 'primary' ? db.primary : db.reader.$replica());

  return {
    async findShowtimeSeats(source, showtimeId, seatIds) {
      const reader = client(source);
      const showtime = await reader.showtime.findUnique({
        where: { id: showtimeId },
        select: { id: true, screenId: true, priceCents: true },
      });
      if (!showtime) return null;
      const seats = await reader.seat.findMany({
        where: { id: { in: [...seatIds] }, screenId: showtime.screenId },
        select: { id: true, row: true, number: true },
      });
      return { showtimeId: showtime.id, priceCents: showtime.priceCents, seats };
    },

    async soldSeatIds(showtimeId, seatIds) {
      const rows = await db.primary.booking.findMany({
        where: { showtimeId, seatId: { in: [...seatIds] } },
        select: { seatId: true },
      });
      return rows.map((r) => r.seatId);
    },

    async soldSeatIdsForShowtime(source, showtimeId) {
      const rows = await client(source).booking.findMany({ where: { showtimeId }, select: { seatId: true } });
      return rows.map((r) => r.seatId);
    },

    async createBookings(rows) {
      try {
        await db.primary.booking.createMany({ data: rows.map((r) => ({ ...r })) });
      } catch (err) {
        if (isUniqueViolation(err)) throw new SeatAlreadyBookedError();
        throw err;
      }
    },

    async findBookingByReference(reference) {
      const rows = await db.primary.booking.findMany({
        where: { reference },
        select: { showtimeId: true, seatId: true, priceCents: true, seat: { select: { row: true, number: true } } },
      });
      if (rows.length === 0) return null;
      return {
        showtimeId: rows[0]!.showtimeId,
        priceCents: rows[0]!.priceCents,
        seats: rows.map((r) => ({ id: r.seatId, row: r.seat.row, number: r.seat.number })),
      };
    },
  };
}
