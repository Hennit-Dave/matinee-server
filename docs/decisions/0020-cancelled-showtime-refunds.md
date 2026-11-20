# 0020 — Cancelled-showtime refunds, admin-gated, in the append-only ledger

Date: 2026-11-20 · Status: accepted · Decided by: Dave (plan approved 2026-11-20)

## Problem

RULES D4.7 requires refunds for cancelled showtimes, recorded in an append-only ledger. There is no auth yet
(`X-Client-Id` is a bearer stand-in, ADR 0015), so a user-reachable cancel endpoint is unacceptable — anyone could
cancel a showing and trigger refunds. Three things have to be decided together: **who may cancel**, **how the money
comes back without double-refunding**, and **how a late `payment_intent.succeeded` is still refunded** after the
cancel job has run.

## Decision

### 1. Admin-only cancellation, guarded by a server-only secret (fail-closed)

`POST /admin/showtimes/:id/cancel`, mounted **only** when `ADMIN_API_KEY` is set. The request must present it in
`X-Admin-Key` (Zod-validated, compared with a constant-time hash compare, `src/http/adminKey.ts`). A wrong or missing
key is a single 403 `invalid_admin_key`; an unset env var means the route is not mounted at all. This is the same
"stand-in" shape as `clientId.ts` and is replaced when real auth lands.

Cancellation is **one primary write**: `showtimes.cancelled_at` (nullable timestamptz; presence = cancelled). The mark
is `UPDATE … WHERE cancelled_at IS NULL`, so exactly one concurrent call wins and every later call is a no-op — which
makes re-cancelling safe.

### 2. A dead showing is closed for business

`BookingService.checkSeats` throws `showtime_cancelled` (HTTP 410) when `cancelled_at` is set. Because holds, checkout
and the webhook confirm all funnel through `checkSeats`, a cancelled showing refuses new holds, new checkouts and new
bookings before any PaymentIntent or seat is touched. The read side excludes it too: `forMovie` drops cancelled
showtimes and `seatService.forShowtime` returns `null` (the map is gone).

### 3. The refund job (`showtime.cancelled`, one queue, one worker)

The cancel endpoint marks the showing, then enqueues a BullMQ job that walks the showtime's orders and settles each by
state (a pure function, `src/payments/cancelRefund.ts`):

- `succeeded` → Stripe refund (deterministic `refund_<pi>` key), a `refund` ledger row with reason
  `showtime_cancelled_refund`, order `refunded`, and the booking rows deleted so the seats are released.
- `requires_payment` (held, unpaid) → cancel the PaymentIntent and release the holds, order `failed`. If the intent can
  no longer be cancelled (it already succeeded), leave it `requires_payment` for the webhook processor.
- `refunded` / `failed` → skip.

### 4. Idempotency (the crux)

Two layers, both already built for hold-expiry refunds (ADR 0019): the Stripe refund idempotency key `refund_<pi>`
(one refund object per PaymentIntent) and the ledger's unique `stripeObjectId` (one refund row). The order's status
short-circuits an already-settled order. A second run finds every order terminal and does nothing; a re-cancel
(`alreadyCancelled: true`) still enqueues the job, which is both a money no-op and the recovery path if a prior enqueue
was stranded by a crash.

### 5. The race: a late `payment_intent.succeeded` is still refunded

Money only ever moves via `payment_intent.succeeded`, and that event is always handled by `handlePaymentSucceeded`.
That processor is now cancellation-aware: it checks `cancelled_at` before confirming (and refunds), and its catch list
now includes `showtime_cancelled` alongside `seat_taken`/`seat_not_held`, so the narrow TOCTOU window (the flag reads
false, the cancel lands, then `confirmBooking`'s own check throws) resolves in one pass. Every charge ends `succeeded`
(non-cancelled, seat free) or `refunded` (hold-expiry or cancellation), never kept on a dead showing. The hold-expiry
reasons (`hold_expired_refund`, `hold_lapsed_refund`) are unchanged; cancellation takes precedence.

### 6. Bookings are hard-deleted, not soft-voided

A refund deletes the booking rows for the order's `reference` (`deleteBookingsByReference`), freeing the seats. The
money truth stays in `orders` + the ledger (charge + refund), so the audit trail is intact; a soft `voided_at` flag
would ripple through every sold-seat query for no gain. The ledger stays append-only — corrections are new rows.

## Consequences

- **Easier:** the refund path reuses the deterministic Stripe key and the ledger's `stripe_object_id` dedup from ADR
  0019; the worker is a thin shell over a pure function; the `Showtime` model gains one nullable column.
- **Harder:** cancellation must be checked in two places (the processor's pre-check and its catch) to close the race;
  the cancel endpoint is admin-gated because there is no auth.
- **Accepted, written down:**
  - A crash between "mark cancelled" and "enqueue" strands the bulk refund of already-`succeeded` orders; a re-cancel
    (or any manual re-enqueue) recovers it, and no *new* money can be stranded because the processor checks the flag
    on every late webhook.
  - `requires_payment` orders that never paid end `failed` (the app's "payment didn't go through" copy); a paid order
    on a cancelled showing ends `refunded` with the cancellation reason.
- **Revisit when:** real auth lands (`ADMIN_API_KEY` and the `owner_id` stand-in become a real user/role); the
  re-hold-if-still-free path remains deferred.

## Evidence

`docs/evidence/payments-p3/` — the fake-gateway unit + integration proofs; the real Stripe test-mode cancel is run by
Dave with throwaway keys in `.env.test.local` (the agent never reads `.env`).
