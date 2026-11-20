import type { DbClients } from '../db/clients.js';

/**
 * The cancelled-showtime state (ADR 0020). `cancelled_at` is the single durable source of truth: a null means
 * live, a set value means cancelled. Marking is ONE primary write, idempotent by construction (the `cancelled_at
 * IS NULL` filter means exactly one concurrent call wins and every later call is a no-op), which is what makes
 * re-cancelling safe.
 */

export interface ShowtimeCancelRepo {
  /** The showtime's cancellation state, or `null` when the showtime does not exist. */
  state(showtimeId: string): Promise<{ cancelledAt: Date | null } | null>;
  /** Sets `cancelled_at` now. Returns `true` when this call set it (it was live), `false` when it was already cancelled. */
  markCancelled(showtimeId: string): Promise<boolean>;
  /** True when the showtime exists and is cancelled. Reads the primary (the processor's check must never see a stale flag). */
  isCancelled(showtimeId: string): Promise<boolean>;
}

export function createShowtimeCancelRepo(db: DbClients): ShowtimeCancelRepo {
  return {
    async state(showtimeId) {
      const row = await db.primary.showtime.findUnique({ where: { id: showtimeId }, select: { cancelledAt: true } });
      return row ? { cancelledAt: row.cancelledAt } : null;
    },

    async markCancelled(showtimeId) {
      const { count } = await db.primary.showtime.updateMany({
        where: { id: showtimeId, cancelledAt: null },
        data: { cancelledAt: new Date() },
      });
      return count > 0;
    },

    async isCancelled(showtimeId) {
      const row = await db.primary.showtime.findUnique({ where: { id: showtimeId }, select: { cancelledAt: true } });
      return row?.cancelledAt != null;
    },
  };
}
