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

