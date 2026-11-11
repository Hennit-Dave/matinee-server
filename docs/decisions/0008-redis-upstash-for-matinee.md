# 0008 — Redis: Railway Redis replaces Aiven Valkey for Matinee (Upstash plan superseded)

Date: 2026-11-11 · Status: superseded by the 2026-11-11 addendum below — **Upstash was never actually used; Matinee's Redis is a Railway Redis service** · Decided by: Dave

## Problem

AGENTS.md §5 names Aiven Valkey, the Redis-fork substitution already signed off and shared with Rota. Reusing
Rota's existing instance for Matinee too would mean two independently-graded apps sharing one Redis's memory,
connection limit and outages — and Matinee's own load test (D5.6: 500 VUs against the same 50 seats) is
designed to stress Redis hard, which would put Rota's own deployed app at risk for the duration of that test.
Matinee needs its own Redis, and the brief names Upstash directly as an acceptable free-tier option. But
BullMQ's own idle polling spends commands even with an empty queue, so Upstash's 500K-commands/month budget
needs measuring before Matinee relies on it for anything load-bearing.

## Options

1. **Share Rota's Aiven Valkey instance**, with a key prefix and a separate database number to keep the two
   apps' keys apart — no new account, but the apps would still share one instance's memory, connection limit
   and availability. A memory spike, a connection-limit hit, or an outage on either app's side affects both;
   Matinee's 500-VU load test would run directly against the same instance serving Rota's real traffic.
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

The brief names Upstash directly as an acceptable free-tier option. The alternative — sharing Rota's Aiven
Valkey instance — would put Rota's deployed app at risk during Matinee's own 500-VU load test, which is exactly
the situation ADR 0008 exists to avoid: two independently-graded apps should not share one instance's memory,
connection limit and outages. A separate Upstash instance for Matinee avoids that risk entirely; the only open
question is whether its command budget actually fits BullMQ's idle polling, hence the 2-hour measurement before
anything depends on it.

## Consequences

- **Easier:** Matinee's Redis usage can't affect Rota's deployed app, and vice versa — no shared blast radius
  during the load test or otherwise.
- **Harder:** command-based billing turns a bug that hot-loops a Redis call into a budget problem, not just a
  bug — worth remembering once the rate limiter and seat-hold code land and actually generate traffic.
- **Known gap until measured:** the numbers in this ADR are theoretical until the 2-hour run happens. A dated
  addendum follows once `REDIS_URL` exists and Dave has run it.
- **Revisit when:** the 2-hour measurement comes back, and again once the rate limiter and real jobs add real
  traffic on top of the idle floor measured here.

## Addendum — 2026-11-11

Upstash is not used. Its free plan allows one database per account, and Dave's existing Upstash database is
already in use as the login rate limiter for a different deployed app — in AF-SOUTH-1, a region Railway does
not have. Everything above this line is the originally recorded decision and reasoning; it is kept as history,
not deleted, but it no longer describes what Matinee runs.

**What Matinee actually uses:** a Redis service on Railway, in a project called "matinee", region EU West
(Amsterdam) — see ADR 0009's addendum. It has no public access, and stays that way. Local development uses a
local Redis installed with Homebrew, at `redis://localhost:6379`. CI uses its Redis service container, as
already planned above. The deployed API and worker reach Railway's Redis over its private URL, from the
deployment slice onward.

**Why the Reason above still holds:** the risk being avoided — Matinee's load test sharing Rota's live Aiven
Valkey instance — is exactly as real with Railway Redis as it would have been with Upstash. Only the specific
provider changed, and only because of Upstash's one-database-per-account limit and its region mismatch with
Railway, not because of anything wrong with the original reasoning.

**What this removes from slice 0 (PR B, not yet merged):** a Railway Redis service has no monthly command
budget to measure, so the 2-hour idle-command measurement, the `jobs/scripts/idle-worker.ts` script, and that
evidence item are all removed from scope. The BullMQ queue and worker files are also removed from slice 0 —
BullMQ arrives with the first real job, and the number of queues is chosen on design grounds then, not cost.
`jobs/connection.ts` stays, since `/health` needs a Redis client. Slice 0's live `/health` evidence is against
Neon and the local Homebrew Redis; the Railway Redis is proven in the deployment slice.

The Mitigation/Measurement/Extrapolation/Fallback subsections above are left exactly as originally written, as
history of a plan that was superseded before anything was measured.
