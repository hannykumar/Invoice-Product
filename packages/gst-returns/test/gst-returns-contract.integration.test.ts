/**
 * Issue #366 — the return workspace's storage on a real PostgreSQL.
 *
 *  - The same contract suite the in-memory stores pass (gst-returns-contract.ts), run as a login
 *    that is only a member of `invoice_app`, so row-level security and the freeze rules of #368
 *    are really in force.
 *  - What only a database can show: a write outside a unit of work is refused, a rolled-back
 *    action leaves nothing, the approval and attempt history is kept, and the frozen figures of an
 *    approved return stay frozen through the repository.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import { isoDate, type CompanyId, type UserId } from '@invoice/kernel';
import type { TransactionalExecutor } from '../../platform/src/database.ts';
import type { PostgresDeclaredThresholds, PostgresReturnPreparations } from '../src/postgres-repository.ts';
import { B2clThresholdTable } from '../src/thresholds.ts';
import { SUNRISE_PERIOD } from '../src/fixtures.ts';
import type { ReturnPreparation } from '../src/types.ts';
import { gstReturnContract, samplePreparation, type GstReturnHarness } from './gst-returns-contract.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the GST return database tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let preparations: PostgresReturnPreparations;
let thresholds: PostgresDeclaredThresholds;
let harness: GstReturnHarness;
const login = `invoice_app_test_${randomBytes(6).toString('hex')}`;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import('../../platform/src/database.ts');
  const { migrate } = await import('../../platform/src/migrations.ts');
  const repositories = await import('../src/postgres-repository.ts');
  owner = createDatabase(url);
  await migrate(owner);
  const password = randomBytes(18).toString('hex');
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  const appUrl = new URL(url);
  appUrl.username = login;
  appUrl.password = password;
  app = createDatabase(appUrl.toString());
  preparations = new repositories.PostgresReturnPreparations(app);
  thresholds = new repositories.PostgresDeclaredThresholds(app);
  harness = {
    preparations, thresholds,
    // The owner only sets the scene; everything under test runs as the application role.
    company: async () => {
      const id = crypto.randomUUID();
      await owner.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Return Traders')", [id]);
      return id as CompanyId;
    },
    user: async () => {
      const id = crypto.randomUUID();
      await owner.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Synthetic preparer')", [id, `gst-returns-${id}@example.invalid`]);
      return id as UserId;
    },
    write: (companyId, work) => app.unitOfWork(companyId, () => work()),
  };
});
after(async () => {
  await app?.close();
  if (owner !== undefined) { await owner.query(`DROP ROLE IF EXISTS ${login}`); await owner.close(); }
});

gstReturnContract('postgres as the application role', () => harness, skip);

const code = (...expected: string[]) => (error: unknown) => expected.includes((error as { code?: string }).code ?? '');
const scene = async () => {
  const companyId = await harness.company();
  const userId = await harness.user();
  return { companyId, userId, first: samplePreparation(companyId, userId) };
};
const approvedFrom = (draft: ReturnPreparation, userId: UserId): ReturnPreparation => ({
  ...draft, state: 'APPROVED', version: draft.version + 1,
  approval: { approvedBy: userId, approvedAt: '2026-08-12T04:00:00.000Z', fingerprint: draft.snapshot.fingerprint, note: null },
});

test('postgres: a write outside a unit of work is refused and saves nothing', { skip }, async () => {
  const { companyId, userId, first } = await scene();
  await assert.rejects(preparations.insert(first), code('NO_UNIT_OF_WORK'));
  await assert.rejects(preparations.update(first, 1), code('NO_UNIT_OF_WORK'));
  await assert.rejects(thresholds.declare({
    companyId, aboveValue: { currency: 'INR', minor: 10_000_000n }, effectiveFrom: isoDate('2026-04-01'), effectiveTo: null,
    declaredBy: userId, declaredOn: isoDate('2026-08-11'), basis: 'Our accountant.',
  }), code('NO_UNIT_OF_WORK'));
  assert.deepEqual(await preparations.list(companyId), []);
  assert.deepEqual(await thresholds.list(companyId), []);
});

test('postgres: a rolled-back action leaves no return, no approval and no threshold', { skip }, async () => {
  const { companyId, userId, first } = await scene();
  await assert.rejects(app.unitOfWork(companyId, async () => {
    await preparations.insert(first);
    await preparations.update(approvedFrom(first, userId), 1);
    await thresholds.declare({
      companyId, aboveValue: { currency: 'INR', minor: 10_000_000n }, effectiveFrom: isoDate('2026-04-01'), effectiveTo: null,
      declaredBy: userId, declaredOn: isoDate('2026-08-11'), basis: 'Our accountant.',
    });
    assert.equal((await preparations.find(companyId, SUNRISE_PERIOD, 'GSTR1'))?.state, 'APPROVED', 'the action reads its own writes');
    throw new Error('the action failed after writing');
  }), /the action failed after writing/);
  assert.deepEqual(await preparations.list(companyId), []);
  assert.deepEqual(await thresholds.list(companyId), []);
  const { rows } = await owner.query('SELECT count(*)::int AS n FROM gst_return_approvals WHERE preparation_id = $1', [first.id]);
  assert.equal(rows[0]?.n, 0);
});

test('postgres: an approved return keeps its figures, and an approval is withdrawn by a named person, never removed', { skip }, async () => {
  const { companyId, userId, first } = await scene();
  const approved = approvedFrom(first, userId);
  await app.unitOfWork(companyId, async () => { await preparations.insert(first); await preparations.update(approved, 1); });

  // The frozen figures: the database refuses, whatever the repository was handed (SQLSTATE 23001).
  const tampered: ReturnPreparation = { ...approved, snapshot: { ...approved.snapshot, fingerprint: 'another', documentCount: 0, documents: [] }, version: 3 };
  await assert.rejects(app.unitOfWork(companyId, () => preparations.update(tampered, 2)), code('23001'));
  // Taking the approval back without saying who and why is refused, and the approval stays.
  const reopened: ReturnPreparation = { ...approved, state: 'DRAFT', approval: null, version: 3 };
  await assert.rejects(app.unitOfWork(companyId, () => preparations.update(reopened, 2)), code('GST_RETURN_WITHDRAWAL_UNATTRIBUTED'));
  assert.deepEqual(await preparations.find(companyId, SUNRISE_PERIOD, 'GSTR1'), approved);

  await app.unitOfWork(companyId, () => preparations.update(reopened, 2, { withdrawal: { by: userId, reason: 'A July bill turned up in August.' } }));
  const again: ReturnPreparation = { ...approvedFrom(reopened, userId), approval: { approvedBy: userId, approvedAt: '2026-08-13T04:00:00.000Z', fingerprint: first.snapshot.fingerprint, note: 'Second look.' } };
  await app.unitOfWork(companyId, () => preparations.update(again, 3));
  assert.deepEqual(await preparations.find(companyId, SUNRISE_PERIOD, 'GSTR1'), again);

  const history = await owner.query(
    'SELECT withdrawn_by, withdrawn_reason, note FROM gst_return_approvals WHERE preparation_id = $1 ORDER BY approved_at', [first.id]);
  assert.deepEqual(history.rows, [
    { withdrawn_by: userId, withdrawn_reason: 'A July bill turned up in August.', note: null },
    { withdrawn_by: null, withdrawn_reason: null, note: 'Second look.' },
  ]);
});

test('postgres: earlier submission attempts are set aside, not deleted, and an accepted one is final', { skip }, async () => {
  const { companyId, userId, first } = await scene();
  const approved = approvedFrom(first, userId);
  const attempt = { provider: 'synthetic-gsp', idempotencyKey: `gstr:GSTR1:${crypto.randomUUID()}` };
  const failed: ReturnPreparation = {
    ...approved, state: 'SUBMISSION_FAILED', version: 4,
    submission: { reference: null, attemptedAt: '2026-08-12T05:00:00.000Z', outcome: 'REJECTED', message: 'Refused.', errors: [{ code: 'RET191113', detail: 'Invalid GSTIN' }] },
  };
  await app.unitOfWork(companyId, async () => {
    await preparations.insert(first);
    await preparations.update(approved, 1);
    await preparations.update({ ...approved, state: 'SUBMITTING', version: 3 }, 2);
    await preparations.update(failed, 3, { attempt });
  });
  assert.deepEqual(await preparations.find(companyId, SUNRISE_PERIOD, 'GSTR1'), failed);

  // Reopened, prepared again (no submission on the return), approved and filed under a new key.
  const second = { provider: 'synthetic-gsp', idempotencyKey: `gstr:GSTR1:${crypto.randomUUID()}` };
  const draft: ReturnPreparation = { ...failed, state: 'DRAFT', approval: null, submission: null, version: 6 };
  const filed: ReturnPreparation = {
    ...approvedFrom(draft, userId), state: 'FILED', version: 9,
    submission: { reference: 'ARN-SYNTHETIC-1', attemptedAt: '2026-08-13T05:00:00.000Z', outcome: 'ACCEPTED', message: 'Filed.', errors: [] },
  };
  await app.unitOfWork(companyId, async () => {
    await preparations.update({ ...failed, state: 'DRAFT', approval: null, version: 5 }, 4, { withdrawal: { by: userId, reason: 'Wrong GSTIN on a bill.' } });
    await preparations.update(draft, 5);
    await preparations.update({ ...approvedFrom(draft, userId), version: 7 }, 6);
    await preparations.update({ ...approvedFrom(draft, userId), state: 'SUBMITTING', version: 8 }, 7);
    await preparations.update(filed, 8, { attempt: second });
  });
  assert.deepEqual(await preparations.find(companyId, SUNRISE_PERIOD, 'GSTR1'), filed);
  const attempts = await owner.query(
    'SELECT outcome, superseded_at IS NOT NULL AS set_aside FROM gst_return_submissions WHERE preparation_id = $1 ORDER BY attempted_at', [first.id]);
  assert.deepEqual(attempts.rows, [{ outcome: 'REJECTED', set_aside: true }, { outcome: 'ACCEPTED', set_aside: false }]);

  // A filed return does not go back, and its accepted attempt cannot be set aside.
  await assert.rejects(app.unitOfWork(companyId, () => preparations.update({ ...filed, state: 'DRAFT', approval: null, version: 10 }, 9, { withdrawal: { by: userId, reason: 'no' } })), code('23001'));
  await assert.rejects(app.unitOfWork(companyId, () => preparations.update({ ...filed, submission: null, version: 10 }, 9)), code('23001'));
  assert.deepEqual(await preparations.find(companyId, SUNRISE_PERIOD, 'GSTR1'), filed);
});

test("postgres: the application role cannot reach another company's approvals or attempts, even by id", { skip }, async () => {
  const { companyId, userId, first } = await scene();
  const other = await harness.company();
  await app.unitOfWork(companyId, async () => { await preparations.insert(first); await preparations.update(approvedFrom(first, userId), 1); });
  const seen = await app.tenantTransaction(other, (sql) => sql.query('SELECT id FROM gst_return_approvals WHERE preparation_id = $1', [first.id]));
  assert.deepEqual(seen.rows, []);
  await assert.rejects(app.tenantTransaction(other, (sql) => sql.query(
    "INSERT INTO gst_return_submissions (id, preparation_id, provider, idempotency_key, outcome, message) VALUES (gen_random_uuid(), $1, 'x', $2, 'UNKNOWN', 'x')",
    [first.id, crypto.randomUUID()])), code('42501'));
});

test('postgres: the declared thresholds of a company feed the threshold table through a reader', { skip }, async () => {
  const { companyId, userId } = await scene();
  await app.unitOfWork(companyId, () => thresholds.declare({
    companyId, aboveValue: { currency: 'INR', minor: 10_000_000n }, effectiveFrom: isoDate('2026-04-01'), effectiveTo: null,
    declaredBy: userId, declaredOn: isoDate('2026-08-11'), basis: 'Our accountant.',
  }));
  const table = new B2clThresholdTable(undefined, await thresholds.readerFor(companyId));
  const found = table.find(companyId, isoDate('2026-07-15'), 'production');
  assert.equal(found.found && found.basis, 'BUSINESS_DECLARED');
  assert.equal(found.found && found.threshold.aboveValue.minor, 10_000_000n);
});
