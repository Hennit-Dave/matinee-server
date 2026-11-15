export interface SeedCinema {
  id: string;
  name: string;
  address: string;
}

export interface SeedScreen {
  id: string;
  cinemaId: string;
  name: string;
  totalSeats: number;
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
}

export const SEED_CINEMAS: readonly SeedCinema[] = [
  { id: 'curzon-soho', name: 'Curzon Soho', address: '99 Shaftesbury Ave, London' },
  { id: 'bfi-southbank', name: 'BFI Southbank', address: 'Belvedere Rd, London' },
  { id: 'prince-charles', name: 'Prince Charles Cinema', address: '7 Leicester Pl, London' },
];

export const LOAD_TEST_SCREEN_ID = 'bfi-southbank-imax';

export const SEED_SCREENS: readonly SeedScreen[] = [
  { id: 'curzon-soho-1', cinemaId: 'curzon-soho', name: 'Screen 1', totalSeats: 120 },
  { id: 'curzon-soho-2', cinemaId: 'curzon-soho', name: 'Screen 2', totalSeats: 84 },
  { id: LOAD_TEST_SCREEN_ID, cinemaId: 'bfi-southbank', name: 'IMAX', totalSeats: 320 },
  { id: 'bfi-southbank-nft1', cinemaId: 'bfi-southbank', name: 'NFT1', totalSeats: 180 },
  { id: 'prince-charles-main', cinemaId: 'prince-charles', name: 'Main House', totalSeats: 140 },
];

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
  };
}
