# 0010 — Cinemas & showtimes schema, idempotent seed, and pooling/directUrl split

Date: 2026-11-15 · Status: accepted · Decided by: Dave

## Problem

Slice 4b introduces Matinee's first Postgres tables (`Cinema`, `Screen`, `Showtime`) and the
`GET /movies/:id/showtimes` endpoint. Four design questions need explicit decisions:

1. **Movie reference:** Movies live in TMDB, not Postgres. Should `Showtime.movieId` have a local
   `movies` mirror table and foreign key, or be stored as a plain integer?
2. **Money & capacity:** How should showtime prices and screen capacity be stored before the SeatMap
   and Payments slices land?
3. **Seed strategy:** How do we keep Browse -> Movie detail -> Showtimes coherent without duplicating
   rows when re-running the seed?
4. **Pooling vs. migrations:** Runtime queries use Neon `-pooler` endpoints (`DATABASE_URL` and
   `DATABASE_READ_URL`, `max: 5`), while Prisma Migrate DDL breaks on PgBouncer transaction mode.

## Decision

1. **`Showtime.movieId` is a plain `Int` with no foreign key.**
   Movies are owned by TMDB and cached in Redis; Postgres does not maintain a `movies` table.
   An index `@@index([movieId, startsAt])` keeps per-movie showtime queries fast.
2. **`priceCents` is a whole integer in minor units; `Screen.totalSeats` holds capacity only; `Screen.format` holds projection/audio format.**
   Follows RULES A3 (no floats/decimals for money). The server formats `priceFormatted` (e.g.
   `"£15.50"`) so the mobile app never performs money arithmetic. Seat layouts stay out of this slice.
   `Screen.format` (`Standard`, `IMAX`, `Dolby Atmos`) is surfaced on each showtime slot to match the Showtimes design.
3. **Repeatable, idempotent seed keyed on natural keys (`id` and `(screenId, startsAt)`).**
   - `prisma/schema.prisma` enforces `@@unique([screenId, startsAt])` on `Showtime`.
   - `src/db/seed.ts` fetches current TMDB `nowPlaying(1)` IDs (dev/Neon seed only; CI integration
     tests pass deterministic fake IDs with zero network calls) and upserts 3 fixed cinemas, 5 screens
     (including a 320-seat `bfi-southbank-imax` load-test target), and 7 days of fixed UTC slots.
   - Every current now-playing movie receives at least one showtime via round-robin assignment.
4. **Pooled runtime (`max: 5`) + `DATABASE_DIRECT_URL` for migrations.**
   - `src/db/clients.ts` keeps `PRIMARY_POOL_MAX = 5` and `REPLICA_POOL_MAX = 5` on Neon `-pooler`
     hosts, leaving headroom on the free-tier Neon project for workers and migrations.
   - `GET /movies/:id/showtimes` routes reads to `db.reader.$replica()` and is intentionally **not**
     cached in Redis so upcoming live seat-availability slices never serve stale showtime state.
   - `prisma.config.ts` reads `DATABASE_DIRECT_URL` (unpooled Neon primary) for `prisma migrate deploy`.

## Consequences

- **Easier:** Re-running `npm run db:seed` updates prices/movies cleanly without duplicates; CI runs
  `prisma migrate deploy` + integration tests against an ephemeral `postgres:17` service container.
- **Harder:** Developers running migrations locally against Neon must set `DATABASE_DIRECT_URL` in `.env`.
- **Revisit when:** Seat layouts (`Seat` / `Booking`) land in Slice 5 and reference `Showtime.id`.

## Addendum — 2026-11-16

Display currency is **GBP** (the cinemas are in London). `priceFormatted` renders pounds with a `£` symbol
(`1550` -> `"£15.50"`). The stored values are unchanged: `priceCents` still holds whole integer minor units
(pence now, cents before), and no row, seed value or migration changed. The field keeps the name `priceCents`;
renaming it to `pricePence` would need a database migration and is out of scope. The charge currency for
payments is recorded in ADR 0001's addendum.
