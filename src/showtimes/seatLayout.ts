/**
 * Physical seat layouts for the seeded screens (ADR 0014). Pure: no database, no clock.
 *
 * Every layout is a full rectangle of `rows x seatsPerRow` seats. Rows are lettered from A at the
 * front (nearest the screen) to the back. Wheelchair spaces sit at both outer ends of the back row,
 * as drawn in the Figma seat map, and count toward the screen's `totalSeats`.
 *
 * The centre aisle is NOT stored: the app draws it after seat `ceil(seatsPerRow / 2)`. Every seeded
 * layout has an even row length so the aisle is exactly in the middle.
 */

export const SEAT_KINDS = ['standard', 'wheelchair'] as const;
export type SeatKind = (typeof SEAT_KINDS)[number];

export interface SeedSeat {
  screenId: string;
  row: string;
  number: number;
  kind: SeatKind;
}

export interface SeatLayout {
  rows: number;
  seatsPerRow: number;
}

/** "A" .. "Z". Row letters stay single characters so plain text ordering is the physical order. */
export const MAX_SEAT_ROWS = 26;

export function rowLetter(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_SEAT_ROWS) {
    throw new Error(`Row index must be an integer from 0 to ${MAX_SEAT_ROWS - 1}, got ${index}.`);
  }
  return String.fromCharCode(65 + index);
}

/**
 * Builds the full seat grid for one screen. Throws when the layout does not add up to the screen's
 * `totalSeats`, so a seed can never quietly create a room whose map disagrees with its capacity.
 */
export function buildSeatGrid(screenId: string, totalSeats: number, layout: SeatLayout): SeedSeat[] {
  const { rows, seatsPerRow } = layout;
  if (!Number.isInteger(rows) || rows < 1 || rows > MAX_SEAT_ROWS) {
    throw new Error(`Screen ${screenId}: rows must be an integer from 1 to ${MAX_SEAT_ROWS}, got ${rows}.`);
  }
  if (!Number.isInteger(seatsPerRow) || seatsPerRow < 2 || seatsPerRow % 2 !== 0) {
    throw new Error(`Screen ${screenId}: seatsPerRow must be an even integer of at least 2, got ${seatsPerRow}.`);
  }
  if (rows * seatsPerRow !== totalSeats) {
    throw new Error(
      `Screen ${screenId}: ${rows} rows x ${seatsPerRow} seats is ${rows * seatsPerRow}, but totalSeats is ${totalSeats}.`,
    );
  }

  const backRow = rowLetter(rows - 1);
  const seats: SeedSeat[] = [];
  for (let r = 0; r < rows; r++) {
    const row = rowLetter(r);
    for (let number = 1; number <= seatsPerRow; number++) {
      const isWheelchairSpace = row === backRow && (number === 1 || number === seatsPerRow);
      seats.push({ screenId, row, number, kind: isWheelchairSpace ? 'wheelchair' : 'standard' });
    }
  }
  return seats;
}
