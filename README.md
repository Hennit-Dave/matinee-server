# Matinee server

The API, background jobs and database behind Matinee, a cinema ticket booking app where a seat is never sold twice.

> GIF, Android download link and demo video link go here once they exist.

**Mobile app repo:** https://github.com/Hennit-Dave/matinee-mobile

## Status

Slice 0: an Express + TypeScript skeleton with a real `/health` (checks Postgres primary + replica
and Redis, 503 on failure), structured logging, request IDs and a Zod validation helper. No
business routes yet. This README is written as the build goes.

## What it is

Users browse movies, see showtimes, pick seats on a seat map and pay. Movie data comes from TMDB through this server. Showtimes, cinemas, seats and bookings live in this server's own database.

## Tech stack

Node + Express · TypeScript · PostgreSQL (Neon, primary + read replica) · Redis on Railway (ADR 0008's addendum — BullMQ arrives with the first real job) · Zod · Stripe (test mode) · Sentry · k6

## How to run locally

```
npm install
cp .env.example .env   # fill in DATABASE_URL, DATABASE_READ_URL, REDIS_URL, TMDB_READ_TOKEN
npm run dev:api         # http://localhost:3000, GET /health
```

`npm run typecheck`, `npm run lint`, `npm test` (unit) and `npm run test:integration` (needs
`TEST_DATABASE_ALLOWED=true` plus `TEST_DATABASE_URL`/`TEST_DATABASE_READ_URL`/`TEST_REDIS_URL` —
see `.github/workflows/ci.yml` for the values CI uses against disposable containers; never point
these at the real `DATABASE_URL`/`REDIS_URL`).

## Starting Redis locally

Production Redis is a private Railway service (ADR 0008's addendum); local development uses a
plain local install instead:

```
brew install redis
brew services start redis   # runs in the background at redis://localhost:6379
```

Set `REDIS_URL=redis://localhost:6379` in `.env`. Stop it later with `brew services stop redis`.

## Docs

- `docs/RULES.md` — every requirement, as a checklist
- `docs/decisions/` — architecture decision records
- `docs/evidence/` — evidence captured per slice
- `AGENTS.md` — how AI agents work in this repo

## Still to write

Architecture summary · key decisions · app store billing rules (Apple/Google in-app purchase) · what I'd do next

## Attribution

This product uses the TMDB API but is not endorsed or certified by TMDB.

## Licence

MIT
