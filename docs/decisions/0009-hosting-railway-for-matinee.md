# 0009 — Hosting: Railway (Hobby plan) replaces Northflank for Matinee

Date: 2026-11-11 · Status: accepted · Decided by: Dave

## Problem

AGENTS.md §5 names Northflank's free tier (Oracle Always Free as the documented fallback), which Rota already
deploys to. **Northflank was not actually available for Matinee:** its free plan allows one project, Rota
already occupies it, and the dashboard showed "Free project limit reached" when Dave tried to create a second
project on 2026-11-11. Matinee needs a real hosting decision for the API and the BullMQ worker, not the one
AGENTS.md currently names.

## Options

1. **Railway, Hobby plan ($5/month)** — API and worker run as two always-on services, no sleep/cold-start
   behaviour.
2. **Render, free tier** — rejected: Render's free services sleep after 15 minutes idle. That breaks hold
   expiry (a sleeping worker doesn't release expired holds on time), webhook delivery (Stripe can't reach a
   sleeping API, and a late webhook racing a hold's expiry is exactly the case ADR 0009-to-be/the webhook ADR
   has to handle), and the k6 load test (500 VUs hitting a cold-starting API is not a measurement of the app).
3. **Oracle Cloud, Always Free** — genuinely free and always on, but needs more setup (a VM to provision and
   manage directly, rather than a platform that deploys from git). Kept as the documented fallback, not
   discarded.

## Decision

Option 1: Railway, Hobby plan, $5/month, two always-on services (API + worker). Oracle Cloud Always Free is
the documented fallback if Railway stops being workable.

## Reason

Northflank is unavailable (its one free project is Rota's). Render's free tier's sleep behaviour directly
breaks three things Matinee is graded on (hold expiry, the webhook pattern, the load test), so it isn't a real
option regardless of cost. Oracle Always Free would work and costs nothing, but needs meaningfully more setup
(provisioning and managing a VM) than Railway's git-deploy model. $5/month for Railway buys always-on behaviour
with the least setup time, which matters more here than the cost.

## Consequences

- **Easier:** independent from Rota's hosting limits (which are exhausted, not just shared); a worker that's
  genuinely always-on; least setup of the three real options.
- **Harder or given up:** a small recurring cost ($5/month) instead of a free tier.
- Deployment itself is a later slice — this ADR only records the decision now, ahead of it.
- **Revisit when:** the deployment slice is planned, or if Railway's Hobby pricing or limits change materially
  before then; Oracle Always Free is the fallback if so.
