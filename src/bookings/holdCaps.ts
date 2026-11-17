import { readTrafficProfile, readWholeNumber, type TrafficProfile } from '../traffic/profile.js';
import { MAX_SEATS_PER_REQUEST } from './booking.js';

/**
 * How many seats of ONE showing may be held at once (ADR 0018). Rate limits slow hoarding but do not stop it: one install
 * could still take 10 holds a minute of up to 8 seats, and rotating `X-Client-Id` is free. These caps do stop it.
 *
 *   perOwner:   live held seats per install (`X-Client-Id`) per showing. 8 = one booking's worth, the same number as the
 *               most seats a single request may ask for, so a person can always hold what one booking needs and no more.
 *   perAddress: live held seats per network address per showing, whoever asks. The install id is self-asserted, so this is
 *               the cap that cannot be dodged by minting ids. 16 leaves room for a household with two phones; a shared
 *               address with more people than that (carrier-grade NAT, a venue's wifi) will be refused: ADR 0016's trade-off.
 *
 * 0 turns a cap off. Both are per SHOWING, not global: the point is that nobody holds a room.
 */
export interface HoldCaps {
  perOwner: number;
  perAddress: number;
}

export const DEFAULT_HOLD_CAPS: Readonly<HoldCaps> = { perOwner: MAX_SEATS_PER_REQUEST, perAddress: 2 * MAX_SEATS_PER_REQUEST };

export interface HoldCapsConfig {
  caps: HoldCaps;
  profile: TrafficProfile;
}

/**
 * Reads HOLD_CAP_PER_OWNER and HOLD_CAP_PER_ADDRESS. Unset means the default, except that `TRAFFIC_PROFILE=loadtest` lifts the
 * ADDRESS cap (500 test users share one address). An explicit variable always wins over the profile. A bad value stops the
 * server at boot rather than starting with limits nobody chose.
 */
export function readHoldCaps(env: NodeJS.ProcessEnv = process.env): HoldCapsConfig {
  const profile = readTrafficProfile(env);
  const range = { min: 0, max: 10_000 };
  const perOwner = readWholeNumber(env, 'HOLD_CAP_PER_OWNER', range) ?? DEFAULT_HOLD_CAPS.perOwner;
  const perAddress = readWholeNumber(env, 'HOLD_CAP_PER_ADDRESS', range) ?? (profile === 'loadtest' ? 0 : DEFAULT_HOLD_CAPS.perAddress);
  return { caps: { perOwner, perAddress }, profile };
}
