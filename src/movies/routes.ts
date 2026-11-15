import { Router, type Response } from 'express';
import type { z } from 'zod';
import { recordRouteBase } from '../http/logger.js';
import { validateRequest } from '../http/validate.js';
import {
  DiscoverQuerySchema,
  MovieIdParamsSchema,
  NowPlayingQuerySchema,
  PopularQuerySchema,
  SearchQuerySchema,
} from './movie.js';
import type { CacheStatus, MovieService } from './service.js';
import type { ShowtimeService } from '../showtimes/showtime.js';

/**
 * Tells the caller (and the request log) where the data came from: HIT | MISS | STALE.
 * Informational only, not part of the Movie/Genre contract.
 */
function sendWithCache(res: Response, payload: unknown, cache: CacheStatus) {
  res.locals.cache = cache;
  res.setHeader('X-Cache', cache.toUpperCase());
  res.json(payload);
}

/**
 * The only way the app gets movie data (RULES D1.2). Mounted at /movies. Query and route params
 * are validated with Zod before anything runs; handlers read only `req.validated`.
 *
 * Specific routes (/now-playing, /search, /discover) are registered BEFORE /:id so Express never
 * matches them as a movie id.
 */
export function createMoviesRouter(service: MovieService, showtimes?: ShowtimeService): Router {
  const router = Router();
  router.use(recordRouteBase); // keeps "/movies" in the request log line (see logger.ts)

  router.get('/now-playing', validateRequest({ query: NowPlayingQuerySchema }), async (req, res) => {
    const { query } = req.validated as { query: z.output<typeof NowPlayingQuerySchema> };
    const result = await service.nowPlaying(query.page);
    sendWithCache(res, result.page, result.cache);
  });

  router.get('/popular', validateRequest({ query: PopularQuerySchema }), async (req, res) => {
    const { query } = req.validated as { query: z.output<typeof PopularQuerySchema> };
    const result = await service.popular(query.page);
    sendWithCache(res, result.page, result.cache);
  });

  router.get('/search', validateRequest({ query: SearchQuerySchema }), async (req, res) => {
    const { query } = req.validated as { query: z.output<typeof SearchQuerySchema> };
    const result = await service.search(query.q, query.page);
    sendWithCache(res, result.page, result.cache);
  });

  router.get('/discover', validateRequest({ query: DiscoverQuerySchema }), async (req, res) => {
    const { query } = req.validated as { query: z.output<typeof DiscoverQuerySchema> };
    const result = await service.discover(query.genreId, query.page);
    sendWithCache(res, result.page, result.cache);
  });

  if (showtimes) {
    router.get('/:id/showtimes', validateRequest({ params: MovieIdParamsSchema }), async (req, res) => {
      const { params } = req.validated as { params: z.output<typeof MovieIdParamsSchema> };
      res.json(await showtimes.forMovie(params.id));
    });
  }

  router.get('/:id', validateRequest({ params: MovieIdParamsSchema }), async (req, res) => {
    const { params } = req.validated as { params: z.output<typeof MovieIdParamsSchema> };
    const result = await service.detail(params.id);
    sendWithCache(res, result.movie, result.cache);
  });

  return router;
}

/** Mounted at /genres. Returns the TMDB movie genre list with cache-aside X-Cache headers. */
export function createGenresRouter(service: MovieService): Router {
  const router = Router();
  router.use(recordRouteBase);

  router.get('/', async (_req, res) => {
    const result = await service.genres();
    sendWithCache(res, result.genres, result.cache);
  });

  return router;
}
