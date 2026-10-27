/**
 * Issue #504 — a connection the server ends while it sits idle in the pool must not take the process down.
 *
 * PostgreSQL ends connections for ordinary reasons: a restart or failover, a managed-database
 * maintenance window, `pg_terminate_backend`. `pg.Pool` reports that as an `error` event on the pool.
 * With no listener Node treats it as an uncaught exception ("terminating connection due to
 * administrator command"): in CI the test that happened to be running failed with it, in production
 * the API would have stopped.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import type { TransactionalExecutor } from '../src/database.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the pool error tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';

let owner: TransactionalExecutor;
let createDb: (url: string) => TransactionalExecutor;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import('../src/database.ts');
  createDb = createDatabase;
  owner = createDatabase(url);
});
after(async () => { if (owner !== undefined) await owner.close(); });

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A pool whose connections are named, so the test ends its own and nobody else's. */
const namedPool = () => {
  const name = `pool_errors_${randomBytes(6).toString('hex')}`;
  const named = new URL(url as string);
  named.searchParams.set('application_name', name);
  return { name, db: createDb(named.toString()) };
};

/** Ends this pool's idle connections from the server side, and waits until the client has been told. */
const endIdleConnections = async (name: string): Promise<void> => {
  await owner.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1', [name]);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await owner.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1', [name]);
    if (rows[0]!.n === 0) break;
    await pause(20);
  }
  // The socket close reaches the client a moment after the backend is gone; an unhandled `error`
  // event would be thrown here, as an uncaught exception, and fail this file.
  await pause(100);
};

test('#504: an idle connection ended by the server does not crash the process, and the next query works', { skip }, async () => {
  const { name, db } = namedPool();
  try {
    await db.query('SELECT 1');
    await endIdleConnections(name);
    assert.equal((await db.query('SELECT 42::int AS answer')).rows[0]!.answer, 42, 'the pool opened a fresh connection');
  } finally { await db.close(); }
});

test('#504: the same, many times over — no run leaves a stray error for the next test to be blamed for', { skip }, async () => {
  const { name, db } = namedPool();
  try {
    for (let round = 0; round < 25; round += 1) {
      await Promise.all([db.query('SELECT 1'), db.query('SELECT 2'), db.transaction(async (sql) => { await sql.query('SELECT 3'); })]);
      await endIdleConnections(name);
    }
    assert.equal((await db.query('SELECT 1::int AS ok')).rows[0]!.ok, 1);
  } finally { await db.close(); }
});

test('#504: a connection ended in the middle of a transaction fails that action only, and the pool recovers', { skip }, async () => {
  const { name, db } = namedPool();
  try {
    await assert.rejects(db.transaction(async (sql) => {
      await sql.query('SELECT 1');
      await owner.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1', [name]);
      await pause(100);
      await sql.query('SELECT 2');
    }), /terminat|Connection|closed|ended/i);
    assert.equal((await db.query('SELECT 7::int AS n')).rows[0]!.n, 7, 'the broken connection was discarded, not handed to the next caller');
  } finally { await db.close(); }
});
