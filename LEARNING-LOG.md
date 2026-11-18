# Learning log

One paragraph per slice, written by Dave in his own words after closing the chat. Agents never write or edit entries here.

## Slice 0 · Secrets and the `.env` overwrite — 2026-11-13

.env is gitignored because it contains the app's service secrets, such as database connection strings and API keys. Since my repository is public, committing those secrets would let anyone copy them and potentially access user data, change or delete records, or use paid services through my account.

During testing, the agent overwrote the file. The secrets were lost locally, not exposed, so I only needed to copy them back from the service dashboards. If they had been exposed—or I suspected someone untrusted had seen them—I would need to rotate them, meaning replace the old secrets with new ones.

That is why the new rule prevents agents from writing to .env: it protects the real configuration from being overwritten during development or testing.
## Slice 0 · The `/health` endpoint — 2026-11-13

`GET /health` checks Postgres primary, replica, and Redis separately so I can identify failures, including a broken replica while the primary still works.
Short timeouts prevent hanging; the endpoint should return `200` when healthy or `503` with each dependency's result when one fails.
Building it in slice 0 helps catch connection and configuration problems before adding features.

## Slice 1 · TMDB backend-for-frontend (caching + fallback) — 2026-11-13

The app gets movies through my server to keep the TMDB key secret and protect the app from changes to TMDB's response format. Only `tmdb.ts` translates TMDB's fields into our own `Movie` type, so changes can be handled in one place.

Cache-aside means checking Redis first and calling TMDB when there is no usable cached result. The TTL controls how long a result stays fresh: now-playing gets 3 hours because it changes less often, while search gets 5 minutes because many different searches create more cached entries.

If TMDB is down, the server returns an older cached copy when one is available. If nothing is cached, it returns a clean `503`, and the app shows the "Server overloaded" screen with a retry option.
## Slice 1 · Squash-merge and the Gitleaks fingerprint — 2026-11-13

I learned that squash-merging creates a new commit ID, so Gitleaks exceptions tied to older commits can stop matching. In my case, it flagged two fake test tokens again. I verified they were dummy values, updated their exact exceptions, and confirmed the secret scan passed on `main`.

## Movie detail + Showtimes

The app asks my server for movie data so the TMDB key stays out of the mobile app, where someone could extract it. The server also caches responses and translates TMDB's fields in one place, keeping the app protected from changes to that format. TMDB supplies movie information, but our cinema schedules belong in our own database because we control the screens, times, and bookings. If a movie does not exist, the user sees a "not found" state (`404`). If TMDB is unavailable, we show an older cached copy when possible; otherwise, we return `503` and offer a retry. Checking Figma first revealed missing data such as age ratings, language, director, cast, and showtimes grouped by format, so I updated the server before building screens that needed those details.

## Slice 5a · Seat holds and the double-booking guarantee — 2026-11-16

What clicked for me was that Redis gives users a fast, temporary hold, but the database's unique constraint is what ultimately prevents two bookings for the same seat. I learned that even if the hold system fails, the database still needs to protect that rule.

## Slice 5c · Rate limiting — fail-open vs fail-closed — 2026-11-17

What clicked for me was that fail-open and fail-closed depend on which mistake would cause more harm. I chose to refuse bookings when holds cannot be checked, but let requests pass when the rate limiter fails so its outage does not block the whole API. That preserves some availability at the cost of temporarily losing throttling, while Postgres still enforces the no-double-booking rule.

## Slice 5d · Waiting room without a background worker — 2026-11-18

What clicked for me was that the waiting room did not need a constantly running background worker. Existing seat-map polls act as heartbeats, and users stop counting as active after about 30 seconds without checking in. Queue requests trigger admissions based on elapsed time and the configured rate, while each operation removes outdated entries and key expiry clears leftover data. The seat-holding cap also counts only holds that still exist, so expired holds stop counting automatically. I learned to check whether existing requests and expiry rules can handle the work before adding another service to run and maintain. 

## Slice 5e · Load test — the bottleneck below the code — 2026-11-18

What surprised me was that the small database pool held up because Redis limited booking attempts to the users who won a seat hold. The connection failures happened before requests reached the app, showing me that bottlenecks can sit below my code. I learned to measure each layer and record test conditions clearly: staggering arrivals helped the local test run, but it was not the same as handling 500 simultaneous connections.

## Slice P1 · Payments — a successful charge isn't a confirmed booking — 2026-11-18
What clicked for me was that a successful payment does not automatically mean a confirmed booking. The verified webhook starts that process, and the worker records the charge before trying to deliver the seats. If the hold has expired, P1 refunds the payment, while idempotent processing makes retries safe without creating duplicate bookings or refunds.
