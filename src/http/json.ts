import express from 'express';

// Mounted per router, never globally: a future webhook route needs the raw body and must be
// registered before any global express.json() (AGENTS.md rule 8).
export const JSON_BODY_LIMIT = '10kb';

export function jsonBody() {
  return express.json({ limit: JSON_BODY_LIMIT, strict: true });
}
