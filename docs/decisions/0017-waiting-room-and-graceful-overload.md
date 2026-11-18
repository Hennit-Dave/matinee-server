# 0017 — Waiting room, graceful overload and why the waiting room fails open

Date: 2026-11-17 · Status: accepted · Decided by: Dave (plan approved 2026-11-17, slice 5d; D4 amended: no estimated wait)

> **OPEN ITEMS CARRIED FORWARD (read these first)**
>
> 1. **DEPLOY SLICE: `WAITING_ROOM_MAX_ACTIVE` MUST BE RAISED FOR PRODUCTION.** It defaults to **2**, a *demo* value, so the queue can be shown on
>    two or three phones in the demo video. On a deployed server that value queues everyone behind two people for every showing. The server logs a
>    loud `waiting_room_demo_defaults` warning at boot whenever the variable is unset, but a warning is not a fix: **set `WAITING_ROOM_MAX_ACTIVE`
>    (and review `WAITING_ROOM_ADMIT_PER_MINUTE`, default 12) on Railway in the deploy slice**, using a figure the 5e load test supports. Nothing
>    else in this ADR needs a production change.
> 2. **5e:** the k6 test runs with `TRAFFIC_PROFILE=loadtest` (this PR already turns the waiting room and load shedding off under it; the hold-cap PR lifts
>    the address cap; 5e adds the rate-limit scaling to the same switch). It also needs a scenario with the room **on** (500 users against a small cap) as
>    the D5.3 evidence. 5e measures the numbers this ADR chose: the cost of the two extra scripts on the hot seat-map poll, the 150 ms deadline, `MAX_IN_FLIGHT`.
> 3. **A later enhancement, not built:** push notifications ("we'll tell you when it's your turn"). The Figma frame promises it; it needs a native
>    module (a new EAS build), an FCM credential and a job. The app copy says "keep Matinee open" instead (mobile PR; a deliberate Figma deviation).

## Problem

RULES D5.3: when active users on a showing exceed a limit, new users queue and are admitted at a fixed rate, and the app shows queue position. RULES D5.7:
an overloaded server shows a clear message and a retry option, never a crash. Four things have to be decided together, because each only makes sense
next to the others: **what counts as "active"**, **how the line and its admission are kept** (and survive people vanishing), **what happens when the
line-tracker itself fails**, and **what "overloaded" means for a server that has no queue of its own**.

## Options

- **What the room gates.** (a) Only when the showing is "hot"; (b) **every** entry; (c) only holds. (a) races: two arrivals read "not hot" and both enter,
  past the cap. (c) lets the whole queue see and poll the map, which is the load. (b) is correct and simple at the cost of one extra call per entry.
- **What "active" means.** (a) any request in the last N seconds; (b) an *admitted* user heard from recently. (a) counts browsers that never queued.
- **How to track activity.** A key per user with a TTL (counting needs `SCAN`: O(all keys), not atomic); a counter (drifts: nothing is told when a
  key expires); or a **sorted set scored by last-heard time**, purged by score inside the same atomic script that counts.
- **How to admit at a fixed rate.** A worker or BullMQ job ticking every interval (one more thing that can fall behind or die), or **lazily inside join and poll** at a fixed spacing.
- **The pass.** A signed token the app carries, or **server-side membership** keyed by the caller's id.
- **Failure of the line-tracker.** Fail open (let people in) or fail closed (refuse them).
- **Overload.** Queue everything and hope; shed by event-loop lag; shed by an **in-flight cap**; map the database's own pool errors.

## Decision

### 1. Gate entry to seat selection, for every entry

`GET /showtimes/:id/seats` and `POST /showtimes/:id/holds` need a pass. **Not gated:** `DELETE /showtimes/:id/holds` (the cleanup path), `POST /bookings` (you
already hold the seats, which needed the pass), `/health`, every other read. The gate runs **after the rate limit and before the body is parsed**, so a flood
without a pass costs a header read and one Redis call (ADR 0016's ordering). Every entry goes through `POST /showtimes/:id/queue` first, which admits **at
once** when there is room: the room is invisible when quiet. `X-Client-Id` becomes **required** on the seat map (it was optional; the app has always sent it).

### 2. "Active" = admitted AND heard from within 30 s; the structures

```
wr:active:{S}  ZSET  owner -> last heard from (ms)       membership IS the pass
wr:queue:{S}   ZSET  owner -> ticket (HINCRBY wr:meta seq)  first in, first out
wr:seen:{S}    ZSET  waiter -> last polled (ms)
wr:since:{S}   ZSET  owner -> admitted at (ms)           the pass's hard lifetime
wr:meta:{S}    HASH  seq, lastAdmit
```
Every key carries the `{showtimeId}` hash tag and a TTL of `passMax + window` renewed on use (RULES C4). Every script **purges first, then counts, in one atomic
step**: passes silent for **30 s** (the heartbeat window; seat-map polls every ~5 s are the heartbeat, no extra traffic), passes older than **20 min** (nobody
camps a slot), waiters silent for **90 s** (a locked phone keeps its place that long). **A closed app frees its slot by itself.** No sweeper, no job.

### 3. The line: FIFO, a fixed spacing, position, and the pass

- **Join** (atomic): already admitted, or already queued, keeps its state and place (idempotent). Otherwise admitted at once if the line is empty and there
  is room; otherwise it takes the next ticket. A line past **5,000** refuses (503 `waiting_room_full`), which bounds Redis memory under abuse.
- **Admission is lazy and at a fixed spacing** (`interval = 60 s / WAITING_ROOM_ADMIT_PER_MINUTE`): inside join and poll, `n = min(free slots, admissions due, waiting)`
  heads are let in and `lastAdmit` advances by `n * interval`, not to "now", so the rate is exact over time. After a long quiet spell **at most one** is due
  (clamped), never a burst. A real Redis and a moved clock pin the exact spacing, including "one millisecond short admits nobody".
- **Position** is `ZRANK`: **`ahead`** = people in front of you (0 = you are next). The API gives `ahead` and a server-chosen `pollAfterMs` (3 s for the first 20,
  then +100 ms per extra person, up to 15 s), and **no estimated wait**: the fixed rate gives only a lower bound (a full room admits nobody until someone leaves), and
  a time that is often wrong is worse than none (Dave, D4).
- **The pass is server-side membership.** The caller's id is self-asserted anyway (ADR 0016), so a signed token would protect nothing. It lasts while heard from;
  a lapsed pass gets `403 waiting_room_required` and the app re-joins (instant if there is room), so a normal user is never re-queued.
  Someone let in from the queue gets a short **15 s claim window**: if their app never shows up the slot goes to the next in line quickly.
- **Holders skip the line.** If the owner still holds live seats here (their pass lapsed while they were on a call), a re-join admits them at once, even over the cap:
  making someone mid-purchase queue behind strangers while their seats stay held helps nobody. (Uses `heldCount`, which trusts the hold keys, ADR 0018.)

### 4. It fails open, and what that costs

|  | Seat holds (ADR 0015) | Hold caps (ADR 0018) | Rate limiter (ADR 0016) | **Waiting room (this ADR)** |
|---|---|---|---|---|
| Protects | who owns a seat | one person holding a room | capacity | **capacity (how many choose at once)** |
| Redis error, not ready, or no answer | **refuse** (503) | **refuse** (with the holds) | let through | **let through** |
| Deadline | 1 s | 1 s | 150 ms | **150 ms** (chosen, not measured) |

A room error, an unconnected Redis, or no answer within 150 ms lets the user in and logs one `waiting_room_unavailable` warning per 10 s. **Residual risk, written
down:** in a *partial* failure (the room's script slow while the rest of Redis works) the cap is not enforced and a surge reaches seats and holds; they are still
protected by the unique key, the hold caps and the rate limits, but the capacity protection is gone for that window. It adds **nothing** to a full outage: seats and holds need Redis
too and are refused (ADR 0015) whatever the room does. **Failing open also does not make a stalled Redis fast:** the app has one Redis connection, so the seat map's own read queues
behind a blocked script and waits the stall out (measured: a 700 ms write pause gives a 200 after about 700 ms, inside the hold store's 1 s deadline). After a Redis restart
or flush everyone re-joins; the first N get in and the rest queue.

### 5. Graceful overload (RULES D5.7)

- **Load shedding:** more than `MAX_IN_FLIGHT` (default **250**, chosen not measured) requests in flight in the process are refused **at once** with `503 server_busy` and a **jittered
  `Retry-After` of 5 to 15 s**, so refused clients do not all come back in the same second. Never shed: `GET /health` and every `DELETE` (releasing seats and leaving the line free capacity). `0` turns it off.
- **The database's own overload** (Prisma pool timeout `P2024`, unreachable `P1001`/`P1002`, `P1008`, `P1017`) becomes the same `503 server_busy` instead of a 500; every other unexpected error is still a 500 and its message is never sent.
- `503 service_unavailable` (the seat map with Redis down) now carries `Retry-After: 5`, so the app can count down instead of guessing.
- The app's side is the Figma frame "We're very busy right now ... Try again now / Trying again in 0:14" on the booking funnel (the mobile PR).

### 6. The numbers, and how to trigger it

| Setting | Default | Why |
|---|---|---|
| `WAITING_ROOM_MAX_ACTIVE` | **2 (DEMO; raise for production, see the top)** | the queue must be showable on two or three phones |
| `WAITING_ROOM_ADMIT_PER_MINUTE` | 12 (one per 5 s) | slow enough to watch |
| `WAITING_ROOM_ENABLED` | true | `TRAFFIC_PROFILE=loadtest` turns it off |
| `MAX_IN_FLIGHT` | 250 | not measured; 5e |
| heartbeat window / claim window / waiter patience / pass lifetime / max line | 30 s / 15 s / 90 s / 20 min / 5,000 | constants in `src/waitingroom/config.ts`, each with its reason |

To show it: start with `WAITING_ROOM_MAX_ACTIVE=1`, open the same showing on each phone. The first is in; the others are "0 ahead" and "1 ahead"; when the first leaves, the
next is let in within about one admission interval. `demo-fill.sh` fills a room with synthetic users so **one phone** can show a long line counting down.

## Consequences

- **Easier:** one atomic place decides who is in and who waits; nothing needs a worker; a vanished user cleans up after themselves; the load test has one switch.
- **Harder:** every seat-map poll now also runs the touch script (one more `EVALSHA` on the hot route, next to the limiter's), and joining runs two Redis calls. 5e measures this.
- **Accepted, written down so nobody is surprised:**
  - **The install id is self-asserted** (ADR 0016): a scripted client can open many queue places. Bounded by the `queue` rate limit (60 a minute per install, 600 per address),
    the 90 s patience (ghosts leave the line), the 5,000 cap, and the claim window (ghosts let in lapse in 15 s). Real auth makes the line mean one person per place.
  - **A shared address** with many people waiting (a venue's wifi, carrier-grade NAT) can pass the address limit on the queue polls and see a 429 (the app already waits out `Retry-After`).
  - **A locked phone loses its place after 90 s**, and there is no push to wake it (item 3 at the top).
  - **Lazy admission** means a waiter learns they are in at their next poll (up to `pollAfterMs`), not the instant a slot frees.
  - **An unclaimed pass wastes a slot for up to 15 s**; a heard-from pass that then goes silent, up to 30 s.
  - **One instance's clock.** The scripts take the API process's clock (so tests can move time); with several API instances the clocks differ by milliseconds, which only shifts a window edge. Railway runs one.
  - **One Redis node** (ADR 0008): every key of a showing shares a hash tag, so this would also work clustered.
- **Revisit when:** the deploy slice sets the real cap, the load test measures the scripts and the shedding threshold, real auth exists, or push notifications are built.

## Evidence

`docs/evidence/traffic-5d/waiting-room/`: `before.txt` (the baseline: no line, 100 users read the map at once, no shedding), `after.txt` (the same probe on the finished code: 2 in, 98 waiting with 98
different places, the drain, the silent users reclaimed at 30 s, the shedding, the load-test profile), `mutation-checks.txt` (28 breakages, all caught), `probe.mjs`, `demo-fill.sh`.
