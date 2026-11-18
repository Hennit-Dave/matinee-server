# Evidence: payments slice P1 — the Stripe payment engine (ADR 0019)

The engine is proven by its tests (unit + integration) with a **fake Stripe gateway** — no real keys, no network. The
real Stripe-test-mode end-to-end is run by **Dave** (the agent never reads `.env`); the exact steps are at the bottom.

| Artifact | What it proves | Reproduce |
|---|---|---|
| `src/payments/checkoutService.test.ts` (5) | Checkout prices the order server-side (seats + £1.50 once), returns a `client_secret`; an idempotent replay returns the SAME PaymentIntent (no second charge); a key reused with different seats is a `409 idempotency_mismatch`; a lapsed hold is refused before any PI; Stripe-down is a retryable `503 payment_unavailable`. | `npm test` |
| `src/payments/stripe.test.ts` (3) | The REAL Stripe SDK signature verification, using Stripe's own header generator: a genuine signature is accepted, a tampered body and a wrong secret are rejected. | `npm test` |
| `src/payments/webhookService.test.ts` (4) | A bad signature is refused before anything is recorded; `payment_intent.succeeded` is recorded and enqueued once; a re-delivered event is skipped; other event types are recorded but not enqueued. | `npm test` |
| `src/payments/processor.test.ts` (6) | The worker: confirm → charge in the ledger; `seat_taken` and `seat_not_held` → refund (distinct ledger reasons), never double-book, never keep the money; a retry is a no-op; an unknown PI is acked; a transient error is re-thrown for BullMQ. | `npm test` |
| `src/payments/payments.integration.test.ts` (3) | The full flow over real Postgres + Redis (fake Stripe): hold → checkout → webhook → worker → booking + ledger; the hold-lapsed refund; the event-id dedup. | `npm run test:integration` (throwaway DB + Redis) |

The migration (`20261118000000_payments`) adds `orders`, `ledger_entries` (append-only, unique `stripe_object_id`) and
`processed_stripe_events`; nothing in `bookings` changed — the charge, the order and the seat rows share `orders.reference`
= `bookings.reference`.

## Dave's real Stripe end-to-end (test mode)

1. Put throwaway test keys in `.env.test.local` (git-ignored), NEVER `.env`:
   ```
   STRIPE_SECRET_KEY=sk_test_…
   STRIPE_WEBHOOK_SECRET=whsec_…
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
4. Hold seats, then checkout:
   ```
   curl -s -X POST localhost:3000/showtimes/<id>/holds   -H 'Content-Type: application/json' -H 'X-Client-Id: <uuid>' -d '{"seatIds":["<seat>"]}'
   curl -s -X POST localhost:3000/showtimes/<id>/checkout -H 'Content-Type: application/json' -H 'X-Client-Id: <uuid>' -H 'Idempotency-Key: test-1' -d '{"seatIds":["<seat>"]}'
   ```
   Copy the returned `clientSecret`.
5. Confirm the PaymentIntent with Stripe's test card using the `clientSecret` (the Stripe dashboard "Confirm" button in
   test mode, or `stripe payment_intents confirm <pi>`).
6. Watch: the webhook → worker → `booking_confirmed`, and a row appears in `bookings` whose `reference` matches the
   checkout, plus a `charge` row in `ledger_entries`. Save the row dumps as evidence here.

The "paid but the hold expired" path is already proven by the integration test (hold released before the webhook → refund).
