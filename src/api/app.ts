import express from 'express';
import type { Redis } from 'ioredis';
import type { DbClients } from '../db/clients.js';
import { createHealthHandler } from '../health/health.js';
import { createErrorHandler, notFoundHandler } from '../http/errors.js';
import { createLogger, recordRouteBase, requestLogger, type Logger } from '../http/logger.js';
import { requestIdMiddleware } from '../http/requestId.js';
import { createMoviesRouter } from '../movies/routes.js';
import type { MovieService } from '../movies/service.js';

export interface AppDeps {
  logger?: Logger;
  db: DbClients;
  redis: Redis;
  /**
   * Optional only so slice 0's /health integration test can build an app without TMDB. When it is
   * absent, /movies is simply not mounted. api/main.ts always provides it.
   */
  movies?: MovieService;
}

export function createApp(deps: AppDeps) {
  const logger = deps.logger ?? createLogger();
  const app = express();

  app.use(recordRouteBase);
  app.use(requestIdMiddleware);
  app.use(requestLogger(logger));

  app.get('/health', createHealthHandler(deps.db, deps.redis));
  if (deps.movies) app.use('/movies', createMoviesRouter(deps.movies));

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}
