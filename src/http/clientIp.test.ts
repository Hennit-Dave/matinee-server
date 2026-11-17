import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { TRUSTED_PROXY_RANGES, clientAddressKey, resolveClientAddress, type ClientAddress } from './clientIp.js';

/**
 * How the per-IP limit decides who is calling (ADR 0016). Three layers of proof, none of which needs Redis:
 *   1. the key an address becomes (IPv4-mapped, the IPv6 /64, a proxy hop that must not be counted);
 *   2. Express's own `req.ip`, with the real trust list, for every peer and header shape that matters;
 *   3. the real app behind a real HTTP proxy that behaves the two ways Railway's edge is said to behave.
 * What none of this proves is Railway itself: that is `docs/evidence/traffic-5c/verify-client-ip.sh`, to be
 * run against the real edge in the deploy slice.
 */

const key = (raw: string | undefined) => {
  const result = clientAddressKey(raw);
  return result.resolved ? result.key : `unresolved:${result.reason}`;
};

test('an address becomes one counter key: IPv4 as is, IPv4-mapped IPv6 as IPv4, other IPv6 as its /64', () => {
  assert.equal(key('203.0.113.7'), '203.0.113.7');
  assert.equal(key('::ffff:203.0.113.7'), '203.0.113.7', 'what a dual-stack socket reports');
  assert.equal(key('::ffff:cb00:7107'), '203.0.113.7', 'the same address written in hex');

  assert.equal(key('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(key('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(key('2001:db8:1:2:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64', 'every address of one /64 is one caller');
  assert.equal(key('2001:DB8:1:2::1'), '2001:db8:1:2::/64', 'case does not matter');
  assert.notEqual(key('2001:db8:1:3::1'), key('2001:db8:1:2::1'), 'a different /64 is a different caller');
  assert.equal(key('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(key('fe80::1%en0'), 'fe80:0:0:0::/64', 'a zone id is not part of the address');
});

test('local development callers are real callers: loopback and ordinary private addresses are counted', () => {
  assert.equal(key('127.0.0.1'), '127.0.0.1');
  assert.equal(key('::1'), '0:0:0:0::/64');
  assert.equal(key('192.168.1.20'), '192.168.1.20');
  assert.equal(key('10.0.0.5'), '10.0.0.5');
});

test('SAFETY NET: an address inside a proxy hop range is not a caller, so it is not counted', () => {
  for (const hop of ['100.64.0.1', '100.100.1.1', '100.127.255.254', '::ffff:100.64.9.9', 'fd12::1', 'fc00::5']) {
    assert.deepEqual(clientAddressKey(hop), { resolved: false, reason: 'infrastructure_address' }, hop);
  }
  // The range edges: just outside 100.64.0.0/10 is a different network.
  assert.equal(key('100.63.255.255'), '100.63.255.255');
  assert.equal(key('100.128.0.1'), '100.128.0.1');
});

test('nothing usable is not a caller either, and a header value that is not an address never becomes a key', () => {
  assert.deepEqual(clientAddressKey(undefined), { resolved: false, reason: 'no_address' });
  assert.deepEqual(clientAddressKey(''), { resolved: false, reason: 'no_address' });
  for (const junk of ['garbage', '1.2.3.4, 5.6.7.8', '999.1.1.1', '1.2.3', '2001:db8::zz', '<script>', '::1::2']) {
    assert.deepEqual(clientAddressKey(junk), { resolved: false, reason: 'not_an_ip' }, junk);
  }
});

// ---- Express's req.ip with the real trust list --------------------------------------------------------

const app = express();
app.set('trust proxy', [...TRUSTED_PROXY_RANGES]);

/** `req.ip` for a request whose TCP peer is `peer` and whose X-Forwarded-For is `forwarded` (no sockets involved). */
function reqIp(peer: string, forwarded?: string): string | undefined {
  const req = Object.create(app.request) as { headers: Record<string, string>; socket: { remoteAddress: string }; connection: unknown };
  req.headers = forwarded === undefined ? {} : { 'x-forwarded-for': forwarded };
  req.socket = { remoteAddress: peer };
  req.connection = req.socket;
  return (req as unknown as { ip?: string }).ip;
}

test('the trust list is ranges, not a count: infrastructure addresses are trusted, public ones never are', () => {
  const trusts = app.get('trust proxy fn') as (address: string, hop: number) => boolean;
  for (const hop of ['127.0.0.1', '::1', '10.1.2.3', '172.16.0.9', '192.168.5.5', '169.254.1.1', '100.64.0.1', '100.127.255.254', 'fd12::1']) {
    assert.equal(trusts(hop, 0), true, `${hop} is a hop`);
  }
  for (const caller of ['203.0.113.9', '8.8.8.8', '100.63.255.255', '100.128.0.1', '2001:db8::1']) {
    assert.equal(trusts(caller, 0), false, `${caller} is a caller`);
  }
});

test('a PUBLIC peer cannot forge its address: its X-Forwarded-For is ignored', () => {
  assert.equal(reqIp('203.0.113.9', '1.2.3.4'), '203.0.113.9');
  assert.equal(reqIp('203.0.113.9', '1.2.3.4, 5.6.7.8'), '203.0.113.9');
  assert.equal(reqIp('203.0.113.9'), '203.0.113.9');
});

test('behind a hop in 100.64.0.0/10 the caller is the first address from the right that a hop cannot be, however many hops there are', () => {
  const peer = '100.64.3.4'; // Railway's range
  assert.equal(reqIp(peer, '203.0.113.7'), '203.0.113.7', 'one proxy: the edge set the header');
  assert.equal(reqIp(peer, '203.0.113.7, 100.64.1.1'), '203.0.113.7', 'an extra hop after the caller');
  assert.equal(reqIp(peer, '203.0.113.7, 100.64.1.1, 100.64.2.2'), '203.0.113.7', 'two extra hops');
  assert.equal(reqIp(peer, '2001:db8:abcd:12::77'), '2001:db8:abcd:12::77', 'an IPv6 caller');
});

test('forged values sit LEFT of what the edge adds, so they never win, whether the edge replaces or appends', () => {
  const peer = '100.64.3.4';
  assert.equal(reqIp(peer, '1.1.1.1, 203.0.113.7'), '203.0.113.7', 'the caller sent 1.1.1.1, the edge appended the truth');
  assert.equal(reqIp(peer, '10.0.0.1, 100.64.0.9, 203.0.113.7'), '203.0.113.7', 'forged values that LOOK like hops do not help either');
  assert.equal(reqIp(peer, '8.8.8.8, 1.1.1.1, 203.0.113.7, 100.64.1.1'), '203.0.113.7');
});

test('if only hops are visible (the edge changed its headers or ranges) the answer is a hop, which the limiter then refuses to count', () => {
  for (const [peer, forwarded] of [['100.64.3.4', undefined], ['100.64.3.4', '100.64.7.7'], ['127.0.0.1', '100.64.7.7, 100.64.8.8']] as const) {
    const resolved: ClientAddress = resolveClientAddress({ ip: reqIp(peer, forwarded) });
    assert.deepEqual(resolved, { resolved: false, reason: 'infrastructure_address' }, `${peer} / ${forwarded ?? 'no header'}`);
  }
});

// ---- A real proxy in front of the real Express ------------------------------------------------------------

type EdgeMode = 'replace' | 'append';

/**
 * Stands in for Railway's edge, in the two ways its behaviour has been described. It is on loopback, which our
 * trust list treats like a hop; `x-sim-client` says which public address "the edge saw" (a test header only).
 */
function startEdge(backendPort: number, mode: EdgeMode): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const claimed = String(req.headers['x-sim-client'] ?? '');
    const headers = { ...req.headers };
    delete headers['x-sim-client'];
    const incoming = typeof headers['x-forwarded-for'] === 'string' ? headers['x-forwarded-for'] : undefined;
    const hop = '100.64.7.7'; // "you may see another hop as the request is forwarded through our network"
    headers['x-forwarded-for'] =
      mode === 'replace' ? [claimed, hop].join(', ') : [incoming, claimed, hop].filter(Boolean).join(', ');
    headers['x-real-ip'] = claimed;
    const upstream = http.request({ host: '127.0.0.1', port: backendPort, path: req.url, method: req.method, headers }, (back) => {
      res.writeHead(back.statusCode ?? 502, back.headers);
      back.pipe(res);
    });
    req.pipe(upstream);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function startBackend(): Promise<http.Server> {
  const backend = express();
  backend.set('trust proxy', [...TRUSTED_PROXY_RANGES]);
  backend.get('/who', (req, res) => {
    res.json(resolveClientAddress(req));
  });
  return new Promise((resolve) => {
    const server = backend.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const close = (server: http.Server) => new Promise<void>((resolve) => server.close(() => resolve()));
const portOf = (server: http.Server) => (server.address() as AddressInfo).port;

for (const mode of ['replace', 'append'] as const) {
  test(`through a real proxy that ${mode === 'replace' ? 'replaces' : 'appends to'} X-Forwarded-For: the caller is the real address and forged headers lose`, async () => {
    const backend = await startBackend();
    const edge = await startEdge(portOf(backend), mode);
    try {
      const who = async (headers: Record<string, string>): Promise<ClientAddress> => {
        const res = await fetch(`http://127.0.0.1:${portOf(edge)}/who`, { headers });
        return (await res.json()) as ClientAddress;
      };

      assert.deepEqual(await who({ 'x-sim-client': '203.0.113.7' }), { resolved: true, key: '203.0.113.7' });
      assert.deepEqual(await who({ 'x-sim-client': '2001:db8:abcd:12::77' }), { resolved: true, key: '2001:db8:abcd:12::/64' });

      // The caller tries to be someone else: a forged X-Forwarded-For and a forged X-Real-IP.
      const forged = { 'x-sim-client': '203.0.113.7', 'x-forwarded-for': '1.1.1.1', 'x-real-ip': '2.2.2.2' };
      assert.deepEqual(await who(forged), { resolved: true, key: '203.0.113.7' });
      // ...including values chosen to look like hops, to try to make the real address the "next" one to skip.
      assert.deepEqual(await who({ ...forged, 'x-forwarded-for': '10.0.0.1, 100.64.0.9' }), { resolved: true, key: '203.0.113.7' });

      // Two different callers behind the same edge stay two different keys (they are NOT collapsed onto the edge).
      const [a, b] = await Promise.all([who({ 'x-sim-client': '203.0.113.7' }), who({ 'x-sim-client': '203.0.113.8' })]);
      assert.notDeepEqual(a, b);
    } finally {
      await close(edge);
      await close(backend);
    }
  });
}

test('through a proxy that forgets to name the caller, the limiter is told "infrastructure", not handed the edge as everyone\'s address', async () => {
  const backend = await startBackend();
  const edge = await startEdge(portOf(backend), 'replace');
  try {
    // An empty claimed address leaves `, 100.64.7.7`: only the hop is left to resolve.
    const res = await fetch(`http://127.0.0.1:${portOf(edge)}/who`);
    assert.deepEqual(await res.json(), { resolved: false, reason: 'infrastructure_address' });
  } finally {
    await close(edge);
    await close(backend);
  }
});
