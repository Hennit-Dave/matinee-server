# 0021 — Tickets list endpoint (GET /tickets)

Date: 2026-11-22 · Status: accepted · Decided by: Dave (plan approved 2026-11-22)

## Problem

Orders are stored against `ownerId` (the `X-Client-Id` install id), but the only read path is
`GET /orders/:reference` — one ticket, by exact reference. The mobile Tickets tab has nothing to call to show a
user's tickets (upcoming, past, refunded and still-confirming).

## Decision

`GET /tickets`, owner-scoped the same way as `/orders/:reference`:

- **Owner-scoped.** `X-Client-Id` (required) is the owner; the endpoint returns only the caller's own orders. A
  caller can never read another install's orders.
- **Which orders.** Every order with ticket context: `succeeded` (app badges "Ready" / "Watched"),
  `refunded` ("Refunded") and in-flight `requires_payment` ("Confirming"). `failed` is excluded — no valid ticket.
- **Item shape.** The `ticket` object from `OrderStatusResponse` (`movieId`, `movieTitle`, `cinemaName`,
  `screenName`, `format`, `startsAt`, `time`, `seats`, `totalFormatted`) plus `reference` and `status`.
- **Never cached** (RULES C4: booking/payment data is Postgres-only), read from the **primary** (like
  `/orders/:reference`), and rate-limited with the existing `orderStatus` policy.
- **One batched read** (`OrderRepo.findTicketsByOwner`): the owner's ticket-bearing orders, their showtimes, and
  their seats — resolved from the order's `seatIds` snapshot (not the `booking` rows, which a refund deletes or a
  hold-expiry never creates). No N+1.
- **Title resolution** reuses the order-status service's best-effort approach, deduped by `movieId` (one TMDB call
  per film, not per ticket) and tolerant of a TMDB failure (empty title).
- **Ordering.** Soonest upcoming (`startsAt >= now`) first, then past shows, most recent first — a pure,
  unit-tested `orderTickets`.

## Consequences

- **Easier:** reuses `TicketSchema` (extracted from `OrderStatusResponseSchema`), `formatPriceCents` and the
  `orderStatus` rate-limit policy; the assembly mirrors `createOrderStatusService`.
- **Harder:** the seat source must be the order's `seatIds` snapshot (the `booking` rows are absent for
  `refunded`/`requires_payment`), which differs from the single-ticket `findTicketByReference` (bookings-based).
- **Revisit when:** real auth lands (`ownerId` becomes a user id); the Tickets tab UI is a separate mobile PR.
