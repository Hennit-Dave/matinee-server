/**
 * TEST-ONLY `fetch` for the tests that start a real server and talk to it. Nothing outside a `*.test.ts` file imports it.
 *
 * Two things a bare `fetch` does that made a rare failure cost five minutes and a confusing message:
 *
 * 1. It has NO deadline of its own: a request that never gets an answer waits for undici's 300 s `headersTimeout`. Here every request
 *    is given `timeoutMs` (10 s unless a test says otherwise), and a hung one fails with a clear `TimeoutError` in seconds.
 * 2. It keeps connections alive and pools them by address, so a test can send a request down a socket left over from an earlier test's
 *    server (which has since closed). Every request here says `Connection: close`, so each one gets a fresh socket and nothing is left to go stale.
 *    (A `close` request can still reuse a socket that is ALREADY pooled and closes it afterwards, so use this helper for every request
 *    in a file, not just some.)
 *
 * A caller's own `signal` still works (the two are combined), and so do its method, headers and body.
 */
export const TEST_REQUEST_TIMEOUT_MS = 10_000;

export function testFetch(url: string | URL, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = TEST_REQUEST_TIMEOUT_MS, signal, headers, ...rest } = init;
  const merged = new Headers(headers);
  merged.set('connection', 'close');
  const deadline = AbortSignal.timeout(timeoutMs);
  return fetch(url, { ...rest, headers: merged, signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
}
