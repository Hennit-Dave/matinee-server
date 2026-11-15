# Handoff: Screen format on showtimes (branch `feat/showtime-format`)

## What changed
- **Prisma schema & safe migration (`prisma/schema.prisma`, `prisma/migrations/20261115000001_screen_format/migration.sql`):**
  - Added `format String @default("Standard") @map("format")` to `Screen`.
  - Generated the migration via `prisma migrate diff --script`: `ALTER TABLE "screens" ADD COLUMN "format" TEXT NOT NULL DEFAULT 'Standard';` so `prisma migrate deploy` applies cleanly to the already-seeded Neon database without failing on existing rows.
- **Seed plan & upsert (`src/showtimes/seedPlan.ts`, `src/db/seed.ts`):**
  - Added `format` to `SeedScreen` and `SEED_SCREENS`:
    - `curzon-soho-1`, `curzon-soho-2`, `prince-charles-main` → `"Standard"`
    - `bfi-southbank-imax` → `"IMAX"`
    - `bfi-southbank-nft1` → `"Dolby Atmos"`
  - Carried `format` into both `update` and `create` of `primary.screen.upsert` in `src/db/seed.ts` so re-running `npm run db:seed` overwrites the temporary `"Standard"` default with the real formats.
- **Showtimes contract & tests (`src/showtimes/showtime.ts`, `src/showtimes/showtime.test.ts`, `src/showtimes/seedPlan.test.ts`, `src/showtimes/showtimes.integration.test.ts`, `src/movies/routes.test.ts`):**
  - Added `format: z.string()` to `ShowtimeSlotSchema`, `format: string` to `ShowtimeRow['screen']`, and `format: row.screen.format` in `groupShowtimesByCinemaAndDate`. Response shape remains `cinema -> date -> showtimes`.
  - Updated `docs/decisions/0010-cinemas-showtimes-schema-and-seed.md` to document `Screen.format`.

## What passed
- `npm run typecheck`
- `npm run lint`
- `npm test` (73 passed, 0 failed; 3 Postgres/Redis integration tests skipped locally without `TEST_DATABASE_ALLOWED=true`)
- `gitleaks git matinee-server` (17 commits scanned, no leaks found)

## Unproven locally
- Live `npm run db:migrate && npm run db:seed` against Dave's Neon database (nothing beyond re-running `db:migrate` + `db:seed` is needed).
- CI will prove `prisma migrate deploy` + `showtimes.integration.test.ts` against the ephemeral `postgres:17` service container on PR push.

## Next
- **Dave:** Squash-merge the PR, then run `npm run db:migrate && npm run db:seed` against Neon so existing screens receive their real `format` values (`IMAX`, `Dolby Atmos`, `Standard`).
- **Slice 4c (mobile):** Mirror the updated `ShowtimeSlot` (including `format`) in `matinee-mobile`.
