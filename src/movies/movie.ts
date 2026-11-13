import { z } from 'zod';

/**
 * THE movie contract (Requirement 1). The shape below IS the API: mobile mirrors these types, and
 * any change lands in a server PR first (AGENTS.md section 6). Nothing in this file knows TMDB's
 * field names; `tmdb.ts` is the only file that does, and it maps INTO these types.
 */

/** Longest `overview` we send. The list screens need a teaser, not TMDB's full synopsis. */
export const OVERVIEW_MAX_LENGTH = 200;

export const MovieSchema = z.strictObject({
  /** Stable movie id. Opaque to the app; later slices (showtimes) key on it. */
  id: z.number().int().positive(),
  title: z.string(),
  /** A ready-to-load image URL, built server-side. null when the movie has no poster. */
  posterUrl: z.url().nullable(),
  /** Release year (e.g. 2026). null when the release date is unknown. */
  year: z.number().int().positive().nullable(),
  /** Short teaser, at most OVERVIEW_MAX_LENGTH characters. null when there is none. */
  overview: z.string().max(OVERVIEW_MAX_LENGTH).nullable(),
});
export type Movie = z.infer<typeof MovieSchema>;

/** A page of movies plus the page info the app needs to ask for the next one. */
export const MoviesPageSchema = z.strictObject({
  movies: z.array(MovieSchema),
  /** The 1-based page these movies are from. */
  page: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
  totalResults: z.number().int().nonnegative(),
});
export type MoviesPage = z.infer<typeof MoviesPageSchema>;

// ---- Request schemas (Zod on every request, AGENTS.md section 4) -----------------------------

/** TMDB serves at most 500 pages per list; asking beyond that is a guaranteed upstream error. */
export const MAX_PAGE = 500;

/** Longest search text we accept. Bounds the cache key and the upstream request. */
export const MAX_QUERY_LENGTH = 100;

/** `?page=` is digits only (no "1e2", " 3", "0x10"), 1..MAX_PAGE, defaulting to 1. */
const pageParam = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(MAX_PAGE))
  .default(1);

/** Lower-case, trim and collapse whitespace: "  Dune   PART two " and "dune part two" are one query. */
export function normaliseQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

export const NowPlayingQuerySchema = z.strictObject({ page: pageParam });

export const SearchQuerySchema = z.strictObject({
  // Length is bounded BEFORE normalising so a huge string is rejected without being processed.
  q: z.string().max(MAX_QUERY_LENGTH).transform(normaliseQuery).pipe(z.string().min(1)),
  page: pageParam,
});

// ---- The seam between the service and whatever supplies movies -------------------------------

/** What the rest of the server needs from a movie provider. TMDB is one implementation. */
export interface MovieSource {
  nowPlaying(page: number): Promise<MoviesPage>;
  /** `query` is already normalised. */
  search(query: string, page: number): Promise<MoviesPage>;
}

/**
 * The provider could not give us movies (down, timing out, rate limiting us, rejecting our key,
 * or answering in a shape we do not recognise). The message is for our logs only and never
 * contains secrets or the provider's response body.
 */
export class MovieSourceError extends Error {
  readonly reason: string;
  readonly upstreamStatus?: number;

  constructor(reason: string, upstreamStatus?: number) {
    super(`movie source failed: ${reason}`);
    this.name = 'MovieSourceError';
    this.reason = reason;
    this.upstreamStatus = upstreamStatus;
  }
}
