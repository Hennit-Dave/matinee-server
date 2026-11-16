import { buildSeatGrid, type SeatLayout, type SeedSeat } from './seatLayout.js';

export interface SeedCinema {
  id: string;
  name: string;
  address: string;
}

export interface SeedScreen {
  id: string;
  cinemaId: string;
  name: string;
  format: string;
  totalSeats: number;
  /** Rows x seats per row. Must multiply out to `totalSeats` (checked when the seat grid is built). */
  layout: SeatLayout;
}

export interface SeedShowtime {
  movieId: number;
  screenId: string;
  startsAt: Date;
  priceCents: number;
}

export interface SeedPlan {
  cinemas: readonly SeedCinema[];
  screens: readonly SeedScreen[];
  showtimes: SeedShowtime[];
  /** Every physical seat of every screen, `sum(totalSeats)` in all. */
  seats: SeedSeat[];
}

export const SEED_CINEMAS: readonly SeedCinema[] = [
  { id: 'curzon-soho', name: 'Curzon Soho', address: '99 Shaftesbury Ave, London' },
  { id: 'bfi-southbank', name: 'BFI Southbank', address: 'Belvedere Rd, London' },
  { id: 'prince-charles', name: 'Prince Charles Cinema', address: '7 Leicester Pl, London' },
];

export const LOAD_TEST_SCREEN_ID = 'bfi-southbank-imax';

export const SEED_SCREENS: readonly SeedScreen[] = [
  {
    id: 'curzon-soho-1',
    cinemaId: 'curzon-soho',
    name: 'Screen 1',
    format: 'Standard',
    totalSeats: 120,
    layout: { rows: 10, seatsPerRow: 12 },
  },
  {
    id: 'curzon-soho-2',
    cinemaId: 'curzon-soho',
    name: 'Screen 2',
    format: 'Standard',
    totalSeats: 84,
    layout: { rows: 7, seatsPerRow: 12 },
  },
  {
    // The load-test target (ADR 0014): 16 rows A-P x 20 seats, as in the Figma "300+" seat map.
    id: LOAD_TEST_SCREEN_ID,
    cinemaId: 'bfi-southbank',
    name: 'IMAX',
    format: 'IMAX',
    totalSeats: 320,
    layout: { rows: 16, seatsPerRow: 20 },
  },
  {
    id: 'bfi-southbank-nft1',
    cinemaId: 'bfi-southbank',
    name: 'NFT1',
    format: 'Dolby Atmos',
    totalSeats: 180,
    layout: { rows: 10, seatsPerRow: 18 },
  },
  {
    id: 'prince-charles-main',
    cinemaId: 'prince-charles',
    name: 'Main House',
    format: 'Standard',
    totalSeats: 140,
    layout: { rows: 10, seatsPerRow: 14 },
  },
];

/** Every seat of every seeded screen. Deterministic, so re-seeding is idempotent. */
export function buildSeedSeats(screens: readonly SeedScreen[] = SEED_SCREENS): SeedSeat[] {
  return screens.flatMap((screen) => buildSeatGrid(screen.id, screen.totalSeats, screen.layout));
}

const DAILY_SLOTS_UTC = [
  { hour: 14, minute: 30, isMatinee: true },
  { hour: 17, minute: 45, isMatinee: false },
  { hour: 20, minute: 30, isMatinee: false },
] as const;

export const SEED_DAYS = 7;
export const PRICE_MATINEE_CENTS = 1200;
export const PRICE_STANDARD_CENTS = 1550;
export const PRICE_IMAX_CENTS = 1850;

function priceForSlot(screenId: string, isMatinee: boolean): number {
  if (screenId === LOAD_TEST_SCREEN_ID) return PRICE_IMAX_CENTS;
  return isMatinee ? PRICE_MATINEE_CENTS : PRICE_STANDARD_CENTS;
}

/**
 * Builds a deterministic, idempotent 7-day showtime schedule.
 *
 * - Reserves the 20:30 UTC slot in the 320-seat `bfi-southbank-imax` screen for `movieIds[0]` so
 *   a busy large-room showtime always exists as a load-test target.
 * - Round-robins every movieId in `movieIds` across all remaining slots so every current
 *   now-playing film gets at least one showtime.
 */
export function buildSeedPlan(movieIds: readonly number[], anchorDate: Date = new Date()): SeedPlan {
  if (movieIds.length === 0) {
    throw new Error('buildSeedPlan requires at least one movieId.');
  }

  const baseYear = anchorDate.getUTCFullYear();
  const baseMonth = anchorDate.getUTCMonth();
  const baseDay = anchorDate.getUTCDate();

  const showtimes: SeedShowtime[] = [];
  let rrIndex = 0;

  for (let dayOffset = 0; dayOffset < SEED_DAYS; dayOffset++) {
    for (const screen of SEED_SCREENS) {
      for (const slot of DAILY_SLOTS_UTC) {
        const startsAt = new Date(Date.UTC(baseYear, baseMonth, baseDay + dayOffset, slot.hour, slot.minute, 0, 0));
        const isLoadTestSlot = screen.id === LOAD_TEST_SCREEN_ID && slot.hour === 20 && slot.minute === 30;
        const movieId = isLoadTestSlot ? movieIds[0]! : movieIds[rrIndex++ % movieIds.length]!;

        showtimes.push({
          movieId,
          screenId: screen.id,
          startsAt,
          priceCents: priceForSlot(screen.id, slot.isMatinee),
        });
      }
    }
  }

  return {
    cinemas: SEED_CINEMAS,
    screens: SEED_SCREENS,
    showtimes,
    seats: buildSeedSeats(SEED_SCREENS),
  };
}
