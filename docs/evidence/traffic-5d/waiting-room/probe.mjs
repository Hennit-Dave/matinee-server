// Probe for traffic slice 5d, PR 2 (waiting room and graceful overload). Plain HTTP against a running matinee-server.
//   node probe.mjs <apiBase> <showtimeId> entry [users]   N users each join the line and then read the seat map
//   node probe.mjs <apiBase> <showtimeId> drain           a short line drains at the fixed admission rate
//   node probe.mjs <apiBase> <showtimeId> lapse           admitted users who go silent give their slots up
//   node probe.mjs <apiBase> <showtimeId> burst [n]       n requests at once (graceful overload)
import { randomUUID } from 'node:crypto';

const [base, showtimeId, mode = 'entry', arg] = process.argv.slice(2);
if (!base || !showtimeId) throw new Error('usage: probe.mjs <apiBase> <showtimeId> entry|drain|lapse|burst [n]');

const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function call(method, path, owner, body) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'X-Client-Id': owner, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null), retryAfter: res.headers.get('Retry-After') };
}
const join = (o) => call('POST', `/showtimes/${showtimeId}/queue`, o);
const poll = (o) => call('GET', `/showtimes/${showtimeId}/queue`, o);
const leave = (o) => call('DELETE', `/showtimes/${showtimeId}/queue`, o);
const seats = (o) => call('GET', `/showtimes/${showtimeId}/seats`, o);
const label = (r, isMap = false) => (r.status !== 200 ? `${r.status} ${r.json?.error?.code ?? ''}`.trim() : isMap ? '200 the map' : r.json.status === 'waiting' ? `waiting, ${r.json.ahead} ahead` : r.json.status);

if (mode === 'entry') {
  const n = Number(arg ?? 100);
  const users = Array.from({ length: n }, () => randomUUID());
  console.log(`${n} users arrive at the same showing and each tries to read the seat map`);
  const joins = await Promise.all(users.map((u) => join(u)));
  const map = await Promise.all(users.map((u) => seats(u)));
  const count = (list, f) => list.filter(f).length;
  console.log(`  join the line:  admitted ${count(joins, (r) => r.json?.status === 'admitted')}, waiting ${count(joins, (r) => r.json?.status === 'waiting')}, other ${count(joins, (r) => !['admitted', 'waiting'].includes(r.json?.status))} (statuses: ${[...new Set(joins.map((r) => r.status))].join(', ')})`);
  console.log(`  read the map:   200 ${count(map, (r) => r.status === 200)}, 403 ${count(map, (r) => r.status === 403)}, other ${count(map, (r) => ![200, 403].includes(r.status))}`);
  const ahead = joins.filter((r) => r.json?.status === 'waiting').map((r) => r.json.ahead).sort((a, b) => a - b);
  if (ahead.length) console.log(`  people ahead of the waiters: ${ahead.slice(0, 6).join(', ')}${ahead.length > 6 ? ', ...' : ''}, ${ahead.at(-1)} (each different: ${new Set(ahead).size === ahead.length})`);
  const sample = users.slice(0, 1).concat(joins.findIndex((r) => r.json?.status === 'waiting') >= 0 ? [users[joins.findIndex((r) => r.json?.status === 'waiting')]] : []);
  for (const u of sample) console.log(`  one user: join -> ${label(joins[users.indexOf(u)])}; map -> ${label(map[users.indexOf(u)], true)}`);
  await Promise.all(users.map((u) => leave(u)));
}

if (mode === 'drain') {
  const users = Array.from({ length: 5 }, () => randomUUID());
  const states = [];
  for (const u of users) states.push(await join(u)); // one after another, so the order is known
  console.log(`${at()}  five users join in order: ${states.map((r, i) => `u${i + 1} ${label(r)}`).join('; ')}`);
  if (states[0].status !== 200) process.exit(0);
  console.log(`${at()}  u1 and u2 (admitted) leave together: two slots free up`);
  await Promise.all([leave(users[0]), leave(users[1])]);
  const admittedAt = {};
  for (let i = 0; i < 90 && Object.keys(admittedAt).length < 3; i += 1) {
    for (const [index, u] of users.entries()) {
      if (index < 2 || admittedAt[index]) continue;
      const r = await poll(u);
      if (r.json?.status === 'admitted') { admittedAt[index] = Date.now(); console.log(`${at()}  u${index + 1} is admitted`); }
    }
    if (admittedAt[2] === undefined && admittedAt[3] !== undefined && i === 20) { console.log(`${at()}  (u5 stays queued: the room is full again; u3 leaves to free a slot)`); await leave(users[2]); }
    await sleep(300);
  }
  const times = Object.entries(admittedAt).sort((a, b) => a[1] - b[1]);
  if (times.length >= 2) console.log(`  spacing between admissions: ${times.slice(1).map(([, t], i) => `${((t - times[i][1]) / 1000).toFixed(1)} s`).join(', ')}`);
  await Promise.all(users.map((u) => leave(u)));
}

if (mode === 'lapse') {
  const users = Array.from({ length: 4 }, () => randomUUID());
  const states = [];
  for (const u of users) states.push(await join(u));
  console.log(`${at()}  four users join: ${states.map((r, i) => `u${i + 1} ${label(r)}`).join('; ')}`);
  if (states[0].status !== 200) process.exit(0);
  console.log(`${at()}  u1 and u2 (admitted) close their apps: they stop polling and never leave. u3 and u4 keep waiting.`);
  const waiter = users[2];
  for (let i = 0; i < 120; i += 1) {
    const r = await poll(waiter);
    if (r.json?.status === 'admitted') { console.log(`${at()}  u3 is admitted: the silent users' passes lapsed and freed the slots`); break; }
    if (i % 20 === 0) console.log(`${at()}  u3: ${label(r)}`);
    await sleep(500);
  }
  await Promise.all(users.map((u) => leave(u)));
}

if (mode === 'burst') {
  const n = Number(arg ?? 80);
  // A different install per request, so the per-install rate limit is not what answers: this is about the SERVER being busy.
  const rs = await Promise.all(Array.from({ length: n }, () => seats(randomUUID())));
  const by = {};
  for (const r of rs) { const k = `${r.status}${r.json?.error?.code ? ' ' + r.json.error.code : ''}`; by[k] = (by[k] ?? 0) + 1; }
  console.log(`${n} seat-map requests at the same moment: ${Object.entries(by).map(([k, v]) => `${v} x ${k}`).join(', ')}`);
  const retry = rs.filter((r) => r.retryAfter).map((r) => Number(r.retryAfter));
  if (retry.length) console.log(`  Retry-After on the refusals: min ${Math.min(...retry)} s, max ${Math.max(...retry)} s `);
  await sleep(1000);
  const after = await seats(randomUUID());
  console.log(`  a request a moment later: ${after.status}`);
}
