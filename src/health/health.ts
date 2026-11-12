import type { Redis } from 'ioredis';
import type { RequestHandler } from 'express';
import type { DbClients } from '../db/clients.js';

export type CheckStatus = 'ok' | 'error';
export type HealthReport = {
  ok: boolean;
  checks: Record<'postgresPrimary' | 'postgresReplica' | 'redis', { status: CheckStatus; reason?: string }>;
};

/** Bounds how long a single dependency check may take, so a hung connection can't hang /health itself. */
const CHECK_TIMEOUT_MS = 2_000;

async function withTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function check(run: () => Promise<unknown>): Promise<{ status: CheckStatus; reason?: string }> {
  try {
    await withTimeout(run(), CHECK_TIMEOUT_MS);
    return { status: 'ok' };
  } catch (err) {
    return { status: 'error', reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Deliberately different from Rota's /health (ADR 0005, Dave's instruction): this one actually
 * reaches Postgres primary, Postgres replica, and Redis, and answers 503 the moment any of them
 * is unreachable, with per-dependency detail. It never throws — a dependency failure is reported
 * in the body, not as an unhandled error, so this route never goes through the generic error
 * handler.
 */
export function createHealthHandler(db: DbClients, redis: Redis): RequestHandler {
  return (_req, res) => {
    void (async () => {
      const [postgresPrimary, postgresReplica, redisCheck] = await Promise.all([
        check(() => db.primary.$queryRaw`SELECT 1`),
        check(() => db.reader.$replica().$queryRaw`SELECT 1`),
        check(() => redis.ping()),
      ]);

      const report: HealthReport = {
        ok: postgresPrimary.status === 'ok' && postgresReplica.status === 'ok' && redisCheck.status === 'ok',
        checks: { postgresPrimary, postgresReplica, redis: redisCheck },
      };
      res.status(report.ok ? 200 : 503).json(report);
    })();
  };
}
