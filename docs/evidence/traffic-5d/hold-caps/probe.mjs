// Probe for traffic slice 5d, PR 1 (hold caps). Plain HTTP against a running matinee-server; nothing is imported.
//   node docs/evidence/traffic-5d/hold-caps/probe.mjs <apiBase> <showtimeId>
// It takes seats the way the app does (POST /showtimes/:id/holds, up to 8 seats a request, with an X-Client-Id) and
// reports how many seats end up held, per install and per address. It releases everything it took.
import { randomUUID } from 'node:crypto';

const [base, showtimeId] = process.argv.slice(2);
if (!base || !showtimeId) throw new Error('usage: probe.mjs <apiBase> <showtimeId>');

async function call(method, path, owner, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'X-Client-Id': owner, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, retryAfter: res.headers.get('Retry-After') };
}

const lister = randomUUID();
const map = await call('GET', `/showtimes/${showtimeId}/seats`, lister);
const seatIds = map.json.rows.flatMap((r) => r.seats).filter((s) => s.kind === 'standard' && s.status === 'available').map((s) => s.id);
const heldNow = async () => (await call('GET', `/showtimes/${showtimeId}/seats`, lister)).json.rows.flatMap((r) => r.seats).filter((s) => s.status === 'held').length;
const took = []; // [owner, seatIds] to give back

async function hold(owner, ids) {
  const r = await call('POST', `/showtimes/${showtimeId}/holds`, owner, { seatIds: ids });
  if (r.status === 201) took.push([owner, ids]);
  return r;
}
const describe = (r) =>
  r.status === 201 ? '201 held' : `${r.status} ${r.json?.error?.code}${r.json?.error?.scope ? ` (scope ${r.json.error.scope}, limit ${r.json.error.limit}, held ${r.json.error.held})` : ''}`;

console.log(`held before: ${await heldNow()}`);

// A. one install asks for 10 batches of 8 distinct seats (the hold rate limit is 10 a minute per install)
console.log('\nA. ONE install, 10 requests of 8 different seats each');
const owner = randomUUID();
for (let i = 0; i < 10; i += 1) {
  const r = await hold(owner, seatIds.slice(i * 8, i * 8 + 8));
  console.log(`   request ${String(i + 1).padStart(2)}: ${describe(r)}`);
}
console.log(`   seats held on the map now: ${await heldNow()}`);
for (const [o, ids] of took.splice(0)) await call('DELETE', `/showtimes/${showtimeId}/holds`, o, { seatIds: ids });
console.log(`   after giving them back: ${await heldNow()}`);

// B. one ADDRESS (this machine), five different installs, 8 seats each
console.log('\nB. ONE address, five different installs (each a new X-Client-Id), 8 seats each');
for (let i = 0; i < 5; i += 1) {
  const r = await hold(randomUUID(), seatIds.slice(i * 8, i * 8 + 8));
  console.log(`   install ${i + 1}: ${describe(r)}`);
}
console.log(`   seats held on the map now: ${await heldNow()}`);
for (const [o, ids] of took.splice(0)) await call('DELETE', `/showtimes/${showtimeId}/holds`, o, { seatIds: ids });
console.log(`   after giving them back: ${await heldNow()}`);
