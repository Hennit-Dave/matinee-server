# Handoff: Movie detail metadata enrichment (branch `feat/movie-detail-metadata`)

## What changed
- **Contract (`src/movies/movie.ts`):**
  - Extended `MovieDetailSchema` (`strictObject`) with four new fields:
    - `certification: z.string().nullable()`
    - `language: z.string().nullable()`
    - `director: z.string().nullable()`
    - `cast: z.array(z.string())`
- **TMDB client & mapping (`src/movies/tmdb.ts`):**
  - Updated `detail(id)` to request `/movie/{id}?append_to_response=credits,release_dates` in a single upstream call.
  - Extended `TmdbMovieDetailSchema` and mapped:
    - `certification`: prefers `GB`, then `US`, then first country with a non-empty certification; `null` if none.
    - `language`: matches `original_language` in `spoken_languages[].english_name`, falls back to the first non-empty `english_name`; `null` if none.
    - `director`: `credits.crew` entries with `job === 'Director'`, joined with `", "`; `null` if none.
    - `cast`: top 5 `credits.cast` names sorted by billing `order`; `[]` if none.
- **Cache compatibility (`src/movies/cache.ts`):**
  - Confirmed `DetailEntrySchema` validates cached JSON against `MovieDetailSchema` (`strictObject` with required `certification`, `language`, `director`, and `cast`) on every read. Old-shape entries fail validation, return `null` (cache miss), and are refreshed from TMDB automatically.
- **ADR & tests:**
  - Wrote `docs/decisions/0011-movie-detail-enrichment.md`.
  - Extended `src/movies/fixtures/tmdb-movie-detail.json` and updated `movie.test.ts`, `tmdb.test.ts`, `service.test.ts`, and `routes.test.ts`.

## What passed
- `npm run typecheck`
- `npm run lint`
- `npm test` (74 passed, 0 failed; 3 Postgres/Redis integration tests skipped locally without `TEST_DATABASE_ALLOWED=true`)
- `gitleaks git matinee-server` (18 commits scanned, no leaks found)

## Next
- **Dave:** Squash-merge the PR.
- **Slice 4c (mobile):** Mirror the enriched `MovieDetail` (`certification`, `language`, `director`, `cast`) and `ShowtimeSlot.format` in `matinee-mobile`.
