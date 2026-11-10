# Matinee server

The API, background jobs and database behind Matinee, a cinema ticket booking app where a seat is never sold twice.

> GIF, Android download link and demo video link go here once they exist.

**Mobile app repo:** https://github.com/Hennit-Dave/matinee-mobile

## Status

Scaffold only. Nothing is built yet. This README is written as the build goes.

## What it is

Users browse movies, see showtimes, pick seats on a seat map and pay. Movie data comes from TMDB through this server. Showtimes, cinemas, seats and bookings live in this server's own database.

## Tech stack

Node + Express · TypeScript · PostgreSQL (Neon) · BullMQ on Valkey · Zod · Stripe (test mode) · Sentry · k6

## Docs

- `docs/RULES.md` — every requirement, as a checklist
- `docs/decisions/` — architecture decision records
- `AGENTS.md` — how AI agents work in this repo

## Still to write

Problem it solves · how to run locally · architecture summary · key decisions · app store billing rules (Apple/Google in-app purchase) · what I'd do next

## Attribution

This product uses the TMDB API but is not endorsed or certified by TMDB.

## Licence

MIT
