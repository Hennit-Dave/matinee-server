import type { DbClients } from '../db/clients.js';
import { isUniqueViolation } from '../bookings/bookingRepo.js';

/**
 * The order and its append-only ledger (ADR 0019). The order links a Stripe PaymentIntent to the seats it pays
 * for, the caller and the idempotency key; the ledger records every money movement (charge or refund) and is
 * NEVER updated or deleted — corrections are new rows, and the order's net position is the sum over its rows.
 */

export type OrderStatus = 'requires_payment' | 'succeeded' | 'refunded' | 'failed';
export type LedgerKind = 'charge' | 'refund';

export interface OrderRecord {
  id: string;
  reference: string;
  ownerId: string;
  showtimeId: string;
  seatIds: string[];
  seatTotalCents: number;
  feeCents: number;
  totalCents: number;
  currency: string;
  stripePaymentIntentId: string;
  idempotencyKey: string;
  status: OrderStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewOrder {
  reference: string;
  ownerId: string;
  showtimeId: string;
  seatIds: readonly string[];
  seatTotalCents: number;
  feeCents: number;
  totalCents: number;
  currency: string;
  stripePaymentIntentId: string;
  idempotencyKey: string;
}

export interface LedgerRecord {
  orderId: string;
  kind: LedgerKind;
  amountCents: number;
  stripeObjectId: string;
  stripeEventId: string | null;
  reason: string;
  createdAt: Date;
}

/** Two requests racing the same (owner, idempotencyKey): the second create loses and the caller replays. */
export class IdempotencyKeyConflictError extends Error {
  constructor() {
    super('this idempotency key was already used');
    this.name = 'IdempotencyKeyConflictError';
  }
}

export interface OrderRepo {
  findByOwnerIdempotencyKey(ownerId: string, idempotencyKey: string): Promise<OrderRecord | null>;
  findByPaymentIntentId(paymentIntentId: string): Promise<OrderRecord | null>;
  /** Throws `IdempotencyKeyConflictError` when the (owner, key) pair is already taken. */
  createOrder(input: NewOrder): Promise<OrderRecord>;
  setStatus(orderId: string, status: OrderStatus): Promise<void>;
  /** Appends one money movement. Idempotent: a `stripeObjectId` already on the ledger is a no-op. */
  appendLedger(entry: Omit<LedgerRecord, 'createdAt'>): Promise<'inserted' | 'duplicate'>;
  ledgerFor(orderId: string): Promise<LedgerRecord[]>;
}

const ORDER_SELECT = {
  id: true,
  reference: true,
  ownerId: true,
  showtimeId: true,
  seatIds: true,
  seatTotalCents: true,
  feeCents: true,
  totalCents: true,
  currency: true,
  stripePaymentIntentId: true,
  idempotencyKey: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toRecord(row: Record<string, unknown>): OrderRecord {
  return {
    id: String(row.id),
    reference: String(row.reference),
    ownerId: String(row.ownerId),
    showtimeId: String(row.showtimeId),
    seatIds: (row.seatIds as string[]) ?? [],
    seatTotalCents: Number(row.seatTotalCents),
    feeCents: Number(row.feeCents),
    totalCents: Number(row.totalCents),
    currency: String(row.currency),
    stripePaymentIntentId: String(row.stripePaymentIntentId),
    idempotencyKey: String(row.idempotencyKey),
    status: String(row.status) as OrderStatus,
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
  };
}

export function createOrderRepo(db: DbClients): OrderRepo {
  return {
    async findByOwnerIdempotencyKey(ownerId, idempotencyKey) {
      const row = await db.primary.order.findUnique({
        where: { ownerId_idempotencyKey: { ownerId, idempotencyKey } },
        select: ORDER_SELECT,
      });
      return row ? toRecord(row as unknown as Record<string, unknown>) : null;
    },

    async findByPaymentIntentId(paymentIntentId) {
      const row = await db.primary.order.findUnique({
        where: { stripePaymentIntentId: paymentIntentId },
        select: ORDER_SELECT,
      });
      return row ? toRecord(row as unknown as Record<string, unknown>) : null;
    },

    async createOrder(input) {
      try {
        const row = await db.primary.order.create({
          data: {
            reference: input.reference,
            ownerId: input.ownerId,
            showtimeId: input.showtimeId,
            seatIds: [...input.seatIds],
            seatTotalCents: input.seatTotalCents,
            feeCents: input.feeCents,
            totalCents: input.totalCents,
            currency: input.currency,
            stripePaymentIntentId: input.stripePaymentIntentId,
            idempotencyKey: input.idempotencyKey,
            status: 'requires_payment',
          },
          select: ORDER_SELECT,
        });
        return toRecord(row as unknown as Record<string, unknown>);
      } catch (err) {
        if (isUniqueViolation(err)) throw new IdempotencyKeyConflictError();
        throw err;
      }
    },

    async setStatus(orderId, status) {
      await db.primary.order.update({ where: { id: orderId }, data: { status } });
    },

    async appendLedger(entry) {
      try {
        await db.primary.ledgerEntry.create({
          data: {
            orderId: entry.orderId,
            kind: entry.kind,
            amountCents: entry.amountCents,
            stripeObjectId: entry.stripeObjectId,
            stripeEventId: entry.stripeEventId,
            reason: entry.reason,
          },
        });
        return 'inserted';
      } catch (err) {
        if (isUniqueViolation(err)) return 'duplicate';
        throw err;
      }
    },

    async ledgerFor(orderId) {
      const rows = await db.primary.ledgerEntry.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });
      return rows.map((r) => ({
        orderId: r.orderId,
        kind: r.kind as LedgerKind,
        amountCents: r.amountCents,
        stripeObjectId: r.stripeObjectId,
        stripeEventId: r.stripeEventId,
        reason: r.reason,
        createdAt: r.createdAt,
      }));
    },
  };
}
