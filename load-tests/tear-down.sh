#!/usr/bin/env bash
# Tears down the throwaway stack that stand-up.sh created (slice 5e). Stops Redis and Postgres and
# removes the throwaway data directory. Dave's own services are never touched.
set -euo pipefail
cd "$(dirname "$0")/.."

PG_PORT="${PG_PORT:-54329}"
REDIS_PORT="${REDIS_PORT:-6391}"
PGDATA="${PGDATA:-/tmp/matinee-loadtest-pg}"
PGHOST="${PGHOST:-/tmp}"

redis-cli -p "$REDIS_PORT" shutdown nosave 2>/dev/null || true
pg_ctl -D "$PGDATA" stop -m fast >/dev/null 2>&1 || true
rm -rf "$PGDATA"
echo "Throwaway stack stopped."
