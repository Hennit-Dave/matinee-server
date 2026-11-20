import { randomUUID } from 'node:crypto';
import { ApiError } from '../http/errors.js';
import type { Logger } from '../http/logger.js';
import { JOB_SHOWTIME_CANCELLED } from '../jobs/queue.js';
import type { CancelShowtimeResponse } from './cancel.js';
import type { ShowtimeCancelRepo } from './cancelRepo.js';

/**
 * The cancelled-showtime action (ADR 0020): mark the showing cancelled in ONE primary write, then enqueue the
 * refund job. Idempotent and re-runnable: a second call finds `cancelled_at` already set (no new write) and still
 * enqueues the job, whose per-order idempotency makes the re-run a money no-op — which is also how a stranded
 * enqueue (a crash between mark and enqueue) is recovered.
 */

export interface CancelShowtimeService {
  cancel(showtimeId: string, requestId?: string): Promise<CancelShowtimeResponse>;
}

export interface CancelShowtimeServiceDeps {
  repo: ShowtimeCancelRepo;
  enqueue: (name: string, data: Record<string, string>, jobId: string) => Promise<void>;
  logger?: Logger;
}

export function createCancelShowtimeService(deps: CancelShowtimeServiceDeps): CancelShowtimeService {
  const { repo, enqueue, logger } = deps;

  return {
    async cancel(showtimeId, requestId) {
      const state = await repo.state(showtimeId);
      if (!state) throw new ApiError('not_found');

      const alreadyCancelled = state.cancelledAt != null;
      if (!alreadyCancelled) await repo.markCancelled(showtimeId);

      logger?.info('showtime_cancelled', { showtimeId, requestId, alreadyCancelled });

      const jobId = randomUUID();
      await enqueue(JOB_SHOWTIME_CANCELLED, { showtimeId }, jobId);
      logger?.info('showtime_cancel_job_enqueued', { showtimeId, jobId });

      return { showtimeId, cancelled: true, alreadyCancelled };
    },
  };
}
