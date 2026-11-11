# 0008 — Redis: Upstash (free plan) replaces Aiven Valkey for Matinee

Date: 2026-11-11 · Status: accepted · Decided by: Dave

## Problem

AGENTS.md §5 names Aiven Valkey, the Redis-fork substitution already signed off and shared with Rota. Matinee's
Redis usage (seat holds, rate limits, cache, BullMQ) will mostly sit idle between showtimes and load-test runs,
and Upstash — named directly in the graduation brief as an acceptable option — bills by command count rather
than by an always-on instance, which may suit a mostly-idle workload better. But BullMQ's own idle polling
spends commands even with an empty queue, so the budget needs measuring before Matinee commits to it for
anything load-bearing.

## Options

1. **Keep Aiven Valkey for Matinee too**, matching Rota exactly — no new research, but an always-on instance
   billed on uptime/memory rather than activity, possibly the worse fit for a mostly-idle app.
2. **Upstash free plan (500K commands/month) for Matinee**, with a measured idle-budget check before relying
   on it fully, and a documented fallback if the budget doesn't fit.

## Decision

Option 2.

**Mitigation, decided now:** one BullMQ queue, one worker handling every job kind (not one queue-and-worker
pair per kind), and a lengthened idle-poll/`drainDelay` interval, to minimise idle command spend.

**Measurement, built in slice 0:** a single BullMQ queue (`src/jobs/queue.ts`) and a worker with a no-op
processor (`src/jobs/worker.ts`), started by a small script (`src/jobs/scripts/idle-worker.ts`) once
`REDIS_URL` exists. Dave runs the idle worker for a real 2 hours on his own machine — not 24, since idle
polling with nothing queued is a steady rate and a shorter window extrapolates cleanly — and reads the command
count from **the Upstash console**, which is what the free-tier limit is actually billed against. Redis's own
`INFO stats` → `total_commands_processed` is read as a **cross-check only**, before and after the 2-hour
window; if Upstash doesn't expose that field over `INFO` (some managed providers restrict it), that's noted
here and the console figure stands alone as authoritative.

**Extrapolation:** `monthly_estimate = commands_in_2h × (24 × 30) / 2 = commands_in_2h × 360`.

**Fallback, if the extrapolated monthly rate doesn't fit 500K:** keep the BullMQ queue on Aiven Valkey (already
signed off in AGENTS.md) and use Upstash only for cache, rate limits and seat holds.

Env var: `REDIS_URL`. Dave fills it into `matinee-server/.env` himself; no agent reads, prints or logs the
value.

## Reason

The brief names Upstash directly as an acceptable free-tier option. A mostly-idle development workload may fit
command-based billing better than an always-on instance, but that's a real trade-off, not an assumption — hence
the 2-hour measurement before anything depends on it.

## Consequences

- **Easier:** if the budget fits, no instance sits "on" costing nothing to run idle.
- **Harder:** command-based billing turns a bug that hot-loops a Redis call into a budget problem, not just a
  bug — worth remembering once the rate limiter and seat-hold code land and actually generate traffic.
- **Known gap until measured:** the numbers in this ADR are theoretical until the 2-hour run happens. A dated
  addendum follows once `REDIS_URL` exists and Dave has run it.
- **Revisit when:** the 2-hour measurement comes back, and again once the rate limiter and real jobs add real
  traffic on top of the idle floor measured here.
