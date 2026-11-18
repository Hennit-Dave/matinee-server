import { Redis, type RedisOptions } from 'ioredis';
import type { Logger } from '../http/logger.js';

export function getRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is not set.');
  return url;
}

/**
 * A basic client only (ADR 0005): a plain `.on('error', ...)` handler that logs and doesn't crash
 * the process, plus ioredis's default reconnect. No producer/worker timeout split and no
 * half-open-connection watchdog (Rota's `recycleIfStale`) — both exist to protect a real consumer
 * under real traffic, and this slice has no queue yet. Revisit once a rate limiter or real BullMQ
 * jobs exist.
 */
export function createRedisClient(logger: Logger, url?: string, overrides?: RedisOptions): Redis {
  const redis = new Redis(url ?? getRedisUrl(), { lazyConnect: true, ...overrides });
  redis.on('error', (err) => {
    logger.warn('redis_connection_error', { reason: err.message });
  });
  return redis;
}

/**
 * A Redis connection for BullMQ (ADR 0019). BullMQ requires `maxRetriesPerRequest: null` — it does its own
 * retry and a re-sent command on a dropped connection would corrupt the queue — so the producer/consumer use
 * this dedicated client, separate from the hold/rate-limit client, on the same Railway Redis (never the
 * Upstash "Jobapplicationmanager" DB; ADR 0008).
 */
export function createBullMqConnection(logger: Logger, url?: string): Redis {
  return createRedisClient(logger, url, { maxRetriesPerRequest: null });
}
