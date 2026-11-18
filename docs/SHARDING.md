# SHARDING.md — a sharding plan (plan only, no simulation)

RULES E3 asks for a plan: which tables shard, the shard key, the hot-shard risk (a single blockbuster
showtime), and the mitigation. This is reasoning, not a simulation — and the first line of the reasoning is
that **Matinee should not shard today**, because the load test shows it does not need to. The plan is what to
do when it does.

## Which tables shard: `bookings` only

- `Cinema`, `Screen`, `Seat`, `Showtime` are **bounded reference data** — a cinema chain has a few thousand
  seats, and showtimes grow slowly and are tiny rows. They stay **global (reference) tables**, replicated to
  every shard or held on a dedicated reference node.
- `bookings` is the only table that grows without bound and takes the writes. It is the only one to shard.

(The stand-in `owner_id`/`X-Client-Id` column is temporary; when real auth lands it becomes a `user_id`, and
a future `orders`/`ledger` table can follow the same key.)

## The shard key: `showtime_id`

Bookings are partitioned by `showtime_id` (a hash of it). The two access patterns that matter both key on it:

1. **"Which seats are sold for this showtime?"** — the seat map. Sharding by `showtime_id` makes it a
   single-shard query.
2. **The uniqueness check `(showtime_id, seat_id)`** — the guarantee that a seat is never sold twice. Sharding
   by `showtime_id` keeps that constraint a **plain local unique index** on one shard.

The whole stack is already consistent about this key: every Redis key for a showing uses a `{showtimeId}`
hash tag (holds, hold-cap indexes, the waiting room's keys — ADR 0015/0017/0018), so a clustered Redis would
co-locate a showing's state in one slot the same way. The partition key is the showtime, everywhere.

## The hot-shard risk (stated precisely)

A **single blockbuster showtime** routes 100% of its traffic to one shard: its seat-map reads, its holds, and
its bookings all land on one node while the others idle. The `UNIQUE (showtime_id, seat_id)` index also
hot-spots on its leading column. This is the classic "hot key / celebrity" problem, and it is real — but less
bad for Matinee than the textbook version, for three reasons that are already built:

1. **Redis absorbs the write contention.** The load test is the proof: 500 users fighting over 50 seats
   produce 450 refusals in Redis and only **50 writes** reach Postgres. The database sees winners, not the
   crowd, so the hot shard's write pressure is already divided by the hold layer.
2. **The waiting room, hold caps and per-showtime rate limits are all per-showtime.** They cap how many
   people *can* touch one showtime at once, by design. The waiting room is, in effect, the hot-shard
   mitigation already built: it bounds the concurrency a blockbuster showtime can reach.
3. **Reads scale via replicas.** The hot showtime's seat-map reads fan out to read replicas; only the
   (small) write load hits the shard's primary.

## The mitigation ladder

1. **Don't shard yet.** The load test shows one Postgres node absorbs a 500-VU burst on one showtime at p99
   ~24 ms. Sharding is a last resort; the trigger is a *measured* saturation of one node (writes, or the
   unique index), not a guess.
2. **Vertical first.** A larger node, the existing read replicas, and the pooled connections (ADR 0007) come
   before horizontal sharding.
3. **Celebrity shard.** If one showtime genuinely saturates its shard, pin that showing (a handful exist at
   once) to a dedicated, over-provisioned shard. Simple, and blockbusters are few.

## What we deliberately will *not* do

Sharding `bookings` by a high-cardinality key — `booking_id` or `reference` — would spread a blockbuster's
writes across *all* shards and "fix" the hot shard. It would also **break the guarantee this whole product
exists to keep**: the `(showtime_id, seat_id)` uniqueness and the seat-map query would fragment across every
shard, forcing a distributed constraint or a cross-shard scatter/gather for "which seats are sold". A seat
being sold twice is worse than a hot shard. So we keep the partition key on `showtime_id`, accept that one
hot showing is one hot shard, and mitigate the *load* (waiting room, caps, replicas, celebrity shard) rather
than moving the *key*.

## Same shape for Redis, if it is ever clustered

A clustered Redis would put one showing's keys in one slot (the `{showtimeId}` hash tag already does this).
The same hot-showtime consideration applies — one showing = one hot slot — with the same answer: the waiting
room bounds how many people touch it, and the hold caps bound what one caller can hold.

## Revisit when

Real auth lands (the `owner_id` column changes), payments add an `orders`/`ledger` table, a second cinema
chain becomes a tenant, or the load test against Railway shows a real saturation point.
