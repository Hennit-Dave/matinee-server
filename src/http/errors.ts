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
  | 'service_unavailable';

const STATUS: Record<ErrorCode, number> = {
  not_found: 404,
  validation_failed: 400,
  invalid_json: 400,
  payload_too_large: 413,
  internal_error: 500,
  service_unavailable: 503,
};

// Safe English defaults for debugging. The app owns user-facing copy and switches on `code`.
const MESSAGE: Record<ErrorCode, string> = {
  not_found: 'Not found.',
  validation_failed: 'The request was not valid.',
  invalid_json: 'The request body is not valid JSON.',
  payload_too_large: 'The request body is too large.',
  internal_error: 'Something went wrong.',
  service_unavailable: 'The service is temporarily unavailable.',
};

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
  /** Server-side only: logged, never sent. */
  readonly reason?: string;

  constructor(code: ErrorCode, options?: { details?: ErrorDetail[]; reason?: string }) {
    super(MESSAGE[code]);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS[code];
    this.details = options?.details;
    this.reason = options?.reason;
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
    const apiError: ApiError = err instanceof ApiError ? err : fromBodyParserError(err) ?? new ApiError('internal_error');

    if (!(err instanceof ApiError) && !fromBodyParserError(err)) {
      // Unexpected: log for us, tell the caller nothing about it.
      logger.error('unhandled_error', { requestId, reason: err instanceof Error ? err.message : String(err) });
    } else if (apiError.reason) {
      logger.warn('request_rejected', { requestId, errorCode: apiError.code, reason: apiError.reason });
    }

    res.locals.errorCode = apiError.code;
    res.status(apiError.status).json({
      error: {
        code: apiError.code,
        message: apiError.message,
        requestId,
        ...(apiError.details ? { details: apiError.details } : {}),
      },
    });
  };
}
