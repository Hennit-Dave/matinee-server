# Handoff: TMDB movie endpoints (branch `feat/tmdb-movies-endpoints`)

## What changed
- `GET /movies/now-playing?page=` and `GET /movies/search?q=&page=`, the only path to movie data.
- `src/movies/movie.ts`: the contract (`Movie`, `MoviesPage` Zod schemas), the query schemas, the
  `MovieSource` seam and `MovieSourceError`. The mobile PR mirrors this file.
- `src/movies/tmdb.ts`: the ONE file that knows TMDB's shape (schema, mapper, image CDN URL, auth,
  retry/backoff, timeouts).
- `src/movies/cache.ts` + `src/movies/service.ts`: Redis cache-aside, TTL policy and its reasons,
  stale-serve fallback, one refresh per key at a time.
- `src/movies/routes.ts`, wired in `src/api/app.ts`; `src/api/main.ts` now requires `TMDB_READ_TOKEN`
  at boot (fails before listening if it is missing, same as `DATABASE_URL`).
- Shared files touched: `src/http/errors.ts` (new code `upstream_unavailable`, 503) and
  `src/http/logger.ts` (allowlist gained `cache`, `attempt`, `upstreamStatus`; request log line
  includes `cache`).
- No new dependency, no new secret, no native build.

## Unproven
- **No call to the real TMDB has been made.** The mapper is tested against a hand-written fixture in
  TMDB's documented shape. Dave's live smoke test: `docs/evidence/tmdb-movies/README.md`.
- Behaviour with a real Redis outage mid-request (the unit tests fake a down store; the evidence run
  used a healthy local Redis).
- Timings (3 s per attempt, 8 s total budget, 250 ms backoff base) are chosen, not measured.

## Decisions worth Dave's eye
- Test runner is `node --test` and the logger is the hand-rolled one, per ADR 0005. The brief said
  Vitest and pino; neither is in this repo, so neither was added.
- Redis down on a movie read fails OPEN (go to TMDB). That is deliberate and is the opposite of seat
  holds, which fail closed (AGENTS.md section 7).
- `createApp`'s `movies` dependency is optional only so slice 0's `/health` integration test is unchanged.

## Next
- Mobile PR mirroring `src/movies/movie.ts`, linking to this one (server merges first).
- Traffic-management slice: rate limiting (search is the abuse magnet: unbounded distinct queries mean
  unbounded Redis keys until the 1 h stale window expires them) and real-time seat data. Both are
  explicitly out of scope here.
- Not built, on purpose: `region` for now-playing (TMDB's default is global), a per-movie detail
  endpoint, background refresh of stale entries.
