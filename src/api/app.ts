import express from 'express';
import type { Redis } from 'ioredis';
import type { DbClients } from '../db/clients.js';
import type { BookingService } from '../bookings/bookingService.js';
import { createBookingsRouter } from '../bookings/routes.js';
import { createHealthHandler } from '../health/health.js';
import { createErrorHandler, notFoundHandler } from '../http/errors.js';
import { createLogger, recordRouteBase, requestLogger, type Logger } from '../http/logger.js';
import { requestIdMiddleware } from '../http/requestId.js';
import { createGenresRouter, createMoviesRouter } from '../movies/routes.js';
import type { MovieService } from '../movies/service.js';
import { createShowtimesRouter } from '../showtimes/seatRoutes.js';
import type { SeatService } from '../showtimes/seat.js';
import type { ShowtimeService } from '../showtimes/showtime.js';

export interface AppDeps {
  logger?: Logger;
  db: DbClients;
  redis: Redis;
  /**
   * Optional only so slice 0's /health integration test can build an app without TMDB. When it is
   * absent, /movies is simply not mounted. api/main.ts always provides it.
   */
  movies?: MovieService;
  showtimes?: ShowtimeService;
  /** When absent, /showtimes is simply not mounted (same convention as `movies`). */
  seats?: SeatService;
  /** Seat holds and bookings, mounted under /showtimes too. When absent those routes are not mounted. */
  bookings?: BookingService;
}

export function createApp(deps: AppDeps) {
  const logger = deps.logger ?? createLogger();
  const app = express();

  app.use(recordRouteBase);
  app.use(requestIdMiddleware);
  app.use(requestLogger(logger));

  app.get('/health', createHealthHandler(deps.db, deps.redis));
  if (deps.movies) {
    app.use('/movies', createMoviesRouter(deps.movies, deps.showtimes));
    app.use('/genres', createGenresRouter(deps.movies));
  }

  if (deps.seats) {
    app.use('/showtimes', createShowtimesRouter(deps.seats));
  }
  if (deps.bookings) {
    app.use('/showtimes', createBookingsRouter(deps.bookings));
  }

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}
