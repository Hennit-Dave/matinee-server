import type { OrderRecord, OrderRepo, OrderStatus } from './orderRepo.js';
import type { PaymentGateway, PaymentIntentResult, StripeEvent } from './stripe.js';
import type { StripeEventRepo } from './eventRepo.js';

/**
 * In-memory stand-ins for the payment engine's dependencies, so the checkout, webhook and processor logic can
 * be unit-tested with no Stripe, no Postgres and no Redis. The real Stripe SDK (signature verification) is
 * proven separately in `stripe.test.ts`; the real tables and the BullMQ wiring in `payments.integration.test.ts`.
 */

export interface FakePaymentGateway extends PaymentGateway {
  intents: Map<string, { id: string; clientSecret: string | null; status: string; amountCents: number; currency: string }>;
  refunds: { paymentIntentId: string; idempotencyKey: string; id: string }[];
  events: StripeEvent[];
  /** When true every call throws, like Stripe being down. */
  down: boolean;
  /** When true, `constructEvent` throws a signature error. */
  badSignature: boolean;
  /** When set, `constructEvent` returns this event instead of pushing a new one. */
  nextEvent?: StripeEvent;
}

let counter = 0;

export function createFakePaymentGateway(): FakePaymentGateway {
  const gateway: FakePaymentGateway = {
    intents: new Map(),
    refunds: [],
    events: [],
    down: false,
    badSignature: false,
    async createPaymentIntent({ amountCents, currency }) {
      if (gateway.down) throw new Error('stripe down');
      counter += 1;
      const pi = { id: `pi_test_${counter}`, clientSecret: `pi_test_${counter}_secret`, status: 'requires_payment', amountCents, currency };
      gateway.intents.set(pi.id, pi);
      return pi;
    },
    async retrievePaymentIntent(paymentIntentId) {
      if (gateway.down) throw new Error('stripe down');
      const pi = gateway.intents.get(paymentIntentId);
      if (!pi) throw new Error(`no such PaymentIntent: ${paymentIntentId}`);
      return pi;
    },
    constructEvent() {
      if (gateway.badSignature) throw new Error('signature verification failed');
      if (gateway.nextEvent) return gateway.nextEvent;
      const event: StripeEvent = { id: `evt_${++counter}`, type: 'payment_intent.succeeded', paymentIntentId: null };
      gateway.events.push(event);
      return event;
    },
    async refund(paymentIntentId, idempotencyKey) {
      if (gateway.down) throw new Error('stripe down');
      const existing = gateway.refunds.find((r) => r.idempotencyKey === idempotencyKey);
      if (existing) return { id: existing.id, status: 'succeeded' };
      const id = `re_test_${++counter}`;
      gateway.refunds.push({ paymentIntentId, idempotencyKey, id });
      return { id, status: 'succeeded' };
    },
  };
  return gateway;
}

export interface FakeOrderRepo extends OrderRepo {
  orders: Map<string, OrderRecord>; // keyed by id
  ledger: { orderId: string; kind: string; amountCents: number; stripeObjectId: string; reason: string }[];
  nextStatus: Record<string, OrderStatus>;
}

export function createFakeOrderRepo(): FakeOrderRepo {
  const repo: FakeOrderRepo = {
    orders: new Map(),
    ledger: [],
    nextStatus: {},
    async findByOwnerIdempotencyKey(ownerId, idempotencyKey) {
      return [...repo.orders.values()].find((o) => o.ownerId === ownerId && o.idempotencyKey === idempotencyKey) ?? null;
    },
    async findByPaymentIntentId(paymentIntentId) {
      return [...repo.orders.values()].find((o) => o.stripePaymentIntentId === paymentIntentId) ?? null;
    },
    async createOrder(input) {
      const order: OrderRecord = {
        id: `order_${++counter}`,
        ...input,
        seatIds: [...input.seatIds],
        status: 'requires_payment',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      repo.orders.set(order.id, order);
      return order;
    },
    async setStatus(orderId, status) {
      const order = repo.orders.get(orderId);
      if (order) order.status = status;
    },
    async appendLedger(entry) {
      if (repo.ledger.some((l) => l.stripeObjectId === entry.stripeObjectId)) return 'duplicate';
      repo.ledger.push({ orderId: entry.orderId, kind: entry.kind, amountCents: entry.amountCents, stripeObjectId: entry.stripeObjectId, reason: entry.reason });
      return 'inserted';
    },
    async ledgerFor(orderId) {
      return repo.ledger
        .filter((l) => l.orderId === orderId)
        .map((l) => ({ ...l, kind: l.kind as 'charge' | 'refund', stripeEventId: null, createdAt: new Date() }));
    },
  };
  return repo;
}

export interface FakeStripeEventRepo extends StripeEventRepo {
  events: Map<string, { type: string; status: string; paymentIntentId: string | null }>;
}

export function createFakeStripeEventRepo(): FakeStripeEventRepo {
  const repo: FakeStripeEventRepo = {
    events: new Map(),
    async recordEvent(input) {
      if (repo.events.has(input.eventId)) return 'duplicate';
      repo.events.set(input.eventId, { type: input.type, status: 'received', paymentIntentId: input.paymentIntentId });
      return 'inserted';
    },
    async markProcessed(eventId) {
      const e = repo.events.get(eventId);
      if (e) e.status = 'processed';
    },
    async markFailed(eventId) {
      const e = repo.events.get(eventId);
      if (e) e.status = 'failed';
    },
  };
  return repo;
}

/** A PaymentIntent result the fake gateway would return, for assertions. */
export const fakeIntent = (id: string, clientSecret: string | null = `${id}_secret`): PaymentIntentResult => ({
  id,
  clientSecret,
  status: 'requires_payment',
  amountCents: 0,
  currency: 'gbp',
});
