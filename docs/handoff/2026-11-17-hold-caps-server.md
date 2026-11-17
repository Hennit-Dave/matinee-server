# Handoff: Per-owner and per-address hold caps, server side (branch `feat/hold-caps`)

Slice 5d, PR 1 of 3 (server PR 1, then server PR 2 = the waiting room, then the mobile PR; server first, per AGENTS.md). Plan approved by Dave 2026-11-17: 8 held seats per install and 16 per address, per showing, not global.

## What changed
- **The cap, inside the existing atomic acquire script** (`src/bookings/holdStore.ts`, ADR 0018). Two SET indexes list the seats an owner, and an address, took. An index is only a list of CANDIDATES: a member counts only while its hold key still exists and belongs to the member's owner, so **a hold that lapses frees its slot with no timer, no job and no clock**; released or re-taken holds are pruned the same way. Seats the owner already holds are not "new" (asking again is free). The caps are judged before any seat is touched, so a refused request writes nothing.
- **`409 hold_limit_reached`** (`src/http/errors.ts`) in the usual envelope with `scope` (`owner`/`address`), `limit` and `held`. No `Retry-After` (waiting does not help a cap).
- **The address** is the one the rate limiter counts (`resolveClientAddress`), passed by the route. If it cannot be resolved (ADR 0016's proxy safety net) the address cap is skipped for that request and the install cap still applies.
- **Settings** (`src/bookings/holdCaps.ts`, validated at boot; a bad value stops the server): `HOLD_CAP_PER_OWNER` (default 8), `HOLD_CAP_PER_ADDRESS` (default 16), 0 turns one off; and **`TRAFFIC_PROFILE`** (`src/traffic/profile.ts`), the one boot switch the k6 test (5e) will use to relax every limit at once. `loadtest` lifts the address cap now (500 test users share one address) and logs a `traffic_profile_loadtest` warning at boot. An explicit variable beats the profile.
- **Docs:** ADR 0018, a README section, `.env.example` (names only), `docs/evidence/traffic-5d/hold-caps/`.
- **No migration, no new dependency, no new service, no secret.** Three optional environment variables. **The defaults are right for production; nothing has to be set on Railway for this PR.**

## What passed
- `npm run typecheck`, `npm run lint`: clean. Unit: **262 tests, 203 pass, 0 fail, 59 skipped** (main was 224 / 182 / 42). Integration on a throwaway Postgres 16 and Redis: **60 of 60** (43 before, 17 new). Every commit passes on its own. `gitleaks` (history): no leaks.
- **On a real Redis** (`holdCaps.integration.test.ts`): the exact numbers (8 allowed, the 9th refused with what is held), "5 then 3 is fine, one more is not", a request that would cross the cap holds **none** of its seats, a lapse frees the slot (real TTL), a lapsed hold re-taken by someone else is not counted against the first owner, a release frees address slots although it does not touch the address index, **100 simultaneous single-seat requests from one install hold exactly 8**, **100 installs behind one address take exactly 16**, a request refused for a taken seat leaves no index entry, the cap is judged before availability, every index key has a TTL, the HTTP 409 body.
- **The tests can fail:** `mutation-checks.txt`, 13 of 13 caught. One was missed at first (the address-index freshness check, which cannot be seen through expiry because the index expires with the holds); I added the two release tests that distinguish it.
- **Against the real server** (`before.txt`, `after.txt`, same probe): before, one install held **80** seats and five installs behind one address held **40**, nothing refusing. After, one install holds 8 (every further request is `409 hold_limit_reached`, scope owner) and one address holds 16 (the third install is refused, scope address). With `TRAFFIC_PROFILE=loadtest` the address cap is lifted, the install cap is not, and the boot log warns.

## Decisions worth knowing (all in ADR 0018)
- **Per showing, not global.** One install can hold 8 seats in each of several showings (slowed by the hold rate limit, harms no single room). A global cap is deferred.
- **A booking does not release its holds**, so for up to 10 minutes after `POST /bookings` the seats still count against the caps. Someone who bought 8 cannot hold more for that showing for those minutes. The payments chapter decides whether confirming releases them.
- **A shared address** with more than 16 seats wanted (a venue's wifi, carrier-grade NAT) is refused with `scope: address`: ADR 0016's trade-off again. Rotating addresses defeats the address cap just as it defeats the address rate limit.
- **The cap fails closed with the holds** (Redis down is `503 holds_unavailable`). The waiting room (PR 2) is the opposite and fails open.
- **Undeclared keys in the Lua** (the script GETs hold keys it builds from the index members, not listed in `KEYS`). Correct on one node (ADR 0008) because they share the `{showtimeId}` hash tag; if Redis is ever clustered those members must be passed in `KEYS`.

## Unproven
- **Every number is chosen, not measured** (8, 16, the script's cost: one extra index read per hold), and **Railway's Redis version** is assumed (the script uses only basic commands: `SMEMBERS`, `GET`, `SREM`, `SADD`, `SET NX PX`, `PEXPIRE`; CI runs Redis 7, local was Redis 8). 5e measures.
- **The real Railway edge** (ADR 0016 carry-forward 1): the address cap relies on the same client-address resolution, so it is unproven there until `verify-client-ip.sh` runs against the deployed API in the deploy slice.
- The mobile app does not yet know `409 hold_limit_reached`: until the mobile PR it shows the server's raw message as an ordinary refusal (`rejected`). Nothing breaks.
- A working-tree `gitleaks --no-git` scan was not used as evidence: it also reads the git-ignored `.env`. (It flagged that file and two old, untouched test fixtures with fake keys; history is clean.)

## Deferred (not built here)
- **PR 2:** the waiting room, graceful overload and load shedding. **Mobile PR:** the waiting-room screen, the hold-limit Toast and the overload countdown, after both server PRs merge.
- **5e:** the k6 load test (`TRAFFIC_PROFILE=loadtest`, plus the rate-limit scaling that profile will also lift), `TRAFFIC.md`, `SHARDING.md`. **Payments chapter:** whether a confirmed booking releases its holds.

## Next
- **Dave:** check CI, then **squash-merge** (no migration, no environment variable needed). Server PR 2 is stacked on this one and I will open it next.
- Close the chat and write your `LEARNING-LOG.md` paragraph (your words only). `LEARNING-LOG.md` is untouched.
