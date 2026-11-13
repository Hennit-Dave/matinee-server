# Evidence: TMDB movie endpoints (`GET /movies/now-playing`, `GET /movies/search`)

| File | What it shows |
|---|---|
| `before.txt` | On `main`, before this slice: both routes answer `404 not_found`. The baseline commit. |
| `after.txt` | After: cold MISS then warm HIT, Redis TTLs on every key, query normalisation sharing one entry, 400s in the standard error shape, TMDB down → `STALE` copy served, TMDB down with nothing cached → clean 503, recovery. |

`after.txt` was produced by an in-process script against a real local Redis with only the TMDB
network call faked (its header says exactly what is real and what is faked). It proves our
behaviour around TMDB. It does not prove the real TMDB answers the way the saved fixture says it
does; that is the live smoke test below, which only Dave can run because no agent reads, prints or
logs `TMDB_READ_TOKEN` (AGENTS.md section 4).

## Dave: live smoke test against the real TMDB

1. `.env` has `TMDB_READ_TOKEN` (the v4 "API Read Access Token") and `REDIS_URL`. Start local Redis
   if needed: `brew services start redis`.
2. `npm run dev:api`
3. In another terminal:
   ```
   curl -i 'http://localhost:3000/movies/now-playing?page=1'     # X-Cache: MISS, real posters
   curl -i 'http://localhost:3000/movies/now-playing?page=1'     # X-Cache: HIT
   curl -i 'http://localhost:3000/movies/search?q=dune'          # X-Cache: MISS
   curl -i 'http://localhost:3000/movies/search?q=%20DUNE%20'    # X-Cache: HIT (same normalised query)
   curl -i 'http://localhost:3000/movies/now-playing?page=0'     # 400 validation_failed
   redis-cli keys 'movies:*' ; redis-cli ttl movies:v1:now-playing:page:1   # a TTL on every key
   ```
4. Save the output as `docs/evidence/tmdb-movies/live-smoke.txt` (check it does not contain your
   token; the server never prints it, but look before committing).
5. Optional, the "TMDB is down" proof with real data: with the cache warm, stop your network (or
   set `TMDB_READ_TOKEN` to nonsense in a *copy* of the env, never `.env` itself) and ask for a page
   whose entry has expired. Note a 401 is not retried, so a bad token fails fast, and any cached
   copy is still served as `X-Cache: STALE`.

If the real response ever disagrees with the fixture (a field renamed, a new shape), the only file
to change is `src/movies/tmdb.ts`; replace the fixture with a real capture and the mapper tests will
show exactly what moved.
