# 0003 — The 5 apps to study

Date: 2026-11-10 · Updated: 2026-11-11 · Status: accepted · Decided by: Dave

## Problem
The brief requires studying 5 well-made apps, with screenshots and one line each on why it works, in the docs.

## Decision
Peacock, Hulu, Amazon Prime Video, Disney+, Apple TV.

AMC Theatres is studied as an extra reference for the booking flow only (showtimes, seat map, ticket selection). It is not one of the five.

## Reason
All five are polished, content-first movie apps: browsing, posters, detail pages, dark UI, loading states, motion.

## Change on 2026-11-11
HBO Max was in the original five and was replaced by Apple TV.
- HBO Max was not installed, so it could not be recorded and studied first-hand.
- Apple TV is the most restrained of the set: edge-to-edge artwork and very little interface around it. That is closer to Matinee's "Projector" direction, where posters supply the colour and the interface stays quiet.

## Consequences
- The five are streaming apps. None has a seat map, a timed hold, or a ticket checkout, which is why AMC Theatres was added as an extra reference.
- Three screens still have no first-hand reference: the payment sheet (the provider's own), the hold countdown, and the ticket with QR code.
- Write-up goes in `matinee-mobile/docs/DESIGN-STUDY.md`: screenshot + one line per app, in Dave's words.
