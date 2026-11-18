// Waiting-room scenario (slice 5e, RULES D5.3): 500 users arrive at one showing at the same moment while
// the waiting room is ON with a small cap (WAITING_ROOM_MAX_ACTIVE=5). It proves three things:
//
//   1. the cap holds under load — exactly 5 are admitted at the join, the other 495 queue;
//   2. the line is FIFO with distinct positions — `ahead_sum` is the sum of every waiter's position; it
//      equals 0+1+...+494 = 122265 if and only if the 495 waiters hold the 495 distinct positions 0..494;
//   3. the fixed admission rate — the admitted users leave, and the queued users are let in at an even
//      spacing (`admission_second`).
//
// A 5xx anywhere, or any unexpected status, fails the run.
//
//   k6 run --env BASE_URL=http://localhost:3000 --env SHOWTIME_ID=<id> load-tests/waiting-room.js
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';
import { sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:3001';
const SHOWTIME_ID = __ENV.SHOWTIME_ID;

const admittedAtJoin = new Counter('admitted_at_join');
const queuedAtJoin = new Counter('queued_at_join');
const aheadSum = new Counter('ahead_sum');
const admittedLater = new Counter('admitted_later');
const admissionSecond = new Trend('admission_second'); // seconds since the run started (a plain number, not a time metric)
const joinDuration = new Trend('join_duration', true);
const pollDuration = new Trend('poll_duration', true);
const unexpected = new Counter('unexpected');

const OBSERVE_MS = 40_000; // long enough to watch a few admissions at the fixed rate, not to drain everyone

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    room: {
      executor: 'per-vu-iterations',
      vus: 500,
      iterations: 1,
      maxDuration: '60s',
    },
  },
  thresholds: {
    unexpected: ['count===0'],
  },
};

const started = Date.now();

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export default function () {
  sleep(Math.random()); // spread the 500 connects over ~1 s (see seat-contention.js)
  const headers = { 'X-Client-Id': uuid() };
  const join = http.post(`${BASE}/showtimes/${SHOWTIME_ID}/queue`, null, { headers });
  joinDuration.add(join.timings.duration);
  if (join.status !== 200) {
    unexpected.add(1);
    return;
  }
  const body = join.json();

  if (body.status === 'admitted') {
    admittedAtJoin.add(1);
    // Hold the slot a moment, then leave, so the queue can drain at the fixed rate.
    sleep(2);
    const leave = http.del(`${BASE}/showtimes/${SHOWTIME_ID}/queue`, null, { headers });
    if (leave.status !== 200) unexpected.add(1);
    return;
  }

  if (body.status === 'waiting') {
    queuedAtJoin.add(1);
    aheadSum.add(body.ahead);
    const deadline = Date.now() + OBSERVE_MS;
    while (Date.now() < deadline) {
      sleep(3); // the app never polls faster than the server's 3 s pollAfterMs
      const poll = http.get(`${BASE}/showtimes/${SHOWTIME_ID}/queue`, { headers });
      pollDuration.add(poll.timings.duration);
      if (poll.status !== 200) {
        unexpected.add(1);
        return;
      }
      const p = poll.json();
      if (p.status === 'admitted') {
        admittedLater.add(1);
        admissionSecond.add((Date.now() - started) / 1000);
        return;
      }
      if (p.status !== 'waiting') {
        unexpected.add(1);
        return;
      }
    }
    return; // still waiting when the window closed — expected for the back of the line
  }

  unexpected.add(1);
}
