# Load test report — slice 5e (traffic)

**Claim under test:** a seat is never sold twice. 500 virtual users contend for the same 50 seats of one
showtime at the same moment; the report proves exactly 50 bookings, one per seat, zero duplicates, and
that every other attempt gets a clean, correct refusal.

## 1. What was tested and how

The scripts in this directory run against the **real server** (`src/api/main.ts` built to `dist/`), a
**throwaway Postgres 16 and Redis 8** (their own ports, `stand-up.sh`), and a single throwaway showtime
with 50 of its 320 seats (`prepare.ts`). No Neon, no Railway, no TMDB, no `.env`.

| Scenario | Script | Proves |
|---|---|---|
| **Headline** | `seat-contention.js` | 500 VUs × (hold → confirm) on the same 50 seats; 10 contenders per seat by construction. Pass = 50 bookings, 450 clean `409 seat_taken`, zero 5xx/unexpected. |
| **Waiting room** | `waiting-room.js` | 500 users against `WAITING_ROOM_MAX_ACTIVE=5`: 5 admitted, 495 queued with distinct FIFO positions, then a fixed-rate drain. |

Both run with `TRAFFIC_PROFILE=loadtest`, the one boot switch that relaxes what a test from one address
and one showing cannot live with: it turns the waiting room and load shedding off, lifts the per-address
hold cap, and (this slice) lifts the per-address rate limits while keeping the per-install ones.

**One deliberate deviation from "instant":** each VU sleeps `0–1 s` before its first request. On macOS
`kern.ipc.somaxconn` is 128, so an instant 500-way connect resets ~370 TCP connections before the request
is even sent. One second is still "the same moment" against a 10-minute hold window, and it is the honest
way to measure the server rather than the OS listen backlog.

## 2. Headline result — 500 users on 50 seats

```
hold_201..............: 50       hold_409_seat_taken: 450
booking_201...........: 50       unexpected: 0
```

| Endpoint | p50 (med) | p95 | p99 |
|---|---|---|---|
| `POST /holds` | 1.15 ms | 11.29 ms | 23.84 ms |
| `POST /bookings` | 4.22 ms | 21.44 ms | 22.88 ms |
| all requests | 1.17 ms | 16.84 ms | 24.33 ms |

Throughput: 551 requests over ~1 s (500 holds + 50 bookings + the setup seat-map read).

### The pass/fail invariant, and the DB proof

1. **Exactly 50 bookings, one per seat:**
   `SELECT COUNT(*), COUNT(DISTINCT seat_id) FROM bookings WHERE showtime_id = …` → **50, 50**.
2. **No seat sold twice:**
   `SELECT showtime_id, seat_id, COUNT(*) … GROUP BY showtime_id, seat_id HAVING COUNT(*) > 1` → **0 rows**.
3. **50 distinct owners:** `COUNT(DISTINCT owner_id)` → **50** — 50 different callers, one seat each.
4. **The ~450 losers got a clean refusal:** 450 × `409 seat_taken`, zero 5xx, zero unexpected 4xx.

### About the error rate

k6's built-in `http_req_failed` reports **81.66%** here, because it counts every 4xx as a failure. That is
wrong for this test: the 450 `409 seat_taken` refusals *are* the correct behaviour, the second half of the
guarantee. The `unexpected` counter is the honest metric — it separates the expected 409s from real errors
(5xx / 429 / 400 / 404 / 403) — and it is **0**. This distinction is the point of the error-rate column in
`TRAFFIC.md`.

## 3. Waiting-room result — 500 users against a room of 5

```
admitted_at_join: 5        queued_at_join: 495
ahead_sum: 122265          admitted_later: 7        unexpected: 0
```

- **The cap holds:** exactly 5 admitted at the join, under a 500-user burst.
- **FIFO with distinct positions:** `ahead_sum = 122265`, which is `0 + 1 + … + 494`. The 495 waiters hold
  the 495 distinct positions, each exactly once — first in, first out.
- **Fixed-rate admission:** the 7 later admissions are spread over 3.0–39.1 s, one every ~5 s (12/min), not
  a burst. The exact even spacing ("one millisecond short admits nobody") is pinned by ADR 0017's tests.
- **No 5xx:** 7,386 requests, 0 failed. Join p50 1.10 ms, poll p50 1.72 ms.

## 4. What the logs showed (RULES E5)

The server's structured log for the headline run, counted:

```
50  hold_acquired        450  hold_rejected (all errorCode=seat_taken)      50  booking_confirmed
0   booking_rejected     0    redis_unavailable     0   server_busy     0   rate_limit_unavailable
```

Request statuses: **100 × 201** (50 holds + 50 bookings), **450 × 409**, **7 × 200** (health + the setup
read) — no 500s, no 429s. For any single user, the log line carries the request id, the user id, the route,
the response time and the result, so "what happened to this user's booking" is answerable from the log
alone (the booking keeps its `reference` and `ownerId`). The waiting-room log shows the line itself: one
`waiting_room_join` per waiter with `ahead: 0…494`, all distinct.

## 5. Chosen-not-measured, revisited (ADRs 0015–0018)

| Number | Was | The run says |
|---|---|---|
| Rate limits (5c) | chosen, abuse headroom | The limiter's `EVALSHA` on the hot hold path costs ~1 ms total (hold p50 is 1.15 ms *including* the DB reads), so the limiter adds nothing worth tuning. The limits stay. |
| 150 ms Redis deadline (5c/5d) | chosen | Redis answered in well under 10 ms at p99 even under the burst; 150 ms is generous. No change. |
| `MAX_IN_FLIGHT=250` (5d) | chosen, not measured | **Not validated here** — the profile turns shedding off so the burst isn't refused. The server absorbed 500 concurrent holds + 50 bookings with p99 24 ms, so 250 is conservative; a ramp test with shedding *on* is the way to set a real figure. Left for the deploy slice. |
| `PRIMARY_POOL_MAX=5` (0015) | chosen | **Not the bottleneck I expected.** 50 concurrent confirms over 5 primary connections finished with booking p99 22.9 ms and no pool timeouts. Adequate at this scale; revisit only at real multi-room concurrency. |

## 6. The surprise (interview Q8)

The thing I expected to bite — the 5-connection primary pool, the "chosen not measured" number I most
distrusted — did **not**: 50 concurrent confirms serialized through it at p99 22.9 ms. What actually bit was
the **environment, not the product**: macOS's 128-slot TCP listen backlog (`kern.ipc.somaxconn`) reset ~370
of the 500 connections on an instant start, before any request reached the app. The fix was a 1 s stagger,
not a code change — and it's a reminder that a "500 users at once" headline measures the transport in front
of the server unless you say what "at once" means.

## 7. Reproduction

```sh
bash load-tests/stand-up.sh
npm run build
TRAFFIC_PROFILE=loadtest DATABASE_URL=… DATABASE_READ_URL=… REDIS_URL=… TMDB_READ_TOKEN=x PORT=3001 node dist/api/main.js
SHOWTIME_ID=$(node -e "console.log(require('./load-tests/params.json').showtimeId)")
k6 run --env BASE_URL=http://localhost:3001 --env SHOWTIME_ID="$SHOWTIME_ID" load-tests/seat-contention.js
# then the DB queries in §2; tear down with bash load-tests/tear-down.sh
```

The deploy slice re-runs the same scripts against the Railway server (change only `BASE_URL`).
