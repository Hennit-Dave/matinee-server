import type { RequestHandler } from 'express';
import type { HoldStore } from '../bookings/holdStore.js';
import { ApiError } from '../http/errors.js';
import type { Logger } from '../http/logger.js';
import { ShowtimeIdParamsSchema } from '../showtimes/seat.js';
import { HEARTBEAT_WINDOW_MS, ROOM_OP_TIMEOUT_MS, type WaitingRoomConfig } from './config.js';
import type { QueueState } from './queue.js';
import type { WaitingRoomStore } from './store.js';

/**
 * The waiting room as the rest of the app sees it (ADR 0017): join, poll, leave, and the gate that keeps people without a pass out of
 * seat selection.
 *
 * IT FAILS OPEN, like the rate limiter and unlike the seat holds. A hold decides who owns a seat, so a guess is worse than a refusal
 * and holds fail closed. The room only protects capacity: if its own Redis call errors, is not connected, or does not answer within
 * 150 ms, the user is let through (and one `waiting_room_unavailable` warning is logged per 10 s). The cost, accepted: during a PARTIAL
 * failure the cap is not enforced. It adds nothing to a full Redis outage, because seats and holds need Redis too and are refused
 * (ADR 0015) whatever the room does.
 */

export interface WaitingRoom {
  readonly enabled: boolean;
  /** Joins the line, or is let straight in when there is room. Never throws: trouble means "admitted". */
  join(showtimeId: string, ownerId: string): Promise<QueueState | { status: 'full' }>;
  /** Heartbeats and reports where the owner stands. Never throws. */
  poll(showtimeId: string, ownerId: string): Promise<QueueState>;
  /** Gives up a pass or a place. Best effort: a failure is logged and ignored (a pass lapses on its own). */
  leave(showtimeId: string, ownerId: string): Promise<void>;
  /** Express middleware: 403 `waiting_room_required` unless the caller holds a valid pass. Needs `res.locals.clientId` (clientIdHeader, required). */
  gate(): RequestHandler;
}

export interface WaitingRoomDeps {
  store: WaitingRoomStore;
  holds: Pick<HoldStore, 'heldCount'>;
  config: WaitingRoomConfig;
  logger?: Logger;
  opTimeoutMs?: number;
  /** Milliseconds since the epoch, for the warning throttle. */
  clock?: () => number;
}

const WARN_EVERY_MS = 10_000;

/** Rejects after `ms`, and swallows a late failure of `work` so it cannot become an unhandled rejection. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`redis did not answer within ${ms} ms`)), ms);
  });
  work.catch(() => {});
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export function createWaitingRoom(deps: WaitingRoomDeps): WaitingRoom {
  const { store, holds, config, logger } = deps;
  const timeoutMs = deps.opTimeoutMs ?? ROOM_OP_TIMEOUT_MS;
  const clock = deps.clock ?? Date.now;
  const open: QueueState = { status: 'admitted', passExpiresInMs: HEARTBEAT_WINDOW_MS };
  let lastWarned: number | undefined;

  function failedOpen(err: unknown, what: string): void {
    const now = clock();
    if (lastWarned !== undefined && now - lastWarned < WARN_EVERY_MS) return;
    lastWarned = now;
    logger?.warn('waiting_room_unavailable', { reason: err instanceof Error ? err.message : String(err), check: what });
  }

  function toState(state: Awaited<ReturnType<WaitingRoomStore['join']>>): QueueState | { status: 'full' } {
    if (state.status === 'waiting') return { status: 'waiting', ahead: state.ahead, pollAfterMs: state.pollAfterMs };
    return state;
  }

  return {
    enabled: config.enabled,

    async join(showtimeId, ownerId) {
      if (!config.enabled) return open;
      // Someone who still holds seats here (their pass lapsed while they were on a call) must not queue behind the line with their seats held.
      let holder = false;
      try {
        holder = (await withDeadline(holds.heldCount(showtimeId, ownerId), timeoutMs)) > 0;
      } catch {
        // A failed check means "not a holder". If Redis is really down, the join below fails open on its own.
      }
      try {
        const state = toState(await withDeadline(store.join(showtimeId, ownerId, { holder }), timeoutMs));
        logger?.info('waiting_room_join', {
          userId: ownerId,
          showtimeId,
          outcome: state.status === 'waiting' ? 'queued' : state.status,
          ...(state.status === 'waiting' ? { ahead: state.ahead } : {}),
          ...(holder ? { check: 'holder' } : {}),
        });
        return state;
      } catch (err) {
        failedOpen(err, 'join');
        return open;
      }
    },

    async poll(showtimeId, ownerId) {
      if (!config.enabled) return open;
      try {
        const state = toState(await withDeadline(store.poll(showtimeId, ownerId), timeoutMs));
        return state.status === 'full' ? { status: 'not_queued' } : state;
      } catch (err) {
        failedOpen(err, 'poll');
        return open;
      }
    },

    async leave(showtimeId, ownerId) {
      if (!config.enabled) return;
      try {
        await withDeadline(store.leave(showtimeId, ownerId), timeoutMs);
      } catch (err) {
        failedOpen(err, 'leave');
      }
    },

    gate() {
      return async (req, res, next) => {
        if (!config.enabled) {
          next();
          return;
        }
        // The id is validated properly by the route a step later; here an id that is not a UUID is simply not looked up (no Redis key for junk).
        const params = ShowtimeIdParamsSchema.safeParse(req.params);
        const ownerId = res.locals.clientId;
        if (!params.success || typeof ownerId !== 'string') {
          next();
          return;
        }
        let hasPass: boolean;
        try {
          hasPass = await withDeadline(store.touch(params.data.id, ownerId), timeoutMs);
        } catch (err) {
          failedOpen(err, 'gate');
          next();
          return;
        }
        next(hasPass ? undefined : new ApiError('waiting_room_required'));
      };
    },
  };
}
