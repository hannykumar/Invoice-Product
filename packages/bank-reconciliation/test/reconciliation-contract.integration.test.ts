/**
 * Issue #366 — the reconciliation store on a real PostgreSQL, connected as the application role so
 * row-level security and the freeze rules are really in force. Needs DATABASE_URL (required in CI).
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import type { TransactionalExecutor } from '../../platform/src/database.ts';
import type { PostgresReconciliationStore as Store } from '../src/postgres-store.ts';
import { reconciliationContract } from './reconciliation-contract.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the reconciliation database tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let PostgresReconciliationStore: typeof Store;
const login = `invoice_app_test_${randomBytes(6).toString('hex')}`;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import('../../platform/src/database.ts');
  const { migrate } = await import('../../platform/src/migrations.ts');
  ({ PostgresReconciliationStore } = await import('../src/postgres-store.ts'));
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

const company = async (): Promise<string> => {
  const id = crypto.randomUUID();
  await app.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Bank Traders')", [id]);
  return id;
};

reconciliationContract('postgres as the application role', () => ({ store: new PostgresReconciliationStore(app), company }), skip);

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
const candidate = { id: 'cand-1', companyId: '', bankTransactionIds: ['b1'], paymentIds: ['p1'], confidence: 90, amountDifferencePaise: 0n, reasons: ['Amounts are exactly equal.'] };

test('a write outside a unit of work is refused, not committed on its own', { skip }, async () => {
  const store = new PostgresReconciliationStore(app);
  const a = await company();
  await assert.rejects(store.saveCandidates(a, [{ ...candidate, companyId: a }]), code('NO_UNIT_OF_WORK'));
  await assert.rejects(store.unmatch(a, crypto.randomUUID(), { at: new Date().toISOString(), by: 'x', reason: 'y' }), code('NO_UNIT_OF_WORK'));
  assert.equal(await store.candidate(a, 'cand-1'), null);
});

test("the database refuses another company's rows and any change to final or undone evidence", { skip }, async () => {
  const store = new PostgresReconciliationStore(app);
  const [a, b] = [await company(), await company()];
  await assert.rejects(app.unitOfWork(b, () => store.saveCandidates(a, [{ ...candidate, companyId: a }])), code('TENANT_ISOLATION'));
  await assert.rejects(app.unitOfWork(b, ({ sql }) => sql.query("INSERT INTO bank_reconciliation_candidates (company_id, id, bank_transaction_ids, payment_ids, confidence, amount_difference_paise, reasons) VALUES ($1, 'x', '{}', '{}', 1, 0, '[]')", [a])), /row-level security/);
  const matchId = crypto.randomUUID();
  await store.action(a, async () => {
    await store.saveCandidates(a, [{ ...candidate, companyId: a }]);
    await store.addMatches(a, [{ ...candidate, companyId: a, id: matchId, candidateId: 'cand-1', status: 'AUTO_MATCHED', remainingBankPaise: 0n, remainingBookPaise: 0n, confirmedBy: null, confirmedAt: null }]);
    await store.appendAudits(a, [{ id: crypto.randomUUID(), companyId: a, actorId: 'owner', action: 'reconciliation.auto_matched', matchId, occurredAt: new Date().toISOString(), reason: null }]);
  });
  const second = { ...candidate, companyId: a, id: crypto.randomUUID(), candidateId: 'cand-1', paymentIds: ['p2'], status: 'CONFIRMED' as const, remainingBankPaise: 0n, remainingBookPaise: 0n, confirmedBy: 'owner', confirmedAt: new Date().toISOString() };
  await assert.rejects(store.action(a, () => store.addMatches(a, [second])), code('23505'), 'a bank line already matched cannot be matched again');
  await assert.rejects(app.unitOfWork(b, ({ sql }) => sql.query("INSERT INTO bank_reconciliation_events (id, company_id, actor_id, action, match_id, occurred_at) VALUES ($1, $2, 'owner', 'reconciliation.confirmed', $3, now())", [crypto.randomUUID(), b, matchId])), code('23503'), "an event cannot name another company's match");
  const inA = (sql: string) => app.unitOfWork(a, ({ sql: s }) => s.query(sql, [a]));
  const FROZEN = '23001';
  await assert.rejects(inA('UPDATE bank_reconciliation_candidates SET confidence = 10 WHERE company_id = $1'), code(FROZEN));
  await assert.rejects(inA("UPDATE bank_reconciliation_events SET reason = 'edited' WHERE company_id = $1"), code(FROZEN));
  await assert.rejects(inA('UPDATE bank_reconciliation_matches SET remaining_bank_paise = 5 WHERE company_id = $1'), code(FROZEN));
  await assert.rejects(inA("UPDATE bank_reconciliation_matches SET status = 'UNMATCHED' WHERE company_id = $1"), code('23514'));
  await inA("UPDATE bank_reconciliation_matches SET status = 'UNMATCHED', unmatched_at = now(), unmatched_by = 'owner', unmatch_reason = 'wrong' WHERE company_id = $1");
  await assert.rejects(inA("UPDATE bank_reconciliation_matches SET status = 'CONFIRMED', unmatched_at = NULL, unmatched_by = NULL, unmatch_reason = NULL WHERE company_id = $1"), code(FROZEN));
  await assert.rejects(inA("UPDATE bank_reconciliation_matches SET unmatch_reason = 'rewritten' WHERE company_id = $1"), code(FROZEN));
  for (const table of ['bank_reconciliation_events', 'bank_reconciliation_matches', 'bank_reconciliation_candidates']) {
    await assert.rejects(inA(`DELETE FROM ${table} WHERE company_id = $1`), code('42501'), table);
  }
  await assert.rejects(owner.query('DELETE FROM bank_reconciliation_events WHERE company_id = $1', [a]), code(FROZEN));
  await assert.rejects(owner.query('TRUNCATE bank_reconciliation_events CASCADE'), code(FROZEN));
});
