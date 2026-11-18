// Headline load test (slice 5e, RULES D5.6): 500 virtual users all contend for the SAME 50 seats of one
// showtime at the same moment, each doing hold -> confirm (the direct /bookings commit; payments are not
// built, so this is what exercises the no-double-booking guarantee end to end).
//
// Pass = exactly 50 bookings exist, one per seat, and the other ~450 attempts get a clean 409 seat_taken.
// A 5xx anywhere, or any unexpected 4xx, fails the run (the `unexpected` threshold).
//
//   k6 run --env BASE_URL=http://localhost:3000 --env SHOWTIME_ID=<id> load-tests/seat-contention.js
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';
import { sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:3001';
const SHOWTIME_ID = __ENV.SHOWTIME_ID;
const SEATS = 50;

const holdDuration = new Trend('hold_duration', true);
const bookingDuration = new Trend('booking_duration', true);
const hold201 = new Counter('hold_201');
const hold409SeatTaken = new Counter('hold_409_seat_taken');
const booking201 = new Counter('booking_201');
const unexpected = new Counter('unexpected');

export const options = {
  // p(50) is `med`; p95 and p99 are the headline latency numbers the report needs.
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    contention: {
      executor: 'per-vu-iterations',
      vus: 500,
      iterations: 1,
      maxDuration: '30s',
    },
  },
  thresholds: {
    // The hard gate: nothing but a 201 or a clean 409 seat_taken is allowed.
    unexpected: ['count===0'],
  },
};

/** One valid v4 UUID per caller: the server validates X-Client-Id as a UUID (zod `z.uuid()`). */
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function setup() {
  const res = http.get(`${BASE}/showtimes/${SHOWTIME_ID}/seats`, { headers: { 'X-Client-Id': uuid() } });
  if (res.status !== 200) throw new Error(`seat map failed: ${res.status}`);
  const seatIds = res
    .json()
    .rows.flatMap((r) => r.seats)
    .slice(0, SEATS)
    .map((s) => s.id);
  if (seatIds.length !== SEATS) throw new Error(`expected ${SEATS} seats, got ${seatIds.length}`);
  return { seatIds };
}

export default function (data) {
  // Spread the 500 connects over ~1 s: on macOS `kern.ipc.somaxconn` is 128, so an instant 500-way
  // connect just resets ~370 TCP connects before the request is ever sent. One second is still "the
  // same moment" against a 10-minute hold window.
  sleep(Math.random());
  // Deterministic assignment: each of the 50 seats gets exactly 10 contenders, so no seat can be left
  // uncontended and every seat has exactly one winner (Redis SET NX is atomic).
  const seat = data.seatIds[(__VU - 1) % SEATS];
  const headers = { 'X-Client-Id': uuid(), 'Content-Type': 'application/json' };
  const body = JSON.stringify({ seatIds: [seat] });

  const hold = http.post(`${BASE}/showtimes/${SHOWTIME_ID}/holds`, body, { headers });
  holdDuration.add(hold.timings.duration);

  if (hold.status === 201) {
    hold201.add(1);
    const booking = http.post(`${BASE}/showtimes/${SHOWTIME_ID}/bookings`, body, { headers });
    bookingDuration.add(booking.timings.duration);
    if (booking.status === 201) booking201.add(1);
    else unexpected.add(1); // a winner that cannot confirm is a real failure
    return;
  }

  if (hold.status === 409) {
    const code = hold.json().error?.code;
    if (code === 'seat_taken') hold409SeatTaken.add(1); // the expected, correct refusal
    else unexpected.add(1);
    return;
  }

  unexpected.add(1); // 5xx, 429, 400, 404, 403 — anything else is a real error
}
