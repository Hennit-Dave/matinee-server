# Handoff: Seat map, server side (branch `feat/seatmap-server`)

Server PR of two. The mobile PR (`feat/seatmap`, "Pick your seats") starts after this merges, because it mirrors this contract.

## What changed
- **Schema and migration (`prisma/schema.prisma`, `prisma/migrations/20261116000000_seats/`):** new `Seat` model (`id` uuid, `screenId` FK to `Screen` with `onDelete: Cascade`, `row`, `number`, `kind`) with `@@unique([screenId, row, number])`. Seats belong to the screen, not the showtime. The migration only adds the `seats` table, its unique index and the FK; no existing table or row is touched. SQL generated with `prisma migrate diff`.
- **Layouts and seed (`src/showtimes/seatLayout.ts`, `seedPlan.ts`, `src/db/seed.ts`):**
  - Each seeded screen has a `layout` (rows x seats per row). `bfi-southbank-imax` is **16 rows A-P x 20 = 320** (the Figma "300+" layout, not the brief's 20x16 example). Others: 120 = 10x12, 84 = 7x12, 180 = 10x18, 140 = 10x14. Wheelchair spaces at both outer ends of the back row. `buildSeatGrid` throws if a layout does not multiply out to `totalSeats`.
  - `seedSeats` is idempotent on `(screenId, row, number)` (batched `createMany` + a `kind` sync) and never deletes. `seedDatabase` now seeds seats too. `npm run db:seed -- --seats-only` seeds only seats (no TMDB token, no showtime or price row touched). No price or showtime code changed.
- **Endpoint (`src/showtimes/seat.ts`, `seatService.ts`, `seatRoutes.ts`, wired in `src/api/app.ts` and `main.ts`):** `GET /showtimes/:id/seats`, Zod-validated. Returns `showtimeId`, `movieId`, `startsAt`, `time`, `screen { id, name, format, totalSeats }`, `priceCents`, `priceFormatted` (`"£18.50"` via `formatPriceCents`), and `rows: [{ row, seats: [{ id, row, number, kind, status }] }]`. Malformed id: `400 validation_failed`. Unknown showtime: `404 not_found`. Read from the replica, not cached. Every `status` is `available` for now; `held` and `sold` are already in the contract.
- **Docs:** ADR `0014` (seat data model, availability from bookings and holds, the rendering decision for mobile), evidence under `docs/evidence/seatmap/`, a README section.

### Three additions to the brief's response shape (agreed in the plan)
`movieId`, `startsAt` and `time` (the header reads "Title · Sat 14, 20:00 · IMAX"), and `kind` on each seat (the design draws wheelchair spaces).

## What passed
- `npm run typecheck`
- `npm run lint`
- `npm test`: 111 tests, 107 pass, 0 fail, 4 skipped (the DB-gated integration tests, including the new one). 19 new tests pass: layout invariants, grouping and contract, and route behaviour (200, 404, 400, strict query).
- `gitleaks detect`: 23 commits scanned, no leaks found.
- `npm run test:integration`: 4 of 4 pass against a **throwaway local PostgreSQL 16** (fresh cluster, migrations applied with `prisma migrate deploy`, every DB variable set inline, `.env` not loaded). The new test covers the seed (844 seats, no duplicates on re-run, a drifted `kind` converges), the real endpoint (320 seats = `totalSeats`, 16 rows, `£18.50`, 404) and a screen with no seats (`rows: []`).
- Real API process (`src/api/main.ts`) against that database: 200 in 34.7 KB with 320 seats, 404, 400, route template in the log lines. Saved in `docs/evidence/seatmap/`.
- `--seats-only` proof: seats 0 to 844 while the checksums of all cinemas, screens and 105 showtimes were identical before and after; a second run is a no-op.

## Unproven
- **Neon.** I did not touch it. The migration and seed have not been run there (see Next). The 4b slice also left this to you.
- **PostgreSQL 17.** I verified on 16; CI runs 17 and will confirm on the PR.
- **Rendering performance.** ADR 0014's mobile approach (memoized cells under one transformed container) is chosen, not measured. The mobile slice measures it.

## Deferred (do NOT build here)
- Live Redis seat holds, the 2:00 hold countdown, seat-taken-by-another-user and hold expiry: traffic slice (Requirement 5, the load-test centrepiece). The one place that will change is `allSeatsAvailable` in `src/showtimes/seat.ts`.
- The running price total and Continue, through checkout, payment, booking, ticket and BullMQ jobs: payments slice (Requirement 4). The total will be server-calculated; the app never does money arithmetic.

## Next
- **Dave:** review CI on the PR, then squash-merge.
- **Dave, after the merge, on Neon** (needs `DATABASE_DIRECT_URL` in `.env`, as for the showtimes migration):
  1. `npm run db:migrate` (adds the `seats` table; existing data untouched)
  2. `npm run db:seed -- --seats-only` (adds 844 seats; touches no showtime or price)
  3. Run the query in `docs/evidence/seatmap/README.md` and check every row has `seats_stored = total_seats`.
  Until then the endpoint returns `rows: []` for every showtime.
- **Mobile slice notes** (for the next agent):
  - `rows: []` with `totalSeats > 0` is an error state, **not** "sold out". A sold-out showing is every seat non-available.
  - The aisle is drawn after seat `ceil(seatsPerRow / 2)`; it is not in the data.
  - `react-native-worklets` is installed at 0.13.1 but Expo SDK 58 pins 0.13.0. Reanimated already runs the Skeleton, so it is probably fine, but check the first gesture run for a JS/native version mismatch error.
