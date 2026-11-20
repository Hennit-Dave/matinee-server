import express from 'express';
import type { Redis } from 'ioredis';
import type { DbClients } from '../db/clients.js';
import type { BookingService } from '../bookings/bookingService.js';
import { createBookingsRouter } from '../bookings/routes.js';
import { createHealthHandler } from '../health/health.js';
import { TRUSTED_PROXY_RANGES } from '../http/clientIp.js';
import { createErrorHandler, notFoundHandler } from '../http/errors.js';
import { createLoadShedder } from '../http/loadShed.js';
import { createLogger, recordRouteBase, requestLogger, type Logger } from '../http/logger.js';
import { requestIdMiddleware } from '../http/requestId.js';
import { createGenresRouter, createMoviesRouter } from '../movies/routes.js';
import type { MovieService } from '../movies/service.js';
import type { RateLimiter } from '../ratelimit/limiter.js';
import { createShowtimesRouter } from '../showtimes/seatRoutes.js';
import type { SeatService } from '../showtimes/seat.js';
import type { ShowtimeService } from '../showtimes/showtime.js';
import { createQueueRouter } from '../waitingroom/routes.js';
import type { WaitingRoom } from '../waitingroom/waitingRoom.js';
import type { CheckoutService } from '../payments/checkoutService.js';
import { createCheckoutRouter, createOrderStatusRouter, createStripeWebhookRouter } from '../payments/routes.js';
import type { OrderStatusService } from '../payments/orderStatus.js';
import type { WebhookService } from '../payments/webhookService.js';
import type { CancelShowtimeService } from '../showtimes/cancelService.js';
import { createAdminCancelRouter } from '../showtimes/cancelRoutes.js';

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
  /** Checkout (ADR 0019), mounted under /showtimes. When absent (no Stripe key) the route is not mounted. */
  checkout?: CheckoutService;
  /** The Stripe webhook (ADR 0019), mounted under /webhooks. When absent the route is not mounted. */
  webhook?: WebhookService;
  /** The confirmation poll (payments P2), mounted under /orders. When absent the route is not mounted. */
  orderStatus?: OrderStatusService;
  /**
   * The admin cancel endpoint (ADR 0020), mounted under /admin only when both this service and `adminKey` are
   * present. When absent the route is not mounted.
   */
  cancel?: CancelShowtimeService;
  /** The server-only secret the cancel endpoint compares against. Never logged; only its presence gates the route. */
  adminKey?: string;
  /**
   * Required, not optional: forgetting it must be a compile error, not a server that silently has no limits
   * (ADR 0016). Tests that are not about limiting pass `noRateLimit`.
   */
  rateLimiter: RateLimiter;
  /**
   * The waiting room (ADR 0017). When present, entry to seat selection is gated and the /showtimes/:id/queue routes are mounted
   * (they also need `showtimeExists`). When absent nothing is gated, same convention as `seats` and `bookings`.
   */
  waitingRoom?: WaitingRoom;
  /** Does this showing exist? The queue refuses an unknown id, so junk ids never become Redis keys. */
  showtimeExists?: (showtimeId: string) => Promise<boolean>;
  /** Requests allowed in flight at once before the rest are shed with 503 server_busy (loadShed.ts). 0 or absent: no shedding. */
  maxInFlight?: number;
}

export function createApp(deps: AppDeps) {
  const logger = deps.logger ?? createLogger();
  const app = express();
  const { limit } = deps.rateLimiter;

  // Behind Railway's proxy the socket address is the proxy's. Trust by address range, not by hop count, so
  // `req.ip` is the first address from the right that a proxy hop cannot be (src/http/clientIp.ts, ADR 0016).
  app.set('trust proxy', [...TRUSTED_PROXY_RANGES]);

  app.use(recordRouteBase);
  app.use(requestIdMiddleware);
  app.use(requestLogger(logger));
  // After the request logger, so a shed request still gets its log line (route, 503, server_busy).
  if (deps.maxInFlight) app.use(createLoadShedder({ maxInFlight: deps.maxInFlight, logger }));

  app.get('/health', createHealthHandler(deps.db, deps.redis));
  if (deps.movies) {
    app.use('/movies', createMoviesRouter(deps.movies, limit, deps.showtimes));
    app.use('/genres', createGenresRouter(deps.movies));
  }

  const gate = deps.waitingRoom?.gate();
  if (deps.seats) {
    app.use('/showtimes', createShowtimesRouter(deps.seats, limit, gate));
  }
  if (deps.bookings) {
    app.use('/showtimes', createBookingsRouter(deps.bookings, limit, gate));
  }
  if (deps.checkout) {
    app.use('/showtimes', createCheckoutRouter(deps.checkout, limit));
  }
  if (deps.waitingRoom && deps.showtimeExists) {
    app.use('/showtimes', createQueueRouter(deps.waitingRoom, limit, deps.showtimeExists));
  }
  if (deps.webhook) {
    app.use('/webhooks', createStripeWebhookRouter(deps.webhook));
  }
  if (deps.orderStatus) {
    app.use(createOrderStatusRouter(deps.orderStatus, limit));
  }
  if (deps.cancel && deps.adminKey) {
    app.use('/admin', createAdminCancelRouter(deps.cancel, deps.adminKey));
  }

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}
