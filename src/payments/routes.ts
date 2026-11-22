import express, { Router } from 'express';
import { z } from 'zod';
import { SeatIdsBodySchema } from '../bookings/booking.js';
import { clientIdHeader } from '../http/clientId.js';
import { ApiError } from '../http/errors.js';
import { jsonBody } from '../http/json.js';
import { recordRouteBase } from '../http/logger.js';
import { validateRequest } from '../http/validate.js';
import type { LimitFactory } from '../ratelimit/limiter.js';
import { ShowtimeIdParamsSchema } from '../showtimes/seat.js';
import type { CheckoutService } from './checkoutService.js';
import type { OrderStatusService } from './orderStatus.js';
import type { TicketsService } from './tickets.js';
import type { WebhookService } from './webhookService.js';

/**
 * Payment routes (ADR 0019). The checkout is mounted under /showtimes next to holds and bookings; the webhook
 * is a top-level route with a RAW body for signature verification (never the global JSON parser); the order
 * status is a top-level GET that the confirmation poll reads.
 */

const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

const OrderReferenceParamsSchema = z.strictObject({ reference: z.uuid() });

export function createCheckoutRouter(service: CheckoutService, limit: LimitFactory): Router {
  const router = Router();
  router.use(recordRouteBase);

  const callerId = clientIdHeader({ required: true });

  // POST /showtimes/:id/checkout { seatIds } + X-Client-Id + Idempotency-Key. The order is the one every route
  // uses (ADR 0016): who is calling, then the rate limit, then the parsed + validated body.
  router.post(
    '/:id/checkout',
    callerId,
    limit('checkout'),
    jsonBody(),
    validateRequest({ params: ShowtimeIdParamsSchema, body: SeatIdsBodySchema }),
    async (req, res) => {
      const { params, body } = req.validated as {
        params: z.output<typeof ShowtimeIdParamsSchema>;
        body: z.output<typeof SeatIdsBodySchema>;
      };
      const idempotencyKey = req.get(IDEMPOTENCY_KEY_HEADER);
      if (!idempotencyKey) {
        throw new ApiError('validation_failed', { details: [{ path: `header.${IDEMPOTENCY_KEY_HEADER}`, code: 'required' }] });
      }
      const result = await service.checkout({
        showtimeId: params.id,
        ownerId: String(res.locals.clientId),
        seatIds: body.seatIds,
        idempotencyKey,
        requestId: String(res.locals.requestId ?? ''),
      });
      res.status(result.created ? 201 : 200).json(result);
    },
  );

  return router;
}

export function createTicketsRouter(service: TicketsService, limit: LimitFactory): Router {
  const router = Router();
  router.use(recordRouteBase);

  // GET /tickets — the caller's tickets (Tickets tab). Owner-scoped, never cached, read from the
  // primary (the same privacy + freshness model as /orders/:reference, and the same limiter).
  router.get(
    '/tickets',
    clientIdHeader({ required: true }),
    limit('orderStatus'),
    async (req, res) => {
      res.json(await service.list(String(res.locals.clientId)));
    },
  );

  return router;
}

export function createStripeWebhookRouter(service: WebhookService): Router {
  const router = Router();
  router.use(recordRouteBase);

  // POST /webhooks/stripe — express.raw on this route only, so the handler receives the exact bytes Stripe
  // signed (AGENTS.md §8). Not rate-limited, not load-shed: Stripe retries, and a fast 200 is the contract.
  router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const signatureHeader = req.get('stripe-signature');
    if (!signatureHeader) {
      throw new ApiError('validation_failed', { details: [{ path: 'header.stripe-signature', code: 'required' }] });
    }
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    await service.handle({ rawBody, signatureHeader });
    res.json({ received: true });
  });

  return router;
}

export function createOrderStatusRouter(service: OrderStatusService, limit: LimitFactory): Router {
  const router = Router();
  router.use(recordRouteBase);

  // GET /orders/:reference — the confirmation poll (payments P2). Owner-scoped: a reference owned by someone
  // else is a 404, never a leak. Not load-shed (a paid caller must always learn their outcome) and never cached.
  router.get(
    '/orders/:reference',
    clientIdHeader({ required: true }),
    limit('orderStatus'),
    validateRequest({ params: OrderReferenceParamsSchema }),
    async (req, res) => {
      const { reference } = req.validated!.params as z.output<typeof OrderReferenceParamsSchema>;
      const result = await service.status(reference, String(res.locals.clientId));
      if (!result) throw new ApiError('not_found');
      res.json(result);
    },
  );

  return router;
}
