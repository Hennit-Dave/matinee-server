import express from 'express';
import type { Redis } from 'ioredis';
import type { DbClients } from '../db/clients.js';
import { createHealthHandler } from '../health/health.js';
import { createErrorHandler, notFoundHandler } from '../http/errors.js';
import { createLogger, recordRouteBase, requestLogger, type Logger } from '../http/logger.js';
import { requestIdMiddleware } from '../http/requestId.js';

export interface AppDeps {
  logger?: Logger;
  db: DbClients;
  redis: Redis;
}

export function createApp(deps: AppDeps) {
  const logger = deps.logger ?? createLogger();
  const app = express();

  app.use(recordRouteBase);
  app.use(requestIdMiddleware);
  app.use(requestLogger(logger));

  app.get('/health', createHealthHandler(deps.db, deps.redis));

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}
