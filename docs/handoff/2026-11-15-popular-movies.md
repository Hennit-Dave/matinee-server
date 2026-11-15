# Handoff: Popular movies endpoint (branch `feat/popular-movies`)

## What changed
- **Contract (`src/movies/movie.ts`):** Added `PopularQuerySchema` (`page` `1..500`, default `1`) and `popular(page)` on `MovieSource`.
- **TMDB (`src/movies/tmdb.ts`):** Added `popular(page)` calling `/3/movie/popular?page=<n>` and reusing `mapTmdbPage`.
- **Service (`src/movies/service.ts`):** Added `POPULAR_FRESH_TTL_SECONDS` (3h), `POPULAR_STALE_GRACE_SECONDS` (24h), `popularKey(page)` (`movies:v1:popular:page:<page>`), and `popular(page)` via `cacheAside` with stale-serve + `503` fallback.
- **Routes (`src/movies/routes.ts`):** Added `GET /movies/popular` before `GET /movies/:id`.
- **Tests & ADR:** Added tests in `movie.test.ts`, `tmdb.test.ts`, `service.test.ts`, and `routes.test.ts` (plus `noopMovies.popular` in `showtimes.integration.test.ts`), and wrote `docs/decisions/0013-popular-movies-endpoint.md`. No database reseed needed (live TMDB).

## What passed
- `npm run typecheck`
- `npm run lint`
- `npm test`
- `gitleaks git matinee-server`

## Next
- **Dave:** Review and squash-merge the PR.
