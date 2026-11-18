# Load tests (slice 5e)

k6 scripts that prove the headline requirement — a seat is never sold twice — and the waiting room,
against a **throwaway** Postgres and Redis (Dave's own services are never touched). The written report is
in [`REPORT.md`](REPORT.md).

## The two scenarios

| Script | What it proves | Server config |
|---|---|---|
| [`seat-contention.js`](seat-contention.js) | **500 VUs contend for the same 50 seats** (10 per seat), each hold → confirm. Pass = exactly 50 bookings, one per seat, zero duplicates, and ~450 clean `409 seat_taken` (no 5xx, no unexpected 4xx). | `TRAFFIC_PROFILE=loadtest` |
| [`waiting-room.js`](waiting-room.js) | **500 users against a small cap.** Exactly `WAITING_ROOM_MAX_ACTIVE` are admitted, the rest queue with distinct FIFO positions (`ahead_sum` = 122265 iff 0..494), and admission proceeds at the fixed rate. | `TRAFFIC_PROFILE=loadtest` **and** `WAITING_ROOM_ENABLED=true` `WAITING_ROOM_MAX_ACTIVE=5` |

## How to run (local throwaway stack)

```sh
# 1. Throwaway Postgres (54329) + Redis (6391), migrate, seed, pick the showtime + 50 seats.
bash load-tests/stand-up.sh

# 2. Build the server, then run it with the load-test profile (its own terminal). Port 3001 keeps it
#    clear of any dev server already on 3000.
npm run build
TRAFFIC_PROFILE=loadtest \
  DATABASE_URL="postgresql://matinee@localhost:54329/matinee" \
  DATABASE_READ_URL="postgresql://matinee@localhost:54329/matinee" \
  REDIS_URL="redis://localhost:6391" \
  TMDB_READ_TOKEN=loadtest-placeholder \
  PORT=3001 node dist/api/main.js

# 3. The headline scenario (the showtime id is in load-tests/params.json).
SHOWTIME_ID=$(node -e "console.log(require('./load-tests/params.json').showtimeId)")
k6 run --env BASE_URL=http://localhost:3001 --env SHOWTIME_ID="$SHOWTIME_ID" \
  --summary-export=docs/evidence/traffic-5e/summary-seat-contention.json \
  load-tests/seat-contention.js

# 4. The waiting-room scenario (room ON, cap 5, fixed rate 12/min).
TRAFFIC_PROFILE=loadtest WAITING_ROOM_ENABLED=true WAITING_ROOM_MAX_ACTIVE=5 WAITING_ROOM_ADMIT_PER_MINUTE=12 \
  DATABASE_URL="postgresql://matinee@localhost:54329/matinee" \
  DATABASE_READ_URL="postgresql://matinee@localhost:54329/matinee" \
  REDIS_URL="redis://localhost:6391" TMDB_READ_TOKEN=loadtest-placeholder \
  PORT=3001 node dist/api/main.js
k6 run --env BASE_URL=http://localhost:3001 --env SHOWTIME_ID="$SHOWTIME_ID" \
  --summary-export=docs/evidence/traffic-5e/summary-waiting-room.json \
  load-tests/waiting-room.js

# 5. Tear down.
bash load-tests/tear-down.sh
```

## The DB proof (no seat sold twice)

After the headline run, against the throwaway Postgres:

```sql
-- one row per seat, exactly 50
SELECT COUNT(*) AS total, COUNT(DISTINCT seat_id) AS distinct_seats
  FROM bookings WHERE showtime_id = '<showtimeId>';

-- no (showtime, seat) sold twice — must return ZERO rows
SELECT showtime_id, seat_id, COUNT(*)
  FROM bookings WHERE showtime_id = '<showtimeId>'
  GROUP BY showtime_id, seat_id HAVING COUNT(*) > 1;
```

## How k6 is obtained

`brew install k6` (already on Dave's machine), or run the same scripts in a container:
`docker run --rm -i -v "$PWD":/tests -v "$PWD":/tmp grafana/k6 run /tests/load-tests/seat-contention.js`.

The deploy slice re-runs these same scripts against the deployed Railway server (change only `BASE_URL`).
