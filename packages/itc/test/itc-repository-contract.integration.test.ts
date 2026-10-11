/**
 * Issue #366 — the purchase comparison's storage on a real PostgreSQL.
 *
 *  - The same contract suite the in-memory stores pass (itc-repository-contract.ts), connected as
 *    the application role so row-level security and the #368 freeze are really in force.
 *  - What only a database can show: a write outside a unit of work is refused, a rolled-back action
 *    leaves nothing, the database itself hides another company's rows, and a history row cannot be
 *    changed.
 *  - The real service on these repositories gives the same month as it does on the in-memory ones.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import { asId, fixedClock, type CompanyId, type UserId } from '@invoice/kernel';
import { InMemoryAuditPort, type ActorContext } from '@invoice/ledger';
import type { TransactionalExecutor } from '../../platform/src/database.ts';
import { InMemoryImportBatches, InMemoryItcClaims, InMemoryItcDecisions, InMemoryPortalRecords, InMemoryPurchaseBooks } from '../src/adapters.ts';
import { SUNRISE_BOOKS, SUNRISE_GSTR2B_FILE, SUNRISE_PERIOD } from '../src/fixtures.ts';
import type { ImportBatchRepository, ItcClaimRepository, ItcDecisionRepository, PortalRecordRepository } from '../src/ports.ts';
import { ItcReconciliationService } from '../src/service.ts';
import { ITC_PERMISSIONS } from '../src/types.ts';
import { JULY, batchOf, claimOf, decisionOf, documentOf, itcRepositoryContract, type ItcRepositoryHarness } from './itc-repository-contract.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the ITC repository database tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';
const login = `invoice_app_itc_${randomBytes(6).toString('hex')}`;

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let harness: ItcRepositoryHarness;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import('../../platform/src/database.ts');
  const { migrate } = await import('../../platform/src/migrations.ts');
  const { PostgresImportBatches, PostgresItcClaims, PostgresItcDecisions, PostgresPortalRecords } = await import('../src/postgres-repository.ts');
  owner = createDatabase(url);
  await migrate(owner);
  // What a deployment does once: a login for the server, with nothing but membership of invoice_app.
  const password = randomBytes(18).toString('hex');
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  const appUrl = new URL(url);
  appUrl.username = login;
  appUrl.password = password;
  app = createDatabase(appUrl.toString());
  harness = {
    records: new PostgresPortalRecords(app),
    batches: new PostgresImportBatches(app),
    decisions: new PostgresItcDecisions(app),
    claims: new PostgresItcClaims(app),
    // The owner only sets the scene; everything under test runs as the application role.
    company: async () => {
      const id = crypto.randomUUID();
      await owner.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic ITC Traders')", [id]);
      return id as CompanyId;
    },
    user: async () => {
      const id = crypto.randomUUID();
      await owner.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Synthetic person')", [id, `itc-${id}@example.invalid`]);
      return id as UserId;
    },
    write: (companyId, work) => app.unitOfWork(companyId, () => work()),
  };
});
after(async () => {
  await app?.close();
  if (owner !== undefined) { await owner.query(`DROP ROLE IF EXISTS ${login}`); await owner.close(); }
});

itcRepositoryContract('postgres as the application role', () => harness, skip);

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
const scene = async () => ({ companyId: await harness.company(), userId: await harness.user() });
const TABLES = ['itc_import_batches', 'itc_portal_documents', 'itc_decisions', 'itc_claims'] as const;
const counts = async (companyId: CompanyId): Promise<number[]> =>
  Promise.all(TABLES.map(async (table) => Number((await owner.query(`SELECT count(*)::int AS n FROM ${table} WHERE company_id = $1`, [companyId])).rows[0]?.n)));

test('a write outside a unit of work is refused, and saves nothing', { skip }, async () => {
  const { companyId, userId } = await scene();
  const batch = batchOf(companyId, userId);
  await assert.rejects(harness.batches.insert(batch), code('NO_UNIT_OF_WORK'));
  await assert.rejects(harness.records.put(companyId, JULY, [documentOf(batch, 0)]), code('NO_UNIT_OF_WORK'));
  await assert.rejects(harness.records.put(companyId, JULY, []), code('NO_UNIT_OF_WORK'));
  await assert.rejects(harness.decisions.insert(decisionOf(companyId, userId)), code('NO_UNIT_OF_WORK'));
  await assert.rejects(harness.claims.insert(claimOf(companyId, userId)), code('NO_UNIT_OF_WORK'));
  // Nor inside another company's action.
  const other = await scene();
  await assert.rejects(app.unitOfWork(other.companyId, () => harness.decisions.insert(decisionOf(companyId, userId))), code('TENANT_ISOLATION'));
  assert.deepEqual(await counts(companyId), [0, 0, 0, 0]);
});

test('an action that fails after writing leaves nothing behind', { skip }, async () => {
  const { companyId, userId } = await scene();
  const batch = batchOf(companyId, userId);
  await assert.rejects(app.unitOfWork(companyId, async () => {
    await harness.records.put(companyId, JULY, [documentOf(batch, 0), documentOf(batch, 1)]);
    await harness.batches.insert(batch);
    await harness.decisions.insert(decisionOf(companyId, userId));
    await harness.claims.insert(claimOf(companyId, userId));
    // The action's own writes are visible to it before it ends.
    assert.equal((await harness.records.listForPeriod(companyId, JULY)).length, 2);
    throw new Error('the power went out');
  }), /the power went out/);
  assert.deepEqual(await counts(companyId), [0, 0, 0, 0]);
  assert.deepEqual(await harness.records.listForPeriod(companyId, JULY), []);
  assert.equal(await harness.batches.latestFor(companyId, JULY), null);
});

test('portal rows saved without their import batch are refused when the action ends', { skip }, async () => {
  const { companyId, userId } = await scene();
  const batch = batchOf(companyId, userId);
  await assert.rejects(app.unitOfWork(companyId, () => harness.records.put(companyId, JULY, [documentOf(batch, 0)])), code('23503'));
  assert.deepEqual(await counts(companyId), [0, 0, 0, 0]);
});

test('the database itself keeps one company out of another\'s rows, and keeps the histories as written', { skip }, async () => {
  const a = await scene();
  const b = await scene();
  const batch = batchOf(a.companyId, a.userId);
  const decision = decisionOf(a.companyId, a.userId);
  const claim = claimOf(a.companyId, a.userId);
  await app.unitOfWork(a.companyId, async () => {
    await harness.records.put(a.companyId, JULY, [documentOf(batch, 0)]);
    await harness.batches.insert(batch);
    await harness.decisions.insert(decision);
    await harness.claims.insert(claim);
  });

  for (const table of TABLES) {
    // A query that forgot its company filter, run for company B: row-level security answers for it.
    const seen = await app.tenantTransaction(b.companyId, (sql) => sql.query(`SELECT count(*)::int AS n FROM ${table}`));
    assert.equal(seen.rows[0]?.n, 0, `${table} hides company A from company B`);
    // And with no company at all, nothing.
    assert.equal((await app.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n, 0, `${table} shows nothing without a company`);
  }
  // Company B cannot write a row that says it belongs to company A.
  await assert.rejects(
    app.unitOfWork(b.companyId, (uow) => uow.sql.query(
      `INSERT INTO itc_claims (id, company_id, source_kind, source_id, period, outcome, line_key, fingerprint, claimed_by)
       VALUES ($1, $2, 'purchase_bill', 'bill-x', '2026-07', 'CLAIM_NOW', 'k', 'f', $3)`,
      [crypto.randomUUID(), a.companyId, b.userId],
    )),
    code('42501'),
  );

  // #368: a change of mind is a new row. The application can neither rewrite nor remove an old one.
  for (const [table, id, column] of [['itc_decisions', decision.id, 'reason'], ['itc_claims', claim.id, 'fingerprint'], ['itc_import_batches', batch.id, 'checksum']] as const) {
    await assert.rejects(app.unitOfWork(a.companyId, (uow) => uow.sql.query(`UPDATE ${table} SET ${column} = 'rewritten' WHERE company_id = $1 AND id = $2`, [a.companyId, id])), code('23001'), `${table} cannot be rewritten`);
    await assert.rejects(app.unitOfWork(a.companyId, (uow) => uow.sql.query(`DELETE FROM ${table} WHERE company_id = $1 AND id = $2`, [a.companyId, id])), code('42501'), `${table} cannot be deleted from`);
  }
  await assert.rejects(app.unitOfWork(a.companyId, (uow) => uow.sql.query('DELETE FROM itc_portal_documents WHERE company_id = $1', [a.companyId])), code('42501'));
  assert.deepEqual(await harness.decisions.history(a.companyId, decision.lineKey), [decision]);
  assert.deepEqual(await harness.claims.listForCompany(a.companyId), [claim]);
  assert.deepEqual(await harness.batches.list(a.companyId, JULY), [batch]);
});

test('the service gives the same month on PostgreSQL as it does in memory: import, re-import, decide, claim', { skip }, async () => {
  const { companyId, userId } = await scene();
  const actor: ActorContext = { companyId, branchId: asId<'Branch'>('main'), userId, permissions: Object.values(ITC_PERMISSIONS) };
  const ids = Array.from({ length: 40 }, () => crypto.randomUUID());
  const desk = (stores: { records: PortalRecordRepository; batches: ImportBatchRepository; decisions: ItcDecisionRepository; claims: ItcClaimRepository }, run: <T>(work: () => Promise<T>) => Promise<T>) => {
    const books = new InMemoryPurchaseBooks();
    books.add(...SUNRISE_BOOKS.map((book) => ({ ...book, companyId })));
    let next = 0;
    const service = new ItcReconciliationService({ ...stores, books, audit: new InMemoryAuditPort(), clock: fixedClock('2026-08-14T10:00:00.000Z'), idFactory: () => ids[next++] as string });
    return async () => {
      // Each command is one unit of work, which is what #340 will wrap it in.
      const first = await run(() => service.importFile(actor, { period: SUNRISE_PERIOD, content: SUNRISE_GSTR2B_FILE, fileName: 'GSTR2B_072026.json' }));
      const again = await run(() => service.importFile(actor, { period: SUNRISE_PERIOD, content: SUNRISE_GSTR2B_FILE }));
      const opened = await service.workspace(actor, SUNRISE_PERIOD);
      const held = opened.lines.find((line) => line.outcome !== 'CLAIM_NOW' && line.book !== null);
      assert.ok(held !== undefined, 'the sample month has a bill that is held back');
      const input = { period: SUNRISE_PERIOD, lineKey: held.key, kind: 'PENDING' as const, reason: 'Waiting on the supplier to file.' };
      const decided = await run(() => service.decide(actor, { ...input, idempotencyKey: 'pending-1' }));
      const retried = await run(() => service.decide(actor, { ...input, idempotencyKey: 'pending-1' }));
      const claims = await run(() => service.claimPeriod(actor, SUNRISE_PERIOD));
      const claimedAgain = await run(() => service.claimPeriod(actor, SUNRISE_PERIOD));
      return {
        first, again, opened, decided, retried, claims, claimedAgain,
        imports: await service.imports(actor, SUNRISE_PERIOD),
        history: await service.decisionHistory(actor, held.key),
        workspace: await service.workspace(actor, SUNRISE_PERIOD),
      };
    };
  };
  const memory = await desk({ records: new InMemoryPortalRecords(), batches: new InMemoryImportBatches(), decisions: new InMemoryItcDecisions(), claims: new InMemoryItcClaims() }, (work) => work())();
  const postgres = await desk(harness, (work) => app.unitOfWork(companyId, () => work()))();

  assert.ok(memory.claims.length > 0 && memory.history.length === 1 && memory.imports.length === 1, 'the scenario exercised every store');
  assert.deepEqual(postgres, memory);
  assert.deepEqual(postgres.again, postgres.first, 'the same file a second time is the first import, not a second one');
  assert.deepEqual(postgres.claimedAgain, postgres.claims, 'claiming a month twice claims each bill once');
});
