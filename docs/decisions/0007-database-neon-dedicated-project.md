# 0007 — Database: a dedicated Neon project for Matinee

Date: 2026-11-11 · Status: accepted · Decided by: Dave

## Problem

Matinee needs Postgres with a primary, a read replica and pooled (`-pooler`) hosts for both (AGENTS.md §5).
Rota already has a Neon account. The question is whether Matinee reuses it or gets its own project, and
whether a free-plan read replica is actually available on a brand-new project.

## Options

1. **Reuse Rota's Neon account**, as a new database inside the same project or organisation — one fewer
   account, but couples two independently-graded apps' storage, compute-hour and connection budgets together.
2. **A dedicated new Neon project for Matinee.**

## Decision

Option 2. Dave is creating the project himself and will add `DATABASE_URL` (primary, `-pooler` host) and
`DATABASE_READ_URL` (replica, `-pooler` host) to `matinee-server/.env` directly. Neither value is read, printed
or logged by any agent — only the names, in `.env.example` and here.

Researched 2026-11-11: Neon has offered free-plan read replicas since October 2024. A free-plan per-project cap
(one source reports 3) and some November 2026 pricing-page repositioning couldn't be fully confirmed from the
sources checked, so this ADR assumes a replica is available on a new project and only falls back if Dave finds
otherwise when he actually creates it.

**Fallback, if the free plan refuses a replica on this project:** `DATABASE_READ_URL` simply points at the
primary too (no physical replica), and `docs/ARCHITECTURE.md` documents plainly what a real replica would
change in production — satisfying RULES C2's "document what changes in production," which the brief explicitly
allows.

## Reason

Keeps Matinee's free-tier usage (storage, compute hours, connection ceiling) independent of Rota's — both apps
are graded separately, and Matinee's own load test (D5.6, 500 VUs) will consume part of whatever budget its
project has. Sharing a project with Rota would make that budget harder to reason about and attribute.

## Consequences

- **Easier:** Matinee's database usage is isolated and legible on its own Neon dashboard; no risk of Rota's
  traffic or storage affecting Matinee's connection ceiling or vice versa.
- **Harder:** a second Neon project to keep track of.
- **Revisit when:** Dave actually creates the project and finds out whether the replica provisions; if not,
  the fallback above applies and this ADR gets a dated addendum recording that.

## Evidence

- [Neon: create read replicas in the Free plan](https://neon.com/blog/create-read-replicas-in-the-free-plan)
- [Neon changelog, 2026-11-06](https://neon.com/docs/changelog/2026-11-06)
