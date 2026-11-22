# Observability (Sentry) — evidence

Proves Sentry is live and capturing on **both** the mobile app and the deployed
server, with real events (stack traces, breadcrumbs, correct environment tags)
and the PII scrub (`scrubSentryEvent` → `delete event.request`) in effect.

Design + rationale: see the "Observability" section of `docs/ARCHITECTURE.md`.

## Screenshots

| File | Shows |
|------|-------|
| `01-mobile-sentry-test-error-stack-trace.png` | `MATINEE-MOBILE-1`: test error, full stack trace with in-app frames (`src/lib/initSentry.ts`, `src/app/_layout.tsx`), Android 17, release `0.0.0 (1)`. |
| `02-mobile-sentry-test-breadcrumbs-and-tags.png` | Breadcrumbs + tags for the same event — including a real `GET https://api-production-5b94d5ce.up.railway.app/movies/1300968 [200]` fetch breadcrumb (the app wired to the deployed backend). |
| `03-mobile-sentry-second-test-stack-trace.png` | `MATINEE-MOBILE-2`: a second, distinct event — DSN captures repeatedly. |
| `04-mobile-sentry-second-test-breadcrumbs.png` | Breadcrumbs for the second event. |
| `05-server-sentry-test-error-stack-trace.png` | `MATINEE-SERVER-1`: server event, `environment: production`, `node v24.22.3`, running on Railway. |
| `06-server-sentry-production-tags-and-context.png` | Same event's tags + context: `environment=production`, `os Debian 12.15`, `server_name dd337fd6f81d` (the deployed Railway container). |

## Server flush test (run on the deployed Railway container)

SSH'd into the production container and fired a manual event, confirming the live
DSN is wired and the event flushes to Sentry. `server_name` in `06` above
(`dd337fd6f81d`) matches the container the flush ran on.

```
root@dd337fd6f81d:/app# node --input-type=module <<'JS'
import { initSentry, captureException } from './dist/observability/sentry.js';
import * as Sentry from '@sentry/node';

if (!initSentry()) {
  throw new Error('SENTRY_DSN is missing');
}

captureException(new Error('Matinee server Sentry evidence test'));
console.log('Flush completed:', await Sentry.flush(5000));
await Sentry.close(2000);
JS
Flush completed: true
```

`initSentry()` returned truthy (so `SENTRY_DSN` is live in production — it didn't
throw `SENTRY_DSN is missing`), and `Sentry.flush(5000)` returned `true` (the
event reached Sentry). The resulting event is `MATINEE-SERVER-1` (screenshots 05/06).