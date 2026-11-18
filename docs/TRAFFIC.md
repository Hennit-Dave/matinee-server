# TRAFFIC.md — traffic management in Matinee

The headline requirement, and the whole point of this document: **a seat is never sold twice.** Everything
here exists to make that true under load and to keep the server answering quickly when the load is real.

## The guarantee, in one sentence

Two independent layers decide who gets a seat: **Redis holds** decide who may *try*, and a **Postgres
`UNIQUE (showtime_id, seat_id)`** decides who *owns* it — so a seat cannot be sold twice even if Redis is
empty, wrong or down (ADR 0015). The k6 test (slice 5e) proves it: 500 users, 50 seats, **50 bookings, 50
distinct seats, 0 duplicates, 450 clean `409 seat_taken`**.

## The layered defence

| Layer | Protects | ADR | Fails |
|---|---|---|---|
| **Seat holds** (`SET key token NX PX`, one atomic Lua step) | who may *try* to book — correctness | 0015 | **closed** |
| **`UNIQUE (showtime_id, seat_id)`** | who *owns* the seat — correctness, the final guard | 0015 | n/a (the DB) |
| **Hold caps** (8/install, 16/address per showing) | one caller cannot hold a whole room | 0018 | **closed** |
| **Waiting room** (cap + fixed-rate admission) | how many choose seats for one showing at once | 0017 | **open** |
| **Rate limiting** (sliding window, per install + per address, in Redis) | capacity and abuse | 0016 | **open** |
| **Load shedding** (`MAX_IN_FLIGHT`, jittered `Retry-After`) | an overloaded server says so quickly | 0017 | n/a |

**Fail-open vs fail-closed is a deliberate split** (ADR 0016's table, extended by 0017/0018):

| | Seat holds | Hold caps | Rate limiter | Waiting room |
|---|---|---|---|---|
| Protects | who owns a seat | one person holding a room | capacity | capacity |
| Redis error / not ready / no answer | **refuse** (503) | **refuse** (with the holds) | let through | let through |
| Deadline on one Redis call | 1 s | 1 s | 150 ms | 150 ms |
| Why | a wrong guess about who holds a seat costs more than a refusal | same | if the protector breaks and we refuse everything, a Redis blip becomes an outage | same, and a full outage refuses seats anyway |

So: **correctness fails closed, capacity fails open.** Redis down means nothing can be booked (holds answer
`503 holds_unavailable`) but search and reads still work.

## The concurrency model

- **Take a hold** is one atomic Lua script: `SET NX PX` per seat, all-or-nothing (ADR 0015). Asking again for
  seats you already hold is free and does not restart the timer, so retries are safe.
- **Release a hold** is compare-then-delete (Lua), never a plain `DEL` (RULES D5.8).
- **Confirm** (`POST /bookings`) checks you still hold every seat, then does **one multi-row INSERT** — all
  seats or none. A unique-key refusal is a clean `409 seat_taken`, never a 500.
- **Read-your-own-writes:** sold seats are read from the replica, except for 5 s after your own booking, when
  they come from the primary (RULES C2). Held seats are never cached; every map read is fresh from Redis.

## The numbers (chosen, then measured)

| Setting | Value | Measured in 5e |
|---|---|---|
| Hold TTL | 10 min | — |
| Rate limits (per min) | hold 10/40, booking 5/20, seatsPoll 60/300, search 60/180, queue 60/600 | the limiter adds ~nothing: hold p50 1.15 ms with it on |
| Hold caps | 8 / 16 per showing | — |
| Waiting room | `MAX_ACTIVE` (demo 2 → raise for production), admit 12/min | 5 admitted / 495 queued under 500 users, sub-10 ms polls |
| `MAX_IN_FLIGHT` | 250 | not measured (the profile turns it off); conservative — see open items |
| Redis deadlines | 1 s (holds), 150 ms (limiter/room) | Redis answered ≪10 ms at p99; both generous |
| `PRIMARY_POOL_MAX` | 5 | 50 concurrent confirms at p99 22.9 ms, no timeouts — adequate |

The full latency picture: `POST /holds` p50 1.15 ms / p99 23.84 ms; `POST /bookings` p50 4.22 ms / p99
22.88 ms, at 500 concurrent users. Zero 5xx across both scenarios.

## Failure modes, written down

- **Redis down:** holds/caps fail closed (`503 holds_unavailable`), limiter/room fail open — so nothing is
  booked, search keeps working, and the seat map refuses rather than guess. A Redis that comes back *empty*
  still cannot double-book: two users can both "hold" a seat, and the second confirm hits the unique key.
- **Shared addresses** (a venue's wifi, carrier-grade NAT) can put more people behind one address than the
  address limits allow; they get a 429 with `Retry-After`, which the app already shows.
- **A locked phone** loses its waiting-room place after 90 s; a silent admitted user's pass lapses after 30 s;
  no pass outlives 20 min. No sweeper job — keys carry TTLs and vanish on their own.
- **Overload:** past `MAX_IN_FLIGHT` the server answers `503 server_busy` with a jittered `Retry-After` of
  5–15 s (never for `/health` or `DELETE`, the cleanup paths). The app shows "We're very busy right now".

## Proof

`docs/evidence/traffic-5e/` — the before/after of the 500/50 run, the waiting-room run, the DB query that
shows no seat sold twice, and the log analysis. The scripts and the written report are in `load-tests/`.

## Open items (deferred, on purpose)

- **Payments** (Stripe, webhooks, BullMQ) replace the direct `POST /bookings` commit; the late-webhook ADR is
  written before that case is tested. This test exercises the temporary direct commit, which is the durable
  `confirmBooking` unit that payments will call.
- **Re-running against Railway** — the deploy slice re-runs these scripts against the deployed server, sets a
  real `WAITING_ROOM_MAX_ACTIVE`, and runs `verify-client-ip.sh` against the real edge.
- **`MAX_IN_FLIGHT`** — find the real knee with a ramp test (shedding on) before trusting 250.
