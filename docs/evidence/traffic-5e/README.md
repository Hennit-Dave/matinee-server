# Evidence: slice 5e, the k6 load test (RULES D5.6, D5.3, C9, E5)

Everything here ran against a **throwaway PostgreSQL 16 (port 54329) and Redis 8 (port 6391)** on this machine, with the real
schema and a single throwaway showtime + 50 of its 320 seats (`load-tests/prepare.ts`). Nothing touched Neon, Railway, or Dave's
own local services. The server is the real `src/api/main.ts` built to `dist/`, run on **PORT=3001** with `TRAFFIC_PROFILE=loadtest`.

| File | What it shows | Reproduce |
|---|---|---|
| `before.txt` + `summary-seat-contention-before.json` | **Baseline**, before the rate-limit scaling change: 500 users from one address are refused by the shipped per-address limits (467 × `429 rate_limited`), so the run cannot measure contention. | `stand-up.sh`, then `k6 run load-tests/seat-contention.js` on the pre-change commit |
| `after.txt` + `summary-seat-contention-after.json` | **The headline.** 500 VUs contend for the same 50 seats: 50 holds, 50 bookings, 450 clean `409 seat_taken`, zero 5xx. The DB holds 50 rows, 50 distinct seats, and `GROUP BY … HAVING COUNT(*) > 1` returns nothing. | as above, after the change |
| `waiting-room.txt` + `summary-waiting-room.json` | **The waiting room.** 500 users against a cap of 5: 5 admitted, 495 queued with distinct FIFO positions (`ahead_sum` = 122265), then a fixed-rate drain, zero 5xx. | `k6 run load-tests/waiting-room.js` with the room re-enabled |

The k6 scripts live in `load-tests/` (they are the "proof script built alongside the feature", RULES D5.10); the written report
that ties the numbers together is `load-tests/REPORT.md`.
