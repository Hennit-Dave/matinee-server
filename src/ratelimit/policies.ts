/**
 * The rate limits, in one place (ADR 0016). A route asks for a policy by name (`limit('hold')`); nothing about
 * windows or counts is repeated per route.
 *
 * EVERY NUMBER HERE IS CHOSEN, NOT MEASURED. They sit above what the app really does, with room to spare, and
 * the load test (5e) tunes them. Two counters per policy, and a request must be under BOTH:
 *
 *   user: the install's `X-Client-Id`. It is self-asserted (anyone can mint a new UUID), so it protects an
 *         install from itself and a household from one noisy phone. It is NOT the abuse backstop.
 *   ip:   the caller's address. The real backstop, so it is set higher than `user` to leave room for a shared
 *         address (a household, a venue's wifi). Carrier-grade NAT can still put more people behind one address
 *         than that; they get a 429 with Retry-After, which the app already knows how to show.
 *
 * All windows are 60 s: easy to read ("per minute") and long enough that the weighted-window estimate (see
 * slidingWindow.ts) is smooth.
 */
export type PolicyName = 'seatsPoll' | 'hold' | 'booking' | 'search' | 'queue';

export interface RateLimitPolicy {
  /** Length of the sliding window. */
  windowMs: number;
  /** Requests one install (`X-Client-Id`) may make per window. Applies only when the request names one. */
  user: number;
  /** Requests one address may make per window. */
  ip: number;
}

const MINUTE_MS = 60_000;

export const RATE_LIMIT_POLICIES: Readonly<Record<PolicyName, RateLimitPolicy>> = {
  /**
   * GET /showtimes/:id/seats. The app polls every 5 s +/- 20 % (4 to 6 s), so 10 to 15 a minute. User: 4x the
   * peak, which covers pull-to-refresh, the refresh on resume and a retry. IP: 20 devices at that peak on one
   * address. A scraper above 1 request a second per id, or 5 a second per address, is cut off.
   */
  seatsPoll: { windowMs: MINUTE_MS, user: 60, ip: 300 },
  /**
   * POST /showtimes/:id/holds. One request per Continue tap, and the app waits out Retry-After between tries,
   * so an honest user makes about 3 a minute. User: 10. IP: 40, about 13 people on one address.
   */
  hold: { windowMs: MINUTE_MS, user: 10, ip: 40 },
  /** POST /showtimes/:id/bookings. One per purchase (the app does not call it yet). */
  booking: { windowMs: MINUTE_MS, user: 5, ip: 20 },
  /**
   * GET /movies/search. The app waits 300 ms after the last keystroke, so a slowly typed 9-letter title is about 9
   * requests in 4 s, and three titles a minute is about 27. User: 60. IP: 180, three people searching at once.
   */
  search: { windowMs: MINUTE_MS, user: 60, ip: 180 },
  /**
   * The waiting room's join, position poll and leave (ADR 0017). A waiter polls every 3 s at the fastest (the server tells the back of a
   * long line to ask less often), so 20 a minute honest, plus a join and a retry. User: 3x that. IP: 10 people waiting on one address at once.
   */
  queue: { windowMs: MINUTE_MS, user: 60, ip: 600 },
};
