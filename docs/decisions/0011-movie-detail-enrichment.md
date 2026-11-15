# 0011 — Movie detail enrichment (`append_to_response` & GB-first certification)

Date: 2026-11-15 · Status: accepted · Decided by: Dave

## Problem

The Movie detail screen and its "More" bottom sheet require `certification`, `language`, `director`, and top-billed `cast`, which were not present on `MovieDetail`. Fetching `/movie/{id}/credits` and `/movie/{id}/release_dates` as separate calls would triple upstream TMDB round-trips, failure modes, and rate-limit pressure. Additionally, TMDB returns certifications per country (`release_dates.results`), so the server must pick one deterministic region.

## Decision

1. **Single TMDB call via `append_to_response=credits,release_dates`.**
   - `tmdb.ts` requests `/3/movie/{id}?append_to_response=credits,release_dates`, keeping `GET /movies/:id` to one upstream HTTP request and one retry/timeout budget (`ATTEMPT_TIMEOUT_MS = 3_000`, `TOTAL_BUDGET_MS = 8_000`).
   - `tmdb.ts` remains the sole module aware of TMDB's shape (`credits`, `release_dates`, `spoken_languages`), mapping into `MovieDetailSchema` (`certification`, `language`, `director`, `cast`). All four fields degrade gracefully (`null` or `[]`) when omitted.
2. **GB-first certification preference (`GB` → `US` → first non-empty country).**
   - Matinee's seeded cinemas are in London (Curzon Soho, BFI Southbank, Prince Charles Cinema), so BBFC ratings (`GB`, e.g. `12A`, `15`) are preferred first, falling back to MPAA (`US`, e.g. `PG-13`) and then the first country with a non-empty certification string.
3. **Cache compatibility via on-read Zod validation.**
   - `DetailEntrySchema` in `src/movies/cache.ts` validates cached JSON against the current `MovieDetailSchema` (`strictObject` with required `certification`, `language`, `director`, and `cast`). Existing Redis entries from before this change fail validation on read, are treated as a cache miss, and are refreshed from TMDB automatically.

## Consequences

- **Easier:** Zero extra TMDB round-trips per cache miss; old cached detail entries self-heal on read without a manual Redis flush.
- **Revisit when:** If Matinee expands to multiple countries with user-selected locale, pass a region parameter to `detail(id, region)` instead of hardcoding `GB` → `US`.
