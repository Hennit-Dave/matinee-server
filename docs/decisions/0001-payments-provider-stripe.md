# 0001 — Payments provider: Stripe (test mode)

Date: 2026-11-10 · Status: accepted · Decided by: Dave

## Problem
Matinee needs ticket checkout in test mode. The brief names Flutterwave or Paystack, and allows Stripe if an account can be opened.

## Options
1. **Stripe.** Already used in Rota. Webhook verification, idempotency keys and the append-only ledger are proven there.
2. **Flutterwave or Paystack.** A second provider would show the adapter pattern, but every payment pattern would need re-proving.

## Decision
Stripe, test mode.

## Reason
Matinee is judged hardest on UI and on traffic management. Reusing proven payment patterns moves time to the seat map, the design work and the load test.

## Consequences
- Payment code sits behind one provider module, so a second provider stays possible later.
- No adapter-pattern story from payments. TMDB (one file knows its shape) carries that story.
