# Handoff: Genre discovery endpoints (branch `feat/genre-discovery`)

## What changed
- **Contracts (`src/movies/movie.ts`):**
  - Added `GenreSchema`, `GenresResponseSchema`, and `DiscoverQuerySchema` (`genreId` positive digits `1..MAX_MOVIE_ID`, `page` `1..500` defaulting to `1`).
  - Extended `MovieSource` with `genres()` and `discover(genreId, page)`.
- **TMDB client (`src/movies/tmdb.ts`):**
  - Added `TmdbGenresResponseSchema`, `mapTmdbGenres`, `genres()` (`/3/genre/movie/list`), and `discover(genreId, page)` (`/3/discover/movie?with_genres=<id>&sort_by=popularity.desc&include_adult=false&page=<n>`).
- **Cache & service (`src/movies/cache.ts`, `src/movies/service.ts`):**
  - Added `GenresEntrySchema`, `readGenres`, and `writeGenres` on `MovieCache`.
  - Added `GENRES_FRESH_TTL_SECONDS` (7d), `GENRES_STALE_GRACE_SECONDS` (30d), `DISCOVER_FRESH_TTL_SECONDS` (3h), `DISCOVER_STALE_GRACE_SECONDS` (24h), `genresKey`, `discoverKey`, and `genres()` / `discover(genreId, page)` on `MovieService` with stale-serve + `503` fallback.
- **Routes & app (`src/movies/routes.ts`, `src/api/app.ts`):**
  - Added `GET /movies/discover` before `GET /movies/:id` so `"discover"` is never captured as `:id`.
  - Added `createGenresRouter(service)` and mounted `/genres` in `createApp`.
- **ADR & tests:**
  - Wrote `docs/decisions/0012-genre-discovery-and-ttls.md`.
  - Added unit tests in `movie.test.ts`, `tmdb.test.ts`, `service.test.ts`, and `routes.test.ts`, plus `noopMovies` stubs in `showtimes.integration.test.ts`.
  - No database reseed needed (live TMDB).

## What passed
- `npm run typecheck`
- `npm run lint`
- `npm test`
- `gitleaks git matinee-server`

## Next
- **Dave:** Review and squash-merge the PR.
- **Mobile:** Wire Search genre chips and genre-filtered browse to `GET /genres` and `GET /movies/discover`.
