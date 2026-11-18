#!/usr/bin/env bash
# Throwaway stack for the k6 load test (slice 5e): Postgres and Redis on their OWN ports, so Dave's
# own services (Postgres on 5432, Redis on 6379) are never touched. Everything lives under /tmp and is
# removed by tear-down.sh. Run from the repo root:
#
#   bash load-tests/stand-up.sh
#
# It migrates the real schema, seeds cinemas/screens/showtimes/seats with a fake movie id (no TMDB),
# and writes load-tests/params.json with the showtime id and 50 seat ids.
set -euo pipefail
cd "$(dirname "$0")/.."

PG_PORT="${PG_PORT:-54329}"
REDIS_PORT="${REDIS_PORT:-6391}"
PGDATA="${PGDATA:-/tmp/matinee-loadtest-pg}"
PG_DB="${PG_DB:-matinee}"
PGHOST="${PGHOST:-/tmp}"
PGUSER="${PGUSER:-matinee}"

export PGHOST PGPORT="$PG_PORT" PGUSER

# 1. Postgres (fresh cluster, trust auth, on /tmp socket + its own port).
if ! pg_isready -h "$PGHOST" -p "$PG_PORT" >/dev/null 2>&1; then
  rm -rf "$PGDATA"
  initdb -D "$PGDATA" -U "$PGUSER" --auth=trust --no-locale -E UTF8 >/dev/null
  pg_ctl -D "$PGDATA" -o "-p $PG_PORT -k /tmp" -l /tmp/matinee-loadtest-pg.log start >/dev/null
fi
createdb "$PG_DB" 2>/dev/null || true

# 2. Redis (its own port, no persistence).
if ! redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1; then
  redis-server --port "$REDIS_PORT" --daemonize yes --dir /tmp --dbfilename matinee-loadtest.rdb --save "" --appendonly no
fi

export DATABASE_URL="postgresql://$PGUSER@localhost:$PG_PORT/$PG_DB"
export DATABASE_READ_URL="$DATABASE_URL"
export DATABASE_DIRECT_URL="$DATABASE_URL"
export REDIS_URL="redis://localhost:$REDIS_PORT"

# 3. Real schema, then the seed + params.
npx prisma migrate deploy >/dev/null
npx tsx load-tests/prepare.ts

echo
echo "Stack is up. Showtime id and 50 seat ids are in load-tests/params.json."
echo
echo "Build and start the server (in its own terminal; 3001 keeps clear of any dev server on 3000):"
echo "  npm run build"
echo "  TRAFFIC_PROFILE=loadtest \\"
echo "    DATABASE_URL=\"$DATABASE_URL\" DATABASE_READ_URL=\"$DATABASE_READ_URL\" \\"
echo "    REDIS_URL=\"$REDIS_URL\" TMDB_READ_TOKEN=loadtest-placeholder \\"
echo "    PORT=3001 node dist/api/main.js"
