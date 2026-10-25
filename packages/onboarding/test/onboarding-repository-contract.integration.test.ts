/**
 * Issue #366 — where a setup is kept, on a real PostgreSQL.
 *
 *  - The same contract suite the in-memory repository passes, connected as the application role so
 *    row-level security and the #368 freeze are really in force.
 *  - What only a database can show: a write outside a unit of work is refused, the database hides
 *    another company's setup, holds one open setup per business and a known state for every step,
 *    and a finished setup cannot be changed.
 *  - A setup started before a restart is finished after it, on a new connection pool.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import { asId, fixedClock, isoDate, rupees, toDecimalString, type CompanyId, type UserId } from '@invoice/kernel';
import { buildDefaultChart, LedgerService, PostgresLedgerStore, permissionPortFromActor, trialBalance, type ActorContext } from '@invoice/ledger';
import type { TransactionalExecutor } from '../../platform/src/database.ts';
import { PostgresAuditLog } from '../../platform/src/postgres-audit.ts';
import { OnboardingService } from '../src/service.ts';
import { PostgresOnboardingRepository } from '../src/postgres-repository.ts';
import { onboardingRepositoryContract, sessionOf, type OnboardingRepositoryHarness } from './onboarding-repository-contract.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the onboarding database tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';
const login = `invoice_app_onb_${randomBytes(6).toString('hex')}`;

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let appUrl: string;
let harness: OnboardingRepositoryHarness;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import('../../platform/src/database.ts');
  const { migrate } = await import('../../platform/src/migrations.ts');
  owner = createDatabase(url);
  await migrate(owner);
  const password = randomBytes(18).toString('hex');
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  const parsed = new URL(url);
  parsed.username = login;
  parsed.password = password;
  appUrl = parsed.toString();
  app = createDatabase(appUrl);
  harness = {
    repository: new PostgresOnboardingRepository(app),
    // The owner only sets the scene; everything under test runs as the application role.
    company: async () => {
      const id = crypto.randomUUID();
      await owner.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Setup Traders')", [id]);
      return id as CompanyId;
    },
    user: async () => {
      const id = crypto.randomUUID();
      await owner.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Synthetic person')", [id, `onboarding-${id}@example.invalid`]);
      return id as UserId;
    },
    write: (companyId, work) => app.unitOfWork(companyId, () => work()),
  };
});
after(async () => {
  await app?.close();
  if (owner !== undefined) { await owner.query(`DROP ROLE IF EXISTS ${login}`); await owner.close(); }
});

onboardingRepositoryContract('postgres as the application role', () => harness, skip);

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
const scene = async () => ({ companyId: await harness.company(), userId: await harness.user() });
const rows = async (companyId: CompanyId): Promise<number> =>
  Number((await owner.query('SELECT count(*)::int AS n FROM onboarding_sessions WHERE company_id = $1', [companyId])).rows[0]?.n);

test('a write outside a unit of work, or inside another company\'s, is refused and saves nothing', { skip }, async () => {
  const { companyId, userId } = await scene();
  const session = sessionOf(companyId, userId);
  await assert.rejects(harness.repository.insert(session, 'k'), code('NO_UNIT_OF_WORK'));
  const other = await scene();
  await assert.rejects(app.unitOfWork(other.companyId, () => harness.repository.insert(session, 'k')), code('TENANT_ISOLATION'));
  assert.equal(await rows(companyId), 0);
});

test('the database itself keeps one business out of another\'s setup', { skip }, async () => {
  const a = await scene();
  const b = await scene();
  await harness.write(a.companyId, () => harness.repository.insert(sessionOf(a.companyId, a.userId), 'k'));
  // A query that forgot its company filter, run for company B: row-level security answers for it.
  assert.equal((await app.tenantTransaction(b.companyId, (sql) => sql.query('SELECT count(*)::int AS n FROM onboarding_sessions'))).rows[0]?.n, 0);
  assert.equal((await app.query('SELECT count(*)::int AS n FROM onboarding_sessions')).rows[0]?.n, 0, 'nothing without a company');
  // Company B cannot write a row that says it belongs to company A.
  await assert.rejects(app.unitOfWork(b.companyId, (uow) => uow.sql.query(
    `INSERT INTO onboarding_sessions (id, company_id, idempotency_key, state, steps, answers, created_by, created_at, updated_at, version)
     VALUES ($1, $2, 'x', 'IN_PROGRESS', $3::jsonb, '{}', $4, now(), now(), 1)`,
    [crypto.randomUUID(), a.companyId, JSON.stringify(sessionOf(a.companyId, a.userId).steps), a.userId],
  )), code('42501'));
});

test('one setup in progress per business, and a step state the service knows, held by the database', { skip }, async () => {
  const { companyId, userId } = await scene();
  await harness.write(companyId, () => harness.repository.insert(sessionOf(companyId, userId), 'first'));
  // Two servers starting setup at once: the second is the same refusal as a repeated key.
  await assert.rejects(harness.write(companyId, () => harness.repository.insert(sessionOf(companyId, userId), 'second')), code('ONBOARDING_ALREADY_STARTED'));
  const odd = sessionOf(companyId, userId, { state: 'COMPLETED' });
  await assert.rejects(harness.write(companyId, () => harness.repository.insert({ ...odd, steps: { ...odd.steps, rates: { state: 'MAYBE' as never, problems: [], completedAt: null } } }, 'odd')), code('23514'));
  const { rates: _dropped, ...missing } = odd.steps;
  await assert.rejects(harness.write(companyId, () => harness.repository.insert({ ...odd, steps: missing as never }, 'odd')), code('23514'));
  await assert.rejects(harness.write(companyId, () => harness.repository.insert({ ...odd, state: 'ABANDONED' as never }, 'odd')), code('23514'));
  assert.equal(await rows(companyId), 1);
});

test('a finished setup cannot be changed or removed, even by hand', { skip }, async () => {
  const { companyId, userId } = await scene();
  const session = sessionOf(companyId, userId);
  await harness.write(companyId, () => harness.repository.insert(session, 'k'));
  await harness.write(companyId, () => harness.repository.update({ ...session, state: 'COMPLETED', version: 2 }, 1));
  await assert.rejects(harness.write(companyId, () => harness.repository.update({ ...session, state: 'IN_PROGRESS', version: 3 }, 2)), code('23001'));
  await assert.rejects(app.unitOfWork(companyId, (uow) => uow.sql.query("UPDATE onboarding_sessions SET answers = '{}' WHERE company_id = $1", [companyId])), code('23001'));
  await assert.rejects(app.unitOfWork(companyId, (uow) => uow.sql.query('DELETE FROM onboarding_sessions WHERE company_id = $1', [companyId])), code('42501'));
  await assert.rejects(owner.query('DELETE FROM onboarding_sessions WHERE company_id = $1', [companyId]), code('23001'));
});

test('a setup started before a restart is finished after it, on a new connection pool', { skip }, async () => {
  const { createDatabase } = await import('../../platform/src/database.ts');
  const { companyId, userId } = await scene();
  const actor: ActorContext = { companyId, branchId: asId<'Branch'>('main'), userId, permissions: ['ledger.setup', 'ledger.post.opening_balance', 'onboarding.run', 'onboarding.finish'] };
  const desk = (db: TransactionalExecutor) => {
    const store = new PostgresLedgerStore(db);
    const audit = new PostgresAuditLog(db);
    const clock = fixedClock('2026-08-29T09:00:00.000Z');
    const idFactory = () => crypto.randomUUID();
    const ledger = new LedgerService({ store, permissions: permissionPortFromActor, audit, clock, idFactory });
    return { store, ledger, service: new OnboardingService({ store, ledger, repository: new PostgresOnboardingRepository(db), permissions: permissionPortFromActor, audit, clock, idFactory }) };
  };

  // Before: the books are opened and three steps saved, then the server goes away.
  const before = createDatabase(appUrl);
  let startedId: string;
  try {
    const { ledger, service } = desk(before);
    const ids = new Map<string, string>();
    await before.unitOfWork(companyId, () => ledger.initialiseCompany(actor, {
      booksStartDate: isoDate('2026-04-01'),
      accounts: buildDefaultChart(companyId, (code) => asId<'Account'>(ids.get(code) ?? ids.set(code, crypto.randomUUID()).get(code)!)),
    }));
    let session = await service.start(actor, { idempotencyKey: 'start' });
    startedId = session.id;
    session = await service.saveStep(actor, session.id, 'business', { business: { legalName: 'Meera Bakers', businessType: 'BAKERY', stateCode: '08' } }, session.version);
    session = await service.saveStep(actor, session.id, 'tax_profile', { taxProfile: { registration: 'UNREGISTERED', gstin: null, booksStartDate: isoDate('2026-04-01') } }, session.version);
    await service.saveStep(actor, session.id, 'items', { items: [{ itemId: 'CAKE', name: 'Chocolate cake', kind: 'GOODS', baseUnit: 'PCS', hsnOrSac: '1905' }] }, session.version);
  } finally {
    await before.close();
  }

  // After: a new pool, a new service. She picks up where she was and finishes.
  const afterwards = createDatabase(appUrl);
  try {
    const { store, service } = desk(afterwards);
    let session = await service.resume(actor);
    assert.equal(session?.id, startedId);
    assert.equal(session?.steps.items.state, 'DONE');
    assert.equal(session?.answers.business.legalName, 'Meera Bakers');
    assert.equal((await service.start(actor, { idempotencyKey: 'start-again' })).id, startedId, 'starting again hands back the same setup');
    session = await service.skipStep(actor, startedId, 'branding', 'Later.');
    session = await service.skipStep(actor, startedId, 'rates', 'Later.');
    session = await service.saveStep(actor, startedId, 'opening_balances', { openingBalances: [
      { accountCode: '1110', label: 'Cash in the till', debit: rupees(8000), credit: rupees(0) },
      { accountCode: '3100', label: 'My own money', debit: rupees(0), credit: rupees(8000) },
    ] }, session.version);
    // Finishing is one action, as the app runs it: the opening entry and the finished setup commit together.
    const finished = await afterwards.unitOfWork(companyId, () => service.finish(actor, startedId, { idempotencyKey: 'finish' }));
    const again = await afterwards.unitOfWork(companyId, () => service.finish(actor, startedId, { idempotencyKey: 'finish' }));
    assert.equal(finished.session.state, 'COMPLETED');
    assert.ok(finished.openingVoucherId !== null);
    assert.equal(again.openingVoucherId, finished.openingVoucherId, 'finishing twice posts one opening entry');
    const tb = await trialBalance(store.read(), companyId);
    assert.ok(tb.balanced);
    assert.equal(toDecimalString(tb.totalDebit), '8000.00');
    const trail = (await owner.query("SELECT action FROM audit_events WHERE company_id = $1 AND action LIKE 'onboarding.%' ORDER BY seq", [companyId])).rows.map((r) => r.action);
    assert.deepEqual(trail, ['onboarding.started', 'onboarding.finished']);
  } finally {
    await afterwards.close();
  }
});
