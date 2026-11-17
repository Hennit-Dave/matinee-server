# 0018 — Hold caps: a limit on live held seats per install and per address

Date: 2026-11-17 · Status: accepted · Decided by: Dave (plan approved 2026-11-17, slice 5d)

## Problem

ADR 0015 and ADR 0016 both recorded the same open item: the rate limits slow hoarding, they do not stop it. One install may take
10 holds a minute of up to 8 seats, which is **80 seats** of a room for 10 minutes. The install id is a UUID the app makes up
(ADR 0015), so minting a new one is free, and one address can take far more (`docs/evidence/traffic-5d/hold-caps/before.txt`:
80 seats from one install, 40 from five installs behind one address, nothing refusing). RULES D5.4 asks for protection on hold,
and "one owner (or address) can't hold a whole room" is the point of the slice.

## Options

- **What to count.** (a) seats held right now; (b) holds taken per window (that is the rate limit again); (c) seats ever booked.
  Only (a) is "concurrent held seats", the thing that blocks other people.
- **How to count (a) without lying.** A hold is a key that Redis expires on its own.
  - **A counter** (`INCR` on hold, `DECR` on release): drifts the moment a hold expires, because expiry sends no event. Would need a job to repair.
  - **A sorted set scored by expiry time**: correct, but it trusts a clock (ours, not Redis's expiry) to agree with when the key really vanished.
  - **Scanning the hold keys** (`SCAN hold:{S}:*`): exact, but O(seats in the room) on every hold, and `SCAN` is not atomic with the hold.
  - **A small index of CANDIDATES that is checked against the keys it names**: exact by construction, O(the cap), atomic if it runs in the acquire script.
- **Where.** In the existing acquire script (one atomic step) or a check before it (a gap in which a storm gets through).
- **Which scopes.** Per install, per address, both; per showing or global.

## Decision

### 1. Two caps, per showing, judged inside the acquire script

| Cap | Default | Why this number |
|---|---|---|
| Live held seats **per install** per showing | **8** | `MAX_SEATS_PER_REQUEST`. A person can always hold what one booking needs, and no more. |
| Live held seats **per address** per showing | **16** | Room for a household with two phones. The install id is self-asserted (ADR 0016), so the address is the cap that cannot be dodged by minting ids. |

Both are per **showing**, not global: the point is that nobody holds a room. `0` turns one off. A global cap across showings is not
built (one install holding 8 seats in each of several showings is slowed by the hold rate limit and harms no single room); it is
revisited if the load test or real use says otherwise.

### 2. How it is counted: the key is the truth, the index only lists candidates

```
hold:{S}:<seat>            -> <owner>                    (the hold; Redis expires it)       [existing]
hold-owner:{S}:<owner>     -> SET { seatId, ... }
hold-addr:{S}:<address>    -> SET { "<owner>:<seatId>", ... }
```

The acquire Lua script, before it takes any seat: walks the owner's index; a member counts **only if its hold key still exists and
is owned by that owner**, and is removed from the index otherwise. Then the address index the same way. Then it compares
`live + new seats` to the cap. If it would pass, it returns `{3, scope, limit, held}` and **has written nothing**. Seats the owner
already holds are not "new", so asking again is free and a retry after a timeout is safe (ADR 0015's idempotence is kept).

Consequences of "the key is the truth":
- **A hold that lapses frees its slot with no timer, no job, no clock.** Redis's own expiry is the only authority. Proven with a
  real Redis and a short TTL (`holdCaps.integration.test.ts`).
- A hold released by compare-and-delete, or re-taken by someone else, is pruned at the next count. A release does not touch the indexes.
- Both indexes are written only on success and get a TTL equal to the hold TTL (renewed on every acquire), so an index always outlives
  every hold it lists and nothing the caps add can live forever (RULES C4).
- The cost is O(live holds of the owner, and of the address) GETs per acquire: at most the cap (8, or 16), a few hundred microseconds.

### 3. What refuses, and what the caller sees

`409 hold_limit_reached` in the usual envelope, with three extra fields: `scope` (`owner` or `address`), `limit` and `held`. No
`Retry-After`: waiting does not help a cap, releasing seats (or the holds lapsing) does. The app owns the wording. The cap is judged
**before** seat availability, so at the cap, asking for a seat someone else holds is a cap refusal, not `seat_taken` (pinned by a test).

The address is the one the rate limiter counts (`resolveClientAddress`, an IPv4 address or an IPv6 /64). If it cannot be resolved
(a proxy hop showing through, ADR 0016's safety net) the **address cap is skipped** for that request and the install cap still applies:
"off, loudly", never "everyone refused".

### 4. Failure mode: with the holds

The cap lives in the hold store, so it fails closed with it (ADR 0015): Redis down is `503 holds_unavailable`, never a request that
slips past the cap. (The waiting room, slice 5d PR 2, is the opposite and fails open; ADR 0017.)

### 5. The load test, and the traffic profile

The k6 test (slice 5e) sends 500 users from ONE address: the 16-seat address cap would refuse it before it measured anything.
`TRAFFIC_PROFILE=loadtest` lifts the **address** cap (and, later, the other limits that test cannot live with); the install cap stays,
because each virtual user is its own install. An explicit `HOLD_CAP_PER_ADDRESS` wins over the profile. The profile is never the
default, and a loud `traffic_profile_loadtest` warning is logged at boot. Settings (all optional, names in `.env.example`):
`HOLD_CAP_PER_OWNER`, `HOLD_CAP_PER_ADDRESS`, `TRAFFIC_PROFILE`.

## Consequences

- **Easier:** one atomic place decides everything about taking seats; a hoarder is stopped by the second request, not slowed.
- **Harder:** the acquire script is longer, and it reads keys it did not declare (see below).
- **Accepted, written down so nobody is surprised:**
  - **Shared addresses.** More than 16 seats wanted from one address (a venue's wifi, carrier-grade NAT, a family of two adults and a
    school trip) is refused with `scope: address`. ADR 0016's trade-off again. The numbers are chosen, not measured; 5e tunes them.
  - **Rotating addresses defeats the address cap**, exactly as it defeats the address rate limit. The install cap and the rate
    limits still apply per identity. Real auth makes the install cap a real boundary.
  - **A booking does not release its holds.** After `POST /bookings` the holds linger up to 10 minutes (ADR 0015: they cover the
    replica lag) and still count. A person who bought 8 seats cannot hold more for the same showing for those minutes. The payments
    chapter decides whether confirming releases them.
  - **Undeclared keys.** The script GETs hold keys it builds from the index members, which are not in `KEYS`. They all share the
    `{showtimeId}` hash tag, so they are in one cluster slot, and ADR 0008 runs one node, so this is correct today. If Redis is ever
    clustered the members must be passed in `KEYS`.
- **Revisit when:** the load test (5e) measures the acquire script's cost, real auth exists, or the payments chapter decides what a
  confirmed booking does to its holds.

## Evidence

`docs/evidence/traffic-5d/hold-caps/`: `before.txt` (the baseline: 80 seats from one install, 40 from one address), `after.txt`
(the same probe on the finished code, plus the gates), `mutation-checks.txt` (13 deliberate breakages, all caught).
