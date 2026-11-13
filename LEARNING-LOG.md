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