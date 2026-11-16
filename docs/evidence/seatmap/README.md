# Evidence: seat map (slice 5, server)

What this proves: the `seats` table exists after the migration, the seed fills every screen with exactly `totalSeats` seats, the seats-only seed touches nothing else, and `GET /showtimes/:id/seats` serves the real 320-seat IMAX map from Postgres (RULES A4: the correct rows exist **and** are served).

| File | What it shows |
|---|---|
| `db-seat-counts.txt` | Seats stored per screen vs `total_seats`; the 2 wheelchair spaces in the IMAX screen; and a before/after checksum proving `--seats-only` changed no cinema, screen or showtime row (seats 0 to 844). |
| `endpoint-checks.txt` | A summary of the 200 response, plus the 404 and 400 responses and their request log lines. |
| `endpoint-imax-seats.json` | The full 200 response for the 320-seat IMAX showtime (about 35 KB). |

## How it was produced

A throwaway PostgreSQL 16 cluster on `127.0.0.1:54329` (CI uses 17), created fresh and deleted afterwards. All three migrations were applied with `prisma migrate deploy`, the integration suite was run, then the API (`src/api/main.ts`) was started and queried with `curl`. Every database variable was set inline; `.env` was not loaded. **No Neon database was touched.**

The showtimes in these files use fake TMDB ids (`900001` and so on) from the integration seed, not real films.

## Not shown here (and why)

- **Neon.** The migration and the seats-only seed are run on Neon by Dave after the merge (see the handoff note). Capture the real numbers there afterwards with this query (every row must have `seats_stored = total_seats`):

  ```sql
  SELECT s.id AS screen, s.total_seats, count(st.id) AS seats_stored,
         count(st.id) FILTER (WHERE st.kind = 'wheelchair') AS wheelchair,
         count(DISTINCT st.row) AS rows
  FROM screens s LEFT JOIN seats st ON st.screen_id = s.id
  GROUP BY s.id, s.total_seats ORDER BY s.id;
  ```
- **The UI.** This is the server slice; the mobile PR captures the seat map on a device or emulator.
