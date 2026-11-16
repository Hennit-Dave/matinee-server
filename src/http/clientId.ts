import type { RequestHandler } from 'express';
import { z } from 'zod';
import { ApiError } from './errors.js';

/**
 * The caller's identity, until real auth exists (ADR 0015). The app generates one random id per install
 * and sends it as `X-Client-Id`; the server treats it as the OWNER of a seat hold and a booking.
 *
 * It is a bearer value, not authentication: anyone who learns an id can act as it. That is acceptable for
 * a demo with fake payments and is the reason this lives in one small middleware: real auth replaces this
 * file and the `owner_id` column, and nothing else needs to change.
 *
 * Validated like every other input (Zod, AGENTS.md section 4). On success the id is left in
 * `res.locals.clientId` (what handlers use) and `res.locals.userId` (what the request log prints).
 */
export const CLIENT_ID_HEADER = 'x-client-id';

const ClientIdSchema = z.uuid();

export function clientIdHeader(options: { required: boolean }): RequestHandler {
  return (req, res, next) => {
    const raw = req.get(CLIENT_ID_HEADER);
    if (raw === undefined) {
      if (!options.required) {
        next();
        return;
      }
      next(new ApiError('validation_failed', { details: [{ path: `header.${CLIENT_ID_HEADER}`, code: 'required' }] }));
      return;
    }
    const parsed = ClientIdSchema.safeParse(raw);
    if (!parsed.success) {
      next(new ApiError('validation_failed', { details: [{ path: `header.${CLIENT_ID_HEADER}`, code: 'invalid_uuid' }] }));
      return;
    }
    // Lower-cased so one person's id compares equal however their client happened to write it.
    const id = parsed.data.toLowerCase();
    res.locals.clientId = id;
    res.locals.userId = id;
    next();
  };
}
