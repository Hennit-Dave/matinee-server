# ARCHITECTURE.md — Matinee server

How the server is put together and where it runs. The traffic story is `TRAFFIC.md`; the sharding plan is
`SHARDING.md`; every significant choice is an ADR in `docs/decisions/`.

## Topology (production, ADR 0007/0008/0009)

Everything runs in two places, kept close for latency:

- **Railway** (Hobby plan, EU West / Amsterdam) — two always-on services from this one repo:
  - `api` — the HTTP API. Public domain, `GET /health` as its healthcheck. Runs migrations on start, then serves.
  - `worker` — the BullMQ worker. **Portless private service: no public domain, no HTTP listener, no healthcheck.**
  - a **Redis service** (private, no public access) — seat holds, rate limits, the waiting room, and the BullMQ
    transport.
- **Neon** (AWS eu-west-2 / London) — the Postgres, with:
  - `DATABASE_URL` — the **primary**, pooled `-pooler` host (runtime writes + primary reads),
  - `DATABASE_READ_URL` — the **read replica**, pooled `-pooler` host (replica reads),
  - `DATABASE_DIRECT_URL` — the **unpooled** primary host, used **only** by `prisma migrate deploy` (DDL).

The two services share one image (`Dockerfile`) and one set of environment variables; only the start command
differs (see the README's "Deploy" section).

## Request path

1. The app talks only to the API (never TMDB, never Stripe directly).
2. Reads route to the replica, writes to the primary; the caller's own recent writes read from the primary
   (read-your-own-writes, ADR 0015).
3. Stripe's `payment_intent.succeeded` webhook hits `POST /webhooks/stripe`; the API verifies the signature,
   records the event id, enqueues a BullMQ job and returns 200 fast; the **worker** does the confirm/refund
   against Postgres + Stripe (ADR 0019).

## A seat is never sold twice

Two independent layers (ADR 0015): a Redis hold decides who may **try**, and `UNIQUE (showtime_id, seat_id)`
decides who **owns**. Correctness fails closed (Redis down → `503 holds_unavailable`); capacity fails open
(rate limiter / waiting room let requests through on a Redis blip). See `TRAFFIC.md`.

## What is never cached

Payment status, webhook idempotency records (`processed_stripe_events`), and the append-only `ledger_entries`
live in Postgres only (RULES C4). Redis is the queue + the fast-path hold/limit store, never the money truth.

## Deploy-time constraints

- **Migrate-on-API-start is safe only because there is a single `api` instance.** `prisma migrate deploy` runs
  in the API's start command and is idempotent, but two instances booting at once would race the same migration.
  **If the API is ever scaled horizontally, move the migration to a release/pre-deploy phase** (or a one-shot
  migrate job) first. This is a hard constraint, not a silent assumption.
- **`sslmode=verify-full` is pinned in code** (`src/db/clients.ts`) for any non-loopback Postgres URL, so the
  Neon connection always verifies the server certificate and never emits node-postgres's SSL deprecation warning.
  Local/CI loopback URLs are left alone (no TLS listener there).
- **`TRAFFIC_PROFILE` must be `default` in production.** `loadtest` relaxes the per-address limits, the waiting
  room and the hold caps, and logs a loud boot warning — it exists only for the k6 runs (see `load-tests/`).

## The numbers (chosen, then measured)

| Setting | Value | Note |
|---|---|---|
| `PRIMARY_POOL_MAX` / `REPLICA_POOL_MAX` | 5 | 50 concurrent confirms at p99 22.9 ms (load test, `TRAFFIC.md`) |
| `WAITING_ROOM_MAX_ACTIVE` | 100 (production) | demo default is 2; 5e absorbed 500 concurrent with the room off |
| `MAX_IN_FLIGHT` | 250 (initial) | load-shedding cap; the real knee is set by `load-tests/ramp.js` |
| Hold caps | 8 / 16 per showing | ADR 0018 |
| Hold TTL | 10 min | ADR 0015 |

## What changes in production vs local

- Reads hit the real Neon replica (locally, `DATABASE_READ_URL` may point at the primary — ADR 0007's fallback).
- The client IP is resolved by address range (`src/http/clientIp.ts`), not a hop count, because Railway publishes
  no hop count; `docs/evidence/traffic-5c/verify-client-ip.sh` is the black-box proof against the real edge.
- The worker is a separate always-on process (locally, `npm run dev:worker` in a second terminal).
