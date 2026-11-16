import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MovieShowtimesResponseSchema,
  formatPriceCents,
  groupShowtimesByCinemaAndDate,
  type ShowtimeRow,
} from './showtime.js';

test('formatPriceCents formats minor units without floating-point drift', () => {
  assert.equal(formatPriceCents(0), '£0.00');
  assert.equal(formatPriceCents(1200), '£12.00');
  assert.equal(formatPriceCents(1550), '£15.50');
  assert.equal(formatPriceCents(1805), '£18.05');
});

test('groupShowtimesByCinemaAndDate returns cinemas: [] when there are no showtimes', () => {
  const res = groupShowtimesByCinemaAndDate(900001, []);
  assert.doesNotThrow(() => MovieShowtimesResponseSchema.parse(res));
  assert.deepEqual(res, { movieId: 900001, cinemas: [] });
});

test('groupShowtimesByCinemaAndDate groups flat rows by cinema -> date -> showtimes', () => {
  const rows: ShowtimeRow[] = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      startsAt: new Date('2026-11-15T14:30:00.000Z'),
      priceCents: 1200,
      screen: {
        id: 'curzon-soho-1',
        name: 'Screen 1',
        format: 'Standard',
        totalSeats: 120,
        cinema: { id: 'curzon-soho', name: 'Curzon Soho', address: '99 Shaftesbury Ave, London' },
      },
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      startsAt: new Date('2026-11-15T20:30:00.000Z'),
      priceCents: 1550,
      screen: {
        id: 'curzon-soho-2',
        name: 'Screen 2',
        format: 'Standard',
        totalSeats: 84,
        cinema: { id: 'curzon-soho', name: 'Curzon Soho', address: '99 Shaftesbury Ave, London' },
      },
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      startsAt: new Date('2026-11-16T20:30:00.000Z'),
      priceCents: 1850,
      screen: {
        id: 'bfi-southbank-imax',
        name: 'IMAX',
        format: 'IMAX',
        totalSeats: 320,
        cinema: { id: 'bfi-southbank', name: 'BFI Southbank', address: 'Belvedere Rd, London' },
      },
    },
  ];

  const grouped = groupShowtimesByCinemaAndDate(7, rows);
  assert.doesNotThrow(() => MovieShowtimesResponseSchema.parse(grouped));
  assert.equal(grouped.cinemas.length, 2);
  assert.equal(grouped.cinemas[0]?.dates[0]?.date, '2026-11-15');
  assert.equal(grouped.cinemas[0]?.dates[0]?.showtimes.length, 2);
  assert.equal(grouped.cinemas[0]?.dates[0]?.showtimes[0]?.time, '14:30');
  assert.equal(grouped.cinemas[0]?.dates[0]?.showtimes[0]?.format, 'Standard');
  assert.equal(grouped.cinemas[0]?.dates[0]?.showtimes[0]?.priceFormatted, '£12.00');
  assert.equal(grouped.cinemas[1]?.dates[0]?.showtimes[0]?.format, 'IMAX');
  assert.equal(grouped.cinemas[1]?.dates[0]?.showtimes[0]?.totalSeats, 320);
});
