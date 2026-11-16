import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOAD_TEST_SCREEN_ID, SEED_SCREENS, buildSeedPlan, buildSeedSeats } from './seedPlan.js';
import { MAX_SEAT_ROWS, buildSeatGrid, rowLetter } from './seatLayout.js';

test('every seeded screen has exactly as many seats as its totalSeats, with unique (row, number)', () => {
  for (const screen of SEED_SCREENS) {
    const grid = buildSeatGrid(screen.id, screen.totalSeats, screen.layout);
    assert.equal(grid.length, screen.totalSeats, `${screen.id} seat count`);
    const keys = new Set(grid.map((s) => `${s.row}${s.number}`));
    assert.equal(keys.size, grid.length, `${screen.id} has a duplicate (row, number)`);
    assert.ok(grid.every((s) => s.screenId === screen.id));
  }
});

test('the load-test screen is the 320-seat Figma layout: 16 rows A-P x 20 seats', () => {
  const imax = SEED_SCREENS.find((s) => s.id === LOAD_TEST_SCREEN_ID);
  assert.ok(imax);
  assert.deepEqual(imax.layout, { rows: 16, seatsPerRow: 20 });

  const grid = buildSeatGrid(imax.id, imax.totalSeats, imax.layout);
  assert.equal(grid.length, 320);
  const rows = [...new Set(grid.map((s) => s.row))];
  assert.equal(rows.join(''), 'ABCDEFGHIJKLMNOP');
  for (const row of rows) {
    const numbers = grid.filter((s) => s.row === row).map((s) => s.number);
    assert.deepEqual(numbers, Array.from({ length: 20 }, (_, i) => i + 1), `row ${row} runs 1..20`);
  }
});

test('wheelchair spaces sit at both outer ends of the back row, and nowhere else', () => {
  for (const screen of SEED_SCREENS) {
    const grid = buildSeatGrid(screen.id, screen.totalSeats, screen.layout);
    const backRow = rowLetter(screen.layout.rows - 1);
    const wheelchair = grid.filter((s) => s.kind === 'wheelchair').map((s) => `${s.row}${s.number}`);
    assert.deepEqual(wheelchair, [`${backRow}1`, `${backRow}${screen.layout.seatsPerRow}`], screen.id);
  }
});

test('every seeded row has an even length, so the centre aisle sits exactly in the middle', () => {
  for (const screen of SEED_SCREENS) assert.equal(screen.layout.seatsPerRow % 2, 0, screen.id);
});

test('buildSeedPlan carries every seat of every screen and no duplicates', () => {
  const plan = buildSeedPlan([1, 2, 3], new Date('2026-11-16T10:00:00.000Z'));
  const expected = SEED_SCREENS.reduce((sum, s) => sum + s.totalSeats, 0);
  assert.equal(plan.seats.length, expected);
  assert.equal(plan.seats.length, buildSeedSeats().length);
  const keys = new Set(plan.seats.map((s) => `${s.screenId}|${s.row}|${s.number}`));
  assert.equal(keys.size, plan.seats.length);
});

test('buildSeatGrid refuses a layout that does not add up, is lopsided, or has too many rows', () => {
  assert.throws(() => buildSeatGrid('x', 100, { rows: 10, seatsPerRow: 12 }), /totalSeats/);
  assert.throws(() => buildSeatGrid('x', 99, { rows: 11, seatsPerRow: 9 }), /even/);
  assert.throws(() => buildSeatGrid('x', 2 * (MAX_SEAT_ROWS + 1), { rows: MAX_SEAT_ROWS + 1, seatsPerRow: 2 }), /rows/);
  assert.throws(() => rowLetter(MAX_SEAT_ROWS));
  assert.equal(rowLetter(0), 'A');
  assert.equal(rowLetter(MAX_SEAT_ROWS - 1), 'Z');
});
