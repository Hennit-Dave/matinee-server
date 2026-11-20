import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { ApiError } from './errors.js';

/**
 * The admin gate, until real auth exists (ADR 0020). The cancel-showtime endpoint is NOT user-reachable: it is
 * mounted only when `ADMIN_API_KEY` is set, and every request must present that key in `X-Admin-Key`. This is the
 * same "stand-in" shape as `clientId.ts` (a bearer header, one small file to replace when real auth lands).
 *
 * The value is never logged and is compared with a constant-time compare over a SHA-256 hash, so a wrong key costs
 * the same as a right one and reveals nothing about how close it was. A missing key, a wrong key or a missing env
 * value is a single 403 `invalid_admin_key` — never a hint that an admin path exists.
 */

export const ADMIN_KEY_HEADER = 'x-admin-key';

const AdminKeySchema = z.string().min(1).max(1024);

function hash(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function adminKeyHeader(expectedKey: string | undefined): RequestHandler {
  const expected = expectedKey ? hash(expectedKey) : undefined;

  return (req, _res, next) => {
    if (!expected) {
      next(new ApiError('invalid_admin_key'));
      return;
    }
    const raw = req.get(ADMIN_KEY_HEADER);
    const parsed = raw === undefined ? undefined : AdminKeySchema.safeParse(raw);
    if (parsed === undefined || !parsed.success) {
      next(new ApiError('invalid_admin_key'));
      return;
    }
    if (!timingSafeEqual(hash(parsed.data), expected)) {
      next(new ApiError('invalid_admin_key'));
      return;
    }
    next();
  };
}
