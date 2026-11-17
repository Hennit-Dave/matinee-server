import { z } from 'zod';

/**
 * The waiting room's answers (ADR 0017). The server owns these schemas; the mobile app mirrors them by hand.
 *
 *   admitted:   you may choose seats. `passExpiresInMs` is how long the pass lasts if you stay quiet; the seat-map polls renew it.
 *   waiting:    you are in the line. `ahead` is how many people are in front of you (0 = you are next); `pollAfterMs` is when to ask
 *               again (the back of a long line asks less often).
 *   not_queued: you are neither admitted nor waiting (never joined, left, lost your place, or your pass lapsed): join again.
 *
 * There is deliberately NO estimated wait. The fixed admission rate gives only a lower bound (a full room admits nobody until
 * someone leaves), and a time that is often wrong is worse than none: the app shows people ahead and nothing else.
 */
export const QueueStateSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('admitted'), passExpiresInMs: z.number().int().min(0) }),
  z.strictObject({ status: z.literal('waiting'), ahead: z.number().int().min(0), pollAfterMs: z.number().int().min(1) }),
  z.strictObject({ status: z.literal('not_queued') }),
]);
export type QueueState = z.output<typeof QueueStateSchema>;
