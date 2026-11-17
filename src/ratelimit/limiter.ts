import type { RequestHandler } from 'express';
import { resolveClientAddress } from '../http/clientIp.js';
import { ApiError } from '../http/errors.js';
import type { Logger } from '../http/logger.js';
import type { PolicyName, RateLimitPolicy } from './policies.js';
import type { RateLimitStore, ScopeCheck } from './slidingWindow.js';

/**
 * The rate-limit middleware (ADR 0016). `limit('hold')` is the whole per-route cost: a route names a policy
 * and the table in policies.ts says how strict it is.
 *
 * It sits right after the client id is read and BEFORE the body is parsed and validated, so a flood costs a
 * header read and one Redis call, not a JSON parse and a Zod run. A request that carries a client id is counted
 * against that id AND against its address; one without (search does not require an id) only against its address.
 *
 * IT FAILS OPEN, ON PURPOSE, and this is the opposite of the seat holds. A hold decides who owns a seat, so a
 * guess is worse than a refusal and holds fail closed (redisGuard.ts). A limiter only protects capacity: if Redis
 * is down, refusing every request would turn a Redis blip into a full outage of the thing it is protecting. So
 * a Redis error, a missing connection or a missed deadline lets the request through. Holds and bookings still
 * fail closed on their OWN Redis calls further down the chain; only the limiter itself fails open.
 */

/** Longest the limiter waits for Redis. CHOSEN, NOT MEASURED (5e measures it); deliberately far below the 1 s the holds allow. */
export const RATE_LIMIT_OP_TIMEOUT_MS = 150;

/** A repeating problem (Redis down) is logged at most this often per process, so an outage is one line, not one per request. */
export const WARN_EVERY_MS = 10_000;

export type LimitFactory = (policy: PolicyName) => RequestHandler;

export interface RateLimiter {
  limit: LimitFactory;
}

/** For tests that are not about rate limiting, and nothing else: never use it in `api/main.ts`. */
export const noRateLimit: RateLimiter = { limit: () => (_req, _res, next) => next() };

export interface RateLimiterOptions {
  store: RateLimitStore;
  logger: Logger;
  policies: Readonly<Record<PolicyName, RateLimitPolicy>>;
  /** Milliseconds since the epoch. Injected so a test can move time. */
  clock?: () => number;
  opTimeoutMs?: number;
}

/** Rejects after `ms`, and swallows a late failure of `work` so it cannot become an unhandled rejection. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`redis did not answer within ${ms} ms`)), ms);
  });
  work.catch(() => {});
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { store, logger, policies } = options;
  const clock = options.clock ?? Date.now;
  const timeoutMs = options.opTimeoutMs ?? RATE_LIMIT_OP_TIMEOUT_MS;
  const lastWarned = new Map<string, number>();

  function warnThrottled(message: string, fields: { reason: string; policy: string }): void {
    const now = clock();
    const last = lastWarned.get(message);
    if (last !== undefined && now - last < WARN_EVERY_MS) return;
    lastWarned.set(message, now);
    logger.warn(message, fields);
  }

  return {
    limit(name) {
      const policy = policies[name];

      return async (req, res, next) => {
        const scopes: ScopeCheck[] = [];
        if (typeof res.locals.clientId === 'string') {
          scopes.push({ kind: 'user', id: res.locals.clientId, max: policy.user });
        }
        const address = resolveClientAddress(req);
        if (address.resolved) {
          scopes.push({ kind: 'ip', id: address.key, max: policy.ip });
        } else {
          // Not counted: a proxy hop (or nothing usable) is not a caller, and one shared counter for everybody would
          // refuse everybody. See clientIp.ts.
          warnThrottled('client_ip_unresolved', { reason: address.reason, policy: name });
        }
        if (scopes.length === 0) {
          next();
          return;
        }

        let result;
        try {
          result = await withDeadline(store.check(name, policy.windowMs, scopes, clock()), timeoutMs);
        } catch (err) {
          // FAIL OPEN (see the header of this file).
          warnThrottled('rate_limit_unavailable', { reason: err instanceof Error ? err.message : String(err), policy: name });
          next();
          return;
        }

        if (result.allowed) {
          next();
          return;
        }

        // Which counters tripped goes in the log line (never the address or the id): 'user', 'ip' or 'user+ip'.
        res.locals.rateLimitPolicy = name;
        res.locals.rateLimitScope = [result.deniedScopes.includes('user') ? 'user' : '', result.deniedScopes.includes('ip') ? 'ip' : '']
          .filter(Boolean)
          .join('+');
        next(new ApiError('rate_limited', { retryAfterSeconds: Math.max(1, Math.ceil(result.retryAfterMs / 1000)) }));
      };
    },
  };
}
