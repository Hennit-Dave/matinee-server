# Handoff: Display currency USD -> GBP (branch `feat/currency-gbp`)

## What changed
- **Formatter (`src/showtimes/showtime.ts`):** `formatPriceCents` now outputs `£` (`1550` -> `"£15.50"`). The doc comments say GBP/pence. The function and the `priceCents` field keep their names (renaming would need a DB migration; out of scope).
- **Tests:** `src/showtimes/showtime.test.ts` and `src/movies/routes.test.ts` now expect `£` strings. No test input changed, so no stored amount changed.
- **Schema comment (`prisma/schema.prisma`):** doc comment on `Showtime.priceCents` says pence/GBP. Comment only; no migration, no generated SQL change.
- **ADRs:** `0010` example string is now `"£15.50"`, plus a dated addendum saying display currency is GBP. `0001` has a dated addendum saying Stripe will charge `currency: 'gbp'` in pence when payments are built.
- **Not changed on purpose:** every stored integer amount, `src/showtimes/seedPlan.ts` (`PRICE_*_CENTS` values and names), the seed, migrations, and `LEARNING-LOG.md`. ADR `0009`'s `$5/month` is Railway's hosting bill (Railway charges in USD), not Matinee's display currency, so it stays.

## What passed
- `npm run typecheck`
- `npm run lint`
- `npm test` (88 pass, 0 fail, 3 DB-gated skips; same counts as `main` before the change)
- Repo-wide grep (excluding `node_modules`) for `$`, `USD`, `dollar`, `cents`: the only hits left are ADR `0009`'s Railway `$5/month`, the `$1` in `.githooks/commit-msg` (shell, not currency), and the `priceCents` field name.

## Unproven
- `src/showtimes/showtimes.integration.test.ts` is skipped without `TEST_DATABASE_*`. It asserts no price strings, so it should be unaffected, but it was not run locally. CI runs it against Postgres.
- Stripe is not built. The `'gbp'` note in ADR 0001 is intent only.

## Next
- **Dave:** review and squash-merge this PR first, then the mobile PR (`feat/currency-gbp` in `matinee-mobile`), which updates hardcoded `$` strings in its test fixtures.
- When payments land: charge in `'gbp'`, `amount` = `priceCents` (pence), no conversion.
