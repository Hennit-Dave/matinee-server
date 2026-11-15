# Handoff: Cinemas & showtimes (branch `feat/cinemas-showtimes`)

## What changed
- **Prisma schema & migration (`prisma/schema.prisma`, `prisma/migrations/20261115000000_cinemas_screens_showtimes/`):**
  - Added `Cinema`, `Screen` (with `totalSeats`), and `Showtime` (`movieId` plain `Int` with no FK, `startsAt` `Timestamptz(3)`, `priceCents` integer minor units, `@@unique([screenId, startsAt])`, `@@index([movieId, startsAt])`).
  - Added `prisma.config.ts` reading `DATABASE_DIRECT_URL` (unpooled Neon primary) for Prisma Migrate DDL, and added `DATABASE_DIRECT_URL=` to `.env.example`.
- **Showtimes contract & service (`src/showtimes/showtime.ts`, `src/showtimes/service.ts`):**
  - Added `GET /movies/:id/showtimes` in `src/movies/routes.ts`, wired through `src/api/app.ts` and `src/api/main.ts`.
  - Routes reads to `db.reader.$replica()`. Returns `200` with `cinemas: []` when a movie has no upcoming showtimes. Not cached in Redis.
  - Groups rows `cinema -> date -> showtimes` with server-formatted `priceFormatted`.
- **Idempotent seed (`src/showtimes/seedPlan.ts`, `src/db/seed.ts`):**
  - Added `npm run db:migrate` and `npm run db:seed`.
  - Seeds 3 cinemas, 5 screens (including 320-seat `bfi-southbank-imax` as the load-test target), and 7 days of UTC slots across all current TMDB `nowPlaying(1)` movie IDs, keyed on `(screenId, startsAt)`.
- **CI & ADR (`ci.yml`, `docs/decisions/0010-cinemas-showtimes-schema-and-seed.md`):**
  - Updated `.github/workflows/ci.yml` to run `npx prisma migrate deploy` and `npm run test:integration` against the ephemeral `postgres:17` service container (deterministic fake movie IDs; zero TMDB calls in CI).
  - Wrote ADR 0010.

## What passed
- `npm run typecheck`
- `npm run lint`
- `npm test` (72 passed, 0 failed; 3 Postgres/Redis integration tests skipped locally without `TEST_DATABASE_ALLOWED=true`)
- `gitleaks detect --no-banner` (16 commits scanned, no leaks found)

## Unproven locally
- Live `prisma migrate deploy` and `npm run db:seed` against Dave's Neon database (intentionally left for Dave to run after setting `DATABASE_DIRECT_URL` in `.env`).
- CI will prove `prisma migrate deploy` + `showtimes.integration.test.ts` against the ephemeral `postgres:17` service container on PR push.

## Next
- **Dave:** Add `DATABASE_DIRECT_URL` (unpooled Neon host) to `matinee-server/.env`, then run `npm run db:migrate && npm run db:seed` after squash-merging.
- **Slice 4c (mobile):** Mirror `MovieDetail` and `MovieShowtimesResponse` in `matinee-mobile` and build the Movie detail + Showtimes screens.
