import { z } from 'zod';

/**
 * Showtimes API contract (Slice 4b). Grouped cinema -> date -> times so the app can render
 * Showtimes without client-side grouping or money maths (AGENTS.md §4, RULES A3).
 */

export const ShowtimeSlotSchema = z.strictObject({
  id: z.uuid(),
  startsAt: z.iso.datetime(),
  /** UTC HH:MM (24-hour, e.g. "19:30") for tabular-numeral Chip labels. */
  time: z.string().regex(/^\d{2}:\d{2}$/),
  screenId: z.string(),
  screenName: z.string(),
  format: z.string(),
  totalSeats: z.number().int().positive(),
  priceCents: z.number().int().nonnegative(),
  /** Server-formatted display price (e.g. "£15.50") so the app never computes money. */
  priceFormatted: z.string(),
});
export type ShowtimeSlot = z.infer<typeof ShowtimeSlotSchema>;

export const CinemaDateScheduleSchema = z.strictObject({
  /** UTC YYYY-MM-DD */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  showtimes: z.array(ShowtimeSlotSchema),
});
export type CinemaDateSchedule = z.infer<typeof CinemaDateScheduleSchema>;

export const CinemaShowtimesSchema = z.strictObject({
  cinemaId: z.string(),
  cinemaName: z.string(),
  cinemaAddress: z.string(),
  dates: z.array(CinemaDateScheduleSchema),
});
export type CinemaShowtimes = z.infer<typeof CinemaShowtimesSchema>;

export const MovieShowtimesResponseSchema = z.strictObject({
  movieId: z.number().int().positive(),
  cinemas: z.array(CinemaShowtimesSchema),
});
export type MovieShowtimesResponse = z.infer<typeof MovieShowtimesResponseSchema>;

export interface ShowtimeRow {
  id: string;
  startsAt: Date;
  priceCents: number;
  screen: {
    id: string;
    name: string;
    format: string;
    totalSeats: number;
    cinema: {
      id: string;
      name: string;
      address: string;
    };
  };
}

export interface ShowtimeService {
  forMovie(movieId: number, from?: Date): Promise<MovieShowtimesResponse>;
}

/**
 * Formats integer minor units (GBP pence) into a finished display string, e.g. 1550 -> "£15.50".
 * The field keeps its `priceCents` name (renaming it would need a DB migration); the value is pence.
 */
export function formatPriceCents(priceCents: number): string {
  const pounds = Math.floor(priceCents / 100);
  const pence = String(priceCents % 100).padStart(2, '0');
  return `£${pounds}.${pence}`;
}

/**
 * Groups flat showtime rows (already ordered by `startsAt ASC`) into `cinema -> date -> showtimes`.
 * Returns `cinemas: []` when there are no upcoming showtimes.
 */
export function groupShowtimesByCinemaAndDate(movieId: number, rows: ShowtimeRow[]): MovieShowtimesResponse {
  const cinemaMap = new Map<
    string,
    {
      cinemaId: string;
      cinemaName: string;
      cinemaAddress: string;
      dateMap: Map<string, ShowtimeSlot[]>;
    }
  >();

  for (const row of rows) {
    const iso = row.startsAt.toISOString();
    const date = iso.slice(0, 10);
    const time = iso.slice(11, 16);
    const { cinema } = row.screen;

    let cinemaEntry = cinemaMap.get(cinema.id);
    if (!cinemaEntry) {
      cinemaEntry = {
        cinemaId: cinema.id,
        cinemaName: cinema.name,
        cinemaAddress: cinema.address,
        dateMap: new Map(),
      };
      cinemaMap.set(cinema.id, cinemaEntry);
    }

    let slots = cinemaEntry.dateMap.get(date);
    if (!slots) {
      slots = [];
      cinemaEntry.dateMap.set(date, slots);
    }

    slots.push({
      id: row.id,
      startsAt: iso,
      time,
      screenId: row.screen.id,
      screenName: row.screen.name,
      format: row.screen.format,
      totalSeats: row.screen.totalSeats,
      priceCents: row.priceCents,
      priceFormatted: formatPriceCents(row.priceCents),
    });
  }

  const cinemas: CinemaShowtimes[] = Array.from(cinemaMap.values()).map((c) => ({
    cinemaId: c.cinemaId,
    cinemaName: c.cinemaName,
    cinemaAddress: c.cinemaAddress,
    dates: Array.from(c.dateMap.entries()).map(([date, showtimes]) => ({ date, showtimes })),
  }));

  return { movieId, cinemas };
}
