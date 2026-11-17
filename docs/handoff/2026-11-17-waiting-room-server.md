# Handoff: Waiting room and graceful overload, server side (branch `feat/waiting-room`)

Slice 5d, PR 2 of 3, **stacked on `feat/hold-caps` (server PR 1)**: it uses PR 1's owner hold index for "holders skip the line". Merge PR 1 first. Plan approved by Dave 2026-11-17 with one change: **no estimated wait** (people ahead only, to match Figma).

> ## CARRY-FORWARDS (do not lose these)
> 1. **DEPLOY SLICE: `WAITING_ROOM_MAX_ACTIVE` MUST BE RAISED FOR PRODUCTION.** It defaults to **2**, a demo value chosen so the queue can be shown on two or three phones. On a deployed server it queues everyone
>    behind two people for every showing. The server logs a loud `waiting_room_demo_defaults` warning at boot while the variable is unset, but a warning is not a fix: **set `WAITING_ROOM_MAX_ACTIVE` (and review `WAITING_ROOM_ADMIT_PER_MINUTE`, default 12) on Railway**
>    with a figure the 5e load test supports. Written in ADR 0017 (top), the README, `.env.example`, `config.ts`, and here.
> 2. **5e:** the k6 test needs `TRAFFIC_PROFILE=loadtest` (this PR already turns the waiting room and load shedding off under it) AND a scenario with the room ON (500 users against a small cap) for the D5.3 evidence. 5e also measures the two extra scripts on the hot
>    seat-map poll, the 150 ms deadline, and `MAX_IN_FLIGHT`, and adds the rate-limit scaling to the same profile switch.
> 3. **Push notifications are a later enhancement.** Figma promises "we'll tell you when it's your turn"; that needs a native module (new EAS build), an FCM credential and a job. The mobile PR will say "keep Matinee open" instead, as a deliberate Figma deviation.

## What changed
- **The room** (`src/waitingroom/`, ADR 0017). Per showing, five keys sharing the `{showtimeId}` hash tag, all with a TTL: active passes (membership IS the pass), a FIFO queue by ticket, waiter heartbeats, pass lifetimes, and a counter. **One atomic Lua script per call purges what lapsed, then counts**, so a closed app frees its slot by itself (30 s without a heartbeat), a waiter silent for 90 s loses their place, and no pass outlives 20 minutes. **Admission is lazy and at a fixed spacing** (inside join and poll): `n = min(free slots, admissions due, waiting)`, and after a long idle at most one. Someone let in from the queue has a 15 s claim window. A holder skips the line. The line has a 5,000 maximum.
- **What it gates:** `GET /showtimes/:id/seats` and `POST /showtimes/:id/holds` need a pass (`403 waiting_room_required`), checked after the rate limit and before the body is parsed. Not gated: releasing seats, booking, `/health`, every other read. **`X-Client-Id` is now required on the seat map** (it was optional; the app always sent it).
- **Routes:** `POST`, `GET`, `DELETE /showtimes/:id/queue`. Answers: `admitted { passExpiresInMs }`, `waiting { ahead, pollAfterMs }`, `not_queued`. **No estimated wait.** A showing that does not exist is a 404 (junk ids never become Redis keys). New `queue` rate-limit policy (60 a minute per install, 600 per address); leaving is not limited.
- **It fails open** (150 ms deadline, one `waiting_room_unavailable` warning per 10 s), like the rate limiter and unlike the holds.
- **Graceful overload:** an in-flight cap (`MAX_IN_FLIGHT`, 250) sheds with `503 server_busy` and a jittered `Retry-After` of 5 to 15 s (never `/health` or `DELETE`); database pool and connection errors (`P2024`, `P1001`, `P1002`, `P1008`, `P1017`) are the same 503 instead of a 500; `503 service_unavailable` now carries `Retry-After: 5`.
- **Settings** (all optional, names in `.env.example`): `WAITING_ROOM_ENABLED`, `WAITING_ROOM_MAX_ACTIVE` (default **2**, DEMO), `WAITING_ROOM_ADMIT_PER_MINUTE` (12), `MAX_IN_FLIGHT` (250). `TRAFFIC_PROFILE=loadtest` turns the room and shedding off. The numbers are logged at boot.
- **Docs:** ADR 0017, README sections ("Waiting room", "Graceful overload"), `docs/evidence/traffic-5d/waiting-room/` (with `probe.mjs` and `demo-fill.sh`). **No migration, dependency, service or secret.**

## What passed
- `npm run typecheck`, `npm run lint`: clean. Unit **336** (244 pass, 92 gated-skipped; PR 1 head was 262 / 203 / 59). Integration on a throwaway Postgres 16 and Redis: **93 of 93** (60 before, 33 new). Every commit passes on its own. `gitleaks` (history): no leaks.
- **On a real Redis with a moved clock** (`store.integration.test.ts`, 20): joining is instant while there is room; FIFO places 0, 1, 2 and a re-join keeps its place; **200 simultaneous joins to a room of 5 admit exactly 5 and give the other 195 distinct places**; the **exact fixed spacing** (one admission per interval, "one millisecond short admits nobody"); no burst after an hour idle; a silent pass lapses at 30 s and frees the slot; a heartbeat keeps a pass alive; the claim window; the 20-minute hard limit; patience; holders skip the line; the line maximum; only an admitted user has a pass; TTL on every key; and a **seeded property test** (600 random operations x 3 seeds: never over the cap, nobody in both places, the line in ticket order).
- **Over HTTP on the full stack** (11): 403 without a pass then 200 after joining; release and booking not gated; the line end to end; **the seat-map poll as the heartbeat** (polling past the window keeps the pass, going quiet loses it and the slot goes to the person waiting); a holder let back in ahead of the line; 100 users at a room of 5 admit exactly 5; the header requirement; disabled; and **three fail-open paths** (a store that throws, one that never answers, a real Redis write pause).
- **The tests can fail:** `mutation-checks.txt`, 28 of 28 caught. Writing them, the real Redis found **one genuine bug** (the touch script returned a bare integer the store rejected, so every pass check would have failed) and corrected **three of my own test set-ups** (waiters and passes lapse over long idle gaps, by design).
- **Against the real server** (`before.txt`, `after.txt`, same probe): before, joining is a 404 and **all 100 users read the seat map at once**. After: **2 in, 98 queued with 98 different places (0 to 97)**, refused the map; a short line drains one person per interval; **two silent users' slots were reclaimed at 30.2 s with no job**; with a tiny `MAX_IN_FLIGHT`, 75 of 80 requests were shed with `503 server_busy` and Retry-After spread across 5 to 15 s; the load-test profile turns the room off and all 100 read the map.

## A claim I had to correct
My first draft of the real-Redis-stall test said failing open means "the seat map is not held up". The run showed it is: the app has **one Redis connection**, so when the room's script blocks, the seat map's own read queues behind it and waits the stall out (a 700 ms write pause gave a 200 after about 700 ms, inside the hold store's 1 s deadline). Failing open stops the room **refusing** people; it does not make a stalled Redis fast. The test and ADR 0017 now say that.

## Decisions worth knowing (all in ADR 0017)
- **Gate every entry**, so there is no race at the cap; the room is invisible when quiet (join is instant with room).
- **The pass is server-side membership**, not a token: the caller's id is self-asserted anyway (ADR 0016).
- **Holders skip the line** (needs PR 1's owner index): someone mid-purchase whose pass lapsed on a phone call is not queued behind strangers with their seats held.
- **Residual risk of failing open:** in a *partial* failure the cap is not enforced and a surge reaches seats and holds (still protected by the unique key, the hold caps and the rate limits). It adds nothing to a full outage.
- **A locked phone loses its place after 90 s**, and there is no push to wake it (carry-forward 3).

## Unproven
- **Every number is chosen, not measured** (the 30 s, 15 s, 90 s, 20 min windows, 150 ms, `MAX_IN_FLIGHT`, the `queue` limits), and **a real overload** could not be produced on this machine: the shedding is shown with a deliberately tiny limit, not under genuine load. 5e measures. Railway's Redis version is assumed (the scripts use basic commands only; CI runs Redis 7).
- **The real Railway edge** (ADR 0016 carry-forward 1): the per-address limits (the `queue` policy, the address hold cap) rely on the same client-address resolution.
- **Several API instances** (clock skew only shifts a window edge by milliseconds; Railway runs one) and **Redis clustering** (the keys share a hash tag, but it was not tried).
- The mobile app does not yet know `waiting_room_required`, `server_busy` or the queue routes. **Until the mobile PR a deployed server with the room on would show the old app a 403 on the seat map**, so the two must ship together (or leave `WAITING_ROOM_ENABLED=false` until the mobile PR is in).

## Deferred (not built here)
- **Mobile PR (after PRs 1 and 2 merge):** the waiting-room screen (Figma `56:6607` and its variants, "people ahead" only), position polling, the hold-limit Toast, and the "We're very busy right now" countdown on the booking funnel.
- **5e:** the k6 load test, `TRAFFIC.md`, `SHARDING.md`. **Deploy slice:** carry-forward 1 above. **Later:** push notifications. **Payments chapter:** checkout and tickets, and whether a confirmed booking releases its holds.

## Next
- **Dave:** merge PR 1 (#25) first, then check CI here and **squash-merge**. After PR 1 merges I merge `main` into this branch so the diff shows only PR 2 (no force-push). No migration, **no environment variable required**; set `WAITING_ROOM_MAX_ACTIVE` in the deploy slice.
- Close the chat and write your `LEARNING-LOG.md` paragraph (your words only). `LEARNING-LOG.md` is untouched.
