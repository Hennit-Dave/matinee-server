import type { RequestHandler } from 'express';
import { readTrafficProfile, readWholeNumber } from '../traffic/profile.js';
import { ApiError } from './errors.js';
import type { Logger } from './logger.js';

/**
 * Graceful overload (ADR 0017, RULES D5.7): when the API already has more requests in flight than it can serve, say so quickly and
 * clearly instead of piling up work until something upstream (the database pool, the proxy) fails in a way the app shows as a crash.
 *
 * A request over the limit is refused at once with `503 server_busy` and a `Retry-After` of 5 to 15 seconds, JITTERED so the clients
 * that were refused do not all come back in the same second. The app shows "We're very busy right now ... Trying again in 0:14".
 *
 * Never shed: `GET /health` (the host's probe) and every DELETE (releasing seats, leaving the line: the cleanup paths, which also free capacity).
 * The count is per process and is CHOSEN, NOT MEASURED (5e measures where the real knee is).
 */
export const DEFAULT_MAX_IN_FLIGHT = 250;
const WARN_EVERY_MS = 10_000;

/** Reads MAX_IN_FLIGHT (0 turns shedding off). The load-test profile turns it off: 500 virtual users are meant to be in flight. */
export function readMaxInFlight(env: NodeJS.ProcessEnv = process.env): { maxInFlight: number; profile: ReturnType<typeof readTrafficProfile> } {
  const profile = readTrafficProfile(env);
  const explicit = readWholeNumber(env, 'MAX_IN_FLIGHT', { min: 0, max: 100_000 });
  return { maxInFlight: explicit ?? (profile === 'loadtest' ? 0 : DEFAULT_MAX_IN_FLIGHT), profile };
}

export interface LoadShedOptions {
  maxInFlight: number;
  logger?: Logger;
  /** A number in [0, 1). Injected so a test is exact. */
  random?: () => number;
  clock?: () => number;
}

export function createLoadShedder(options: LoadShedOptions): RequestHandler & { inFlight(): number } {
  const { maxInFlight, logger } = options;
  const random = options.random ?? Math.random;
  const clock = options.clock ?? Date.now;
  let inFlight = 0;
  let lastWarned: number | undefined;

  const handler: RequestHandler = (req, res, next) => {
    if (maxInFlight <= 0 || req.method === 'DELETE' || req.path === '/health') {
      next();
      return;
    }
    if (inFlight >= maxInFlight) {
      const now = clock();
      if (lastWarned === undefined || now - lastWarned >= WARN_EVERY_MS) {
        lastWarned = now;
        logger?.warn('load_shed', { inFlight, maxInFlight });
      }
      next(new ApiError('server_busy', { retryAfterSeconds: 5 + Math.floor(random() * 11) }));
      return;
    }
    inFlight += 1;
    // 'close' fires once whether the response finished or the client went away, so the count cannot leak.
    res.once('close', () => {
      inFlight -= 1;
    });
    next();
  };
  return Object.assign(handler, { inFlight: () => inFlight });
}
