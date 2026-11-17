import { BlockList, isIP } from 'node:net';
import type { Request } from 'express';

/**
 * Who is calling, by address, for the per-IP rate limit (ADR 0016).
 *
 * THE PROBLEM. On Railway the container never talks to the caller directly: an edge proxy sits in between,
 * so the socket address is the proxy's, and the caller's address arrives in a header. Two ways to get that
 * wrong, and they fail differently: trust too little and every user is "the proxy's address" (one shared
 * bucket, an outage); trust too much and a caller can write their own address into the header (a free bypass).
 *
 * WHY NOT A HOP COUNT. Express's usual answer is `trust proxy = <number of proxies>`. Railway publishes no
 * such number: its docs document only `X-Real-IP`, its staff have said "you may see another hop", and its
 * answers disagree on whether `X-Forwarded-For` is replaced or appended to. A number we cannot justify is a
 * number that fails one of the two ways above.
 *
 * WHAT WE DO INSTEAD. Trust by ADDRESS RANGE: the addresses a proxy hop can have (loopback, private and
 * link-local ranges, and 100.64.0.0/10, the shared range Railway's hops are seen in) can never be a public
 * caller. Express then walks `X-Forwarded-For` from the right and stops at the first address that is NOT one
 * of those: that is the caller. It does not matter how many hops there are, and it does not matter whether the
 * edge replaces the header or appends to it, because anything a caller forges sits to the LEFT of what the
 * edge adds.
 *
 * THE SAFETY NET. Railway's ranges are "not a stable contract". If they change, Express would stop skipping a
 * hop and hand us the proxy's address. A proxy hop is never a caller, so when the resolved address is itself
 * in the infrastructure ranges below we do not count it: the address counter is skipped for that request (the
 * user counter still applies) and the limiter logs it. The failure is "the address limit is off, loudly", not
 * "everyone is refused".
 *
 * Not verified against a real Railway edge (nothing is deployed yet): `docs/evidence/traffic-5c/verify-client-ip.sh`
 * is that check and MUST be run against the real edge in the deploy slice.
 */

/** Handed to `app.set('trust proxy', ...)`. Express/proxy-addr accept these names and CIDR ranges. */
export const TRUSTED_PROXY_RANGES: readonly string[] = ['loopback', 'linklocal', 'uniquelocal', '100.64.0.0/10'];

/**
 * Addresses that can only be a hop of OUR OWN infrastructure when seen as "the caller": RFC 6598 shared space
 * (where Railway's hops are seen) and IPv6 unique-local (fc00::/7, how a private IPv6 hop would look).
 * Loopback and ordinary private ranges are deliberately NOT here: they are real callers in local development.
 */
const infrastructure = new BlockList();
infrastructure.addSubnet('100.64.0.0', 10, 'ipv4');
infrastructure.addSubnet('fc00::', 7, 'ipv6');

export type ClientAddress =
  | { resolved: true; /** The counter key: an IPv4 address, or an IPv6 /64. */ key: string }
  | { resolved: false; reason: 'no_address' | 'not_an_ip' | 'infrastructure_address' };

/** Expands any textual IPv6 address (including `::` and a trailing dotted quad) to its eight 16-bit groups. */
function expandIPv6(text: string): number[] | null {
  const address = text.split('%')[0]!; // a zone id (fe80::1%en0) is not part of the address
  const [head, tail] = address.split('::') as [string, string | undefined];
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    const pieces = part.split(':');
    for (const [index, piece] of pieces.entries()) {
      if (piece.includes('.')) {
        if (index !== pieces.length - 1) return null;
        const quad = piece.split('.').map(Number);
        if (quad.length !== 4 || quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        out.push(quad[0]! * 256 + quad[1]!, quad[2]! * 256 + quad[3]!);
      } else {
        const group = Number.parseInt(piece, 16);
        if (!/^[0-9a-f]{1,4}$/i.test(piece) || Number.isNaN(group)) return null;
        out.push(group);
      }
    }
    return out;
  };

  const first = toGroups(head);
  if (first === null) return null;
  if (tail === undefined) return first.length === 8 ? first : null;
  const second = toGroups(tail);
  if (second === null || first.length + second.length > 7) return null;
  return [...first, ...Array<number>(8 - first.length - second.length).fill(0), ...second];
}

/**
 * Turns the address Express resolved into a counter key. IPv4-mapped IPv6 (`::ffff:1.2.3.4`, what a dual-stack
 * socket reports) becomes plain IPv4, so one caller is one key however it arrived. An IPv6 caller is counted by
 * its /64, because a single host can use any address inside its /64 and per-address counting would be free to
 * dodge. (A household with a larger prefix can still rotate between /64s; ADR 0016 lists that as a known limit.)
 */
export function clientAddressKey(raw: string | undefined): ClientAddress {
  if (!raw) return { resolved: false, reason: 'no_address' };
  const family = isIP(raw.split('%')[0]!);
  if (family === 0) return { resolved: false, reason: 'not_an_ip' };

  if (family === 4) return fromIPv4(raw);

  const groups = expandIPv6(raw);
  if (groups === null) return { resolved: false, reason: 'not_an_ip' };
  const isMapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (isMapped) {
    return fromIPv4(`${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`);
  }
  if (infrastructure.check(groups.map((g) => g.toString(16)).join(':'), 'ipv6')) {
    return { resolved: false, reason: 'infrastructure_address' };
  }
  return { resolved: true, key: `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64` };
}

function fromIPv4(address: string): ClientAddress {
  if (infrastructure.check(address, 'ipv4')) return { resolved: false, reason: 'infrastructure_address' };
  return { resolved: true, key: address };
}

/** The caller's address as Express resolved it (`trust proxy` is set in api/app.ts), as a counter key. */
export function resolveClientAddress(req: Pick<Request, 'ip'>): ClientAddress {
  return clientAddressKey(req.ip);
}
