# 0002 — Figma: a new file for Matinee

Date: 2026-11-10 · Status: accepted · Decided by: Dave

## Problem
The brief requires a Figma file link with design tokens and all screens, and every screen must exist in Figma before it is built.

## Options
1. **New file for Matinee.**
2. **New page in the existing Rota file.**

## Decision
A new Figma file holding Matinee's tokens and all app screens.

## Reason
The deliverable is a file link. A separate file gives one clean link that shows only Matinee, with its own tokens.

## Consequences
- Tokens are defined in this file first, then mirrored in code.
- No screen is built before its Figma frame exists.
