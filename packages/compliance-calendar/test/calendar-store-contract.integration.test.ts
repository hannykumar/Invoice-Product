/**
 * Issue #366 — the compliance calendar store contract on a real PostgreSQL, connected as the
 * application role so row-level security is really in force. The owner only sets the scene.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import type { CompanyId, UserId } from '@invoice/kernel';
import type { TransactionalExecutor } from '../../platform/src/database.ts';
import { bilingual } from '../src/types.ts';
import { calendarStoreContract, occurrenceFor, type CalendarStoreHarness } from './calendar-store-contract.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the compliance calendar database tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let harness: CalendarStoreHarness;
const login = `invoice_app_test_${randomBytes(6).toString('hex')}`;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import('../../platform/src/database.ts');
  const { migrate } = await import('../../platform/src/migrations.ts');
  const { PostgresAlerts, PostgresComplianceExceptions, PostgresOccurrences } = await import('../src/postgres.ts');
  owner = createDatabase(url);
  await migrate(owner);
  const password = randomBytes(18).toString('hex');
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  const appUrl = new URL(url);
  appUrl.username = login;
  appUrl.password = password;
  app = createDatabase(appUrl.toString());
  harness = {
    occurrences: new PostgresOccurrences(app),
    alerts: new PostgresAlerts(app),
    exceptions: new PostgresComplianceExceptions(app),
    write: (companyId, work) => app.unitOfWork(companyId, () => work()),
    company: async () => {
      const id = crypto.randomUUID();
      await owner.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Calendar Traders')", [id]);
      return id as CompanyId;
    },
    user: async () => {
      const id = crypto.randomUUID();
      await owner.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Synthetic person')", [id, `calendar-${id}@example.invalid`]);
      return id as UserId;
    },
  };
});
after(async () => {
  await app?.close();
  if (owner !== undefined) { await owner.query(`DROP ROLE IF EXISTS ${login}`); await owner.close(); }
});

calendarStoreContract('postgres', () => harness, skip);

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

test('postgres: a write outside a unit of work throws instead of committing on its own', { skip }, async () => {
  const companyId = await harness.company();
  const userId = await harness.user();
  const occurrence = occurrenceFor(companyId, userId, '2026-07');
  await assert.rejects(harness.occurrences.put(occurrence), code('NO_UNIT_OF_WORK'));
  await assert.rejects(harness.exceptions.put({ companyId, code: 'GSTR1', periodKey: '2026-07', missing: [], question: bilingual('q', 'q'), raisedAt: occurrence.createdAt }), code('NO_UNIT_OF_WORK'));
  await assert.rejects(harness.exceptions.clear(companyId, 'GSTR1', '2026-07'), code('NO_UNIT_OF_WORK'));
  assert.equal(await harness.occurrences.find(companyId, occurrence.key), null);
});

test('postgres: a rolled-back unit of work leaves nothing behind', { skip }, async () => {
  const companyId = await harness.company();
  const userId = await harness.user();
  const occurrence = occurrenceFor(companyId, userId, '2026-07', {
    revisions: [{ at: '2026-08-18T00:00:00.000Z', previousDueDate: '2026-08-19' as never, dueDate: '2026-08-20' as never, previousVersion: 1, version: 1, reason: bilingual('r', 'r'), sourceRef: null }],
  });
  await assert.rejects(app.unitOfWork(companyId, async () => {
    await harness.occurrences.put(occurrence);
    await harness.exceptions.put({ companyId, code: 'GSTR1', periodKey: '2026-07', missing: [], question: bilingual('q', 'q'), raisedAt: occurrence.createdAt });
    throw new Error('the till lost power');
  }), /the till lost power/);
  assert.equal(await harness.occurrences.find(companyId, occurrence.key), null);
  assert.deepEqual(await harness.exceptions.list(companyId), []);
  const left = await owner.query('SELECT count(*)::int AS n FROM compliance_deadline_revisions WHERE company_id = $1', [companyId]);
  assert.equal(left.rows[0]?.n, 0);
});

test('postgres: row-level security hides and refuses another company’s rows even without a company filter', { skip }, async () => {
  const a = await harness.company();
  const b = await harness.company();
  const userId = await harness.user();
  await harness.write(b, () => harness.occurrences.put(occurrenceFor(b, userId, '2026-07')));
  const seen = await app.tenantTransaction(a, (sql) => sql.query('SELECT count(*)::int AS n FROM compliance_occurrences'));
  assert.equal(seen.rows[0]?.n, 0);
  // Company B's row written inside company A's unit of work is refused by the policy.
  await assert.rejects(app.unitOfWork(a, () => harness.occurrences.put(occurrenceFor(b, userId, '2026-08'))), code('TENANT_ISOLATION'));
  await assert.rejects(app.unitOfWork(a, (uow) => uow.sql.query(
    "INSERT INTO compliance_calendar_exceptions (id, company_id, code, period_key, missing_facts, missing, question) VALUES (gen_random_uuid(), $1, 'GSTR1', '2026-07', '{}', '[]', '{}')", [b],
  )), code('42501'));
});

test('postgres: an id reused for a different obligation is a conflict, and an alert needs its occurrence', { skip }, async () => {
  const companyId = await harness.company();
  const userId = await harness.user();
  const july = occurrenceFor(companyId, userId, '2026-07');
  await harness.write(companyId, () => harness.occurrences.put(july));
  await assert.rejects(harness.write(companyId, () => harness.occurrences.put(occurrenceFor(companyId, userId, '2026-08', { id: july.id }))), code('COMPLIANCE_RECORD_CONFLICT'));
  const orphan = (await harness.alerts.listForCompany(companyId)).length;
  assert.equal(orphan, 0);
  const lonely = occurrenceFor(companyId, userId, '2026-09');
  await assert.rejects(harness.write(companyId, () => harness.alerts.insert({
    id: crypto.randomUUID(), companyId, occurrenceKey: lonely.key, code: 'GSTR3B', obligationKind: 'STATUTORY', version: 1, reviewState: 'DRAFT',
    sourceRef: null, level: 'EARLY', audiences: ['ACCOUNTANT'], dueDate: lonely.dueDate, daysRemaining: 3, period: lonely.period,
    headline: bilingual('h', 'h'), detail: bilingual('d', 'd'), nextAction: bilingual('n', 'n'), actionCode: 'X', consequence: bilingual('c', 'c'),
    signals: [], affected: [], deduplicationKey: 'k', raisedAt: lonely.createdAt, raisedBy: userId,
  })), code('COMPLIANCE_OCCURRENCE_NOT_FOUND'));
});
