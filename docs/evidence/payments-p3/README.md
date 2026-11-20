# Evidence: payments slice P3 — cancelled-showtime refunds (ADR 0020)

The cancellation + refund path is proven by its tests (unit + integration) with a **fake Stripe gateway** — no real keys,
no network. The real Stripe-test-mode end-to-end is run by **Dave** (the agent never reads `.env`); the exact steps are at
the bottom.

| Artifact | What it proves | Reproduce |
|---|---|---|
| `src/payments/processor.test.ts` (2 new) | A `payment_intent.succeeded` on a cancelled showtime is refunded (never booked) with reason `showtime_cancelled_refund`; `confirmBooking` throwing `showtime_cancelled` (the TOCTOU window) is still refunded in one pass. | `npm test` |
| `src/payments/cancelRefund.test.ts` (5) | The settle job: `succeeded` → refund + ledger + seats released; `requires_payment` → PI cancelled + holds released + `failed` (no refund); a PI that can no longer be cancelled is deferred to the webhook processor; `refunded`/`failed` are skipped; a re-run is a no-op (one refund object, one refund row). | `npm test` |
| `src/showtimes/cancel.test.ts` (4) | Marking is idempotent (`alreadyCancelled` on the second call) and every cancel still enqueues the job; an unknown showtime is `not_found`; the correct `X-Admin-Key` cancels, a wrong/missing key is `403 invalid_admin_key` and never reaches the service; without `ADMIN_API_KEY` the route is not mounted. | `npm test` |
| `src/bookings/bookingService.test.ts` (1) | A cancelled showtime refuses holds, confirm and verify with `410 showtime_cancelled`, never touching Redis. | `npm test` |
| `src/showtimes/seatService.test.ts` (1) | A cancelled showtime has no seat map (`null`), touching neither Redis nor bookings. | `npm test` |
| `src/payments/cancel.integration.test.ts` (1) | The full flow over real Postgres + Redis (fake Stripe): two confirmed bookings → cancel → both refunded in the ledger, orders `refunded`, zero bookings; re-cancel is a no-op; a new checkout on the cancelled showing is refused. | `npm run test:integration` (throwaway DB + Redis) |

The migration (`20261120000000_showtime_cancelled_at`) adds one nullable column `showtimes.cancelled_at`; nothing in
`bookings` changed its constraints (the refund deletes the booking rows, freeing the seats, while the order + ledger keep
the money truth).

## Dave's real Stripe end-to-end (test mode)

1. Put throwaway test keys in `.env.test.local` (git-ignored), NEVER `.env`:
   ```
   STRIPE_SECRET_KEY=sk_test_…
   STRIPE_WEBHOOK_SECRET=whsec_…
   ADMIN_API_KEY=<a long random value>
   ```
   (`DATABASE_URL`, `DATABASE_READ_URL`, `REDIS_URL`, `TMDB_READ_TOKEN` as usual.)
2. Start the API and the worker in two terminals:
   ```
   npm run dev:api       # terminal 1
   npm run dev:worker    # terminal 2 (needs STRIPE_SECRET_KEY)
   ```
3. Forward Stripe to the local webhook (Stripe CLI, already authenticated):
   ```
   stripe listen --forward-to localhost:3000/webhooks/stripe
   ```
4. For **two different customers/seats** on one showing: hold, checkout, and confirm the PaymentIntent with a test card
   (the Stripe dashboard "Confirm" button, or `stripe payment_intents confirm <pi>`). Watch each webhook → worker →
   `booking_confirmed`. You now have two `succeeded` orders and their `bookings` rows.
5. Cancel the showing with the admin key:
   ```
   curl -s -X POST localhost:3000/admin/showtimes/<id>/cancel -H 'X-Admin-Key: <ADMIN_API_KEY>'
   ```
   Watch the worker log `showtime_cancelled_settled` with `refunded: 2`.
6. **Proof, in the DB** (save the dumps as evidence here):
   ```sql
   -- every order on the showing is refunded
   SELECT reference, status FROM orders WHERE showtime_id = '<id>';

   -- the ledger is append-only: charge, then a showtime_cancelled_refund row per order
   SELECT kind, amount_cents, reason, stripe_object_id
     FROM ledger_entries e JOIN orders o ON o.id = e.order_id
    WHERE o.showtime_id = '<id>' ORDER BY e.created_at;

   -- the seats are released
   SELECT count(*) FROM bookings WHERE showtime_id = '<id>';
   ```
7. Re-run the same cancel `curl` → `alreadyCancelled: true`, and the Stripe dashboard shows **no new refunds**.
8. Try a new hold/checkout on the cancelled showing → `410 showtime_cancelled`.
