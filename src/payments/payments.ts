import { z } from 'zod';

/**
 * Checkout API contract (ADR 0019). The server computes every price in whole pence and formats the display
 * total, so the app never does money maths (RULES A3). The mobile app mirrors these types by hand (P2).
 */

export const CheckoutResponseSchema = z.strictObject({
  /** The order id; becomes `bookings.reference` on success. */
  reference: z.uuid(),
  showtimeId: z.uuid(),
  seatIds: z.array(z.uuid()),
  /** The seat subtotal, the fee and the total, in whole pence. */
  seatTotalCents: z.number().int().nonnegative(),
  feeCents: z.number().int().nonnegative(),
  totalCents: z.number().int().nonnegative(),
  totalFormatted: z.string(),
  currency: z.string(),
  /** For the native PaymentSheet (P2). `null` once the PaymentIntent can no longer be confirmed. */
  clientSecret: z.string().nullable(),
  /** The order status (`requires_payment` | `succeeded` | `refunded` | `failed`), for the client. */
  status: z.string(),
});
export type CheckoutResponse = z.infer<typeof CheckoutResponseSchema>;
