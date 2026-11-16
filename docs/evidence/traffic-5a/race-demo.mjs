// The double-booking race, on purpose. 50 "users" try to book the same seat at the same moment.
//
//   naive:   SELECT to see whether the seat is free, then INSERT if it is. No constraint.
//   guarded: the same two steps, but the table has UNIQUE (showtime_id, seat_id).
//
// Every user holds a connection before anyone starts, then they are released together. Between the check
// and the write each one pauses CHECK_TO_WRITE_MS, standing in for what a real request does there (a price
// lookup, validation, a network round trip). The pause makes the window visible; it does not create it:
// any gap at all between "is it free?" and "take it" is the race.
//
// Run against a throwaway local Postgres only (it creates and drops two scratch tables):
//   RACE_DEMO_URL=postgresql://ci@127.0.0.1:54329/matinee5a node docs/evidence/traffic-5a/race-demo.mjs
import pg from 'pg';

const url = process.env.RACE_DEMO_URL;
if (!url) throw new Error('set RACE_DEMO_URL to a throwaway local Postgres');
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(url).hostname)) {
  throw new Error('refusing to run against a non-local database');
}

const USERS = 50;
const CHECK_TO_WRITE_MS = 20;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SHOWTIME = '11111111-1111-4111-8111-111111111111';
const SEAT = '22222222-2222-4222-8222-222222222222';

const pool = new pg.Pool({ connectionString: url, max: USERS });

async function bookIfFree(table, owner, client, start) {
  await start; // everyone is released at the same moment
  try {
    const free = await client.query(`SELECT 1 FROM ${table} WHERE showtime_id = $1 AND seat_id = $2`, [SHOWTIME, SEAT]);
    if (free.rowCount > 0) return 'refused (seat already taken)';
    await sleep(CHECK_TO_WRITE_MS);
    await client.query(`INSERT INTO ${table} (showtime_id, seat_id, owner) VALUES ($1, $2, $3)`, [SHOWTIME, SEAT, owner]);
    return 'booked';
  } catch (err) {
    return err.code === '23505' ? 'refused by the database (unique violation)' : `error ${err.code}`;
  }
}

async function run(table) {
  const clients = await Promise.all(Array.from({ length: USERS }, () => pool.connect()));
  let go;
  const start = new Promise((resolve) => (go = resolve));
  const running = clients.map((client, i) => bookIfFree(table, `user-${i}`, client, start));
  go();
  const outcomes = await Promise.all(running);
  clients.forEach((client) => client.release());
  const tally = {};
  for (const o of outcomes) tally[o] = (tally[o] ?? 0) + 1;
  const rows = (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE showtime_id = $1 AND seat_id = $2`, [SHOWTIME, SEAT])).rows[0].n;
  console.log(`${table}: rows for the one seat = ${rows}`);
  console.log(`  outcomes: ${JSON.stringify(tally)}`);
  return rows;
}

await pool.query('DROP TABLE IF EXISTS race_naive, race_guarded');
await pool.query('CREATE TABLE race_naive (showtime_id uuid, seat_id uuid, owner text)');
await pool.query('CREATE TABLE race_guarded (showtime_id uuid, seat_id uuid, owner text, UNIQUE (showtime_id, seat_id))');

console.log(`${USERS} users, one seat, all at once\n`);
const naive = await run('race_naive');
const guarded = await run('race_guarded');
console.log(`\nnaive check-then-insert sold the seat ${naive} times; with the unique constraint: ${guarded}.`);

await pool.query('DROP TABLE race_naive, race_guarded');
await pool.end();
