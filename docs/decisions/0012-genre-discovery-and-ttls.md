# 0012 — Genre discovery endpoints and cache TTLs

Date: 2026-11-15 · Status: accepted · Decided by: Dave

## Problem

Mobile Search needs genre-based browsing: a list of official movie genres (`GET /genres`) and a paginated list of popular movies for a selected genre (`GET /movies/discover?genreId=<id>&page=<n>`). Because TMDB genre IDs and popularity rankings change at very different cadences, both endpoints need explicit cache-aside TTLs, stale-while-error fallback, and strict request/response validation without leaking TMDB's shape outside `src/movies/tmdb.ts`.

## Decision

1. **Two read endpoints, reusing the `MoviesPage` contract for discovery:**
   - `GET /genres` → `{ genres: [{ id, name }] }` backed by TMDB `/3/genre/movie/list`.
   - `GET /movies/discover?genreId=<digits>&page=<1..500>` → `MoviesPage` backed by TMDB `/3/discover/movie?with_genres=<id>&sort_by=popularity.desc&include_adult=false&page=<n>`.
   - `/movies/discover` is declared before `/movies/:id` in `createMoviesRouter` so `"discover"` is never captured as an `:id` parameter.
2. **Cache-aside TTLs with stale-serve grace:**
   - **Genres (`movies:v1:genres`):** `7 days` fresh TTL (`604_800s`), `30 days` stale grace (`2_592_000s`). TMDB's official movie genre list almost never changes, so a week-long fresh window avoids unnecessary upstream calls while a 30-day grace window keeps genre chips working during extended TMDB outages.
   - **Discover (`movies:v1:discover:<genreId>:page:<page>`):** `3 hours` fresh TTL (`10_800s`), `24 hours` stale grace (`86_400s`). Matches `now-playing` cadence since genre popularity rankings shift on a similar timescale.
   - Both serve stale cached data with `X-Cache: STALE` when TMDB is unavailable, and return `503 upstream_unavailable` when no cached entry exists.
3. **Isolation & validation:**
   - `src/movies/tmdb.ts` remains the sole module aware of TMDB's payload shape (`TmdbGenresResponseSchema`).
   - `DiscoverQuerySchema` validates `genreId` (positive integer `1..MAX_MOVIE_ID`) and `page` (`1..500`, default `1`).

## Consequences

- **Easier:** Mobile Search reuses `MoviesPage` for genre discovery without another movie card contract; genre list requests are nearly free in steady state.
- **Revisit when:** If Matinee adds multi-language localization (`language=en-GB` etc.), include the locale in `genresKey` and `discoverKey`.
