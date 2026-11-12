import { closeDbClients, createDbClients } from '../db/clients.js';
import { createLogger } from '../http/logger.js';
import { createRedisClient } from '../jobs/connection.js';
import { createApp } from './app.js';

// Local-development default only; a host injects its own PORT.
const DEFAULT_PORT = 3000;

function readPort(): number {
  const raw = process.env.PORT;
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535, got "${raw}"`);
  }
  return port;
}

const logger = createLogger();

// A bad or missing env var stops the server before it listens: never start weaker. Every boot
// and shutdown line goes through the logger — no console.log/console.error anywhere (AGENTS.md).
let port: number;
let db: ReturnType<typeof createDbClients>;
try {
  port = readPort();
  db = createDbClients();
} catch (err) {
  logger.error('api_start_failed', { reason: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}

const redis = createRedisClient(logger);
void redis.connect().catch(() => {
  // Already reported through the 'error' event handler in createRedisClient; ioredis keeps
  // retrying in the background.
});

const app = createApp({ logger, db, redis });

const server = app.listen(port, () => {
  logger.info('api_listening', { port });
});

async function shutdown(signal: NodeJS.Signals) {
  logger.info('api_shutting_down', { reason: signal });
  server.closeIdleConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  redis.disconnect();
  await closeDbClients(db);
  logger.info('api_closed');
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
