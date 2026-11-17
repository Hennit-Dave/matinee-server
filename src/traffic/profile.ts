/**
 * The traffic profile: ONE boot switch that relaxes every traffic limit at once, for the k6 load test (slice 5e).
 *
 *   TRAFFIC_PROFILE=default    (or unset)  the limits as shipped
 *   TRAFFIC_PROFILE=loadtest               the limits that a load test from ONE address and ONE showing cannot live with are lifted
 *
 * Why it exists: the load test sends 500 users from one address at the same 50 seats. The per-address hold cap, the waiting
 * room and the request-rate limits are each right in production and each would refuse that test before it measured anything.
 * Each limit reads this one switch, so "relax everything for the load test" is one setting, not a checklist someone can get
 * half right. An explicit environment variable for a single limit still wins over the profile.
 *
 * It is NEVER the default, and every module that relaxes itself because of it logs a loud `traffic_profile_loadtest` warning
 * at boot, so a deploy that carries it by mistake is visible in the first log lines.
 */
export type TrafficProfile = 'default' | 'loadtest';

export function readTrafficProfile(env: NodeJS.ProcessEnv = process.env): TrafficProfile {
  const raw = env.TRAFFIC_PROFILE?.trim();
  if (raw === undefined || raw === '' || raw === 'default') return 'default';
  if (raw === 'loadtest') return 'loadtest';
  throw new Error('TRAFFIC_PROFILE must be "default" or "loadtest".');
}

/** Reads a whole number from `env[name]`, or `undefined` when it is not set. A bad value stops the server at boot. */
export function readWholeNumber(env: NodeJS.ProcessEnv, name: string, range: { min: number; max: number }): number | undefined {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return undefined;
  const value = /^\d{1,9}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    throw new Error(`${name} must be a whole number from ${range.min} to ${range.max}.`);
  }
  return value;
}
