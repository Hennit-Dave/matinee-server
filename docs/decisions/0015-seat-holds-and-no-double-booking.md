# 0015 — Seat holds and the no-double-booking guarantee

Date: 2026-11-16 · Status: accepted · Decided by: Dave

## Problem

A seat must never be sold twice (RULES D5, the headline requirement, proven later by k6 with 500 users on the same 50 seats). Several decisions have to be made together, because each only makes sense next to the others:

1. **How is a seat held** while someone decides, so two people cannot both be told "it's yours"?
2. **What makes double booking impossible** if that hold is wrong, lost or Redis is down?
3. **When is the hold taken**, and for how long?
4. **What happens when Redis is down?** (Interview question 2.)
5. **Where do seat reads come from**, given a read replica that can lag? (RULES C2, read-your-own-writes.)
6. **Who is "the user"** while there is no login?

## Options

- **Taking the hold.**
  - **A. `SET key owner NX PX ttl` per seat in a pipeline, then undo the ones that worked if any failed.** Each `SET NX` is atomic on its own. The set of them is not: half-held seats are visible for a moment, the undo is a second round trip that can itself fail, and because pipelined commands run unconditionally two users who both want seats {a, b} can each win one seat and both fail. Safe, but wrong.
  - **B. One Lua script over all the seats.** Redis runs a script start to finish with nothing interleaved, so the whole request is one atomic step. Per seat it is still `SET ... NX PX`; if any seat is taken the script removes the keys it just set, before returning.
  - **C. Postgres row locks (`SELECT ... FOR UPDATE`) and no Redis hold.** Correct, but a held seat then ties up a database connection for the length of a hold (the pool is 5), and the brief asks for Redis locks (RULES B3, D5.1).
- **Seat reads.** Bookings from the primary always, or from the replica with read-your-own-writes.
- **Redis down.** Fail open (carry on without holds, rely on the database) or fail closed.

## Decision

1. **Two layers.** Redis is the fast path: it decides who may *try* to book a seat. Postgres `UNIQUE (showtime_id, seat_id)` on `bookings` is the final guard: it decides who *owns* it. The second layer does not trust the first. A booking is one row per seat, so the constraint sits on the row that represents the sale.
2. **Holds use option B.** One atomic Lua script takes every seat of a request or none (`hold:{<showtimeId>}:<seatId>` holding the owner's id, `SET NX PX`). Asking again for seats you already hold succeeds and does **not** restart the timer, so a retry is safe and the countdown stays honest. Release is a Lua compare-and-delete, never a plain `DEL` (RULES D5.8). The braces in the key are a hash tag, so every hold of a showtime would sit in one cluster slot if Redis is ever clustered (SHARDING.md).
3. **Holds are taken at checkout, not per tap.** The user picks seats on the device, then one call (`POST /showtimes/:id/holds`) starts the window. The window is **10 minutes** (AGENTS.md section 7, RULES D5.1: the default, so no deviation). The app's countdown starts at about 9:58 and turns urgent under 2:00 (Figma `Countdown`, 37:819). The response carries `expiresInMs` so the app counts down from the server's remaining time, not from a device clock.
4. **The order inside "take a hold" matters.** Validate the seats (they must belong to the showtime's screen), take the Redis hold, **then** check the primary for sold seats and give the hold back if there are any. Checking first and holding second would leave a gap in which a booking could commit and its hold lapse, and we would then hold a sold seat. A loser costs one Redis script and no booking query.
5. **Confirming** (`POST /showtimes/:id/bookings`) checks the caller holds every seat (fast, and turns "your hold ran out" into a clear 409), then does **one multi-row INSERT** (all seats or none). A unique-key refusal is a clean `409 seat_taken` naming the sold seats, never a 500. The hold check cannot make double booking impossible, because a hold can lapse a millisecond after it; the unique key does. The hold is left to expire on its own (see 7).
6. **Redis down fails closed.** Every hold operation refuses at once if the connection is not ready, refuses if Redis does not answer within 1 s (chosen, not measured), and treats any Redis error as a refusal: taking, releasing and confirming holds all answer `503 holds_unavailable` with `Retry-After: 2`, and the seat map answers `503` because we will not show seat state we cannot verify. Existing bookings are untouched in Postgres. This is the opposite of the movie cache, which fails open, on purpose. A Redis outage cannot double-book (layer two), and a Redis that comes back *empty* cannot either: two users can then both "hold" a seat, and the second confirm hits the unique key. Tested both ways.
7. **Read-your-own-writes, and an amendment to ADR 0014.** ADR 0014 said availability is never read from the replica. That is amended: **sold seats are read from the replica, except for 5 s after the caller's own booking, when they come from the primary** (RULES C2). This is safe because bookings are insert-only: a stale replica can only show a just-sold seat as free, never the reverse, and every authoritative check (taking a hold, confirming) uses the primary, so the cost is a refused tap. The lingering hold (it is not deleted on confirm) covers other users while the replica catches up, and `sold` outranks `held` once it does. "This user booked recently" is a Redis key with a TTL (`ryow:<userId>`), not process memory, so it is right with more than one API instance. In production the window should be sized from measured replica lag; 5 s is the course's rule and a comfortable multiple of Neon's typical lag, not a measurement. **Held seats are never cached**; they are read from Redis on every request.
8. **The user is a stand-in.** There is no auth yet, so each request carries `X-Client-Id` (a UUID the app generates once per install), validated by Zod and treated as the *owner* of holds and bookings (`bookings.owner_id`, the hold's value, the log's `userId`). It is a bearer value, not authentication: anyone who learns an id can act as it. Real auth replaces `src/http/clientId.ts` and the column; nothing else changes. The load test supplies 500 distinct ids.
9. **The direct booking route is temporary.** AGENTS.md section 4 says a booking is confirmed only by a verified webhook. That arrives with payments. Until then `POST /showtimes/:id/bookings` commits a hold directly with no payment, as an explicit, recorded stand-in. The durable unit is the service function `confirmBooking`: when payments land, the webhook job calls it and the route is removed. The late-webhook-after-expiry ADR (RULES D4.9) is written then, before that case is tested.

## Consequences

- **Easier:** the guarantee is two independent layers, each testable alone, and the hardest case (Redis wrong) is the database's job, not a clever Redis protocol. The suite includes five deliberate breakages of it, each caught (`docs/evidence/traffic-5a/mutation-checks.txt`).
- **Harder:** the seat map now needs Postgres plus Redis on every read, and it is the hot endpoint under load. Taking a hold costs one Redis script, one validation read and (for winners) one primary read; `PRIMARY_POOL_MAX` is 5, so the load test (5e) must measure whether that is enough.
- **Accepted, and written down so nobody is surprised:**
  - A command sent just before Redis drops can still run afterwards, leaving a "ghost" hold of at most 10 minutes for a caller who was told it failed. Scripts are idempotent for the same owner, so that caller asking again simply succeeds.
  - One client can take hold after hold, up to the whole room, 10 minutes each. A per-owner cap and the rate limits (RULES D5.4) arrive in slice 5c.
  - Bookings cannot be cancelled yet. Cancellation and refunds will need a status column and the unique key changed to a partial one (`WHERE status = 'confirmed'`).
  - The 1 s Redis deadline, the 5 s read-your-own-writes window and the pool size are chosen, not measured.
- **Revisit when:** auth exists (replace the stand-in), payments land (the webhook job replaces the route), or the load test shows the primary pool or the Redis deadline is wrong.
