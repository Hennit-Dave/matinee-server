# 0005 — Server toolchain: matched from Rota where there's no reason to differ

Date: 2026-11-11 · Status: accepted · Decided by: Dave

## Problem

Slice 0 needs a logger, a test runner, a request-ID scheme, an error-response shape, a request-validation
pattern, a database-access library and a Redis client. Rota already built every one of these, some of them
after a real incident (the half-open Valkey connection, ADR 0018) or a real registry check (TypeScript/Express
version pins, ADR 0001). Re-deriving them from scratch for Matinee would risk repeating mistakes Rota already
paid to fix.

## Options

1. **Decide independently for Matinee** (e.g. pino, Vitest, raw `pg`): a clean slate, but ignores working,
   already-proven solutions sitting one directory over.
2. **Match Rota file-for-file where there's no reason to differ**, and say explicitly, in one place, everywhere
   Matinee's own rules or its different infrastructure force a difference.

## Decision

Option 2.

| Area | Matched from Rota (source file) | Deliberately different for Matinee |
|---|---|---|
| Logger | Hand-rolled allowlist JSON-line logger — `createLogger`, an `ALLOWED` fields list, redaction by construction, no pino/winston (`server/src/http/logger.ts`) | **No `console.log` anywhere, including boot/shutdown.** Rota's own scaffold ADR (0001) allowed `console.log` until a later logging slice, and `api/main.ts` still uses it today for boot lines. AGENTS.md bans `console.log` in Matinee's server code outright, from the first commit. |
| Request ID | `res.locals.requestId`; an incoming `X-Request-Id` is accepted only if it's a canonical UUID, else `randomUUID()` (`server/src/http/requestId.ts`) | None. No `AsyncLocalStorage` — Rota doesn't need it either. |
| Test runner | Node's built-in `node --test` via `tsx`, both repos. No Vitest, no Jest/`jest-expo` (`server/package.json`, `app/package.json` scripts) | None for pure logic. **`node --test` has no React Native renderer.** When Matinee's component library lands (D3) and needs to render-test a component, that will need `@testing-library/react-native` under Jest + `jest-expo` as a second, additional test runner scoped to its own file pattern — decided at that slice, not now. |
| Error handling | `ApiError` class, `STATUS`/`MESSAGE` maps per code, one response body `{ error: { code, message, requestId, details?, retryAfterSeconds? } }`, never a stack trace, `notFoundHandler`, connection-failure detection mapped to 503 (`server/src/http/errors.ts`) | Matinee's `STATUS`/`MESSAGE` map starts with only the codes slice 0 needs (`not_found`, `validation_failed`, `invalid_json`, `payload_too_large`, `internal_error`, `service_unavailable`) and grows per slice, same as Rota's did. No Prisma-sharding-specific error codes — Matinee has no shards. |
| Request validation | `validateRequest({ params?, query?, body? })`, strict Zod objects, an unspecified part defaults to an empty strict object, `req.validated`, `ZodError` mapped to our own `ErrorDetail[]` (`server/src/http/validate.ts`) | None. |
| JSON body parsing | No global `express.json()`; each router mounts its own parser, leaving room for a raw-body webhook route registered first (`server/src/http/json.ts`, `server/src/api/app.ts`) | None — this is exactly AGENTS.md rule 8's webhook pattern, already solved. |
| Database access | Prisma + `@prisma/adapter-pg` + `@prisma/extension-read-replicas`, pinned exact versions, pooled `-pooler` URLs only, never falling back to a direct URL, pool size as an explicit parameter (`server/src/db/clients.ts`) | **No sharding.** Matinee is one logical database: one primary `PrismaClient` plus one reader extended with `$replica()`, not Rota's per-shard `Shards` record. Pool sizes reasoned independently for Matinee in `docs/ARCHITECTURE.md` (not simply copied from Rota's numbers). |
| Redis client | `ioredis`, `lazyConnect`, bounded command/connect timeouts for producer-style use; `maxRetriesPerRequest: null` / `enableReadyCheck: false` for worker-style use (`server/src/jobs/connection.ts`) | **A basic `.on('error', ...)` handler only** (logs, doesn't crash the process) plus ioredis's default reconnect — not Rota's `recycleIfStale` half-open-connection watchdog (ADR 0018). That watchdog exists to protect a rate limiter and a real BullMQ consumer under real traffic; slice 0's worker is a no-op idle-budget probe (ADR 0008), so the elaborate recovery isn't worth building yet. Known gap, to revisit when the Requirement 5 slice adds a rate limiter and real jobs. |
| Toolchain pins | TypeScript **6.0.3** exact (`typescript-eslint`'s peer range excludes 7.x — verified by Rota 2026-10-16), **Express 5.3.0** exact, Node **24.x** (`.nvmrc` + `engines`), `tsx` for dev, no `dotenv` package (`--env-file-if-exists=.env`), npm with exact versions and a committed lockfile (ADR 0001) | None. |
| `/health` | — (Rota's `/health` is `res.json({ ok: true })` and never touches Postgres or Valkey) | **Deliberately different, at Dave's instruction.** Matinee's `/health` checks Postgres (primary + replica) and Redis, with a 503 path, proven against real service containers in CI. |
| CI gate (typecheck/lint/test/secret scan) | — (Rota's `.github/workflows/` has only `docker.yml`, a build-and-smoke-test of the image, and `pages.yml`, a static-site deploy — no typecheck/lint/test/secret-scan gate exists in Rota at all; `gitleaks` is run manually, once, near submission) | Matinee runs typecheck, lint, unit tests, an integration test against service containers, and a secret scan on every push/PR, from slice 0, in both repos — required by Matinee's own AGENTS.md/RULES.md, not something to match from Rota. |
| ESLint / token lint | — (Rota has no ESLint at all) | Matinee needs it regardless, for the D2.3 mechanical token-enforcement check and general lint. No Rota pattern to reuse. |

## Reason

Rota's choices already survived either a real incident or a real version-compatibility check; reusing them is
lower-risk than re-deriving. Where Matinee's own rules are stricter (no `console.log`) or Dave wants different
behaviour (`/health` checking live services, a CI gate from day one), matching would mean building something
that breaks Matinee's own rules, so those are recorded as deliberate differences instead.

## Consequences

- **Easier:** proven patterns, fewer novel failure modes in slice 0; Dave can compare directly against Rota's
  equivalent file when something is unclear, since the shape is the same.
- **Harder or given up:** Rota's half-open-Redis-connection watchdog isn't carried over yet — nothing in slice 0
  needs it. The component-rendering test setup (Jest + `jest-expo` + RNTL) isn't decided yet either.
- **Revisit when:** a rate limiter or real BullMQ jobs exist (the Redis watchdog question); the component
  library lands (the rendering-test setup).
