import { z } from 'zod';
import { SEAT_KINDS, type SeatKind } from './seatLayout.js';
import { formatPriceCents } from './showtime.js';

/**
 * Seat-map API contract (ADR 0014): `GET /showtimes/:id/seats`. Seats are grouped into rows so the app
 * draws the map without client-side sorting, and the price arrives as a finished string so the app
 * never does money maths (AGENTS.md section 4, RULES A3). The mobile app mirrors these types by hand.
 */

/**
 * Per-showtime availability. `sold` means a booking row exists; `held` means a live Redis hold exists (someone,
 * possibly the caller, has the seat for the next few minutes); otherwise `available` (ADR 0015). The values
 * were in the contract from day one so adding holds changed no response shape. "Yours" (selected) is
 * client-only state.
 */
export const SEAT_STATUSES = ['available', 'held', 'sold'] as const;
export type SeatStatus = (typeof SEAT_STATUSES)[number];

const RowLetterSchema = z.string().regex(/^[A-Z]$/);

export const ShowtimeIdParamsSchema = z.strictObject({ id: z.uuid() });

export const SeatSchema = z.strictObject({
  id: z.uuid(),
  row: RowLetterSchema,
  /** 1-based, left to right as seen from the seats. The centre aisle is drawn by the app after ceil(n / 2). */
  number: z.number().int().positive(),
  kind: z.enum(SEAT_KINDS),
  status: z.enum(SEAT_STATUSES),
});
export type Seat = z.infer<typeof SeatSchema>;

export const SeatRowSchema = z.strictObject({
  row: RowLetterSchema,
  seats: z.array(SeatSchema),
});
export type SeatRow = z.infer<typeof SeatRowSchema>;

export const ShowtimeSeatsResponseSchema = z.strictObject({
  showtimeId: z.uuid(),
  movieId: z.number().int().positive(),
  startsAt: z.iso.datetime(),
  /** UTC HH:MM (24-hour), same as `ShowtimeSlot.time`. */
  time: z.string().regex(/^\d{2}:\d{2}$/),
  screen: z.strictObject({
    id: z.string(),
    name: z.string(),
    format: z.string(),
    totalSeats: z.number().int().positive(),
  }),
  priceCents: z.number().int().nonnegative(),
  /** Server-formatted per-seat price (e.g. "£15.50") so the app never computes money. */
  priceFormatted: z.string(),
  rows: z.array(SeatRowSchema),
});
export type ShowtimeSeatsResponse = z.infer<typeof ShowtimeSeatsResponseSchema>;

/** A seat as stored: `kind` is a plain string in the database and is checked on the way out. */
export interface SeatRecord {
  id: string;
  row: string;
  number: number;
  kind: string;
}

export interface ShowtimeSeatsRow {
  id: string;
  movieId: number;
  startsAt: Date;
  priceCents: number;
  screen: {
    id: string;
    name: string;
    format: string;
    totalSeats: number;
    seats: SeatRecord[];
  };
}

export interface SeatService {
  /**
   * `null` when the showtime does not exist. `viewerId` is the caller's client id when they sent one: for a few
   * seconds after that caller books, their reads go to the primary so they see their own booking
   * (read-your-own-writes, RULES C2).
   */
  forShowtime(showtimeId: string, viewerId?: string): Promise<ShowtimeSeatsResponse | null>;
}

/**
 * Decides each seat's status for one showtime. Built from the showtime's bookings and live Redis holds by
 * `seatStatusResolver`. Never cache what it returns (RULES C4: seat availability is never cached in a way that
 * could sell a seat twice).
 */
export type SeatStatusResolver = (seat: SeatRecord) => SeatStatus;

/** Every seat free. The default for a showtime nobody has touched, and what the layout tests use. */
export const allSeatsAvailable: SeatStatusResolver = () => 'available';

/**
 * `sold` beats `held`: a booked seat is sold even while its hold key still exists (confirming a booking
 * leaves the hold to expire on its own), and the seat is only `held` if it is not sold.
 */
export function seatStatusResolver(sold: ReadonlySet<string>, held: ReadonlySet<string>): SeatStatusResolver {
  return (seat) => (sold.has(seat.id) ? 'sold' : held.has(seat.id) ? 'held' : 'available');
}

function isSeatKind(value: string): value is SeatKind {
  return (SEAT_KINDS as readonly string[]).includes(value);
}

/**
 * Groups flat seats into rows, A first, and orders seats by number within a row. Sorts here rather than
 * trusting the query's ordering, so the contract does not depend on how the rows were fetched.
 */
export function groupSeatsIntoRows(seats: readonly SeatRecord[], resolveStatus: SeatStatusResolver): SeatRow[] {
  const ordered = [...seats].sort((a, b) => (a.row === b.row ? a.number - b.number : a.row < b.row ? -1 : 1));

  const rows: SeatRow[] = [];
  for (const seat of ordered) {
    // A kind we do not know would be drawn wrongly (a wheelchair space is not a standard seat), so
    // refuse to serve the map rather than guess. The API turns this into a logged 500.
    if (!isSeatKind(seat.kind)) {
      throw new Error(`Seat ${seat.id} has an unknown kind "${seat.kind}".`);
    }
    let current = rows[rows.length - 1];
    if (!current || current.row !== seat.row) {
      current = { row: seat.row, seats: [] };
      rows.push(current);
    }
    current.seats.push({
      id: seat.id,
      row: seat.row,
      number: seat.number,
      kind: seat.kind,
      status: resolveStatus(seat),
    });
  }
  return rows;
}

export function buildShowtimeSeatsResponse(
  showtime: ShowtimeSeatsRow,
  resolveStatus: SeatStatusResolver = allSeatsAvailable,
): ShowtimeSeatsResponse {
  const iso = showtime.startsAt.toISOString();
  return {
    showtimeId: showtime.id,
    movieId: showtime.movieId,
    startsAt: iso,
    time: iso.slice(11, 16),
    screen: {
      id: showtime.screen.id,
      name: showtime.screen.name,
      format: showtime.screen.format,
      totalSeats: showtime.screen.totalSeats,
    },
    priceCents: showtime.priceCents,
    priceFormatted: formatPriceCents(showtime.priceCents),
    rows: groupSeatsIntoRows(showtime.screen.seats, resolveStatus),
  };
}
