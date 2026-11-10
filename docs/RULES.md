# Matinee — RULES (full requirement checklist)

Source of truth: *Final Graduation Task* PDF (Dev and Design HQ), sections "Rules that apply to every part", 1.3–1.5 (repo hygiene), 2.1, 2.2, 2.4, 2.5, and the Final Submission checklist. If this file and the PDF disagree, the PDF wins.

Pass rule: every item below done, with a working link to evidence. Missing or broken link = not complete. "Stretch" items are optional.
Evidence goes in `docs/evidence/<id>/` and is linked from the README or PR. Dave copies links into `SUBMISSION.md` (in `final-task-dave-hennit`).

Legend: `[ ]` required · `[S]` stretch · `[SS]` self-study (Dave writes up what he learned, in his own words, in `LEARNING-LOG.md`).

---

## A. Rules for every part

- [ ] **A1 Explain everything.** Dave can explain every line submitted.
- [ ] **A2 Never trust the frontend.** Identity, payment, permissions, price, seat state checked on the server.
- [ ] **A3 Money in minor units.** Whole numbers only. No decimals, no floats.
- [ ] **A4 "It works" is not success.** Correct record exists in the DB **and is shown**. Capture the row before cleanup.
- [ ] **A5 No secrets** in repo or app. Env vars on server. `.env.example` lists names, no values. Every `EXPO_PUBLIC_` var listed and justified as safe.
- [ ] **A6 Part ends with a LinkedIn post** on one specific technical decision. For Matinee: the double-booking problem and the fix. No "excited to announce".
- [ ] **A7 Explain-back.** One paragraph per slice in `LEARNING-LOG.md`, Dave's words only.

## B. Shared stack rules for both apps (2.1)

- [ ] **B1** React Native + Expo, built in Antigravity.
- [ ] **B2** Backend Dave controls: Node (Express/Hono) or Next API routes, plus PostgreSQL.
- [ ] **B3** Redis for caching, rate limiting **and locks** (hosted free tier fine; Aiven Valkey is the signed-off substitution).
- [ ] **B4** Background job queue: BullMQ.
- [ ] **B5** Payments in **test mode** (Flutterwave/Paystack, or Stripe if account exists). Provider choice recorded as ADR.
- [ ] **B6** Zod validates **every** request on the server.
- [ ] **B7** Push (if used) needs an EAS Build development build; Expo Go cannot do remote push on Android. Android only is fine. `[SS]` EAS Build.
- [ ] **B8** **README section: Apple/Google in-app purchase rules.** Explain the distinction and what it means for each app in production: Rota = digital subscription (IAP rules bite); Matinee = real-world service/cinema tickets (generally may use other processors). Store publishing is out of scope; test mode is correct.

## C. Backend system design standard (2.2) — applies to Matinee

- [ ] **C1 Connection pooling.** Pooled connection string (Neon `-pooler`). Pool size set and justified. (Postgres default limit is 100 connections; serverless makes it worse.)
- [ ] **C2 Replication.** Reads routed to the read replica. **Read-your-own-writes:** for 5 s after a user's write, that user's reads go to primary. Document what changes in production.
- [ ] **C3 Sharding.** Matinee = plan only (see E3).
- [ ] **C4 Caching.** Cache-aside. **TTL on every item.** Explicit invalidation on change. Document what is cached and what is **never** cached. Never cache: active subscriptions, payment status, credit balances, webhook idempotency records, and seat availability in any way that could sell a seat twice.
- [ ] **C5 Rate limiting.** In Redis, never an in-memory object. Per user and per IP. Strict on hold, checkout, search, login and password reset (if auth exists), payment initiation, and any expensive endpoint.
- [ ] **C6 Background jobs.** Anything slow or unreliable (push, webhooks, emails, slow third-party calls) is a job. Exponential backoff. Moves to a failed list after N attempts.
- [ ] **C7 Idempotency** `[SS]`. Idempotency key per payment attempt, sent in a header, stored with its result; repeated key returns stored result. Webhooks: store each event ID, skip already-processed.
- [ ] **C8 Observability** `[SS]`. Log request ID, user ID, route, response time, result. Log every job attempt. Sentry on app and server. Must answer "what happened to this user's booking at 3:14pm?" from logs alone.
- [ ] **C9 Load testing** `[SS]`. k6. `load-tests/` has scripts and a written report.

## D. Matinee requirements (2.4)

### D1 — Requirement 1: API integration (TMDB)
- [ ] D1.1 TMDB API key obtained. TMDB terms read, **attribution requirement followed** (attribution visible in the app) `[SS]`.
  - About/Credits screen shows, word for word: "This product uses the TMDB API but is not endorsed or certified by TMDB."
  - Approved TMDB logo (from TMDB's logos & attribution page), less prominent than Matinee's logo, colour and aspect ratio unchanged.
  - Link back to https://www.themoviedb.org.
  - Refer to it only as "TMDB" or "The Movie Database".
- [ ] D1.2 App **never** calls TMDB directly. Backend for frontend. Key stays server-side.
- [ ] D1.3 Redis cache for TMDB responses with sensible TTLs. **Each TTL and its reason documented** (details change rarely; "now playing" changes daily).
- [ ] D1.4 Handles TMDB rate limits and failures: retry with backoff, **serve cached data when TMDB is down**.
- [ ] D1.5 TMDB data mapped to own types. **Only one backend file knows TMDB's shape.**
- [S] D1.6 Second external API (e.g. currency conversion) to show prices in the user's currency.

### D2 — Requirement 2: UI design and aesthetics (judged harshly)
Design first
- [ ] D2.1 **Every screen designed in Figma before it is built.** Figma file link with tokens and all screens is a deliverable.
- [ ] D2.2 Design tokens defined **and used in code**: colour palette, typography scale, spacing scale (multiples of 4 or 8), border radii, shadows. No raw values like `margin: 13`.
- [ ] D2.3 **Mechanical enforcement:** a test/lint rule fails when a raw numeric spacing, colour or radius appears outside the token file.
- [ ] D2.4 **Study 5 well-made apps.** Screenshots + one line each on why it works, in the docs.

Build quality
- [ ] D2.5 Reanimated animations: screen transitions, seat selection, booking confirmation `[SS]`.
- [ ] D2.6 Haptics on selecting a seat and on confirming payment.
- [ ] D2.7 Skeleton loading screens, not spinners, for content.
- [ ] D2.8 Designed empty states **and** error states. A blank screen is a bug.
- [ ] D2.9 Dark mode that is designed, not inverted.
- [ ] D2.10 Progressive image loading with placeholders; images cached.
- [ ] D2.11 Lists scroll smoothly at volume.
- [ ] D2.12 Works on small and large phones, no broken layouts.

Accessibility
- [ ] D2.13 Text contrast ≥ 4.5:1 (WCAG AA).
- [ ] D2.14 Accessibility label on every button and image.
- [ ] D2.15 Text scales with the phone's font-size setting.
- [ ] D2.16 Touch targets ≥ 44×44.

### D3 — Requirement 3: UI components
- [ ] D3.1 In-app component library, **at least 12**: Button (variants + loading), Text (typography scale), Card, MovieCard, Input, Chip, Badge, BottomSheet, Skeleton, Toast, EmptyState, SeatMap.
- [ ] D3.2 Each component uses **only** design tokens.
- [ ] D3.3 Variants, states and props documented in `COMPONENTS.md`.
- [ ] D3.4 Hidden **component gallery** screen: every component in every state.
- [ ] D3.5 **SeatMap handles ≥ 300 seats smoothly** with states: selected, available, held, sold, wheelchair-accessible. Rendering approach (virtualised / canvas / memoised views) decided early, reason written down (ADR).
- [S] D3.6 Publish one component to npm with its own README (also counts as Part 1 edge project, which is Dave's weakest Part 1 item).

### D4 — Requirement 4: Payments
- [ ] D4.1 Ticket checkout in test mode.
- [ ] D4.2 Prices in minor units; **service fee calculated on the server**. App shows server-produced strings.
- [ ] D4.3 Idempotency keys on checkout.
- [ ] D4.4 Booking confirmed **only** by a **verified webhook**, processed in a **background job**, **duplicates ignored**.
- [ ] D4.5 Held seats released if payment fails or checkout is abandoned.
- [ ] D4.6 Ticket screen with **QR code** after successful payment.
- [ ] D4.7 **Refunds for cancelled showtimes recorded in a ledger** (append-only; corrections are new rows).
- [ ] D4.8 Webhook signature verified against raw body (`express.raw` on that route only, before global JSON parser); event recorded durably first, 200 returned, then processing queued.
- [ ] D4.9 **ADR for "pays, webhook arrives 20 min later, hold expired":** refund automatically / re-hold if free / offer alternative seat. Written before testing it.

### D5 — Requirement 5: Traffic management
- [ ] D5.1 Seat holds via Redis `SET … NX` with expiry, single atomic step `[SS]`. 10-minute expiry unless ADR says otherwise.
- [ ] D5.2 **DB safety net:** unique constraint on (showtime, seat) in bookings.
- [ ] D5.3 **Waiting room:** when active users on a showtime exceed a limit, new users queue and are admitted at a fixed rate; app shows queue position.
- [ ] D5.4 Rate limiting per user **and** per IP on hold, checkout, search.
- [ ] D5.5 Caching of movie data and seat maps; availability near real time via polling / WebSockets / SSE. **Choice justified** (cost, free-tier limits, battery).
- [ ] D5.6 **k6 load test: 500 VUs trying to hold the same 50 seats at the same moment.** Report proves **zero double bookings**, with response times and error rates.
- [ ] D5.7 Graceful failure: overloaded server shows a clear message and a retry option, never a crash.
- [ ] D5.8 Hold release is compare-and-delete (token or Lua), never plain `DEL`.
- [ ] D5.9 Redis-down behaviour decided and documented (fail closed on holds).
- [ ] D5.10 Proof script built alongside the feature, not at the end.

## E. Backend requirements specific to Matinee

- [ ] E1 Connection pooling configured and justified (= C1).
- [ ] E2 Read/write routing with read-your-own-writes (= C2).
- [ ] E3 **`SHARDING.md` — plan only, no simulation:** which tables shard, the shard key, the hot-shard risk (a single blockbuster showtime), the mitigation.
- [ ] E4 Background jobs for **webhooks, hold-expiry cleanup, refund processing**.
- [ ] E5 Observability: request IDs in logs, error tracking on app and server, and a **written analysis of what the logs showed during the load test**.

## F. Repo and process (set up on the first commit)

Structure (split repos, ADR 0004): `matinee-server` holds the API, jobs, database, `load-tests/`, and `docs/` (`RULES.md` `ARCHITECTURE.md` `TRAFFIC.md` `SHARDING.md` `decisions/`). `matinee-mobile` holds the Expo app and `docs/COMPONENTS.md`. **Each repo** has `README.md` `LEARNING-LOG.md` `.env.example` `LICENSE` (MIT) `AGENTS.md`.

- [ ] F1 Conventional Commits (`feat: …`, `fix: prevent double booking on seat hold`).
- [ ] F2 Feature branch + PR per feature, with description and screenshots; Dave merges.
- [ ] F3 `docs/decisions/` ADR per significant choice: problem, options, decision, reason `[SS]`.
- [ ] F4 `LEARNING-LOG.md`: Dave's own paragraph per slice.
- [ ] F5 README written as you build, not at the end.
- [ ] F6 GitHub issues used as the task list.
- [ ] F7 Clear descriptive repo name; GitHub **description and topic tags** on every public repo (e.g. `react-native`, `expo`, `postgresql`).
- [ ] F8 App and backend repos link to each other in both READMEs (required: repos are split).
- [ ] F9 Matinee **pinned** on Dave's profile (exactly 6 pins total; decide whether both Matinee repos take a slot or only the mobile one).
- [ ] F10 Before/after recordings of problems fixed; **record from bug one**.
- [ ] F11 Baseline commit before any "before and after" improvement.
- [ ] F12 At least 2 LinkedIn posts per week during the build, each one problem + one decision (on top of the general 3/week).
- [ ] F13 No faked activity (no empty-commit scripts).
- [ ] F14 **Secret scan at end:** full git history for `sk_`, `secret`, `password`, `_KEY`; check GitHub secret-scanning alerts. Any key ever committed is **rotated at the provider**, not just deleted.

## G. README requirements

First screen, in order: one-liner → GIF → Android download link → demo video link.
Then (Part 1.3 "every featured repo"): what it is (one sentence), screenshot/GIF, live link or downloadable build, problem it solves, tech stack, how to run locally, architecture summary, key decisions, what you'd do next. Plus: the IAP section (B8), the `EXPO_PUBLIC_` list with justifications, TMDB attribution, links to app/backend counterpart.

## H. Deliverables

- [ ] Public repo(s), linked to each other
- [ ] Android development build download link
- [ ] Deployed backend
- [ ] **Figma file link** with design tokens and all screens
- [ ] README · ARCHITECTURE.md · TRAFFIC.md · SHARDING.md · COMPONENTS.md · LEARNING-LOG.md
- [ ] Load test scripts and report (+ logs analysis, E5)
- [ ] **3-minute demo video** (under 3 min): product first (UI, seat map, a booking, load-test result), then **one** technical deep dive. Not a feature tour.
- [ ] **LinkedIn post** on double booking and the fix. **Separate artefact from the video.**

## I. After building (Part 2.5)

- [ ] I1 Portfolio **case study**: problem, constraints, architecture, 3 hardest decisions, results with load-test numbers, what next.
- [ ] I2 **30 target companies** for Matinee (ticketing, events, travel, booking, consumer) added to the lead tracker. Leads need a named person + hiring signal.
- [ ] I3 Message booking-type companies leading with Matinee, pointing at the closest feature.
- [ ] I4 One CV bullet and one LinkedIn bullet with specifics, e.g. "Built a cinema booking app with Redis seat holds and a waiting room. Load tested with 500 concurrent users on 50 seats with zero double bookings."
- [ ] I5 Repos organised and pinned (F9).

## J. Interview questions (ask one at a time as the slice completes; give an honest verdict)

1. Two users tap the same seat at the same millisecond. Walk through exactly what happens.
2. Redis goes down during a surge. What happens to bookings?
3. Why does the app call your backend and not TMDB directly?
4. TMDB is down. What does the user see?
5. A user pays, but the webhook arrives 20 minutes later, after the hold expired. What happens?
6. Show where design tokens are defined and change one colour live.
7. Polling vs WebSockets vs SSE for seat updates. What does each cost?
8. What did the load test reveal that you did not expect?

## K. Part 1 duties that run alongside this build (tracked outside the repo)

Not code, but part of passing. Agents should remind Dave, not do them for him.
- Daily (weekdays): 10 new leads, 5 personalised cold messages, all due follow-ups, 2 tailored applications, 5 thoughtful comments, 2 h building/open source, 30 min interview practice, 5 min daily log.
- Weekly: 3 LinkedIn posts, 1 open-source contribution attempt, 1 mock interview, Friday review in the tracker.
- Totals for submission: lead tracker with ≥ 100 leads and a daily-log entry for every weekday from task start to deadline; message library with reply rates; ≥ 2 OSS PRs opened, ≥ 1 merged; one edge project (npm component from D3.6 qualifies); all LinkedIn post links; portfolio with 3 case studies.
- GitHub profile README, exactly 6 pinned repos, tutorial clones archived, secrets scan across all repos.

## L. Final submission (Matinee row)

`SUBMISSION.md` must link: repo · build link · backend link · Figma link · docs · load test report · demo video · LinkedIn post · portfolio case study. Repo for the whole submission is `final-task-dave-hennit`, public.

## M. Open items for Dave

- Deadline in the PDF is **Monday 19 October 2026**. Confirm the current deadline with the facilitator.
- Payments provider, TMDB key, Figma file, repo layout, 5 apps to study (see AGENTS.md section 2).
