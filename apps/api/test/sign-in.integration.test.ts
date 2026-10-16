/**
 * Issue #342 — sign-in on a real PostgreSQL, as the application's own least-privilege role.
 *
 *  - A restart keeps people signed in: a second `SignIn` on the same database (nothing in memory
 *    shared) accepts yesterday's cookie.
 *  - Signing out and removing a member end the session at once, for every server.
 *  - A CA's two businesses are read through the `app.user_id` policy, before any company is chosen,
 *    and switching moves the session from one to the other.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import type { TransactionalExecutor } from '../../../packages/platform/src/database.ts';
import { MockIdentityProvider } from '../../../packages/platform/src/identity.ts';
import { DEMO_SIGN_IN_CODE, SYNTHETIC_PLATFORM_COMPANIES } from '../../../packages/platform/src/seed.ts';
import { SignIn } from '../src/sign-in.ts';
import { PostgresAccessControl, PostgresAuthenticationService } from '../../../packages/platform/src/postgres-platform.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the sign-in database tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';

let owner: TransactionalExecutor;
let createDb: (url: string) => TransactionalExecutor;
let appUrl = '';
const login = `sign_in_${randomBytes(4).toString('hex')}`;
const [SAMPOORNA, KONKAN] = SYNTHETIC_PLATFORM_COMPANIES;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import('../../../packages/platform/src/database.ts');
  const { migrate } = await import('../../../packages/platform/src/migrations.ts');
  const { seed } = await import('../../../packages/platform/src/seed.ts');
  createDb = createDatabase;
  owner = createDatabase(url);
  await migrate(owner);
  await seed(owner);
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

const pools: TransactionalExecutor[] = [];
/** A server process: its own store and pool, nothing shared with any other but the database. */
const server = () => {
  const db = createDb(appUrl);
  pools.push(db);
  return new SignIn(new PostgresAuthenticationService(db, new PostgresAccessControl(db)), new MockIdentityProvider(DEMO_SIGN_IN_CODE));
};
const bearer = (token: string) => `Bearer ${token}`;

test('#342: a restart keeps a CA signed in; switching moves the session; signing out ends it everywhere', { skip }, async () => {
  const yesterday = server();
  const opened = await yesterday.checkCode('ca@example.invalid', DEMO_SIGN_IN_CODE);
  assert.equal(opened.companyId, SAMPOORNA.companyId);
  const context = await yesterday.authenticate(bearer(opened.token));
  assert.deepEqual((await yesterday.companies(context)).map((membership) => membership.companyId), [SAMPOORNA.companyId, KONKAN.companyId]);

  const today = server();
  assert.equal((await today.authenticate(bearer(opened.token))).companyId, SAMPOORNA.companyId, 'the restarted server knows the session');

  const switched = await today.switchCompany(await today.authenticate(bearer(opened.token)), KONKAN.companyId);
  const inKonkan = await yesterday.authenticate(bearer(switched.token));
  assert.equal(inKonkan.companyId, KONKAN.companyId);
  assert.equal(inKonkan.branchId, KONKAN.branchId);
  await assert.rejects(yesterday.authenticate(bearer(opened.token)), /Sign in again/, 'the Sampoorna session ended on every server');

  await yesterday.signOut(inKonkan);
  await assert.rejects(today.authenticate(bearer(switched.token)), /Sign in again/);
});

test('#342: the token is never stored; only its hash is', { skip }, async () => {
  const opened = await server().checkCode('owner@sampoorna.example.invalid', DEMO_SIGN_IN_CODE);
  const { rows } = await owner.query('SELECT count(*)::int AS n FROM sessions WHERE token_hash = encode(sha256($1::bytea), \'hex\')', [opened.token]);
  assert.equal(rows[0]!.n, 1);
  const leaked = await owner.query("SELECT count(*)::int AS n FROM sessions WHERE id::text = $1 OR token_hash = $1", [opened.token]);
  assert.equal(leaked.rows[0]!.n, 0);
});

test('#342: removing a member ends their session at once, on every server', { skip }, async () => {
  const companyId = crypto.randomUUID(); const branchId = crypto.randomUUID(); const userId = crypto.randomUUID();
  const email = `removed-${userId}@example.invalid`;
  await owner.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Removal Traders')", [companyId]);
  await owner.query("INSERT INTO branches (id, company_id, name) VALUES ($1, $2, 'Main shop')", [branchId, companyId]);
  await owner.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Synthetic cashier')", [userId, email]);
  const db = createDb(appUrl);
  try {
    const access = new PostgresAccessControl(db);
    const auth = new PostgresAuthenticationService(db, access);
    await access.grant({ companyId, userId, branchIds: new Set([branchId]), active: true, permissions: new Set(['dashboard.read']) });
    const one = server(); const two = server();
    const opened = await one.checkCode(email, DEMO_SIGN_IN_CODE);
    assert.equal((await two.authenticate(bearer(opened.token))).actorId, userId, 'the person added before signing in was linked by the email they proved');
    await auth.revokeMember(companyId, userId);
    await assert.rejects(two.authenticate(bearer(opened.token)), /Sign in again/);
    await assert.rejects(one.checkCode(email, DEMO_SIGN_IN_CODE), /no business has added you yet/);
  } finally { await db.close(); }
});

test('#342: the idle clock cannot be pushed into the future, and a switched-off person is signed out everywhere', { skip }, async () => {
  const opened = await server().checkCode('viewer@sampoorna.example.invalid', DEMO_SIGN_IN_CODE);
  const db = createDb(appUrl);
  pools.push(db);
  await assert.rejects(db.query("UPDATE sessions SET last_seen_at = now() + interval '1 year' WHERE token_hash = encode(sha256($1::bytea), 'hex')", [opened.token]), /cannot be marked as used in the future/);
  const one = server();
  assert.equal((await one.authenticate(bearer(opened.token))).companyId, SAMPOORNA.companyId);
  const viewer = '00000000-0000-4000-8000-000000000004';
  await db.query('UPDATE users SET active = false WHERE id = $1', [viewer]);
  try {
    await assert.rejects(one.authenticate(bearer(opened.token)), /Sign in again/);
    await assert.rejects(one.checkCode('viewer@sampoorna.example.invalid', DEMO_SIGN_IN_CODE), /switched off/);
  } finally { await db.query('UPDATE users SET active = true WHERE id = $1', [viewer]); }
});
