# 0014 — Seat data model, seats endpoint, and seat-map rendering

Date: 2026-11-16 · Status: accepted · Decided by: Dave

## Problem

Seat selection is the keystone of the booking flow: holds, the waiting room, payments and the load test all sit on top of it. Five questions need an explicit answer before any of that is built:

1. **Where do seats live?** Per screen (the room), or copied per showtime?
2. **How will per-showtime availability be answered later?** (booked, held, free)
3. **What does the seats endpoint return**, and how does it stay stable when availability arrives?
4. **What does the seed build**, given the 320-seat load-test screen?
5. **How does the app draw 320 seats** smoothly, with zoom? (RULES D3.5: a rendering approach decided early, reason written down.)

## Options

1. **Seats per showtime** (a row per seat per showtime, with a status column). Availability is one table read, but every showtime creates a full copy of its room: 320 rows for each IMAX showing, 105 showtimes seeded this week alone, and a layout fix means rewriting all of them.
2. **Seats per screen, availability layered on top.** One row per physical seat. Whether it is free for a given showtime is answered by bookings and holds, not stored on the seat.
3. **Rendering, three candidates:** (a) a virtualised list of rows; (b) a Skia canvas; (c) plain memoized views inside one transformed container.

## Decision

1. **Seats belong to the `Screen`.** `Seat(id, screenId -> Screen, row, number, kind)` with `@@unique([screenId, row, number])` and `onDelete: Cascade`. A room's chairs do not change between showings, so there is one copy per room (844 rows for the five seeded screens), not one per showtime. The unique key leads with `screenId`, so it also serves every lookup by screen and the foreign key; a separate index would be redundant.
2. **Availability comes from bookings and Redis holds, in the traffic slice.** A later `Booking` table references `Seat` and `Showtime` with `UNIQUE (showtime_id, seat_id)` (RULES D5.2, the safety net that makes double booking impossible), and live holds are Redis `SET NX PX` keys (AGENTS.md section 7). The seat read model asks both. When that lands:
   - availability is read from the **primary** and Redis, **never from the replica and never from a cache** (RULES C4: seat availability is never cached in a way that could sell a seat twice);
   - only the layout (this endpoint's rows and seats) stays replica-readable.
3. **`GET /showtimes/:id/seats`** returns the showtime (`showtimeId`, `movieId`, `startsAt`, `time`), the screen (`id`, `name`, `format`, `totalSeats`), the per-seat price (`priceCents` and `priceFormatted`, e.g. `"£18.50"`, built by `formatPriceCents`, so the app never does money maths), and `rows: [{ row, seats: [{ id, row, number, kind, status }] }]`.
   - **`status` is `'available' | 'held' | 'sold'` from day one**, so the traffic slice adds no contract change. Today every seat is `'available'`. The only code that decides status is one `SeatStatusResolver` (`src/showtimes/seat.ts`); the traffic slice replaces it. "Yours" (selected) is client-only state and never appears here.
   - **`kind` is `'standard' | 'wheelchair'`**, because the design draws wheelchair spaces. A string column (like `Screen.format`), validated by the Zod contract at the edge.
   - **The centre aisle is a rendering convention, not data.** The app draws it after seat `ceil(seatsPerRow / 2)`; every seeded layout has an even row length so it is exactly in the middle. If irregular rooms are ever needed, add a `col` (physical column) to `Seat` and the contract.
   - A malformed id is `400 validation_failed`; a well-formed id that matches no showtime is `404 not_found`. A showtime whose screen has no seats yet (the table exists but has not been seeded) is `200` with `rows: []` and the real `totalSeats`: the app must treat that as an error, not as "sold out".
   - Not cached in Redis, read from the replica (layout only, see 2).
4. **The seed follows the Figma layouts.** The load-test screen `bfi-southbank-imax` is **16 rows (A-P) x 20 seats = 320**, with the centre aisle after seat 10, exactly as the "300+" frame draws it. The others keep their `totalSeats`: 120 = 10 x 12, 84 = 7 x 12, 180 = 10 x 18, 140 = 10 x 14. Wheelchair spaces sit at both outer ends of the back row and count toward `totalSeats`. `buildSeatGrid` throws if a layout does not multiply out to `totalSeats`, so a map can never disagree with its capacity. Seeding is idempotent on `(screenId, row, number)` (batched `createMany` with `skipDuplicates`, plus a `kind` sync), changes no price or showtime, and never deletes a seat. `npm run db:seed -- --seats-only` seeds only seats: it needs no TMDB token and touches no cinema, screen or showtime row.
5. **Rendering: memoized seat cells inside one transformed container.**
   - Each seat is a `React.memo` view with primitive props, so selecting one seat re-renders one cell, not 320.
   - Zoom and pan are a single Reanimated transform on the container, driven by `react-native-gesture-handler` pinch and pan, so a gesture runs on the UI thread and triggers no React render. The three levels (overview, overview 300+, zoomed) are derived from room size and zoom, and the app re-renders only when zoom crosses a level threshold.
   - Taps are one container-level gesture that finds the nearest seat by arithmetic, not 320 touchables. That also implements the "nearest centre wins" hit rule in COMPONENTS.md.
   - **Why not the alternatives:** a virtualised list cannot zoom or pan in two dimensions, and 320 simple views do not need virtualising. Skia would be a new native module and so a new EAS build (limited credits, AGENTS.md section 3) for a problem that views solve. `react-native-gesture-handler` (3.3.0) and `react-native-reanimated` (4.7.1) are already installed, match Expo SDK 58's bundled native module list, and so need no new EAS build.
   - **Not yet measured.** This is chosen, not proven; the mobile slice measures it on a device or emulator and records the result. If 320 views are not smooth on mid-range Android, the fallback is to draw the seat grid as one `react-native-svg` element and keep the same container and gestures.

## Consequences

- **Easier:** one row per physical seat; a layout correction is one migration or seed run. The load test has a real 320-seat room. The traffic slice changes one resolver and adds `Booking`, not the contract.
- **Harder:** availability needs a join (bookings) plus Redis for every showtime request once it lands, so that endpoint will be the hot one under the 500-user load test. Its cost is a traffic-slice concern.
- **Accepted:** the full IMAX response is about 35 KB of JSON (320 seats with ids). Compression is a deployment decision, not made here.
- **Revisit when:** the traffic slice lands (replace `allSeatsAvailable`), or a screen needs an irregular layout (add `col`).
