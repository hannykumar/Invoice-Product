/**
 * Issue #350 — "limits still hold after a redeploy and across two instances", on PostgreSQL as the
 * application's own least-privilege role. Each `RateLimiter` here is a separate server: its own pool,
 * nothing shared but the database.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import type { TransactionalExecutor } from '../../../packages/platform/src/database.ts';
import { LIMITS, PostgresCounterStore, RateLimited, RateLimiter } from '../../../packages/platform/src/rate-limits.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the rate-limit database tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';

let owner: TransactionalExecutor;
let appUrl = '';
const login = `rate_limits_${randomBytes(4).toString('hex')}`;
const pools: TransactionalExecutor[] = [];
let createDb: (url: string) => TransactionalExecutor;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import('../../../packages/platform/src/database.ts');
  const { migrate } = await import('../../../packages/platform/src/migrations.ts');
  createDb = createDatabase;
  owner = createDatabase(url);
  await migrate(owner);
  const password = randomBytes(18).toString('hex');
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  const app = new URL(url);
  app.username = login;
  app.password = password;
  appUrl = app.toString();
});
after(async () => {
  if (owner === undefined) return;
  for (const pool of pools) await pool.close();
  await owner.query(`DROP OWNED BY ${login}`);
  await owner.query(`DROP ROLE IF EXISTS ${login}`);
  await owner.close();
});

const server = () => { const db = createDb(appUrl); pools.push(db); return new RateLimiter(new PostgresCounterStore(db)); };

test('#350: two servers share one count, and a restarted server still remembers it', { skip }, async () => {
  const address = `+9198${String(randomBytes(4).readUInt32BE() % 100_000_000).padStart(8, '0')}`;
  const one = server(); const two = server();
  // Two servers, at the same moment: every attempt is counted once, none lost.
  await Promise.all([1, 2, 3].map(() => one.take(LIMITS.wrongCodesPerAddress, address)).concat([4, 5].map(() => two.take(LIMITS.wrongCodesPerAddress, address))));
  assert.equal(await one.used(LIMITS.wrongCodesPerAddress, address), 5);
  await assert.rejects(two.take(LIMITS.wrongCodesPerAddress, address), RateLimited);
  // A deploy: a new process, a new pool. The count is still there.
  const restarted = server();
  await assert.rejects(restarted.refuseIfSpent(LIMITS.wrongCodesPerAddress, address), RateLimited);
});

test('#350: the table holds hashes, never a phone number, an email or an IP address', { skip }, async () => {
  await server().take(LIMITS.codeRequestsPerAddress, 'someone@example.invalid');
  const { rows } = await owner.query("SELECT count(*)::int AS n FROM rate_limit_counters WHERE bucket LIKE '%someone%' OR bucket LIKE '%example.invalid%'");
  assert.equal(rows[0]!.n, 0);
});
