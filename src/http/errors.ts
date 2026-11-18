import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from './logger.js';

/**
 * The error vocabulary the app switches on (ADR 0005). Starts with only what slice 0 needs and
 * grows per slice, same as Rota's did — no Sentry/Prisma-specific codes yet, nothing this repo
 * doesn't have a route for.
 */
export type ErrorCode =
  | 'not_found'
  | 'validation_failed'
  | 'invalid_json'
  | 'payload_too_large'
  | 'internal_error'
  | 'service_unavailable'
  | 'upstream_unavailable'
  | 'seat_taken'
  | 'seat_not_held'
  | 'hold_limit_reached'
  | 'holds_unavailable'
  | 'rate_limited'
  | 'waiting_room_required'
  | 'waiting_room_full'
  | 'server_busy'
  | 'idempotency_mismatch'
  | 'payment_unavailable';

const STATUS: Record<ErrorCode, number> = {
  not_found: 404,
  validation_failed: 400,
  invalid_json: 400,
  payload_too_large: 413,
  internal_error: 500,
  service_unavailable: 503,
  upstream_unavailable: 503,
  seat_taken: 409,
  seat_not_held: 409,
  hold_limit_reached: 409,
  holds_unavailable: 503,
  rate_limited: 429,
  waiting_room_required: 403,
  waiting_room_full: 503,
  server_busy: 503,
  idempotency_mismatch: 409,
  payment_unavailable: 503,
};

// Safe English defaults for debugging. The app owns user-facing copy and switches on `code`.
const MESSAGE: Record<ErrorCode, string> = {
  not_found: 'Not found.',
  validation_failed: 'The request was not valid.',
  invalid_json: 'The request body is not valid JSON.',
  payload_too_large: 'The request body is too large.',
  internal_error: 'Something went wrong.',
  service_unavailable: 'The service is temporarily unavailable.',
  // A third party we depend on (TMDB) is down and we have nothing cached. Retryable.
  upstream_unavailable: 'Movie data is temporarily unavailable. Please try again shortly.',
  // Traffic slice (ADR 0015). The two 409s carry `seatIds`: which seats the caller cannot have / does not hold.
  seat_taken: 'One or more of those seats are no longer available.',
  seat_not_held: 'You do not hold one or more of those seats.',
  // Traffic slice 5d (ADR 0018). Nothing was held. The body also carries `scope`, `limit` and `held`.
  hold_limit_reached: 'The most seats that can be held for this showing have already been taken.',
  // Redis is the seat-hold store; when it cannot be reached we refuse rather than guess (fail closed).
  holds_unavailable: 'Seat reservations are temporarily unavailable. Please try again shortly.',
  // Traffic slice 5c (ADR 0016). The limiter refuses before the route runs, so nothing was held, booked or searched.
  rate_limited: 'Too many requests. Please slow down and try again shortly.',
  // Traffic slice 5d (ADR 0017). The first means "join the line first"; the two 503s carry a Retry-After.
  waiting_room_required: 'Join the waiting room before choosing seats for this showing.',
  waiting_room_full: 'The waiting room is full. Please try again shortly.',
  server_busy: 'We are very busy right now. Please try again shortly.',
  // Payments slice (ADR 0019). The idempotency key was already used with a different payload; payment setup is unavailable right now.
  idempotency_mismatch: 'That request id was already used for a different order.',
  payment_unavailable: 'Payment is temporarily unavailable. Please try again shortly.',
};

/** Seconds a client should wait before retrying a `holds_unavailable` (sent as `Retry-After`). */
export const HOLDS_RETRY_AFTER_SECONDS = 2;

/**
 * `Retry-After` for the other retryable 503s (ADR 0017), so the app can show "Trying again in 0:14" instead of guessing. A shed request
 * gets its own jittered value (loadShed.ts) so refused clients do not all come back at the same second; these are the defaults.
 */
export const BUSY_RETRY_AFTER_SECONDS = 10;
export const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/**
 * Prisma errors that mean "the database could not serve this right now" (the pool had no free connection in time, the server was not
 * reachable, a query timed out) rather than "the app has a bug". They are overload, so they answer `503 server_busy`, never a 500.
 * Matched on the error's `code` so this file does not import Prisma.
 */
const TRANSIENT_DATABASE_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);
export function isTransientDatabaseError(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && TRANSIENT_DATABASE_CODES.has(code);
}

/** One field-level problem. Never carries the submitted value. */
export interface ErrorDetail {
  path: string;
  code: string;
  min?: number;
  max?: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: ErrorDetail[];
  /** The seats a `seat_taken` / `seat_not_held` is about. Sent to the caller; seat ids are not secret. */
  readonly seatIds?: string[];
  /** Server-side only: logged, never sent. */
  readonly reason?: string;
  /** Whole seconds a `rate_limited` caller should wait. Sent as the `Retry-After` header, not in the body. */
  readonly retryAfterSeconds?: number;
  /** Only on `hold_limit_reached`: which cap was hit (`owner` or `address`), how high it is, and how many seats are held. */
  readonly holdLimit?: { scope: 'owner' | 'address'; limit: number; held: number };

  constructor(
    code: ErrorCode,
    options?: {
      details?: ErrorDetail[];
      reason?: string;
      seatIds?: string[];
      retryAfterSeconds?: number;
      holdLimit?: { scope: 'owner' | 'address'; limit: number; held: number };
    },
  ) {
    super(MESSAGE[code]);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS[code];
    this.details = options?.details;
    this.seatIds = options?.seatIds;
    this.reason = options?.reason;
    this.retryAfterSeconds = options?.retryAfterSeconds;
    this.holdLimit = options?.holdLimit;
  }
}

/** Express 5 forwards rejected promises from async handlers to the error handler. */
export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new ApiError('not_found'));
};

/** Maps the errors Express' JSON body parser raises (it sets `type`) onto our codes. */
function fromBodyParserError(err: unknown): ApiError | null {
  if (typeof err !== 'object' || err === null) return null;
  const type = (err as { type?: unknown }).type;
  if (type === 'entity.parse.failed') return new ApiError('invalid_json');
  if (type === 'entity.too.large') return new ApiError('payload_too_large');
  if (typeof type === 'string' && (type.startsWith('encoding.') || type.startsWith('charset.'))) {
    return new ApiError('validation_failed');
  }
  return null;
}

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  // Express identifies error middleware by its four parameters, so `_next` must stay.
  return (err, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    const requestId = String(res.locals.requestId ?? '');
    const busy = !(err instanceof ApiError) && isTransientDatabaseError(err);
    const apiError: ApiError = err instanceof ApiError
      ? err
      : fromBodyParserError(err) ?? (busy ? new ApiError('server_busy', { reason: err instanceof Error ? err.message : String(err) }) : new ApiError('internal_error'));

    if (busy) {
      logger.warn('database_busy', { requestId, reason: err instanceof Error ? err.message : String(err) });
    } else if (!(err instanceof ApiError) && !fromBodyParserError(err)) {
      // Unexpected: log for us, tell the caller nothing about it.
      logger.error('unhandled_error', { requestId, reason: err instanceof Error ? err.message : String(err) });
    } else if (apiError.reason) {
      logger.warn('request_rejected', { requestId, errorCode: apiError.code, reason: apiError.reason });
    }

    res.locals.errorCode = apiError.code;
    if (apiError.code === 'holds_unavailable') res.setHeader('Retry-After', String(HOLDS_RETRY_AFTER_SECONDS));
    if (apiError.code === 'service_unavailable') res.setHeader('Retry-After', String(UNAVAILABLE_RETRY_AFTER_SECONDS));
    if (apiError.code === 'server_busy' || apiError.code === 'waiting_room_full') {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(apiError.retryAfterSeconds ?? BUSY_RETRY_AFTER_SECONDS))));
    }
    if (apiError.code === 'rate_limited') {
      // Always present on a 429 (at least one second), so a client never has to guess how long to wait.
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(apiError.retryAfterSeconds ?? 1))));
    }
    res.status(apiError.status).json({
      error: {
        code: apiError.code,
        message: apiError.message,
        requestId,
        ...(apiError.details ? { details: apiError.details } : {}),
        ...(apiError.seatIds ? { seatIds: apiError.seatIds } : {}),
        ...(apiError.holdLimit ? apiError.holdLimit : {}),
      },
    });
  };
}
