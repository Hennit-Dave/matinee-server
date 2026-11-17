import { HoldsUnavailableError } from './redisGuard.js';
import { SeatAlreadyBookedError, type BookingRepo, type NewBooking, type ReadSource, type ShowtimeSeats } from './bookingRepo.js';
import { SEAT_HOLD_TTL_MS, type AcquireResult, type HoldStore } from './holdStore.js';
import type { RyowStore } from './ryow.js';

/**
 * In-memory stand-ins for the three things the services depend on, so the logic can be unit tested with no
 * Redis and no Postgres. They follow the same rules as the real ones (all-or-nothing acquire, owner-only
 * release, one booking per seat), and each can be switched off to test the failure paths. The real Redis
 * scripts and the real unique key are proven separately by `holds.integration.test.ts`.
 */

export interface FakeHoldStore extends HoldStore {
  /** When true every call throws HoldsUnavailableError, like a Redis outage. */
  down: boolean;
  /** seatId -> owner, for seats currently held. */
  held(showtimeId: string): Map<string, string>;
  calls: string[];
  /** What each acquire was told about its caller's address (undefined when none). */
  addressesSeen: (string | undefined)[];
}

export function createFakeHoldStore(ttlMs = SEAT_HOLD_TTL_MS, caps: { perOwner?: number; perAddress?: number } = {}): FakeHoldStore {
  const keys = new Map<string, string>();
  /** key -> the address that took it, for the per-address cap. */
  const addresses = new Map<string, string>();
  const key = (showtimeId: string, seatId: string) => `${showtimeId}:${seatId}`;
  const store: FakeHoldStore = {
    down: false,
    calls: [],
    addressesSeen: [],
    held(showtimeId) {
      return new Map(
        [...keys].filter(([k]) => k.startsWith(`${showtimeId}:`)).map(([k, owner]) => [k.slice(showtimeId.length + 1), owner]),
      );
    },
    async acquire(showtimeId, ownerId, seatIds, context = {}): Promise<AcquireResult> {
      store.calls.push('acquire');
      store.addressesSeen.push(context.address);
      if (store.down) throw new HoldsUnavailableError('redis not ready (end)');
      // The caps are judged first, like the real script: seats the owner already holds are not new.
      const inShowtime = [...keys].filter(([k]) => k.startsWith(`${showtimeId}:`));
      const fresh = seatIds.filter((id) => keys.get(key(showtimeId, id)) !== ownerId).length;
      const ownHeld = inShowtime.filter(([, owner]) => owner === ownerId).length;
      if (caps.perOwner && ownHeld + fresh > caps.perOwner) {
        return { ok: false, limitReached: { scope: 'owner', limit: caps.perOwner, held: ownHeld } };
      }
      if (caps.perAddress && context.address !== undefined) {
        const atAddress = inShowtime.filter(([k]) => addresses.get(k) === context.address).length;
        if (atAddress + fresh > caps.perAddress) {
          return { ok: false, limitReached: { scope: 'address', limit: caps.perAddress, held: atAddress } };
        }
      }
      const taken = seatIds.filter((id) => {
        const owner = keys.get(key(showtimeId, id));
        return owner !== undefined && owner !== ownerId;
      });
      if (taken.length > 0) return { ok: false, takenSeatIds: taken };
      for (const id of seatIds) {
        keys.set(key(showtimeId, id), ownerId);
        if (context.address !== undefined) addresses.set(key(showtimeId, id), context.address);
      }
      return { ok: true, expiresInMs: ttlMs };
    },
    async release(showtimeId, ownerId, seatIds) {
      store.calls.push('release');
      if (store.down) throw new HoldsUnavailableError('redis not ready (end)');
      const freed = seatIds.filter((id) => keys.get(key(showtimeId, id)) === ownerId);
      for (const id of freed) {
        keys.delete(key(showtimeId, id));
        addresses.delete(key(showtimeId, id));
      }
      return freed;
    },
    async heldBy(showtimeId, ownerId, seatIds) {
      store.calls.push('heldBy');
      if (store.down) throw new HoldsUnavailableError('redis not ready (end)');
      return seatIds.filter((id) => keys.get(key(showtimeId, id)) === ownerId);
    },
    async heldCount(showtimeId, ownerId) {
      store.calls.push('heldCount');
      if (store.down) throw new HoldsUnavailableError('redis not ready (end)');
      return [...keys].filter(([k, owner]) => k.startsWith(`${showtimeId}:`) && owner === ownerId).length;
    },
    async heldAmong(showtimeId, seatIds) {
      store.calls.push('heldAmong');
      if (store.down) throw new HoldsUnavailableError('redis not ready (end)');
      return new Set(seatIds.filter((id) => keys.has(key(showtimeId, id))));
    },
  };
  return store;
}

export interface FakeRyowStore extends RyowStore {
  down: boolean;
  active: Set<string>;
  calls: string[];
}

export function createFakeRyowStore(): FakeRyowStore {
  const store: FakeRyowStore = {
    down: false,
    active: new Set(),
    calls: [],
    async mark(ownerId) {
      store.calls.push(`mark:${ownerId}`);
      if (store.down) throw new HoldsUnavailableError('redis not ready (end)');
      store.active.add(ownerId);
    },
    async isActive(ownerId) {
      store.calls.push(`isActive:${ownerId}`);
      if (store.down) throw new HoldsUnavailableError('redis not ready (end)');
      return store.active.has(ownerId);
    },
  };
  return store;
}

export interface FakeRepoSeed {
  /** showtimeId -> its screen and per-seat price. */
  showtimes: Record<string, { screenId: string; priceCents: number }>;
  /** screenId -> its seats. */
  screens: Record<string, { id: string; row: string; number: number }[]>;
}

export interface FakeBookingRepo extends BookingRepo {
  bookings: NewBooking[];
  /** Every read, with where it was sent. */
  reads: { method: string; source: ReadSource }[];
  /** Make the next `soldSeatIds` throw, to test cleanup when Postgres fails after a hold was taken. */
  failNextSoldCheck: boolean;
}

export function createFakeRepo(seed: FakeRepoSeed): FakeBookingRepo {
  const repo: FakeBookingRepo = {
    bookings: [],
    reads: [],
    failNextSoldCheck: false,
    async findShowtimeSeats(source, showtimeId, seatIds): Promise<ShowtimeSeats | null> {
      repo.reads.push({ method: 'findShowtimeSeats', source });
      const showtime = seed.showtimes[showtimeId];
      if (!showtime) return null;
      const screenSeats = seed.screens[showtime.screenId] ?? [];
      return {
        showtimeId,
        priceCents: showtime.priceCents,
        seats: screenSeats.filter((seat) => seatIds.includes(seat.id)),
      };
    },
    async soldSeatIds(showtimeId, seatIds) {
      repo.reads.push({ method: 'soldSeatIds', source: 'primary' });
      if (repo.failNextSoldCheck) {
        repo.failNextSoldCheck = false;
        throw new Error('postgres went away');
      }
      return repo.bookings.filter((b) => b.showtimeId === showtimeId && seatIds.includes(b.seatId)).map((b) => b.seatId);
    },
    async soldSeatIdsForShowtime(source, showtimeId) {
      repo.reads.push({ method: 'soldSeatIdsForShowtime', source });
      return repo.bookings.filter((b) => b.showtimeId === showtimeId).map((b) => b.seatId);
    },
    async createBookings(rows) {
      const clash = rows.some((row) => repo.bookings.some((b) => b.showtimeId === row.showtimeId && b.seatId === row.seatId));
      if (clash) throw new SeatAlreadyBookedError();
      repo.bookings.push(...rows);
    },
  };
  return repo;
}
