// Ramp test (deploy slice): find the MAX_IN_FLIGHT knee.
//
// It ramps concurrency from 50 to 500 VUs against GET /showtimes/:id/seats and reports latency plus the
// load-shedding refusals. The knee is where p99 latency climbs sharply (or `server_busy` first appears):
// set MAX_IN_FLIGHT just above that so the server sheds only when it is actually past the knee.
//
// Run it against a server with `TRAFFIC_PROFILE=loadtest` AND an explicit `MAX_IN_FLIGHT`:
//   - TRAFFIC_PROFILE=loadtest lifts the per-address rate limits, the waiting room and the hold caps
//     (500 VUs from one address, one showing) — each VU sends a fresh X-Client-Id, so per-install limits
//     never accumulate and nothing but the shedder can refuse the request.
//   - an explicit MAX_IN_FLIGHT beats the profile (src/http/loadShed.ts), so shedding STAYS ON at that
//     number — that is the whole point of the run.
// Watch the API log's `load_shed` lines (`inFlight`, `maxInFlight`) next to this summary: they mark the
// exact concurrency where the shedder started refusing.
//
//   k6 run --env BASE_URL=http://localhost:3001 --env SHOWTIME_ID=<id> load-tests/ramp.js
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';
import { sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:3001';
const SHOWTIME_ID = __ENV.SHOWTIME_ID;

const latency = new Trend('seats_latency', true);
const ok = new Counter('ok');
const shed = new Counter('server_busy');
const rateLimited = new Counter('rate_limited');
const other = new Counter('other');

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    ramp: {
      executor: 'ramping-vus',
      startVUs: 50,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '30s', target: 100 },
        { duration: '30s', target: 200 },
        { duration: '30s', target: 300 },
        { duration: '30s', target: 400 },
        { duration: '30s', target: 500 },
        { duration: '15s', target: 0 },
      ],
      gracefulRampDown: '15s',
    },
  },
};

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export default function () {
  const res = http.get(`${BASE}/showtimes/${SHOWTIME_ID}/seats`, { headers: { 'X-Client-Id': uuid() } });
  latency.add(res.timings.duration);
  if (res.status === 200) {
    ok.add(1);
  } else if (res.status === 503 && res.json().error?.code === 'server_busy') {
    shed.add(1);
  } else if (res.status === 429) {
    rateLimited.add(1);
  } else {
    other.add(1);
  }
  sleep(1);
}
