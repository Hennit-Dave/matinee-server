# 0013 — Popular movies endpoint (`GET /movies/popular`)

Date: 2026-11-15 · Status: accepted · Decided by: Dave

## Problem

The app needs a general "Popular" movie feed (`GET /movies/popular?page=<1..500>`) separate from `now-playing` and genre-filtered `discover`, while keeping TMDB's payload shape isolated in `src/movies/tmdb.ts` and matching the existing cache-aside and error-handling guarantees.

## Decision

1. **Reuse `MoviesPage` and `mapTmdbPage`:**
   - `GET /movies/popular` validates `?page` with `PopularQuerySchema` (`1..500`, default `1`) and returns `MoviesPage`.
   - `src/movies/tmdb.ts` calls `/3/movie/popular?page=<n>` and reuses `mapTmdbPage`.
   - Registered in `createMoviesRouter` before `/:id` so `"popular"` is never captured as a movie id.
2. **Cache-aside TTLs matching `now-playing`:**
   - Key `movies:v1:popular:page:<page>` uses `3 hours` fresh TTL (`10_800s`) and `24 hours` stale grace (`86_400s`), serving stale cached data (`X-Cache: STALE`) on TMDB outage and `503 upstream_unavailable` when uncached.

## Consequences

- **Easier:** Zero new contract types or mappers; consistent `X-Cache` and `503` behaviour across all movie list endpoints.
- **Revisit when:** If popularity feeds ever need regional filtering (`region=GB`), include the region in `popularKey`.
