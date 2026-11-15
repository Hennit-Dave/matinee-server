# Handoff: Movie detail endpoint (branch `feat/movie-detail-endpoint`)

## What changed
- Added `GET /movies/:id` in `src/movies/routes.ts`, registered after `/now-playing` and `/search` so static paths are never captured as `:id`.
- Added `MovieDetailSchema`, `MovieDetail`, `DETAIL_OVERVIEW_MAX_LENGTH` (2000), `MovieIdParamsSchema` (positive 32-bit int), and `MovieSource.detail(id)` in `src/movies/movie.ts`.
- Added `TmdbMovieDetailSchema`, `BACKDROP_IMAGE_BASE` (`w780`), `mapTmdbMovieDetail`, and `detail(id)` in `src/movies/tmdb.ts` (404 returns `null` without retrying; `vote_average` rounded to 1 decimal place, `null` when unrated).
- Extended `src/movies/cache.ts` (`readDetail`, `writeDetail`) and `src/movies/service.ts` (`detail(id)`, key `movies:v1:detail:${id}`):
  - **TTL:** 24 h fresh (`DETAIL_FRESH_TTL_SECONDS`) + 7 d stale grace (`DETAIL_STALE_GRACE_SECONDS`) = 8 days total in Redis.
  - **Failures:** unknown ID (`null`) throws `ApiError('not_found')` (404, not cached); TMDB outage serves stale (`X-Cache: STALE`) if cached, else throws `ApiError('upstream_unavailable')` (503).
- Added synthetic fixture `src/movies/fixtures/tmdb-movie-detail.json` and unit/route tests across `movie.test.ts`, `tmdb.test.ts`, `service.test.ts`, and `routes.test.ts`.

## What passed
- `npm run typecheck`
- `npm run lint`
- `npm test` (66 passed, 0 failed; 2 Postgres/Redis integration tests skipped without `TEST_DATABASE_ALLOWED=true`)
- `gitleaks detect --no-banner` (no leaks found)

## Unproven
- Real TMDB `/3/movie/{id}` call was not made (tested against synthetic fixture `tmdb-movie-detail.json`).

## Next
- **Slice 4b:** Cinemas + showtimes endpoints (and Prisma schema/migrations if needed).
- **Mobile:** Mirror `MovieDetail` in `matinee-mobile` once this PR is squash-merged.
