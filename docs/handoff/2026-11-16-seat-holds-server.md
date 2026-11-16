# Handoff: Seat holds and the no-double-booking guarantee (branch `feat/seat-holds`)

Slice 5a of the traffic chapter, server only. Mobile wiring is 5b. Plan approved by Dave with one change: the hold window is **10 minutes (600 s)**, the AGENTS.md section 7 default, so there is no TTL deviation. The start value was checked on the Figma frames: the `Countdown` component (`37:819`) and the Zoomed frame (`57:7114`) both read `9:58 left`; the "Hold under 2:00" frame (`57:9738`) reads `1:59`.

## What changed
- **`Booking` model and migration (`prisma/migrations/20261116000001_bookings/`):** one row per sold seat, `UNIQUE (showtime_id, seat_id)`, foreign keys `Restrict` (a sale cannot vanish by cascade), `reference` groups seats confirmed together, `owner_id` is the stand-in client id, `price_cents` is the per-seat price at booking time. The migration only creates the new table: row counts and an md5 of every row in `cinemas`, `screens`, `seats` and `showtimes` are identical before and after (`docs/evidence/traffic-5a/migration.txt`), and `prisma migrate diff` reports no drift.
- **Hold store (`src/bookings/holdStore.ts`, `redisGuard.ts`):** key `hold:{<showtimeId>}:<seatId>` holding the owner id, 10-minute TTL. Acquire is **one Lua script** for the whole request (`SET NX PX` per seat; if any seat is taken the script removes the keys it just set before returning, so nothing partial is ever visible). Asking again for your own seats succeeds without restarting the timer. Release is a Lua **compare-and-delete**. Every call runs through `failClosed`: connection not ready, a Redis error, or no answer within 1 s is a refusal (`HoldsUnavailableError`), never a guess.
- **Services and routes (`src/bookings/bookingService.ts`, `bookingRepo.ts`, `routes.ts`, `booking.ts`):**
  - `POST /showtimes/:id/holds`, `DELETE /showtimes/:id/holds`, `POST /showtimes/:id/bookings`, each Zod-validated (params, body, and the `X-Client-Id` header), 1 to 8 unique seat ids, every seat must belong to the showtime's screen.
  - Taking a hold: validate, take the Redis hold, **then** check the primary for sold seats (and give the hold back if any). That order closes the gap in which a booking could commit between a check and a hold.
  - Confirming: check the caller holds every seat, then **one multi-row INSERT** (all or nothing). A unique-key refusal is `409 seat_taken` naming the seats, never a 500. The hold is left to expire on its own.
  - New errors: `seat_taken` and `seat_not_held` (409, carry `seatIds`), `holds_unavailable` (503, `Retry-After: 2`).
- **Seat map (`src/showtimes/seat.ts`, `seatService.ts`, `seatRoutes.ts`):** `status` now takes all three values, **sold wins over held**. Held seats come from Redis on every request (never cached). Sold seats come from the replica, except for 5 s after the caller's own booking, when they come from the primary (read-your-own-writes, a Redis key with a TTL). With Redis unreachable the map is a `503`. The response shape is unchanged.
- **`X-Client-Id` (`src/http/clientId.ts`):** required on the three write routes, optional on `GET /seats`. A UUID, lower-cased, validated by Zod. A stand-in for a user id until auth exists; it is a bearer value, not authentication.
- **Logging:** the logger gains `userId`, `showtimeId` and `seatCount`; the request line carries `userId`; `hold_acquired`, `hold_rejected`, `hold_released`, `booking_confirmed`, `booking_rejected` and `redis_unavailable` events, so "what happened to this user's booking at 3:14pm?" can be answered from the logs.
- **Docs:** ADR `0015` (the two layers, hold at checkout, the 10-minute window, fail closed, read-your-own-writes, the stand-in, the temporary route), an addendum to ADR `0014` (sold seats may be read from the replica; amended by 0015), a README section, and evidence under `docs/evidence/traffic-5a/`.

## What passed
- `npm run typecheck` and `npm run lint`: clean.
- `npm test`, no database set (as on a plain machine): **177 tests, 155 pass, 0 fail, 22 skipped** (the DB- and Redis-gated integration tests). The tests added on top of `main`'s 111 are unit tests with in-memory fakes: the hold store's script arguments and fail-closed rules, the service logic, the routes' validation and error envelopes, the seat map's three sources, the client-id middleware.
- `npm run test:integration` against a **throwaway local PostgreSQL 16 and a throwaway local Redis 8** (own ports, `.env` not loaded): **23 of 23 pass**, run twice with nothing left behind. The 19 new ones include:
  - 200 users on one seat: exactly one wins, 199 get `seat_taken` (and 30 over HTTP: one 201, 29 409s; `proof.txt` runs 100 over HTTP).
  - Overlapping multi-seat holds: no partial hold survives.
  - Release only works for the owner; confirm without a hold, with someone else's hold, or after expiry writes nothing.
  - The unique key alone: 50 confirms with the Redis check bypassed give exactly one row and no 500; a hold lost between check and insert cannot double-book.
  - Read-your-own-writes against a second database that never hears about the booking.
  - Redis not ready, and Redis connected but not answering: `503`, never a hang, and a retry is safe.
- **The tests can fail.** `docs/evidence/traffic-5a/mutation-checks.txt` breaks the guarantee five ways (drop the unique key, GET-then-SET instead of the script, plain `DEL` on release, hold outranking sold, ignoring read-your-own-writes); each is caught, then reverted. (My first record of this had a bad restore step and was redone; the file in the PR is the clean run.)
- The baseline commit has the same suite **red** (`before.txt`) and a demo of the problem (`race-demo.txt`): 50 users, one seat, check-then-insert with no constraint sold it **50 times**; with the constraint, once.
- `EXPLAIN` on 8,862 booking rows: the sold-check and the map's sold read both use `bookings_showtime_id_seat_id_key`, so no extra index (`explain.txt`).
- `gitleaks detect`: no leaks.

## Unproven
- **Neon.** Not touched. The `bookings` migration has not been run there (see Next). **The seat map now reads `bookings`, so once this code is deployed against a Neon without the table, `GET /showtimes/:id/seats` returns 500 and the hold and booking routes fail too.** The migration only adds a table the current code ignores, so it is safe to run before the merge.
- **The k6 load test.** Not written (5e). The 100-client HTTP storm and the 200-user service-level storm are local and prove correctness, not capacity. The HTTP storm stops at 100 because macOS caps the listen backlog at 128 sockets (a client limit, not the app's).
- **Capacity numbers.** The 1 s Redis deadline, the 5 s read-your-own-writes window and `PRIMARY_POOL_MAX = 5` are chosen, not measured. A winner's hold costs one Redis script, one replica read and one primary read; 5e measures whether the pool of 5 holds up.
- **Real replica lag.** Neon's replica was not involved; the lag is simulated with a database that never receives bookings.
- **Railway Redis.** Never touched by tests (they refuse any non-loopback Redis). Its behaviour under real latency and its Lua support are assumed from Redis 7+, not observed.
- **PostgreSQL 17.** Verified on 16; CI runs 17.

## Deferred (do NOT build here)
- Mobile: Continue to hold, the live 2:00 countdown, and short-polling the seat map: **5b**.
- Rate limiting per user and per IP, and the per-owner hoarding cap: **5c**. Waiting room and graceful overload: **5d**.
- The k6 500-user / 50-seat load test, `TRAFFIC.md`, `SHARDING.md`: **5e**.
- Real Stripe checkout, the verified webhook, BullMQ, QR tickets, cancellations and refunds (these need a status column and a partial unique key), and the late-webhook-after-expiry ADR (RULES D4.9): **the payments chapter**.

## Next
- **Dave, BEFORE you squash-merge, on Neon** (needs `DATABASE_DIRECT_URL` in `.env`): `npm run db:migrate`. It adds the `bookings` table and nothing else (existing rows untouched; the code on `main` ignores the table, so running it early is harmless). Do it first: if Railway deploys on merge, the new code would otherwise meet a database with no `bookings` table. No seed change, no new environment variable.
- **Dave:** review CI on the PR, then squash-merge.
- **5b (mobile) notes:**
  - Send `X-Client-Id` (a UUID generated once per install, kept in `expo-secure-store`) on the hold, release and booking calls, and on `GET /seats` so the booker sees their own booking at once.
  - Count down from `expiresInMs` plus the time the response arrived, not from `expiresAt` (device clocks lie). The window starts at 10:00; the Countdown turns urgent strictly under 2:00.
  - `409 seat_taken` carries `seatIds`: those seats are gone, refresh the map. `409 seat_not_held` means the hold ran out. `503 holds_unavailable` carries `Retry-After` and is safe to retry.
  - Your own held seats come back as `held` on the map; "yours" is client state.
  - `POST /showtimes/:id/bookings` is temporary and has no payment step: it is how 5b can show a booking until payments land.
- Close the chat and write your `LEARNING-LOG.md` paragraph (your words only).
