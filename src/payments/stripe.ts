import Stripe from 'stripe';

/**
 * The ONE file that knows Stripe's shape (the TMDB rule, AGENTS.md §4). Everything else talks to a
 * `PaymentGateway`, so the engine is unit-tested with a fake and a second provider stays possible later
 * (ADR 0001).
 *
 * The gateway takes the secret key and the webhook secret at construction and never logs either: the values
 * are read once in `src/api/main.ts` and only their absence is reported, by name.
 */

export interface PaymentIntentResult {
  id: string;
  clientSecret: string | null;
  status: string;
  amountCents: number;
  currency: string;
}

export interface RefundResult {
  id: string;
  status: string;
}

export interface StripeEvent {
  /** The Stripe event id (e.g. `evt_…`). The webhook dedup key. */
  id: string;
  type: string;
  /** The PaymentIntent id, when the event's object is a PaymentIntent. */
  paymentIntentId: string | null;
}

export interface PaymentGateway {
  /** Creates a PaymentIntent in GBP (amount in pence). `idempotencyKey` is namespaced by the caller (ADR 0019). */
  createPaymentIntent(params: {
    amountCents: number;
    currency: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<PaymentIntentResult>;
  /** Re-reads a PaymentIntent (used by the idempotent checkout replay, to hand back the current client_secret). */
  retrievePaymentIntent(paymentIntentId: string): Promise<PaymentIntentResult>;
  /** Verifies a webhook signature against the raw body. Throws when the signature is bad or stale. */
  constructEvent(rawBody: Buffer, signatureHeader: string): StripeEvent;
  /** Refunds a PaymentIntent. `idempotencyKey` is deterministic (`refund_<pi>`) so a retried job refunds once. */
  refund(paymentIntentId: string, idempotencyKey: string): Promise<RefundResult>;
  /**
   * Cancels an unconfirmed PaymentIntent (ADR 0020): the customer's PaymentSheet can no longer complete. Throws
   * when it cannot be cancelled (e.g. it already succeeded), which the caller treats as "the money is moving, let
   * the webhook's processor settle it".
   */
  cancelPaymentIntent(paymentIntentId: string): Promise<PaymentIntentResult>;
}

export interface StripeGatewayOptions {
  secretKey: string;
  /** Only `constructEvent` needs it; a worker that only refunds can omit it. */
  webhookSecret?: string;
}

export function createStripeGateway(options: StripeGatewayOptions): PaymentGateway {
  const stripe = new Stripe(options.secretKey);

  function toIntent(pi: Stripe.PaymentIntent): PaymentIntentResult {
    return {
      id: pi.id,
      clientSecret: pi.client_secret,
      status: pi.status,
      amountCents: pi.amount,
      currency: pi.currency,
    };
  }

  return {
    async createPaymentIntent({ amountCents, currency, metadata, idempotencyKey }) {
      const pi = await stripe.paymentIntents.create(
        { amount: amountCents, currency, metadata, automatic_payment_methods: { enabled: true } },
        { idempotencyKey },
      );
      return toIntent(pi);
    },

    async retrievePaymentIntent(paymentIntentId) {
      return toIntent(await stripe.paymentIntents.retrieve(paymentIntentId));
    },

    constructEvent(rawBody, signatureHeader) {
      if (!options.webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not set.');
      const event = stripe.webhooks.constructEvent(rawBody, signatureHeader, options.webhookSecret);
      const object = event.data.object as { id?: string };
      const paymentIntentId = event.type.startsWith('payment_intent.') ? (object.id ?? null) : null;
      return { id: event.id, type: event.type, paymentIntentId };
    },

    async refund(paymentIntentId, idempotencyKey) {
      const refund = await stripe.refunds.create({ payment_intent: paymentIntentId }, { idempotencyKey });
      return { id: refund.id, status: refund.status ?? '' };
    },

    async cancelPaymentIntent(paymentIntentId) {
      const pi = await stripe.paymentIntents.cancel(paymentIntentId);
      return toIntent(pi);
    },
  };
}
