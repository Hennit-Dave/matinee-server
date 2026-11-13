import type { RequestHandler } from 'express';

/**
 * Minimal structured logging (ADR 0005, matched from Rota). One JSON object per line, UTC ISO
 * 8601 timestamps. Redaction by construction: the logger only accepts the fields named in
 * `ALLOWED`, and only primitive values — there is no way to log a request body, a header or a
 * connection string by passing it in.
 *
 * The sink writes to stdout directly (never `console.log`): AGENTS.md bans `console.log`
 * anywhere in this repo's server code, including boot and shutdown lines, from the first commit.
 */
const ALLOWED = [
  'requestId',
  'method',
  'route',
  'status',
  'durationMs',
  'errorCode',
  'outcome',
  'reason',
  'check',
  'port',
  'cache',
  'attempt',
  'upstreamStatus',
] as const;
export type LogField = (typeof ALLOWED)[number];
export type LogFields = Partial<Record<LogField, string | number | boolean>>;

const ALLOWED_SET: ReadonlySet<string> = new Set(ALLOWED);
// Bounds one field's size so a long error message can't flood a log line.
const MAX_STRING_LENGTH = 300;

export type LogSink = (line: string) => void;
export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const defaultSink: LogSink = (line) => process.stdout.write(line + '\n');

export function createLogger(sink: LogSink = defaultSink): Logger {
  function write(level: LogLevel, message: string, fields: LogFields = {}) {
    const entry: Record<string, string | number | boolean> = {
      ts: new Date().toISOString(),
      level,
      msg: message,
    };
    for (const [key, value] of Object.entries(fields)) {
      if (!ALLOWED_SET.has(key)) continue;
      if (typeof value === 'string') {
        entry[key] = value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) : value;
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        entry[key] = value;
      }
    }
    sink(JSON.stringify(entry));
  }
  return {
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}

/**
 * Express resets `req.baseUrl` when an error leaves a router, so by the time the request is
 * logged the mount prefix is gone. Put this first in every mounted router: it records the prefix
 * while the request is still inside it.
 */
export const recordRouteBase: RequestHandler = (req, res, next) => {
  res.locals.routeBase = req.baseUrl;
  next();
};

/**
 * One line per request: request ID, route TEMPLATE (never the raw URL), status, duration, and the
 * error code on failure. Handlers set `res.locals.errorCode`; the error handler also sets it.
 * Routes that serve cached data also set `res.locals.cache` so the line says where the data came from.
 */
export function requestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const started = performance.now();
    res.on('close', () => {
      const aborted = !res.writableFinished;
      const base = String(res.locals.routeBase ?? req.baseUrl ?? '');
      const template = req.route?.path ? `${base}${String(req.route.path)}` : '(unmatched)';
      const status = res.statusCode;
      const fields: LogFields = {
        requestId: String(res.locals.requestId ?? ''),
        method: req.method,
        route: template,
        status,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        outcome: aborted ? 'aborted' : status >= 500 ? 'error' : status >= 400 ? 'rejected' : 'ok',
      };
      if (res.locals.errorCode) fields.errorCode = String(res.locals.errorCode);
      if (res.locals.cache) fields.cache = String(res.locals.cache);
      const level: LogLevel = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      logger[level]('request', fields);
    });
    next();
  };
}
