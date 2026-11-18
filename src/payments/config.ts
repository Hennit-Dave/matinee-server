// Payment constants (ADR 0019). Whole pence, GBP (RULES A3).

/** The flat service fee added once per order, in pence (£1.50). Documented and server-side only. */
export const SERVICE_FEE_CENTS = 150;

/** The currency every PaymentIntent is created in (ADR 0001's addendum). */
export const CURRENCY = 'gbp';
