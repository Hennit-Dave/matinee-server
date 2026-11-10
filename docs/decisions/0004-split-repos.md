# 0004 — Two repos: matinee-mobile and matinee-server

Date: 2026-11-10 · Status: accepted · Decided by: Dave

## Problem
The brief allows one repo or one for the app and one for the backend, linked to each other. Rota used one repo.

## Options
1. **One repo** with `/app` `/server` `/docs` `/load-tests`. One PR per feature, shared types, one pin slot.
2. **Split** into a mobile repo and a server repo. Separate deploys and build contexts, and a second way of working after Rota.

## Decision
Split: `matinee-mobile` and `matinee-server`.

## Reason
Cleaner separate deploys, and it shows a different repo setup from Rota.

## Consequences
- Most features need two PRs, cross-linked, server merged first.
- The API contract (Zod schemas) is owned by the server repo. The mobile repo mirrors the types, so drift is a risk to watch.
- `docs/RULES.md`, all ADRs and `load-tests/` live in the server repo. `COMPONENTS.md` lives in the mobile repo.
- Both READMEs must link to each other (graded item).
- Each repo needs its own `LEARNING-LOG.md`, `.env.example`, LICENSE, description and topic tags.
- Pinning both uses two of the six profile pin slots.
