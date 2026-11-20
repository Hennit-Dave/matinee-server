import { PrismaPg } from '@prisma/adapter-pg';
import { readReplicas } from '@prisma/extension-read-replicas';
import { PrismaClient } from '../generated/prisma/client.js';

// Runtime clients use the POOLED (-pooler) URLs. They never fall back to a direct URL: if the
// pooled connection fails, the failure is reported (ADR 0007), not silently retried elsewhere.
const PRIMARY_VAR = 'DATABASE_URL';
const READ_VAR = 'DATABASE_READ_URL';

/** Loopback hosts run a local Postgres with no TLS listener, so no `sslmode` should be pinned on them. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/**
 * Pins `sslmode=verify-full` on a Postgres URL that points at a TLS host (Neon, in production), and leaves
 * local/CI URLs alone (their Postgres has no TLS listener). Neon requires TLS; `verify-full` both satisfies it and
 * silences node-postgres's SSL-configuration deprecation warning. The URL is re-serialised by `URL`, which round-
 * trips a valid `postgresql://` connection string (including a percent-encoded password) unchanged apart from the
 * one query parameter we set. A URL that cannot be parsed, or one with no host, is returned as given.
 */
export function withSslModeVerifyFull(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || LOOPBACK_HOSTS.has(host)) return url;
  parsed.searchParams.set('sslmode', 'verify-full');
  return parsed.toString();
}

/**
 * Pool size, chosen (not measured yet — revisit once real traffic exists, see docs/decisions and
 * the follow-up ARCHITECTURE.md). Neon's free-plan pooled endpoint multiplexes many client
 * connections over few server ones, so a single-process API can afford a modest cap without
 * starving anything else on the same Neon project.
 */
export const PRIMARY_POOL_MAX = 5;
export const REPLICA_POOL_MAX = 5;

/** How long a connection to the replica may take before the attempt fails. CHOSEN, NOT MEASURED. */
export const REPLICA_CONNECT_TIMEOUT_MS = 8_000;

function withReplica(primary: PrismaClient, replica: PrismaClient) {
  return primary.$extends(readReplicas({ replicas: [replica] }));
}
export type ReaderClient = ReturnType<typeof withReplica>;

export type DbClients = {
  /** The PLAIN client: every read made on it goes to the primary, as it always has. */
  primary: PrismaClient;
  /** The extended client. Reached only through a read-routing function once one exists. */
  reader: ReaderClient;
};

export function createDbClients(overrides?: { primaryUrl?: string; readUrl?: string }): DbClients {
  const primaryUrl = overrides?.primaryUrl ?? process.env[PRIMARY_VAR];
  if (!primaryUrl) throw new Error(`${PRIMARY_VAR} is not set.`);
  const readUrl = overrides?.readUrl ?? process.env[READ_VAR];
  if (!readUrl) throw new Error(`${READ_VAR} is not set.`);

  const primary = new PrismaClient({ adapter: new PrismaPg({ connectionString: withSslModeVerifyFull(primaryUrl), max: PRIMARY_POOL_MAX }) });
  const replica = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: withSslModeVerifyFull(readUrl),
      max: REPLICA_POOL_MAX,
      connectionTimeoutMillis: REPLICA_CONNECT_TIMEOUT_MS,
    }),
  });
  return { primary, reader: withReplica(primary, replica) };
}

export async function closeDbClients(clients: DbClients): Promise<void> {
  await clients.primary.$disconnect();
  await clients.reader.$disconnect();
}
