import { readTrafficProfile, readWholeNumber, type TrafficProfile } from '../traffic/profile.js';

/**
 * The waiting room (ADR 0017): when more people are choosing seats for one showing than the room allows, new arrivals
 * queue and are let in at a fixed rate.
 *
 * THE NUMBERS BELOW THAT YOU CAN SET ARE DEMO VALUES. `maxActive` defaults to 2 so the queue can be shown on two or three
 * phones for the demo video. THAT IS FAR TOO LOW FOR PRODUCTION: WAITING_ROOM_MAX_ACTIVE MUST BE RAISED in the deploy slice
 * (a real figure comes from the 5e load test), or every showing queues everyone behind two people. The server logs a loud
 * `waiting_room_demo_defaults` warning at boot whenever it is running on the default.
 */

/** An admitted user counts as active while they have been heard from within this long. Seat-map polls (every ~5 s) are the heartbeat. */
export const HEARTBEAT_WINDOW_MS = 30_000;
/** A user let in from the queue must be heard from within this long, or the pass lapses and the slot goes to the next in line. */
export const CLAIM_WINDOW_MS = 15_000;
/** A waiter keeps their place this long without polling (a phone that locks), then loses it. */
export const WAITER_PATIENCE_MS = 90_000;
/** No pass lasts longer than this from admission, however busy the user keeps it, so nobody can camp a slot. */
export const PASS_MAX_MS = 20 * 60_000;
/** The longest a line may get. Beyond it, joining is refused (503 `waiting_room_full`), which bounds Redis memory under abuse. */
export const MAX_QUEUE = 5_000;
/** Longest the waiting room waits for Redis (the same as the rate limiter). CHOSEN, NOT MEASURED: 5e measures it. */
export const ROOM_OP_TIMEOUT_MS = 150;

export const DEFAULT_MAX_ACTIVE = 2;
export const DEFAULT_ADMIT_PER_MINUTE = 12;

export interface RoomTiming {
  heartbeatWindowMs: number;
  claimWindowMs: number;
  waiterPatienceMs: number;
  passMaxMs: number;
  maxQueue: number;
}

export const DEFAULT_TIMING: Readonly<RoomTiming> = {
  heartbeatWindowMs: HEARTBEAT_WINDOW_MS,
  claimWindowMs: CLAIM_WINDOW_MS,
  waiterPatienceMs: WAITER_PATIENCE_MS,
  passMaxMs: PASS_MAX_MS,
  maxQueue: MAX_QUEUE,
};

export interface WaitingRoomConfig {
  enabled: boolean;
  /** Most users that may be choosing seats for one showing at once. */
  maxActive: number;
  /** How many queued users are let in per minute, one at a time at an even spacing. */
  admitPerMinute: number;
  /** True when `maxActive` was not set and is the demo default: a production deploy must not run on it. */
  maxActiveIsDefault: boolean;
}

export interface WaitingRoomSettings {
  config: WaitingRoomConfig;
  profile: TrafficProfile;
}

function readBoolean(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be "true" or "false".`);
}

/**
 * Reads WAITING_ROOM_ENABLED, WAITING_ROOM_MAX_ACTIVE and WAITING_ROOM_ADMIT_PER_MINUTE. `TRAFFIC_PROFILE=loadtest` turns the room off
 * (the k6 test sends 500 users at one showing; a queue would throttle exactly what it measures); an explicit variable beats the profile.
 * A bad value stops the server at boot rather than starting with limits nobody chose.
 */
export function readWaitingRoomConfig(env: NodeJS.ProcessEnv = process.env): WaitingRoomSettings {
  const profile = readTrafficProfile(env);
  const maxActive = readWholeNumber(env, 'WAITING_ROOM_MAX_ACTIVE', { min: 1, max: 100_000 });
  return {
    profile,
    config: {
      enabled: readBoolean(env, 'WAITING_ROOM_ENABLED') ?? profile !== 'loadtest',
      maxActive: maxActive ?? DEFAULT_MAX_ACTIVE,
      admitPerMinute: readWholeNumber(env, 'WAITING_ROOM_ADMIT_PER_MINUTE', { min: 1, max: 6_000 }) ?? DEFAULT_ADMIT_PER_MINUTE,
      maxActiveIsDefault: maxActive === undefined,
    },
  };
}
