import * as Sentry from '@sentry/node';
import type { Event } from '@sentry/node';

/**
 * Sentry error tracking (the observability slice). ADDS to the allow-list logger, never replaces it: the logger
 * still carries every request's `requestId`/`userId`, and Sentry reuses those same ids, so "what happened to this
 * user's payment at 3:14pm?" is answerable from Sentry + the logs together.
 *
 * FAIL-SAFE: without `SENTRY_DSN` this module no-ops and the API/worker still boot (the same convention as the
 * Stripe / ADMIN_API_KEY gating) — local and CI run with no DSN.
 *
 * Reporting stays on the MANUAL path only: `createErrorHandler` calls `shouldReportToSentry` (in http/errors.ts)
 * and then `captureException`. We deliberately do NOT call `Sentry.setupExpressErrorHandler`, which would bypass
 * that 4xx/5xx filter and re-admit the expected vocabulary. The process-level `OnUncaughtException` /
 * `OnUnhandledRejection` integrations (default-on in @sentry/node) are KEPT, so a crash that escapes the request
 * handler entirely is still captured.
 */

let enabled = false;

/** Reads SENTRY_DSN; no-ops (returns false) when unset. Called once at boot in api/main.ts and jobs/worker.ts. */
export function initSentry(dsn: string | undefined = process.env.SENTRY_DSN): boolean {
  const value = dsn?.trim();
  if (!value) return false;
  Sentry.init({
    dsn: value,
    environment: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    tracesSampleRate: 0, // error capture only; no performance tracing this slice
    beforeSend: (event) => scrubSentryEvent(event),
  });
  enabled = true;
  return true;
}

export function isSentryEnabled(): boolean {
  return enabled;
}

/** Captures to Sentry with the request correlation ids; a no-op when Sentry is not enabled. */
export function captureException(error: unknown, context?: { tags?: Record<string, string>; user?: { id: string } }): void {
  if (!enabled) return;
  Sentry.captureException(error, { tags: context?.tags, user: context?.user });
}

/**
 * `beforeSend`: drop the whole `event.request` so a checkout body or a webhook's raw payload can never ride along
 * in an event. Only our own tags (requestId/userId/route/method) travel. Pure, so it is unit-tested.
 */
export function scrubSentryEvent<T extends Event>(event: T): T {
  delete event.request;
  return event;
}
