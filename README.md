# Matinee server

The API, payments, background jobs and database behind Matinee, a cinema ticket booking app where a seat is never sold twice.

- **The app** (screenshots, demo GIF, Android build): [matinee-mobile](https://github.com/Hennit-Dave/matinee-mobile)
- **Download the Android build:** https://expo.dev/accounts/hennit_dave/projects/matinee/builds/ef7c7345-80bd-43cf-a9bf-1d5f534817e7
- **Demo video:** https://lnkd.in/p/dM-k2isA

## Status

Slice 0: an Express + TypeScript skeleton with a real `/health` (checks Postgres primary + replica
and Redis, 503 on failure), structured logging, request IDs and a Zod validation helper.
Slice 1: the movie endpoints below (TMDB through this server, cached in Redis). Showtimes and the
seat map are built (see "Seat map endpoint"); seat holds and bookings are built (see "Seat holds and
bookings"), without payments, and rate limiting guards the busy routes (see "Rate limiting").
The traffic chapter (5a–5e) is done: seat holds, rate limiting, hold caps, the waiting room and graceful
overload, and the k6 load test that proves a seat is never sold twice (see "Load test", `TRAFFIC.md`,
`SHARDING.md`). The deploy slice (Railway + Neon) is configured: see "Deploy" and `ARCHITECTURE.md`. This
README is written as the build goes.

## What it is

Users browse movies, see showtimes, pick seats on a seat map and pay. Movie data comes from TMDB through this server. Showtimes, cinemas, seats and bookings live in this server's own database.

## Tech stack

Node + Express · TypeScript · PostgreSQL (Neon, primary + read replica) · Redis on Railway (ADR 0008's addendum — BullMQ arrives with the first real job) · Zod · Stripe (test mode) · Sentry · k6

## How to run locally

```
npm install
cp .env.example .env   # fill in DATABASE_URL, DATABASE_READ_URL, REDIS_URL, TMDB_READ_TOKEN
npm run dev:api         # http://localhost:3000, GET /health
```

`npm run typecheck`, `npm run lint`, `npm test` (unit) and `npm run test:integration` (needs
`TEST_DATABASE_ALLOWED=true` plus `TEST_DATABASE_URL`/`TEST_DATABASE_READ_URL`/`TEST_REDIS_URL` —
see `.github/workflows/ci.yml` for the values CI uses against disposable containers; never point
these at the real `DATABASE_URL`/`REDIS_URL`).

## Starting Redis locally

Production Redis is a private Railway service (ADR 0008's addendum); local development uses a
plain local install instead:

```
brew install redis
brew services start redis   # runs in the background at redis://localhost:6379
```

Set `REDIS_URL=redis://localhost:6379` in `.env`. Stop it later with `brew services stop redis`.

## Movie endpoints

The app never calls TMDB; these two routes are the only path to movie data (`TMDB_READ_TOKEN` is
read from `.env` and never leaves the server).

| Route | Query | Returns |
|---|---|---|
| `GET /movies/now-playing` | `page` (1-500, default 1) | `{ movies, page, totalPages, totalResults }` |
| `GET /movies/search` | `q` (required, 1-100 chars after trimming), `page` | same shape |

The response contract (`Movie` and `MoviesPage`, as Zod schemas) is in `src/movies/movie.ts`;
`src/movies/tmdb.ts` is the only file that knows TMDB's response shape. Bad input is a `400
validation_failed`; TMDB down with nothing cached is a `503 upstream_unavailable`. The `X-Cache`
response header (`HIT`, `MISS` or `STALE`) says where the data came from.

**Cache TTLs (Redis, cache-aside, reasons in `src/movies/service.ts`):** now-playing is fresh for 3
hours (the list changes about daily), search for 5 minutes (unbounded distinct queries, so keep it
short); each key is kept for 24 h / 1 h longer than that purely to serve if TMDB is down, so every
key still expires (27 h and 65 min in Redis).

## Seat map endpoint

| Route | Returns |
|---|---|
| `GET /showtimes/:id/seats` | `{ showtimeId, movieId, startsAt, time, screen, priceCents, priceFormatted, rows }`, where `rows` is `[{ row, seats: [{ id, row, number, kind, status }] }]` |

`:id` is a showtime id (the `id` of a slot in `GET /movies/:id/showtimes`). A malformed id is a `400
validation_failed`, an unknown showtime a `404 not_found`. `priceFormatted` is a finished string
(`"£18.50"`); the app never does money maths. Seats belong to the screen (ADR 0014). `status` is
`available`, `held` (a live Redis hold) or `sold` (a booking exists), sold winning; see "Seat holds and
bookings" below. With Redis unreachable the map is a `503`, not a guess. The contract is in
`src/showtimes/seat.ts`.

**It needs `X-Client-Id` and, when the waiting room is on, a pass** (see "Waiting room"): without a pass the answer is
`403 waiting_room_required`, and each map poll is what keeps the pass alive. (`X-Client-Id` used to be optional here.)

After pulling this change, add the table and the seats: `npm run db:migrate`, then
`npm run db:seed -- --seats-only` (seats only: no TMDB token needed, no showtime or price touched).
A plain `npm run db:seed` also seeds seats.

## Seat holds and bookings

A seat is never sold twice. Two layers, each testable alone (ADR 0015): a Redis hold decides who may *try*,
and Postgres `UNIQUE (showtime_id, seat_id)` on `bookings` decides who *owns* the seat, even if Redis is
empty, wrong or down.

| Route | Does | Success | Refusals |
|---|---|---|---|
| `POST /showtimes/:id/holds` `{ seatIds }` | Holds the seats for **10 minutes**, all or nothing | `201 { showtimeId, seatIds, expiresAt, expiresInMs }` | `409 seat_taken { seatIds }` (the seats it could not get), `409 hold_limit_reached { scope, limit, held }` (see "Hold caps"), `403 waiting_room_required` (no pass: see "Waiting room"), `503 holds_unavailable` |
| `DELETE /showtimes/:id/holds` `{ seatIds }` | Gives back the caller's own holds (owner-checked, idempotent) | `200 { released }` | `503 holds_unavailable` |
| `POST /showtimes/:id/bookings` `{ seatIds }` | Turns the caller's holds into bookings, priced on the server | `201 { reference, showtimeId, seats, priceCents, totalCents, totalFormatted }` | `409 seat_not_held { seatIds }`, `409 seat_taken { seatIds }`, `503 holds_unavailable` |

- Every route needs an **`X-Client-Id`** header (a UUID; the app makes one per install). It stands in for a user
  id until there is auth, and is the owner of holds and bookings. It is not authentication (ADR 0015).
- `1` to `8` unique seat ids per request, and every seat must belong to the showtime's screen (`400
  validation_failed` otherwise). Money is whole pence, formatted on the server.
- **Redis down fails closed**: holds, releases and confirms answer `503 holds_unavailable` with `Retry-After: 2`,
  and so does the seat map. Nothing is booked without a hold check, and nothing double-books either way.
- **Read-your-own-writes**: bookings are read from the replica, except for 5 s after the caller's own booking
  (`X-Client-Id` on the seat-map request), when they come from the primary.
- `POST /showtimes/:id/bookings` is the **temporary direct commit** with no payment step, kept as the k6
  load-test path. The real booking path is the payments webhook job (see "Payments" below), which calls the same
  `confirmBooking` (ADR 0015, 0019).
- Needs the migration: `npm run db:migrate` adds `bookings` (a new table only; no existing row changes).

Proof is in `docs/evidence/traffic-5a/`: the tests, a narrated run (`proof.txt`), five deliberate breakages of
the guarantee that the tests catch (`mutation-checks.txt`), and the race this prevents (`race-demo.txt`: 50 users,
one seat, no constraint, sold 50 times).

## Payments (test mode)

Stripe in test mode, GBP (ADR 0001, 0019). Checkout creates a PaymentIntent and returns a `client_secret` for the
native PaymentSheet (P2); a booking is confirmed only by a **verified webhook**, processed in a background job —
never by the checkout call itself.

| Route | Does | Returns / refusals |
|---|---|---|
| `POST /showtimes/:id/checkout` `{ seatIds }` + `Idempotency-Key` | Verifies the caller still holds every seat, prices the order server-side (seats **+ £1.50**), creates the PaymentIntent, returns its `client_secret` | `201 { reference, clientSecret, seatTotalCents, feeCents, totalCents, totalFormatted, currency, status }` · `409 seat_not_held` · `409 idempotency_mismatch` · `503 payment_unavailable` |
| `GET /orders/:reference` + `X-Client-Id` | The confirmation poll (P2): the order's `requires_payment \| succeeded \| refunded \| failed`, plus the ticket (on `succeeded`) or the refund reason (on `refunded`). Owner-scoped: someone else's order is a 404. Read from the primary, never cached, never load-shed, never waiting-room-gated. | `200 { reference, status, ticket?, refundReason? }` · `404 not_found` |
| `POST /webhooks/stripe` (raw body) | Verifies the Stripe signature, records the event id (dedup), enqueues the job, returns 200 fast | `200 { received: true }` |

- **Idempotency.** The `Idempotency-Key` header makes a repeated checkout return the SAME PaymentIntent (no second
  charge); a key reused with different seats is a `409`. The webhook dedup is separate: every Stripe `event id` is
  stored first, so a re-delivered event is skipped.
- **The worker** (`npm run worker`, a separate always-on process) turns a succeeded payment into a booking via
  `confirmBooking`, records the charge in an **append-only `ledger_entries`** table, and — if the hold lapsed — refunds
  the PaymentIntent and records the refund. Retries with exponential backoff, then the job moves to BullMQ's failed set.
- **Never cached:** payment status and webhook idempotency records live in Postgres only (RULES C4).
- Needs the migration: `npm run db:migrate` adds `orders`, `ledger_entries` and `processed_stripe_events`.
- Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (names in `.env.example`, values in `.env` / `.env.test.local`)
  to mount the routes; without them the server boots without payments.

## Hold caps

Rate limits slow hoarding; these stop it (ADR 0018). Per **showing**, counted inside the same atomic Redis step that takes the seats:

| Cap | Default | Setting |
|---|---|---|
| Live held seats per install (`X-Client-Id`) | **8** (one booking's worth) | `HOLD_CAP_PER_OWNER` |
| Live held seats per network address | **16** | `HOLD_CAP_PER_ADDRESS` |

- Over a cap the answer is **`409 hold_limit_reached`** with `scope` (`owner` or `address`), `limit` and `held`, and **nothing is held**.
  No `Retry-After`: releasing seats, or the holds lapsing, is what helps.
- **A hold that expires frees its slot by itself.** The hold key is the truth; the per-owner and per-address SET indexes only list
  candidates and are checked against the keys they name, so no timer or cleanup job is needed. Asking again for seats you already hold is free.
- `0` turns a cap off. `TRAFFIC_PROFILE=loadtest` lifts the **address** cap for the k6 test (slice 5e; 500 users share one address) and logs a
  `traffic_profile_loadtest` warning at boot. **Never set it in production.**
- The address is the one the rate limiter counts. If it cannot be resolved the address cap is skipped for that request.
- Fails closed with the holds (Redis down is `503 holds_unavailable`). A booking does not release its holds, so they still count for up to 10 minutes.
- Proof is in `docs/evidence/traffic-5d/hold-caps/`.

## Waiting room

When more people are choosing seats for one showing than the room allows, new arrivals queue and are let in at a fixed rate
(RULES D5.3; ADR 0017). It gates **entry to seat selection**, per showing.

> **WAITING_ROOM_MAX_ACTIVE MUST BE RAISED FOR PRODUCTION.** It defaults to **2**, a demo value, so the queue can be shown on two or
> three phones. Left unset on a deployed server, every showing queues everyone behind two people. The server logs a
> `waiting_room_demo_defaults` warning at boot while it is unset. Set a real figure in the deploy slice (the 5e load test gives it).

| Route | Does |
|---|---|
| `POST /showtimes/:id/queue` | Join the line, or be let straight in when there is room. Idempotent: joining again keeps your place. `503 waiting_room_full` past 5,000 waiting |
| `GET /showtimes/:id/queue` | Where you stand, and a heartbeat for your place. Never joins |
| `DELETE /showtimes/:id/queue` | Give up a pass or a place. Idempotent; not rate limited |

All three answer `{ status: 'admitted', passExpiresInMs }`, `{ status: 'waiting', ahead, pollAfterMs }` (people ahead of you, `0` = you are
next; the back of a long line is told to ask less often) or `{ status: 'not_queued' }`. **There is no estimated wait:** a fixed admission rate
gives only a lower bound, and a time that is often wrong is worse than none.

- **Gated:** `GET /showtimes/:id/seats` and `POST /showtimes/:id/holds` answer `403 waiting_room_required` without a pass. The gate runs after the
  rate limit and before the body is parsed. **Not gated:** releasing seats, booking (you already hold the seats), `/health`, every other read.
- **A pass** is membership of the showing's active set. It lasts while the user is heard from within **30 s** (the seat-map polls are the heartbeat),
  never longer than **20 min** from admission. Someone let in from the queue must show up within **15 s** or the slot goes to the next in line. A closed
  app frees its slot by itself: no sweeper job.
- **The line** is first in, first out, and people are let in **one at a time at an even spacing** (`WAITING_ROOM_ADMIT_PER_MINUTE`), as many as there
  are free slots. A waiter keeps their place for 90 s without polling (a locked phone), then loses it. Someone who still **holds seats** here is let back in
  ahead of the line.
- **Fails open.** If the room's own Redis call errors or takes over 150 ms, the user is let through and one `waiting_room_unavailable` warning is
  logged per 10 s: the opposite of seat holds (which fail closed). Residual risk in ADR 0017: in a partial failure the cap is not enforced.
- Settings (all optional, names in `.env.example`): `WAITING_ROOM_ENABLED` (default on), `WAITING_ROOM_MAX_ACTIVE` (default **2**, DEMO), `WAITING_ROOM_ADMIT_PER_MINUTE`
  (default 12). `TRAFFIC_PROFILE=loadtest` turns the room off for the k6 test (slice 5e).
- **To show it on two or three phones:** start with `WAITING_ROOM_MAX_ACTIVE=1`, open the same showing on each phone. The first is in; the others
  are "0 people ahead" and "1 person ahead"; when the first leaves, the next is let in within about one admission interval.
  `docs/evidence/traffic-5d/waiting-room/demo-fill.sh` fills a room with synthetic users so one phone can show a long line counting down.

## Graceful overload

An overloaded server says so quickly instead of piling up work (RULES D5.7; ADR 0017):

- **Load shedding.** More than `MAX_IN_FLIGHT` requests in flight (default 250, chosen not measured) and the next are refused at once with
  `503 server_busy` and a **jittered `Retry-After` of 5 to 15 s**, so refused clients do not all come back together. Never shed: `GET /health` and every
  `DELETE` (releasing seats and leaving the line free capacity).
- **A database that cannot answer** (pool timeout, unreachable: Prisma `P2024`, `P1001`, `P1002`, `P1008`, `P1017`) is the same `503 server_busy`, not a 500.
- `503 service_unavailable` (the seat map with Redis down) now carries `Retry-After: 5` too, so the app can count down.
- `MAX_IN_FLIGHT=0` turns shedding off; the load-test profile does.

Proof is in `docs/evidence/traffic-5d/waiting-room/`.

## Rate limiting

Per install and per address, in Redis, never in memory (RULES C5, D5.4; ADR 0016). A request over a limit is a
**`429 rate_limited`** with a **`Retry-After`** header in whole seconds (at least 1); the body is the usual error
envelope and says nothing about which counter tripped.

| Policy | Route | Per install (`X-Client-Id`) | Per address |
|---|---|---|---|
| `seatsPoll` | `GET /showtimes/:id/seats` (the map the app polls every ~5 s) | 60 / min | 300 / min |
| `hold` | `POST /showtimes/:id/holds` | 10 / min | 40 / min |
| `booking` | `POST /showtimes/:id/bookings` | 5 / min | 20 / min |
| `search` | `GET /movies/search` | 60 / min | 180 / min |
| `queue` | `POST` and `GET /showtimes/:id/queue` (the waiting room) | 60 / min | 600 / min |

- **Sliding window** (the weighted current + previous window), one atomic Lua script per request covering both
  counters. A refused request counts against neither, so hammering cannot extend a lock-out. It is an
  approximation (worst case about 2x the limit inside one window, for a caller timing bursts to the millisecond);
  ADR 0016 says why that is fine for abuse limits.
- **Fails open.** If the limiter's Redis call errors or takes over 150 ms, the request goes through. This is the
  opposite of seat holds, which fail closed: a limiter protects capacity, a hold protects correctness. With Redis
  down, holds and bookings still answer `503 holds_unavailable` on their own path.
- **The limiter runs before the body is parsed or validated**, right after the client id is read. Not limited:
  `GET /health`, every other read, and `DELETE /showtimes/:id/holds` (releasing seats is the cleanup path; a 429
  there would leave them held for 10 minutes).
- `X-Client-Id` is optional on search (without one, only the address is counted) and required everywhere else, the seat map included.
- **Client address behind a proxy**: trusted by address range (loopback, private ranges, `100.64.0.0/10`), not by a
  hop count, because Railway publishes none (`src/http/clientIp.ts`). If only a proxy hop is visible, the address
  counter is skipped and a `client_ip_unresolved` warning is logged. **Not yet verified against the real Railway
  edge: run `docs/evidence/traffic-5c/verify-client-ip.sh` against the deployed API in the deploy slice.**
- Every number was chosen, then measured by the load test (slice 5e): the limiter's Redis script adds ~nothing
  (the hold path is ~1 ms with it on), so the limits stay. The load test runs with `TRAFFIC_PROFILE=loadtest`,
  which lifts the per-address limits (500 users share one address) and keeps the per-install ones.
- No new environment variable, dependency or migration. Proof is in `docs/evidence/traffic-5c/` and `traffic-5e/`.

## Load test

`load-tests/` holds the k6 scripts and the written report. The headline run — 500 virtual users contending
for the same 50 seats, each doing hold → confirm — passes with **50 bookings, 50 distinct seats, 0
duplicates, and 450 clean `409 seat_taken`** (the DB query `GROUP BY (showtime_id, seat_id) HAVING COUNT(*) > 1`
returns nothing). The waiting-room run proves the cap, the FIFO line and the fixed admission rate under 500
users. Full numbers in `load-tests/REPORT.md`; the traffic story is `docs/TRAFFIC.md`; the sharding plan is
`docs/SHARDING.md`.

## Deploy (Railway + Neon, ADR 0007/0008/0009)

Two services from this one repo, both on Neon Postgres + Railway Redis. The full topology is `ARCHITECTURE.md`.

**Build:** the `Dockerfile` (`node:24`, `npm ci`, `npm run build`; `prisma` CLI kept for the deploy-time migration).

| Service | Start command | Health / exposure |
|---|---|---|
| `api` | `npx prisma migrate deploy && node --enable-source-maps dist/api/main.js` | public; healthcheck path **`GET /health`** (load-shed-exempt) |
| `worker` | `node --enable-source-maps dist/jobs/worker.js` | **portless private service — no public domain, no HTTP healthcheck** |

Migrate-on-API-start is safe only because there is a single `api` instance; if it ever scales horizontally the
migration moves to a release/pre-deploy phase first (documented in `ARCHITECTURE.md`).

### Environment (names only — Dave sets the values in Railway)

Shared (both services): `DATABASE_URL` (pooled primary) · `DATABASE_READ_URL` (pooled replica) ·
`DATABASE_DIRECT_URL` (unpooled, migrations only) · `REDIS_URL` (private Railway Redis) · `STRIPE_SECRET_KEY` ·
`TRAFFIC_PROFILE` (`default`) · `SENTRY_DSN` (optional — error tracking; unset ⇒ Sentry no-ops and the server still boots).

API only: `STRIPE_WEBHOOK_SECRET` · `ADMIN_API_KEY` · `TMDB_READ_TOKEN` · `PORT`.

Production tuning: `WAITING_ROOM_MAX_ACTIVE=100` (default 2 is a demo) · `MAX_IN_FLIGHT=250` (real knee set by
`load-tests/ramp.js`) · the other knobs stay at their defaults (`WAITING_ROOM_ENABLED` on,
`WAITING_ROOM_ADMIT_PER_MINUTE` 12, hold caps 8/16).

### Dave-run checklist

1. Create the Railway project ("matinee", EU West), link this repo.
2. Add **two services** (`api`, `worker`) from the repo/Dockerfile; set the start commands above. **The worker
   must have no public domain and no HTTP healthcheck.**
3. Set the environment variables (shared at the environment level, API-only at the API service).
4. Deploy. In the API boot log: `api_listening`, and **no `traffic_profile_loadtest`**, **no
   `waiting_room_demo_defaults`**.
5. **Post-deploy sanity:** confirm the **pg SSL deprecation warning is gone** from the log lines **and** the API
   connects to Neon with no certificate error (`/health` → 200). This is the first real connection — where
   `sslmode=verify-full` is proven.
6. Register the Stripe webhook (test mode): `https://<deployed-api>/webhooks/stripe`, event
   `payment_intent.succeeded`; the signing secret Stripe shows becomes `STRIPE_WEBHOOK_SECRET`.
7. Prove client-IP resolution against the real edge:
   `bash docs/evidence/traffic-5c/verify-client-ip.sh https://<deployed-api> spoof` (→ 429 at/before request 41),
   then `… share` from a second network (→ 400). Save output as `docs/evidence/traffic-5c/railway-edge-check.txt`.
8. **Last:** the k6 re-run. Temporarily set `TRAFFIC_PROFILE=loadtest` on the API, run the seed + the two scripts
   against `https://<deployed-api>` (`seat-contention.js`, then `waiting-room.js` with `WAITING_ROOM_ENABLED=true
   WAITING_ROOM_MAX_ACTIVE=5`), **revert `TRAFFIC_PROFILE=default` immediately**, and **verify the revert in the
   log** (no `traffic_profile_loadtest`, no `waiting_room_demo_defaults` after the redeploy). Run once — it
   consumes the Neon free-tier budget. Rate limiting is proven separately by step 7, not the k6 run.

## Docs

- `docs/RULES.md` — every requirement, as a checklist
- `docs/ARCHITECTURE.md` — the production topology and deploy-time constraints
- `docs/TRAFFIC.md` — the traffic-management write-up
- `docs/SHARDING.md` — the sharding plan (plan only)
- `docs/decisions/` — architecture decision records
- `docs/evidence/` — evidence captured per slice
- `AGENTS.md` — how AI agents work in this repo

## Still to write

Key decisions · app store billing rules (Apple/Google in-app purchase) · what I'd do next · Sentry (app + server)

## Attribution

This product uses the TMDB API but is not endorsed or certified by TMDB.

## Licence

MIT
