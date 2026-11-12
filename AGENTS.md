# Matinee server — agent instructions

Read by Codex, Antigravity agents and Claude Code (`CLAUDE.md` just imports this file).
Cinema booking app. Part 2, Task B of the Dev and Design HQ Final Graduation Task.

**Authority order:** graduation brief PDF > `docs/RULES.md` > this file.
If they disagree, say so to Dave. Do not guess.

`docs/RULES.md` holds every graded requirement as a checklist with an evidence column. Read it fully before writing code. This file is how you work; that file is what must be true.

---

## 1. Ground truth

- The task is pass/fail per checklist item. A missing or broken evidence link means the item is not complete.
- The UI is "judged harshly". "It works" scores nothing.
- Headline requirement: a seat is **never sold twice**, proven by k6 (500 VUs, same 50 seats, zero double bookings).
- `SUBMISSION.md` lives in a different repo (`final-task-dave-hennit`). This repo produces evidence and links. Dave assembles them there.
- Dave must be able to explain every line. You write code; he writes `LEARNING-LOG.md`. **Never write or edit his entries.**

## 2. Blocked until answered

Do not start building until Dave has answered these. Record each answer as an ADR in `docs/decisions/`.

1. Payments provider: reuse Stripe test mode, or Flutterwave/Paystack?
2. TMDB key obtained and attribution terms read?
3. Figma: new file for Matinee (preferred, the brief wants a file link) or a page in the Rota file?
4. One repo or split app/server? (Rota used one.)
5. Which 5 well-made apps will he study?

## 3. The working loop (every slice)

1. **Plan.** Write the slice plan: scope, files, tests, evidence to capture, whether it needs a new native build.
2. **Wait for Dave's go.** Never implement from an unapproved plan.
3. **Branch** `feat/<slice>` or `fix/<slice>`. One feature, one branch, one PR.
4. **Capture the "before"** (baseline, failing test, or recording) in its own commit before any improvement.
5. **Build.** Conventional Commits only.
6. **Prove.** Correct row exists in the DB **and is shown in the UI**. Capture the row before any cleanup.
7. **PR** with description and screenshots. Link the issue. **Dave squash-merges** (see "Merging and branch cleanup"). Never merge, never force-push.
8. **Hand back.** Remind Dave to close the chat and write his `LEARNING-LOG.md` paragraph.
9. **Interview question.** Ask him the relevant one (list in RULES.md section J), one at a time, and give an honest verdict, not a pass.

Say **"tell Dave before the change"** if something will need a new EAS native build. Credits are limited and shared with the rest of the task.

Ten-minute rule: if a blocking unknown can be settled by trying it, try it. That is the research.

## Merging and branch cleanup

1. **Dave merges, and always with "Squash and merge".** Never a plain merge commit, never rebase-merge. The squash commit title is the PR title in Conventional Commits format.
2. **The agent never merges** and never deletes a branch whose PR is still open.
3. **When Dave says a PR is merged, confirm it before doing anything else:**
   - `git fetch --prune origin`
   - `gh pr view <number> --json state,mergeCommit` shows `MERGED` (if `gh` is unavailable, check that the PR's change is on `origin/main`).
   - The new commit on `origin/main` has **one parent** and a title ending in `(#<number>)`: `git log -1 --format='%p | %s' origin/main`. Two parents, or a title starting "Merge pull request", means it was not squashed. Tell Dave; do not rewrite history to fix it.
4. **Then clean up:** `git checkout main && git pull`, delete the local branch with `git branch -D <branch>` (capital D, because a squashed branch does not look merged to git), and delete the remote branch if GitHub has not already: `git push origin --delete <branch>`.
5. **Report back in one line:** PR number, squash confirmed or not, branches deleted.

## 4. Non-negotiables

- **No AI attribution in git.** Never add `Co-Authored-By`, `Claude-Session`, "Generated with" or any other AI credit line to a commit message or PR description. Dave is the only author. The `.githooks/commit-msg` hook rejects them; after a fresh clone run `git config core.hooksPath .githooks`.
- **Never trust the frontend.** Identity, price, fee, total, seat state, payment state: server only.
- **Money = integer minor units.** No decimals or floats anywhere. Server returns finished display strings. The app never computes a total.
- **No secrets** in repo, history or app. Server env vars only. Keep `.env.example` (names, no values) current. Every `EXPO_PUBLIC_*` is listed in the README with a reason it is safe to expose. Never create, overwrite, modify, or delete `.env` — it holds real credentials and regenerating it cannot recover them. If a local smoke test needs throwaway env values, write them to `.env.test.local` (git-ignored) and load that file explicitly via a dotenv path or an inline env override — never write to `.env` or point a test at it.
- **Zod on every request** (body, query, route params), server side.
- **The app never calls TMDB.** Backend only. Exactly **one file** knows TMDB's shape.
- **Booking is confirmed only by a verified webhook**, processed in a BullMQ job, duplicates ignored.
- **Tokens only** for spacing, colour, radius, type, shadow. No `margin: 13`. A failing test enforces it.
- **Tokens in `expo-secure-store`**, never AsyncStorage.
- **No `console.log` in server code.** Structured logger only.
- **Do not relitigate decided stack.** Raise a conflict as an ADR proposal instead.

## 5. Decided stack

React Native + Expo (Antigravity) · TypeScript strict · Node + Express · PostgreSQL on a dedicated Neon project for Matinee (primary + read replica + `-pooler` host, ADR 0007) · BullMQ on Redis, hosted on Railway (replaces Aiven Valkey for Matinee specifically; ADR 0008) · Zod · TanStack Query · Zustand (small) · expo-secure-store · Resend from a verified `davebuilds.design` subdomain · Sentry (app + server, shared redaction list) · k6 · Railway, Hobby plan (replaces Northflank for Matinee; ADR 0009 — Oracle Always Free remains the documented fallback) · EAS Android `preview` profile · Reanimated · expo-haptics.

## 6. Layout (split repos, ADR 0004)

Two public repos, side by side locally in `Developer/Matinee/`. Each README links to the other.

```
matinee-server/   (this repo)
  src/            API, jobs, database
  docs/           RULES.md ARCHITECTURE.md TRAFFIC.md SHARDING.md decisions/ evidence/ handoff/
  load-tests/     k6 scripts + written report
  README.md  LEARNING-LOG.md  .env.example  LICENSE (MIT)  AGENTS.md  CLAUDE.md

matinee-mobile/
  src/            Expo React Native app, tokens, component library
  docs/           COMPONENTS.md DESIGN-STUDY.md evidence/
  README.md  LEARNING-LOG.md  .env.example  LICENSE (MIT)  AGENTS.md  CLAUDE.md
```

- **This repo is the single home for `docs/RULES.md` and all ADRs** (`docs/decisions/`), including mobile ones.
- **The API contract lives here.** Request/response Zod schemas are defined in the server. The mobile repo mirrors the types; any contract change lands in a server PR first, then a mobile PR that links to it.
- A feature touching both sides is two PRs, cross-linked, server merged first.
- Server secrets live in this repo's `.env` only. The mobile repo holds no secrets.

Commands: fill this table in after slice 0 scaffolds the repo. Do not invent script names.

| Task | Command |
|---|---|
| install / dev / typecheck / lint / test / k6 | _TBD at slice 0_ |

## 7. Seat-hold invariants (Requirement 5)

- Take a hold: Redis `SET key token NX PX <ttl>`. One atomic step. TTL 10 minutes unless an ADR says otherwise.
- Release a hold: **compare token then delete** (Lua). Never a plain `DEL`.
- DB safety net: `UNIQUE (showtime_id, seat_id)` on bookings. Redis is the fast path; the constraint makes double booking impossible.
- **Redis down = fail closed.** Refuse new holds with a clear retryable error. Never fall open on holds.
- Never cache seat availability in a way that can sell a seat twice. Never cache payment status or webhook idempotency records.
- Late webhook after hold expiry: follow the ADR. Write that ADR **before** testing the case.
- Waiting room admits at a fixed rate and the app shows queue position.
- Rate limits live in Redis, per user and per IP, strict on hold, checkout and search.

## 8. Webhook pattern (carried from Rota)

`express.raw({type:'application/json'})` on the webhook route only, registered before any global JSON parser → verify signature against the raw body → store event ID durably first → respond 200 → queue processing. Skip already-seen event IDs. Ledger is append-only; corrections are new rows.

## 9. Logging and observability

Every request logs: request ID, user ID, route, response time, result. Every job attempt is logged. Sentry on app and server. Must be able to answer "what happened to this user's booking at 3:14pm?" from logs alone.

## 10. Evidence and recording protocol

- When something breaks, stop and tell Dave: **"record this before we fix it."** Then record it working after. Do this from bug one.
- Save evidence under `docs/evidence/<slice>/` (screenshots, row dumps, clips, EXPLAIN output, k6 output) and reference it in the PR.
- Demo video and LinkedIn decision post are **two separate artefacts**.
- "Measure before you improve": a baseline commit exists before the improvement commit.

## 11. Mechanical checks (CI must fail on these)

- Token lint: raw numeric spacing, colour or radius outside the token file.
- Money lint: prices or arithmetic in `/app`.
- Secret scan: `sk_`, `secret`, `password`, `_KEY` across full git history.
- `EXPO_PUBLIC_` audit against the README list.
- Accessibility: contrast ≥ 4.5:1 in token tests, 44×44 min touch targets, labels on all buttons/images.

## 12. Multi-agent coordination (Claude Code, Codex, Antigravity)

- One agent per branch. Never two agents on the same branch or same files.
- Before starting, read `docs/handoff/` for the latest note. Before stopping, write one: what changed, what is unproven, what is next.
- Do not run formatters or refactors over files you do not own in your slice.
- Do not touch: `LEARNING-LOG.md`, other agents' branches, `.env` files, git history, EAS credentials.
- If two agents disagree on a design choice, write an ADR draft and ask Dave. Do not pick quietly.
- Prefer small PRs. If a slice grows past one feature, split it and say so.

## 13. Stop and ask Dave when

- Spec and PDF disagree, or the PDF is silent on something that matters.
- A change needs a new native build, a new paid service, or a new secret.
- You would deviate from the decided stack or change the hold TTL.
- You are about to delete data, rotate a key, or rewrite history.
