# Handoff: Rate limiting per user and per IP, server side (branch `feat/rate-limiting`)

Slice 5c of the traffic chapter, server only. The small mobile PR follows once this is merged (server first, per AGENTS.md). Plan approved by Dave with all five defaults: trust the proxy by address range with a `100.64.0.0/10` safety net, the limits table as proposed, `DELETE /holds` unlimited, the hoarding cap out of 5c, and `X-Client-Id` added to search in the mobile PR.

> ## CARRY-FORWARDS (do not lose these)
> 1. **DEPLOY SLICE: run `docs/evidence/traffic-5c/verify-client-ip.sh` against the REAL Railway edge** (`spoof` from one machine, then `share` from a different network within 60 s) and save the output as `docs/evidence/traffic-5c/railway-edge-check.txt`. **It has never been run on Railway**: no API was deployed during this slice, and Railway publishes no hop count and its answers about `X-Forwarded-For` contradict each other. Until then, per-IP limiting behind Railway is **unproven**. If `spoof` fails, the address limit is dodgeable or off (check the API log for `client_ip_unresolved`); if `share` fails, callers are being collapsed onto the edge. ADR 0016 section 6 says what to change.
> 2. **5D: the per-owner hoarding cap is DEFERRED, not dropped.** ADR 0015 promised it with the rate limits; this slice's brief did not include it. Rate limits only slow hoarding: one install can take 10 holds a minute of up to 8 seats, one address 40 a minute (320 seats, a whole room) by rotating install ids. 5d should decide a cap on live seats per owner per showtime (and what to do about one address) alongside the waiting room.

## What changed
- **The limiter (`src/ratelimit/`)**
  - `slidingWindow.ts`: **one atomic Lua script per request check**, covering the install and the address together. Weighted current + previous window; a request is allowed when `estimate + 1 ≤ max`. A refused request writes to neither counter. Keys `rl:<policy>:u:<clientId>:<window>` and `rl:<policy>:ip:<address>:<window>`, every key with a TTL of two windows. `Retry-After` is computed in the script (earliest instant a retry could pass; two branches: the blend fading, or a full window waiting for the boundary).
  - `policies.ts`: the one table of limits (all 60 s windows), each with its reason. `limiter.ts`: `createRateLimiter` returning `limit(policyName)`, and `noRateLimit` for tests.
  - **Fails open**: Redis error, not ready, or no answer within **150 ms** lets the request through (one `rate_limit_unavailable` warning per 10 s). Holds and bookings still fail closed on their own path.
- **Client address (`src/http/clientIp.ts`)**: `trust proxy` is the list `loopback, linklocal, uniquelocal, 100.64.0.0/10` (not a hop count). IPv4-mapped IPv6 becomes IPv4, IPv6 is counted by its /64. **Safety net**: if the resolved address is itself in `100.64.0.0/10` or `fc00::/7`, the address counter is skipped and `client_ip_unresolved` is logged. (The `fc00::/7` part extends what the plan said, for the same reason: a private IPv6 hop.)
- **Wiring**: `clientIdHeader → limit(policy) → jsonBody → validateRequest → handler`, so the limiter runs before the body is parsed. `POST /holds` = `hold`, `POST /bookings` = `booking`, `GET /movies/search` = `search` (now with an optional `X-Client-Id`; a malformed one is a 400), `GET /showtimes/:id/seats` = `seatsPoll`. **Not limited:** `DELETE /holds` (cleanup path), `/health`, every other read. `createApp` now **requires** a `rateLimiter` (a compile error if forgotten); `api/main.ts` wires the real one.
- **Contract**: new error `rate_limited`, **429**, in the usual envelope, with `Retry-After` in whole seconds (at least 1). The log line gains `policy` and `scope` (`user`, `ip`, `user+ip`); never the address.
- **Docs**: ADR `0016`, a README section, and `docs/evidence/traffic-5c/` (with its own README).
- **No new dependency, environment variable, migration, service or native build.**

## What passed
- `npm run typecheck` and `npm run lint`: clean.
- `npm test`, no test env set (as on a plain machine): **224 tests, 182 pass, 0 fail, 42 skipped** (the DB- and Redis-gated ones). On top of 5a's 177: 47 new tests (27 run on a plain machine, 20 are the gated ones).
- Integration against a **throwaway local PostgreSQL 16 and Redis 8** (own ports, `.env` not loaded): **43 of 43 pass**, run twice, nothing left in Redis or `bookings`. 5a's 23 are unchanged; 20 are new:
  - **The arithmetic, on real Redis with a hand-moved clock** (12): exact numbers (10 at the end of a window, refused at +1 s with a 5 s wait, refused until the very millisecond that wait ends; the other `Retry-After` branch); **the window slides** (a burst at a boundary is refused; a fixed-window reference admits all 20); the documented worst case pinned as KNOWN LIMIT (about 2×); a seeded property test; a refusal writes nothing and 100 refused requests do not extend the wait; user and address independent, and when both trip `Retry-After` is the longer; **200 simultaneous checks over several connections admit exactly the limit** for the install and the address; TTL on every key; a not-connected Redis is an error, not an answer.
  - **Over HTTP, on the real app** (8): the 11th hold in a minute is a 429 with `Retry-After`, the envelope and the log line; each of the four routes refuses past its own limit while release and other reads never do; user and address independent over HTTP, each counted wherever the other goes; the window slides over HTTP; **realistic seat-map polling** (10 simulated minutes at the fastest poll, a resume burst, 10 devices on one address: zero refusals; a scraper at 5 req/s gets exactly one limit's worth; a scraper rotating install ids is stopped by the address); **Redis down: the limiter fails open and holds and the seat map still answer 503**; **Redis paused: the limiter gives up near its 150 ms deadline**; a malformed `X-Client-Id` on search is a 400.
- Unit tests (no Redis): the middleware around a fake store (scopes sent, 429 mapping, log line, fail-open on a throw, a hang and a late rejection, throttled warnings); **client address resolution** (12 tests, including a real HTTP proxy in front of the real Express in both replace and append modes with forged headers); the policy table (the poll limit stays above the real cadence); which route gets which policy; the app trusts the documented ranges and nothing wider.
- **The tests can fail**: `docs/evidence/traffic-5c/mutation-checks.txt` breaks the limiter seven ways (fixed window, read-then-write race, counting refused requests, skipping the address, failing closed, limiting after validation, trusting every proxy). All seven are caught, then restored.
- Baseline first (`before.txt`): the red test and 700 unlimited requests. `429-retry-after.txt`: a real 429 from the running API. `window-slide.txt`: sliding against fixed, same traffic.
- `gitleaks detect`: no leaks.

## Unproven
- **Railway's real client-address headers** (carry-forward 1). Only a local stand-in for the edge (`verify-client-ip-rehearsal.txt`) has been exercised, so what Railway actually sends is still an assumption built from its docs and forum answers.
- **Every limit and the 150 ms deadline are chosen, not measured** (5e). The extra Redis `EVALSHA` on every guarded request, including the hot seat-map poll, is also unmeasured.
- **Railway Redis** was never touched (the tests refuse any non-loopback Redis). The script uses only basic Lua (`redis.call`, `GET`, `INCR`, `PEXPIRE`) and CI runs Redis 7; local was Redis 8. Railway's version is assumed, not observed.
- **A shared address or carrier-grade NAT** with more people behind it than the address limits allow will see 429s. Not exercised by a real network.
- **Neon**: not touched; no migration.
- **The mobile app**: it sends `X-Client-Id` on holds, release and the seat map but **not on search**, so until the mobile PR the per-install search limit never applies (search is counted by address only).

## Deferred (do NOT build here)
- Mobile handling of 429 (Toast honouring `Retry-After` on the hold and search paths, and `X-Client-Id` on search): **the mobile PR, after this merges.**
- **5d:** the waiting room, graceful overload, and the **per-owner hoarding cap** (carry-forward 2).
- **5e:** the k6 500-user / 50-seat load test, `TRAFFIC.md`, `SHARDING.md`. **The load test sends 500 users from one address, which the address limits will refuse**: 5e needs a way to lift or scale the limits for that run. Not built here. 5e also tunes the limits.
- Rate limiting on auth routes (login, password reset): out of scope, Matinee has no auth yet.
- Real payments and the verified-webhook job (the payments chapter); that job replaces `POST /showtimes/:id/bookings`, and its `booking` policy goes with it or moves to the checkout route.

## Next
- **Dave:** check CI, then **squash-merge** (no migration, no environment variable, no new service). I will then open the small mobile PR.
- **Deploy slice:** carry-forward 1 (`verify-client-ip.sh` against the real edge).
- **5d:** carry-forward 2 (the hoarding cap).
- Close the chat and write your `LEARNING-LOG.md` paragraph (your words only). `LEARNING-LOG.md` is untouched.
