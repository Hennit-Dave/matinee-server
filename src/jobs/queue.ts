import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

/**
 * The payment queue (ADR 0019, ADR 0008's mitigation: ONE queue, ONE worker handling every job kind, to keep
 * idle command spend low). Job names distinguish the kinds; this slice has exactly one real kind.
 */
export const PAYMENT_QUEUE_NAME = 'payments';
export const JOB_PAYMENT_SUCCEEDED = 'payment.succeeded';

export interface PaymentQueue {
  add(name: string, data: Record<string, string>, jobId: string): Promise<void>;
  close(): Promise<void>;
}

export function createPaymentQueue(connection: Redis): PaymentQueue {
  const queue = new Queue(PAYMENT_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 100,
      removeOnFail: 1000,
    },
  });
  return {
    add: async (name, data, jobId) => {
      await queue.add(name, data, { jobId });
    },
    close: () => queue.close(),
  };
}
