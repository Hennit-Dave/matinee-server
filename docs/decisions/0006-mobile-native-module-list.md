# 0006 — Mobile native module list: settled now, first EAS build deferred

Date: 2026-11-11 · Status: accepted · Decided by: Dave

## Problem

EAS development builds are a shared, limited resource across the whole graduation task (AGENTS.md: "Credits
are limited and shared with the rest of the task"). Rota's own ADR 0011 found that settling every native
dependency before spending the first build avoids a rebuild per feature slice. Slice 0 itself needs no native
build at all (Expo Go covers an `expo-router` skeleton with fonts and TanStack Query), so the two questions are
separate: what will Matinee eventually need natively, and when does it first have to spend a build.

## Options

1. **Decide native dependencies per slice**, as each feature needs one — risks discovering a needed build
   mid-slice and spending quota reactively, the exact problem Rota's ADR 0011 avoided.
2. **Settle the whole foreseeable list now** (matching Rota's philosophy, without spending a build yet), and
   record which of them Expo Go can already run, so the first real build installs everything in one pass.

## Decision

Option 2.

| Module | Needed for | Runs in Expo Go? |
|---|---|---|
| `expo-secure-store` | token storage (AGENTS.md non-negotiable) | Yes |
| `react-native-reanimated` + `react-native-worklets` | screen transitions, seat selection, booking confirmation (D2.5) | Yes |
| `expo-haptics` | seat-select and payment-confirm haptics (D2.6) | Yes |
| `react-native-svg` | the `Icon` component: every icon is an SVG path, coloured by a semantic token (added 2026-11-13, Browse slice, matinee-mobile #13) | Yes — in SDK 58's bundled native modules (`15.16.0`); no custom EAS build for development |
| `expo-blur` | the NavBar's backdrop blur, the glass material on iOS and Android (added 2026-11-13, NavBar slice, matinee-mobile #16) | Yes — in SDK 58's bundled native modules (`~58.0.6`); no custom EAS build for development |
| `@sentry/react-native` | app error tracking (C8) | **No** — native init needs a custom build |
| `@stripe/stripe-react-native` | the payment sheet (D4.1) | **No** — native SDK, not in Expo Go's bundled set |
| QR code display (e.g. `react-native-qrcode-svg`) | ticket screen QR code (D4.6) | Yes — pure JS/SVG; Matinee only *shows* a QR code, never scans one, so no camera module is needed |
| `expo-notifications` | push, only `[S]`/if used (B7) | Not yet decided — Matinee doesn't commit to push the way Rota does |
| Offline ticket cache (TanStack Query persistence, or `expo-sqlite`) | "tickets work from saved data" (no-internet state) | TBD at the Tickets-offline slice |

**None of the Expo-Go-incompatible modules are installed as dependencies in slice 0**, not even unused — newer
Expo Go releases can flag a known-incompatible package in `package.json` whether or not anything imports it,
and there's no reason to risk that while the app is still Expo-Go-only. The Expo-Go-compatible ones
(`expo-secure-store`, Reanimated, `expo-haptics`) are recorded here but also not installed until the slice that
first uses them.

The first EAS Android preview build happens in whichever slice first wires in Stripe's SDK or Sentry's native
init — payments looks likely to land first — and installs the **whole table above** at that point, not just
the one module that triggered it. Per AGENTS.md, that slice's plan says "tell Dave before the change" before
any code lands.

## Reason

Matches Rota's own reasoning: the EAS free tier has a monthly build cap shared across the whole task, so
settling the list once and spending one build is cheaper than discovering new native requirements slice by
slice.

## Consequences

- **Easier:** one future EAS build instead of several, each one burning shared quota.
- **Harder or given up:** this list is a forecast, not a lockfile. Something unforeseen (e.g. a second external
  API for D1.6, or a push-notification decision) could still force an earlier or an additional build — accepted,
  not solved by this ADR.
- **Revisit when:** the payments slice or the observability slice is planned, whichever comes first — that
  slice's plan is where the build actually gets spent.

## Addendum — 2026-11-13

The Browse and NavBar slices installed three Expo-Go-compatible native modules ahead of the first EAS build.
Checked against `matinee-mobile`'s `main` (which includes #16) and Expo SDK 58's bundled native modules, the
list of what Expo Go ships:

| Module | Version on mobile `main` | First used by | In SDK 58's bundled set |
|---|---|---|---|
| `react-native-reanimated` | `4.7.1` | the `Skeleton` pulse animation (Browse slice, matinee-mobile #13) | Yes, `4.7.1` |
| `react-native-svg` | `15.16.0` | the `Icon` component (Browse slice, matinee-mobile #13) | Yes, `15.16.0` |
| `expo-blur` | `~58.0.6` | the NavBar's backdrop blur (NavBar slice, matinee-mobile #16) | Yes, `~58.0.6` |

- **Two rows are new** in the table above: `react-native-svg` and `expo-blur`. **Reanimated was already listed**
  (for screen transitions, seat selection and booking confirmation), so it gets no second row. What changed for it
  is that it is now installed, and its first use is the Skeleton pulse rather than a transition. This supersedes the
  Decision section's remark that Reanimated is "not installed until the slice that first uses them".
- **No new EAS build was needed for any of the three.** All three run in Expo Go, so development stays
  Expo-Go-only. Like the rest of the Expo-Go-compatible rows, they are installed by the first EAS Android preview
  build along with the whole table; they do not by themselves trigger it.
- Nothing about when the first build is spent changes: still the slice that first wires in Stripe's SDK or
  Sentry's native init.
