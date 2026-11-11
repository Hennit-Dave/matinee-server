# 0009 — Hosting: Railway (Hobby plan) replaces Northflank for Matinee

Date: 2026-11-11 · Status: accepted · Decided by: Dave

## Problem

AGENTS.md §5 names Northflank's free tier (Oracle Always Free as the documented fallback), which Rota already
deploys to. Matinee needs its own hosting decision for the API and the BullMQ worker.

## Options

1. **Northflank free tier**, matching Rota — one fewer account, but shares whatever free-tier limits exist
   across two independently-graded apps.
2. **Railway (Hobby plan)** — a small recurring cost, two always-on services (API + worker), kept separate
   from Rota's hosting.

## Decision

Option 2: Railway, Hobby plan, two always-on services. Oracle Always Free stays as the documented fallback,
unchanged from AGENTS.md.

## Reason

Keeps Matinee's deployment independent of Rota's free-tier usage, and gives the worker an always-on home from
the start rather than fighting a free tier's sleep/cold-start behaviour — which matters once BullMQ jobs are
real (webhooks, hold-expiry cleanup, refund processing) rather than the no-op idle probe in ADR 0008.

## Consequences

- **Easier:** independent from Rota's hosting limits; a worker that's genuinely always-on.
- **Harder or given up:** a small recurring cost instead of a free tier.
- Deployment itself is a later slice — this ADR only records the decision now, ahead of it.
- **Revisit when:** the deployment slice is planned, or if Railway's Hobby pricing or limits change materially
  before then.
