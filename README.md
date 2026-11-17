# Matinee server

The API, background jobs and database behind Matinee, a cinema ticket booking app where a seat is never sold twice.

> GIF, Android download link and demo video link go here once they exist.

**Mobile app repo:** https://github.com/Hennit-Dave/matinee-mobile

## Status

Slice 0: an Express + TypeScript skeleton with a real `/health` (checks Postgres primary + replica
and Redis, 503 on failure), structured logging, request IDs and a Zod validation helper.
Slice 1: the movie endpoints below (TMDB through this server, cached in Redis). Showtimes and the
seat map are built (see "Seat map endpoint"); seat holds and bookings are built (see "Seat holds and
bookings"), without payments, and rate limiting guards the busy routes (see "Rate limiting"). This README is
written as the build goes.

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

After pulling this change, add the table and the seats: `npm run db:migrate`, then
`npm run db:seed -- --seats-only` (seats only: no TMDB token needed, no showtime or price touched).
A plain `npm run db:seed` also seeds seats.

## Seat holds and bookings

A seat is never sold twice. Two layers, each testable alone (ADR 0015): a Redis hold decides who may *try*,
and Postgres `UNIQUE (showtime_id, seat_id)` on `bookings` decides who *owns* the seat, even if Redis is
empty, wrong or down.

| Route | Does | Success | Refusals |
|---|---|---|---|
| `POST /showtimes/:id/holds` `{ seatIds }` | Holds the seats for **10 minutes**, all or nothing | `201 { showtimeId, seatIds, expiresAt, expiresInMs }` | `409 seat_taken { seatIds }` (the seats it could not get), `503 holds_unavailable` |
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
- `POST /showtimes/:id/bookings` is a **temporary** direct commit with no payment step; the payments slice
  replaces it with the verified-webhook job (ADR 0015). It is the only way to book today.
- Needs the migration: `npm run db:migrate` adds `bookings` (a new table only; no existing row changes).

Proof is in `docs/evidence/traffic-5a/`: the tests, a narrated run (`proof.txt`), five deliberate breakages of
the guarantee that the tests catch (`mutation-checks.txt`), and the race this prevents (`race-demo.txt`: 50 users,
one seat, no constraint, sold 50 times).

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
- `X-Client-Id` is optional on search and the seat map: without one, only the address is counted.
- **Client address behind a proxy**: trusted by address range (loopback, private ranges, `100.64.0.0/10`), not by a
  hop count, because Railway publishes none (`src/http/clientIp.ts`). If only a proxy hop is visible, the address
  counter is skipped and a `client_ip_unresolved` warning is logged. **Not yet verified against the real Railway
  edge: run `docs/evidence/traffic-5c/verify-client-ip.sh` against the deployed API in the deploy slice.**
- Every number is chosen, not measured (`src/ratelimit/policies.ts`); the load test (slice 5e) tunes them.
- No new environment variable, dependency or migration. Proof is in `docs/evidence/traffic-5c/`.

## Docs

- `docs/RULES.md` — every requirement, as a checklist
- `docs/decisions/` — architecture decision records
- `docs/evidence/` — evidence captured per slice
- `AGENTS.md` — how AI agents work in this repo

## Still to write

Architecture summary · key decisions · app store billing rules (Apple/Google in-app purchase) · what I'd do next

## Attribution

This product uses the TMDB API but is not endorsed or certified by TMDB.

## Licence

MIT
