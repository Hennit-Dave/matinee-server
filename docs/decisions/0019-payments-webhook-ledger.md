# 0019 — Payments: webhook-confirmed, background-job, idempotency, append-only ledger

Date: 2026-11-18 · Status: accepted · Decided by: Dave (plan approved 2026-11-18; table name `orders`)

## Problem

Matinee needs ticket checkout in Stripe test mode (RULES D4, ADR 0001). Several things have to be decided together,
because each only makes sense next to the others: **what confirms a booking**, **how a webhook is trusted**, **how the
same payment is never charged twice**, **how the money is recorded**, and **what happens when the payment arrives after
the hold expired** (interview J5). The traffic chapter already built `confirmBooking` (the durable hold→booking commit,
ADR 0015) and the direct `POST /bookings` route as a temporary stand-in; this slice is the real path.

## Decision

### 1. A booking is confirmed ONLY by a verified webhook, processed in a background job (RULES D4.4)

`POST /showtimes/:id/checkout` creates a Stripe PaymentIntent and returns its `client_secret`; it does NOT book. The
booking happens when Stripe's `payment_intent.succeeded` webhook arrives: the API verifies it, records the event id, enqueues
a BullMQ job and returns 200 fast; the job calls the existing `confirmBooking`. The direct `POST /bookings` route stays as
the load-test shell (no payment, generates its own reference) and is the only remaining path that books without a webhook.

### 2. Two idempotency mechanisms, both built (RULES C7, D4.3)

- **Checkout idempotency key** (`Idempotency-Key` header): the client retries and gets the SAME PaymentIntent, never a second
  charge. Stored as `orders` `(owner_id, idempotency_key)` unique, scoped per caller; the Stripe create call is namespaced
  (`<owner>:<key>`). A key reused with DIFFERENT seats is a `409 idempotency_mismatch`.
- **Webhook event-id dedup** (`processed_stripe_events`, `event_id` primary key): the event id is recorded durably FIRST,
  before the 200, so a re-delivered event is skipped. Only `payment_intent.succeeded` is enqueued; other event types are
  recorded and acked.

### 3. The data model (three new tables; `bookings` unchanged)

- **`orders`** — the PaymentIntent ↔ held seats ↔ owner ↔ idempotency key. `reference` (unique) is the order id and becomes
  `bookings.reference` on success, so the charge, the order and the seat rows share one id. Prices are captured at checkout
  (a later price change cannot touch an in-flight order).
- **`ledger_entries`** — the append-only financial record: one row per money movement (`charge` / `refund`), `amountCents`
  always positive, `stripe_object_id` unique (a retried job can never record the same Stripe object twice). NEVER updated or
  deleted; corrections are new rows. The order's net position and status are rebuildable from it.
- **`processed_stripe_events`** — the webhook dedup + audit trail; `status` (`received` → `processed`/`failed`) is metadata,
  not money.

### 4. One BullMQ queue, one worker, on Railway Redis (ADR 0008, C6)

One `payments` queue, one worker handling every job kind (ADR 0008's mitigation). The worker is a SEPARATE always-on process
(`src/jobs/worker.ts`, `npm run worker`) — the API only enqueues. Retries: 5 attempts, exponential backoff, then the job moves
to BullMQ's failed set (the "failed list"). It runs on the same Railway Redis as the rest of the app, via a BullMQ-specific
connection (`maxRetriesPerRequest: null`) — never the Upstash "Jobapplicationmanager" DB, and Railway Redis stays
no-public-access.

### 5. NEVER cache payment status or webhook idempotency records (RULES C4)

`orders.status`, `ledger_entries` and `processed_stripe_events` live in Postgres only. Redis is only the queue transport; the
money truth is Postgres + Stripe.

### 6. The "paid but the hold expired" reconciliation (J5)

The job, for a succeeded payment: resolve the order, record the charge (the money has already moved), then `confirmBooking`
with the order's reference. If that throws `seat_taken` OR `seat_not_held` (the hold lapsed), refund the PaymentIntent
(idempotent Stripe key `refund_<pi>`) and record the refund in the ledger with a distinct reason — `hold_expired_refund` for a
seat sold to someone else, `hold_lapsed_refund` for a seat still free but no longer held. **Never double-book, never keep the
money.** Re-holding a still-free seat is deliberately deferred to P3.

### 7. Retry-safe idempotency (the hazard this ADR exists to close)

A BullMQ retry can land between "bookings inserted" and "status updated". Three guards make it converge: (1) `confirmBooking`
takes the order's `reference` and replays the existing booking instead of re-inserting; (2) the ledger's unique
`stripe_object_id` makes a re-recorded charge/refund a no-op; (3) the order's `status` short-circuits an already-handled order.
A retry at any point never double-charges, never double-books, never double-refunds.

### 8. Service fee

A flat **`SERVICE_FEE_CENTS = 150`** (£1.50) is added once per order, server-side (`src/payments/config.ts`). `total = Σ seat
prices + 150`, computed and formatted on the server (RULES A3, D4.2).

## Consequences

- **Easier:** the durable booking unit is unchanged (`confirmBooking`); the direct route and the webhook job share it. The
  Stripe shape is hidden behind one `PaymentGateway` (`src/payments/stripe.ts`, the TMDB rule), so a second provider stays
  possible and the engine is unit-tested with a fake.
- **Harder:** the webhook must receive the RAW body (signature verification), so it is `express.raw` on that route only and
  bypasses the JSON parser; payment state must never be cached; and the worker must be idempotent across the confirm/status
  gap (§7).
- **Accepted, written down:**
  - The window between recording an event id and enqueuing is the one place a crash could strand an event as `received`; it is
    visible in `processed_stripe_events` for reconciliation, and BullMQ's `jobId = eventId` keeps a re-add safe.
  - A refund that fails permanently leaves the order `requires_payment` with a charge and no booking/refund after the failed
    list is reached — visible for manual reconciliation.
  - Two requests racing the same idempotency key: the loser's PaymentIntent is created but never confirmed, so Stripe expires
    it harmlessly.
  - `payment_intent.payment_failed` needs no handler in P1: the hold lapses on its own (10-minute TTL).
- **Revisit when:** real auth lands (the `owner_id` stand-in becomes a user id), P2 adds the native PaymentSheet, or P3 adds
  cancelled-showtime refunds and the re-hold-if-still-free path.

## Evidence

`docs/evidence/payments-p1/` — the fake-gateway flow and reconciliation dumps; the real Stripe-test-mode + Stripe-CLI end-to-end
is run by Dave with throwaway keys in `.env.test.local` (the agent never reads `.env`).
