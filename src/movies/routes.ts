import { Router, type Response } from 'express';
import type { z } from 'zod';
import { recordRouteBase } from '../http/logger.js';
import { validateRequest } from '../http/validate.js';
import { NowPlayingQuerySchema, SearchQuerySchema } from './movie.js';
import type { MoviesResult, MovieService } from './service.js';

/**
 * The only way the app gets movie data (RULES D1.2). Mounted at /movies. Query params are
 * validated with Zod before anything runs; handlers read only `req.validated`.
 */
export function createMoviesRouter(service: MovieService): Router {
  const router = Router();
  router.use(recordRouteBase); // keeps "/movies" in the request log line (see logger.ts)

  // Tells the caller (and the request log) where the data came from: HIT | MISS | STALE.
  // Informational only, not part of the Movie contract.
  function send(res: Response, result: MoviesResult) {
    res.locals.cache = result.cache;
    res.setHeader('X-Cache', result.cache.toUpperCase());
    res.json(result.page);
  }

  router.get('/now-playing', validateRequest({ query: NowPlayingQuerySchema }), async (req, res) => {
    const { query } = req.validated as { query: z.output<typeof NowPlayingQuerySchema> };
    send(res, await service.nowPlaying(query.page));
  });

  router.get('/search', validateRequest({ query: SearchQuerySchema }), async (req, res) => {
    const { query } = req.validated as { query: z.output<typeof SearchQuerySchema> };
    send(res, await service.search(query.q, query.page));
  });

  return router;
}
