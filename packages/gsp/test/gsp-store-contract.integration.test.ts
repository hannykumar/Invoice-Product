/**
 * Issue #366 — this module's stores on a real PostgreSQL, connected as the application role so
 * row-level security and the freeze rules of #368 are really in force.
 *
 * The sandbox provider and the synthetic IRP answer in-process, so calling them inside a unit of
 * work here holds no real connection open. In the server, #340 must keep provider calls outside it.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import type { CompanyId, UserId } from '@invoice/kernel';
import type { TransactionalExecutor } from '../../platform/src/database.ts';
import { KARNATAKA_GSTIN, invoicePayload } from '../src/fixtures.ts';
import type * as Repositories from '../src/postgres-repositories.ts';
import { desk, gspStoreContract, type GspHarness } from './gsp-store-contract.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the gsp database tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let repos: typeof Repositories;
const login = `invoice_app_test_${randomBytes(6).toString('hex')}`;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import('../../platform/src/database.ts');
  const { migrate } = await import('../../platform/src/migrations.ts');
  repos = await import('../src/postgres-repositories.ts');
  owner = createDatabase(url);
  await migrate(owner);
  const password = randomBytes(18).toString('hex');
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  const appUrl = new URL(url);
  appUrl.username = login;
  appUrl.password = password;
  app = createDatabase(appUrl.toString());
});
after(async () => {
  await app?.close();
  if (owner !== undefined) { await owner.query(`DROP ROLE IF EXISTS ${login}`); await owner.close(); }
});

const company = async (): Promise<{ companyId: CompanyId; userId: UserId }> => {
  const companyId = crypto.randomUUID() as CompanyId;
  const userId = crypto.randomUUID() as UserId;
  await app.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Hardware Traders')", [companyId]);
  await app.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Synthetic owner')", [userId, `gsp-${userId}@example.invalid`]);
  return { companyId, userId };
};

const harness = (): GspHarness => ({
  authorisations: new repos.PostgresAuthorisations(app),
  calls: new repos.PostgresCallLog(app),
  company,
  write: (companyId, work) => app.unitOfWork(companyId, () => work()),
});

gspStoreContract('postgres as the application role', harness, skip);

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

test('a write outside the action\'s transaction is refused, and a failed action leaves nothing', { skip }, async () => {
  const h = harness();
  const d = await desk({ ...h, write: (_companyId, work) => work() });
  await assert.rejects(d.connect(KARNATAKA_GSTIN), code('NO_UNIT_OF_WORK'));
  await assert.rejects(d.channel.call(d.owner, { operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-1'), idempotencyKey: 'SI-1' }), code('NO_UNIT_OF_WORK'));
  await assert.rejects(app.unitOfWork(d.companyId, async () => {
    await d.service.beginOnboarding(d.owner, { gstin: KARNATAKA_GSTIN, legalName: 'Synthetic', signatoryHint: 'the owner', scopes: ['GSTR2B_FETCH'] });
    throw new Error('abandoned');
  }), /abandoned/);
  assert.equal(await h.authorisations.find(d.companyId, KARNATAKA_GSTIN), null);
  assert.deepEqual(await h.calls.list(d.companyId), []);
});

test('every table of this module that holds a company\'s rows is closed to other companies by the database', { skip }, async () => {
  const tables = ['gstin_authorisations', 'gstin_consents', 'gsp_credentials', 'gsp_otp_challenges', 'government_calls'];
  const { rows } = await owner.query(
    'SELECT c.relname AS name FROM pg_class c WHERE c.relname = ANY ($1) AND c.relrowsecurity AND c.relforcerowsecurity', [tables]);
  assert.deepEqual(rows.map((row) => row.name).sort(), [...tables].sort());
  const h = harness();
  const d = await desk(h);
  await d.connect(KARNATAKA_GSTIN);
  const theirs = await h.authorisations.find(d.companyId, KARNATAKA_GSTIN);
  const other = await company();
  // A query that forgot its company filter still sees only its own company's rows.
  for (const table of tables) {
    const seen = await app.tenantTransaction(other.companyId, (sql) => sql.query(`SELECT count(*)::int AS n FROM ${table}`));
    assert.equal(seen.rows[0]?.n, 0, table);
  }
  // A consent cannot be hung on another company's authorisation, under either company's name.
  const consent = (as: string) => app.unitOfWork(other.companyId, ({ sql }) => sql.query(
    `INSERT INTO gstin_consents (id, authorisation_id, company_id, scopes, wording_shown, method, granted_by)
     VALUES (gen_random_uuid(), $1, $2, '{GSTR2B_FETCH}', '{}', 'PORTAL_OTP', $3)`, [theirs?.id, as, other.userId]));
  await assert.rejects(consent(d.companyId), code('42501'));
  await assert.rejects(consent(other.companyId), code('23503'));
});

test('a settled call, a consent and a credential cannot be rewritten or removed', { skip }, async () => {
  const h = harness();
  const d = await desk(h);
  await d.connect(KARNATAKA_GSTIN);
  const answered = await d.act(() => d.channel.call(d.owner, { operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-9'), idempotencyKey: 'SI-9', documentRef: 'SI-9' }));
  const settled = await h.calls.find(d.companyId, answered.callId);
  assert.equal(settled?.outcome, 'ACCEPTED');
  const settle = (over: Record<string, unknown>) => d.act(() => h.calls.settle({ ...settled!, ...over }));
  // What reconciliation and a callback do to a settled call is allowed: mark it looked at.
  await settle({ reconciledAt: '2026-08-17T05:00:00.000Z' });
  // Nothing else.
  await assert.rejects(settle({ outcome: 'UNKNOWN' }), code('23001'));
  await assert.rejects(settle({ governmentReference: 'another-irn' }), code('23001'));
  await assert.rejects(settle({ errorCode: 'REWRITTEN' }), code('23001'));
  const raw = (statement: string) => app.unitOfWork(d.companyId, ({ sql }) => sql.query(statement, [d.companyId]));
  await assert.rejects(raw("UPDATE gstin_consents SET method = 'SIGNED_AUTHORISATION' WHERE company_id = $1"), code('23001'));
  await assert.rejects(raw("UPDATE gsp_credentials SET reference = 'vault://elsewhere' WHERE company_id = $1"), code('23001'));
  for (const table of ['government_calls', 'gstin_consents', 'gsp_credentials']) {
    await assert.rejects(raw(`DELETE FROM ${table} WHERE company_id = $1`), code('42501'), table);
  }
  assert.equal((await h.calls.find(d.companyId, answered.callId))?.reconciledAt, '2026-08-17T05:00:00.000Z');
});

test('a callback finds its company, and only its company, through the narrow lookup (#477)', { skip }, async () => {
  const h = harness();
  const d = await desk(h);
  await d.connect(KARNATAKA_GSTIN);
  const answered = await d.act(() => d.channel.call(d.owner, { operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-5'), idempotencyKey: 'SI-5', documentRef: 'SI-5' }));
  const made = await h.calls.find(d.companyId, answered.callId);
  assert.ok(made?.providerRequestId);
  // The lookup answers one uuid — the company that made the call — by our own correlation id,
  // and nothing at all for an id nobody made.
  assert.equal(await h.calls.companyForRequest('irp', made.correlationId), d.companyId);
  assert.equal(await h.calls.companyForRequest('irp', 'a-request-id-nobody-made'), null);
  // A provider request id that names exactly one company's call resolves on that connector; on
  // another connector's namespace the same text is nothing.
  const solo = `req-${randomBytes(6).toString('hex')}`;
  const soloCall = { ...made, id: crypto.randomUUID(), providerRequestId: solo, correlationId: `gsp-${solo}`, idempotencyKey: `key-${solo}` };
  await h.write(d.companyId, async () => h.calls.insert(soloCall));
  assert.equal(await h.calls.companyForRequest('irp', solo), d.companyId);
  assert.equal(await h.calls.companyForRequest('gst', solo), null);
  const other = await company();
  // Inside its own company the call is found; inside another's it is not.
  assert.equal((await h.calls.findByProviderRequestId('irp', d.companyId, solo))?.id, soloCall.id);
  assert.equal(await h.calls.findByProviderRequestId('irp', other.companyId, solo), null);
  assert.equal((await h.calls.findByCorrelationId(d.companyId, made.correlationId))?.id, made.id);
  assert.equal(await h.calls.findByCorrelationId(other.companyId, made.correlationId), null);
  // A request id that could name two companies' calls is ambiguous, so the lookup says nothing
  // rather than guess — a forged or colliding reference settles nobody's call.
  const clash = { ...made, id: crypto.randomUUID(), companyId: other.companyId, providerRequestId: solo, correlationId: `gsp-cl-${solo}`, idempotencyKey: `key-cl-${solo}` };
  await h.write(other.companyId, async () => h.calls.insert(clash));
  assert.equal(await h.calls.companyForRequest('irp', solo), null);
  // The correlation ids stay unique: each company's own call is still found by its own.
  assert.equal(await h.calls.companyForRequest('irp', `gsp-cl-${solo}`), other.companyId);
  // An ambiguous request id answers null outright: the same string being a correlation id
  // somewhere must not let the fallback settle that company's call instead.
  const boom = `boom-${randomBytes(6).toString('hex')}`;
  const named = (as: CompanyId, over: object) => ({ ...made, ...over, id: crypto.randomUUID(), companyId: as });
  await h.write(d.companyId, async () => h.calls.insert(named(d.companyId, { providerRequestId: boom, correlationId: `gsp-x1-${boom}`, idempotencyKey: `key-x1-${boom}` })));
  await h.write(other.companyId, async () => h.calls.insert(named(other.companyId, { providerRequestId: boom, correlationId: `gsp-x2-${boom}`, idempotencyKey: `key-x2-${boom}` })));
  await h.write(other.companyId, async () => h.calls.insert(named(other.companyId, { providerRequestId: `p-x3-${boom}`, correlationId: boom, idempotencyKey: `key-x3-${boom}` })));
  assert.equal(await h.calls.companyForRequest('irp', boom), null);
});

test('the company lookup can read a company id and nothing else (#477)', { skip }, async () => {
  const h = harness();
  const d = await desk(h);
  await d.connect(KARNATAKA_GSTIN);
  const answered = await d.act(() => d.channel.call(d.owner, { operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-6'), idempotencyKey: 'SI-6', documentRef: 'SI-6' }));
  const made = await h.calls.find(d.companyId, answered.callId);
  assert.ok(made?.providerRequestId);
  // The function hands the application role a uuid, never the row: with no tenant set on the
  // connection, row-level security still shows invoice_app no calls, even for the company the
  // lookup just named.
  const { rows } = await app.query(`SELECT government_call_company($1, $2::text[]) AS company`, [made.correlationId, '{EINVOICE_GENERATE}']);
  assert.equal(rows[0]?.company, d.companyId);
  const direct = await app.query(`SELECT count(*)::int AS n FROM government_calls WHERE company_id = government_call_company($1, $2::text[])`, [made.correlationId, '{EINVOICE_GENERATE}']);
  assert.equal(direct.rows[0]?.n, 0);
  // And the role the function runs as is granted only the four columns it matches on: it could
  // not be rewritten to leak a GST number, a payload or a credential.
  const privilege = async (column: string) =>
    (await owner.query(`SELECT has_column_privilege('invoice_work_finder', 'government_calls', $1, 'SELECT') AS yes`, [column])).rows[0]?.yes === true;
  for (const column of ['company_id', 'provider_request_id', 'correlation_id', 'scope']) assert.equal(await privilege(column), true, column);
  for (const column of ['id', 'seq', 'gstin', 'operation', 'document_ref', 'government_reference', 'error_message', 'credential_reference']) assert.equal(await privilege(column), false, column);
  // invoice_app may run it; PUBLIC may not. A null proacl would be the default — executable by
  // everyone — so the acl must exist and name only the granted roles.
  assert.equal((await owner.query(`SELECT has_function_privilege('invoice_app', 'government_call_company(text,text[])', 'EXECUTE') AS yes`)).rows[0]?.yes, true);
  const { rows: aclRows } = await owner.query(`SELECT proacl::text AS acl FROM pg_proc WHERE proname = 'government_call_company'`);
  const acl = String(aclRows[0]?.acl);
  assert.notEqual(acl, 'null');
  assert.equal(acl.includes('invoice_app=X'), true);
  assert.equal(acl.includes('PUBLIC'), false);
});

test('the migration runs down and up again', { skip }, async () => {
  const { gspMigrations } = await import('../src/migrations.ts');
  const mine = gspMigrations.at(-1)!;
  const { migrate } = await import('../../platform/src/migrations.ts');
  const { withScratchDatabase } = await import('../../platform/test/scratch-database.ts');
  await withScratchDatabase(owner, url as string, 'gsp_updown', async (scratch) => {
    await migrate(scratch);
    await scratch.query(mine.down);
    await scratch.query(mine.up);
    await scratch.query(mine.down);
    await scratch.query(mine.up);
  });
});
