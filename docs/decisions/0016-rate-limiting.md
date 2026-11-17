# 0016 — Rate limiting: sliding window, per install and per address, fail open

Date: 2026-11-17 · Status: accepted · Decided by: Dave (plan approved 2026-11-17)

> **OPEN ITEMS CARRIED FORWARD (read these first)**
>
> 1. **`docs/evidence/traffic-5c/verify-client-ip.sh` MUST be run against the REAL Railway edge in the deploy slice.** Nothing about Railway's client-address headers has been observed on Railway: no API was deployed when this slice was built. The only proof so far is a local stand-in for the edge (`verify-client-ip-rehearsal.txt`). Until the real run is saved as `docs/evidence/traffic-5c/railway-edge-check.txt`, "per-IP limiting is correct behind Railway" is **unproven**. If it fails, the address limit is either dodgeable or off; see "Client address behind a proxy" for what to change.
> 2. **The per-owner hoarding cap is DEFERRED TO SLICE 5D, not dropped.** ADR 0015 said it would arrive with the rate limits; this slice's brief did not include it, and Dave decided to carry it. It is an explicit open item for 5d (see "Hoarding" below).

## Problem

RULES C5 and D5.4: rate limits live in Redis, never in memory, per user and per IP, strict on hold, checkout and search. Three further things had to be decided with them, because each only makes sense next to the others:

1. **Which algorithm**, and how wrong is it allowed to be?
2. **What happens when the limiter's own Redis call fails?** (The opposite question to ADR 0015's, and the answer is deliberately different.)
3. **Who is "the IP" behind Railway's proxy**, so users are neither collapsed into one address nor able to forge one?

## Options

- **Algorithm.**
  - **A. Fixed window**: one counter per window. Trivial, but forgets everything at the boundary: `max` requests at the end of one window and `max` at the start of the next are twice the limit in a moment.
  - **B. Sliding log**: a sorted set of timestamps per caller. Exact, but memory and work grow with the limit, per caller, per route.
  - **C. Sliding window counter (weighted)**: two counters per caller, the current window and the previous one, blended by how far into the current window we are. Close to B for ordinary traffic at the cost of two integers.
  - **D. Token bucket**: smooth, allows bursts by design. Dave chose a sliding window over this (and over A) before planning.
- **Atomicity and scopes.** One script per scope (user, then address), or one script per request covering both.
- **Redis failure.** Fail open or fail closed.
- **Client address.**
  - **E.** `trust proxy = <hop count>` and read `X-Forwarded-For`.
  - **F.** Read Railway's documented `X-Real-IP`.
  - **G.** `trust proxy` by **address range**.

## Decision

### 1. Sliding window counter (option C), and it is an approximation

For a request at time `t` in window `w`: `estimate = previous × (windowMs − elapsed) / windowMs + current`, allowed when `estimate + 1 ≤ max`. It assumes the previous window's requests were spread evenly across it.

**What the approximation costs.** It is not an exact limit over every span of one window. The worst case is **2× `max` inside a span just under one window**, for a caller who times one burst at the very end of a window and another at the very end of the next. A fixed window has that hole too. What the blend closes is the natural exploit, a burst straddling the boundary, which a fixed window lets through at 2× and this refuses (`window-slide.txt`: 10 admitted against the fixed window's 20, over the same 6 seconds). Both facts are pinned by tests (`slidingWindow.integration.test.ts`, including a test named KNOWN LIMIT that fails if the algorithm changes), and a seeded property test checks that no window admits more than `max` and no one-window span more than 2× `max`.

**Why that is acceptable.** These are *abuse* limits with large headroom over real use (the limits table), not billing quotas or a contractual SLA. The exact alternative (B) costs a sorted set per caller per route and gains nothing the headroom does not already give. If a limit ever has to be exact, that is the time to switch to B.

### 2. Per install AND per address, one atomic script, a refusal writes nothing

Every guarded request is judged against two counters at once and must be under **both**. They are judged in **one Lua script** (so there is no read-then-write gap, and the whole decision is one atomic step), and a request refused by either is written to **neither**. That means refused traffic costs nothing and cannot extend its own lock-out, and an address that is over its limit does not also use up the innocent install's budget. If both trip, `Retry-After` is the longer wait.

- **Key shape:** `rl:<policy>:u:<clientId>:<window>` and `rl:<policy>:ip:<address>:<window>`, `window = floor(now / windowMs)`. Every key is written with a TTL of two windows (RULES C4), so one outlives its own window exactly as long as it is needed as "the previous window".
- **Clock:** the API process's `Date.now()`, passed to the script, not Redis `TIME`. A test can then move time without sleeping. With several API instances their clocks differ by milliseconds, which only shifts a window edge by that much. (Railway runs one instance today.)
- **Redis topology:** one node (ADR 0008). If Redis were ever clustered, the keys of one check would need a shared hash tag.
- **The install id is not a security boundary.** `X-Client-Id` is a UUID the app makes up (ADR 0015); anyone can mint another. The per-install limit protects an install from itself and a household from one noisy phone. **The address limit is the real backstop**, which is why it is higher than the install limit (room for a shared address) and not lower.
- **IPv6** is counted by its **/64** (one host can use any address in its /64, so per-address counting would be free to dodge); IPv4-mapped IPv6 becomes plain IPv4. A household with a larger prefix can still rotate between /64s: a known limit.
- **No client id** (search does not require one): only the address is counted.

### 3. The limits (all 60 s windows; CHOSEN, NOT MEASURED, 5e's load test tunes them)

| Policy | Route | Install | Address | Why |
|---|---|---|---|---|
| `seatsPoll` | `GET /showtimes/:id/seats` | 60 | 300 | The app polls every 5 s ±20 % (4 to 6 s): 10 to 15 a minute. Install = 4× the peak (pull-to-refresh, resume refresh, a retry). Address = 20 devices at peak. A scraper above 1/s per id or 5/s per address is cut. A test (`policies.test.ts`) keeps this above the real cadence. |
| `hold` | `POST /showtimes/:id/holds` | 10 | 40 | One request per Continue tap, retries paced by `Retry-After`: about 3 a minute honest. Address = about 13 people. |
| `booking` | `POST /showtimes/:id/bookings` | 5 | 20 | One per purchase. |
| `search` | `GET /movies/search` | 60 | 180 | 300 ms debounce: a slowly typed 9-letter title is ~9 requests in 4 s, three titles a minute ~27. |

Not limited: `GET /health` and every other read (RULES), and **`DELETE /showtimes/:id/holds`**: releasing seats is the cleanup path (the app releases when the user leaves the screen) and a 429 there would leave seats held for the full 10 minutes. It is owner-only and cheap.

### 4. Where it sits, and the 429 contract

`clientIdHeader` → **`limit('<policy>')`** → `jsonBody` → `validateRequest` → handler. The limiter runs before the body is parsed and validated, so a flood costs a header read and one Redis call, not a JSON parse and a Zod run. A request with a *malformed* client id is a 400 before the limiter (cheap, no Redis). It is a factory: `limit(name)` takes a policy name from one table (`src/ratelimit/policies.ts`); `createApp` requires a `rateLimiter` dependency, so forgetting it is a compile error, not a server with silently no limits.

A refusal is `429` with `{ error: { code: "rate_limited", message, requestId } }` and **`Retry-After`** in whole seconds, at least 1: the earliest moment a retry could pass if nothing else is admitted meanwhile, rounded up. Which counter tripped goes in the request log line (`policy`, `scope`: `user`, `ip` or `user+ip`), never in the body, and the address is never logged.

### 5. Fail open here, fail closed on holds (the contrast)

| | Seat holds (ADR 0015) | Rate limiter (this ADR) |
|---|---|---|
| What it protects | correctness: who owns a seat | capacity |
| Redis down, not ready, or error | **refuse**: `503 holds_unavailable`, `Retry-After: 2` | **let the request through** |
| Deadline on one Redis call | 1 s | **150 ms** (chosen, not measured) |
| Why | a wrong guess about who holds a seat costs more than a refusal (ADR 0015) | if the protector breaks and we refuse everything, a Redis blip becomes a full outage of the thing it protects |

Holds and bookings **still fail closed on their own Redis path**: with Redis down, `POST /holds` passes the limiter and is then refused by the hold store (`503 holds_unavailable`), and the seat map is still a 503. Tested end to end. The cost, accepted: **while Redis is down nothing is rate limited.** The unique key and the closed hold path still guard seats; what is exposed is search (TMDB quota) and polling load, and the seat map is down anyway. An outage is one `rate_limit_unavailable` warning per 10 s, not one per request.

### 6. Client address behind a proxy: trust by range, not by hop count

Behind Railway the socket address is the proxy's, and the caller's arrives in a header. Two ways to get it wrong, and they fail differently: trust too little and everyone is "the proxy" (one shared bucket: an outage); trust too much and a caller writes their own address (a free bypass).

**Why not a hop count (option E).** Researched 2026-11-17 (sources below): Railway's own docs (Specs & Limits) document **only `X-Real-IP`**, and say the spec may change at any time. Nothing published gives a hop count or proxy ranges. A Railway staff answer says the edge strips `X-Forwarded-For`, "the first value is the real connecting IP", and "you may see another hop"; a community answer in the same thread says it appends and only the rightmost value can be trusted; a moderator says the edge overwrites it and that the proxy range seen (100.64.0.0/10) is "not a stable range". A number nobody can justify fails one way or the other.

**What we do (option G).** `trust proxy` is the list `loopback, linklocal, uniquelocal, 100.64.0.0/10`: addresses a proxy hop can have and a public caller never can. Express walks `X-Forwarded-For` from the right and stops at the first address not in that list, which is the caller. It does not matter how many hops there are, or whether the edge replaces or appends, because anything a caller forges sits to the *left* of what the edge adds. Option F (`X-Real-IP`) was not chosen as the primary because it needs the same "is the peer really the edge?" trust decision to be safe, and ties the code to one host (ADR 0009 keeps Oracle as the fallback); `clientIp.ts` is one function, so switching is a small change if the deploy check says to.

**The safety net.** If the resolved address is itself in `100.64.0.0/10` (or IPv6 unique-local `fc00::/7`, how a private IPv6 hop would look), a proxy hop is showing through, because the ranges changed or the headers did. We do **not** count it: the address counter is skipped for that request (the install counter still applies) and a `client_ip_unresolved` warning is logged. The failure is "the address limit is off, loudly", not "everybody is refused". (This extends the plan's `100.64.0.0/10` by the IPv6 unique-local range, for the same reason.)

**How it was verified, and what was not:**
- Express's `req.ip` logic read in `proxy-addr@2.0.8`, and pinned by tests for every peer and header shape that matters, with the real trust list (`clientIp.test.ts`).
- The real app behind a real HTTP proxy that behaves both ways Railway is described (replace, append), with forged `X-Forwarded-For` and `X-Real-IP` and forged "hop-looking" values: the caller is always the real address, and two callers stay two keys.
- `verify-client-ip.sh` rehearsed against that stand-in: passes in both modes, fails the same-address control, and fails when the API is deliberately broken (`trust proxy = true`).
- **NOT verified: Railway itself.** See open item 1.

**What a trusted peer can do, accepted.** A peer inside the trusted ranges (another service in the same Railway project, or loopback in local development) can set `X-Forwarded-For` and be believed. Private networking skips the edge's header cleanup, and the project's other services are ours.

Sources: [Railway Specs & Limits](https://docs.railway.com/networking/public-networking/specs-and-limits) · [forum: hop count and header handling](https://station.railway.com/questions/security-critical-questions-on-edge-prox-8fddd775) · [forum: which headers the edge sets](https://station.railway.com/questions/which-client-address-headers-does-the-ra-fb9e36d7).

## Consequences

- **Easier:** one table of limits, one line per route; the arithmetic is one script with pinned numbers; the proxy question has a safety net, a black-box check and a rehearsal.
- **Harder:** every guarded request costs one Redis `EVALSHA` (including the seat map, the hot polled route). 5e measures it.
- **Accepted, and written down so nobody is surprised:**
  - The sliding window is approximate (2× worst case, section 1).
  - Shared addresses (a venue's wifi, **carrier-grade NAT**) can put more people behind one address than the address limits allow. They get a 429 with `Retry-After`, which the app shows.
  - A caller who rotates `X-Client-Id` evades the install limit; only the address limit holds (section 2). A caller who rotates addresses or /64s evades that one. Real auth makes the install limit meaningful.
  - No rate limiting while Redis is down (section 5).
  - The 150 ms deadline and every number in the limits table are chosen, not measured.
  - **The k6 load test (5e) sends 500 users from ONE address, which the address limits will refuse.** 5e needs a way to lift or scale the limits for that run; it is not built here.
  - **Hoarding.** Rate limits slow seat hoarding, they do not stop it: one install can still take 10 holds a minute of up to 8 seats (80 seats), and one address 40 a minute (320 seats, a whole room) with rotating install ids. **A cap on live seats per owner per showtime (and what to do about one address) is open for 5d**, together with the waiting room, which limits who is active on a showtime at all.
  - **Auth routes are not limited** (login, password reset): Matinee has no auth yet.
- **Revisit when:** the deploy slice's real-edge check runs (open item 1), real auth exists (the install limit becomes a real boundary), or 5e measures the numbers, the deadline and the per-request Redis cost.

## Evidence

`docs/evidence/traffic-5c/`: `before.txt` (the baseline: 700 requests, no 429), `429-retry-after.txt` (a real 429 with `Retry-After` from the running API), `window-slide.txt` (sliding against fixed, same traffic), `mutation-checks.txt` (seven deliberate breakages, all caught), `verify-client-ip.sh` and `verify-client-ip-rehearsal.txt`.
