# Slice 0 evidence: `/health` against Neon + local Redis

Per ADR 0008's addendum, slice 0's live evidence is captured against the real Neon project and a
local Redis — not a Railway Redis service, which is proven later in the deployment slice. This is
the one step in this slice the agent doesn't do itself: no agent reads, prints or logs
`DATABASE_URL`, `DATABASE_READ_URL` or `REDIS_URL` (ADR 0007/0008), and this step runs them for
real.

## Dave: steps to capture this

1. `.env` already has `DATABASE_URL` and `DATABASE_READ_URL` filled in (ADR 0007's addendum). Add
   `REDIS_URL=redis://localhost:6379` if it isn't there yet.
2. Start local Redis if it isn't running: `brew services start redis` (see the README's "Starting
   Redis locally").
3. `npm install` if you haven't yet, then `npm run dev:api`.
4. In another terminal: `curl -i http://localhost:3000/health`.
5. Save the terminal output (or a screenshot) showing:
   - HTTP `200`
   - `"ok":true`
   - all three checks (`postgresPrimary`, `postgresReplica`, `redis`) as `"status":"ok"`
   as `docs/evidence/slice-0/health-ok.png` (or `.txt`), replacing this note.
6. Optional but convincing for the 503 path: stop local Redis (`brew services stop redis`), repeat
   the `curl`, confirm `503` and `"redis":{"status":"error", ...}`, save as
   `health-redis-down.png` (or `.txt`), then start Redis again.

Link both files from the PR description once captured.
