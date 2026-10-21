/**
 * Issue #366 — the bank-feed store on a real PostgreSQL, connected as the application role so
 * row-level security and the freeze rules of #368 are really in force.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import type { TransactionalExecutor } from '../../platform/src/database.ts';
import type { PostgresBankFeedStore as Store } from '../src/postgres-store.ts';
import type { BankFeedTransaction } from '../src/index.ts';
import { bankFeedContract, pendingConnection, type BankFeedHarness } from './bank-feeds-contract.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the bank-feed database tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let PostgresBankFeedStore: typeof Store;
const login = `invoice_app_test_${randomBytes(6).toString('hex')}`;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import('../../platform/src/database.ts');
  const { migrate } = await import('../../platform/src/migrations.ts');
  ({ PostgresBankFeedStore } = await import('../src/postgres-store.ts'));
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

const company = async (): Promise<{ companyId: string; userId: string }> => {
  const companyId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  await app.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Bank Traders')", [companyId]);
  await app.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Synthetic owner')", [userId, `bank-${userId}@example.invalid`]);
  return { companyId, userId };
};

const harness = (): BankFeedHarness => ({
  store: new PostgresBankFeedStore(app),
  company,
  write: (companyId, work) => app.unitOfWork(companyId, () => work()),
  atomic: true,
});

bankFeedContract('postgres as the application role', harness, skip);

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

test('a write outside the action\'s transaction is refused, not committed on its own', { skip }, async () => {
  const { store } = harness();
  const { companyId, userId } = await company();
  const c = pendingConnection(companyId);
  const account = { id: crypto.randomUUID(), companyId, connectionId: c.id, providerAccountId: 'a', displayName: 'd', maskedAccountNumber: 'XX12', accountType: 'CURRENT' as const, currency: 'INR' as const, balancePaise: null, balanceAsOf: null, cursor: null, active: true };
  const line: BankFeedTransaction = { id: crypto.randomUUID(), companyId, connectionId: c.id, accountId: account.id, providerTransactionId: 't', bookedOn: '2026-08-29', description: 'd', debitPaise: 1n, creditPaise: 0n, fingerprint: 'f', importedAt: '2026-08-30T12:00:00.000Z' };
  const writes: (() => Promise<void>)[] = [
    () => store.saveConnection(c), () => store.saveAccount(account), () => store.addTransactions([line]),
    () => store.saveSyncResult(companyId, c.id, 'k', { connection: c, imported: 0, duplicates: 0, transactions: [] }),
    () => store.record({ id: crypto.randomUUID(), companyId, actorId: userId, action: 'bank_feed.connected', connectionId: c.id, occurredAt: '2026-08-30T12:00:00.000Z', details: {} }),
  ];
  for (const write of writes) await assert.rejects(write(), code('NO_UNIT_OF_WORK'));
  assert.equal(await store.connection(companyId, c.id), null);
  assert.deepEqual(await store.audit(companyId), []);
});

test('the database refuses another company\'s rows, a repeated line or sync key, and any change to an imported line', { skip }, async () => {
  const { store } = harness();
  const a = await company();
  const b = await company();
  const c = pendingConnection(a.companyId);
  const account = { id: crypto.randomUUID(), companyId: a.companyId, connectionId: c.id, providerAccountId: 'a', displayName: 'd', maskedAccountNumber: 'XX12', accountType: 'CURRENT' as const, currency: 'INR' as const, balancePaise: null, balanceAsOf: null, cursor: null, active: true };
  const line: BankFeedTransaction = { id: crypto.randomUUID(), companyId: a.companyId, connectionId: c.id, accountId: account.id, providerTransactionId: 't-1', bookedOn: '2026-08-29', description: 'd', debitPaise: 1n, creditPaise: 0n, fingerprint: `f-${crypto.randomUUID()}`, importedAt: '2026-08-30T12:00:00.000Z' };
  await app.unitOfWork(a.companyId, async () => { await store.saveConnection(c); await store.saveAccount(account); await store.addTransactions([line]); await store.saveSyncResult(a.companyId, c.id, 'k', { connection: c, imported: 1, duplicates: 0, transactions: [line] }); });
  // Company B's action cannot write a row that says it is company A's.
  await assert.rejects(app.unitOfWork(b.companyId, () => store.saveConnection(pendingConnection(a.companyId))), code('TENANT_ISOLATION'));
  await assert.rejects(app.unitOfWork(b.companyId, () => app.requireUnitOfWork(b.companyId).sql.query(
    `INSERT INTO bank_feed_connections (id, company_id, provider, status, sync_status) VALUES ($1, $2, 'p', 'PENDING_CONSENT', 'IDLE')`, [crypto.randomUUID(), a.companyId])), /row-level security/);
  assert.equal(await store.connection(b.companyId, c.id), null);
  // The same provider line twice, or the same sync key twice, is a bug in the caller: refused.
  await assert.rejects(app.unitOfWork(a.companyId, () => store.addTransactions([{ ...line, id: crypto.randomUUID(), fingerprint: `f-${crypto.randomUUID()}` }])), code('23505'));
  await assert.rejects(app.unitOfWork(a.companyId, () => store.saveSyncResult(a.companyId, c.id, 'k', { connection: c, imported: 0, duplicates: 0, transactions: [] })), code('23505'));
  // An imported line is evidence: it cannot be edited, and the application cannot delete it.
  await assert.rejects(app.unitOfWork(a.companyId, () => app.requireUnitOfWork(a.companyId).sql.query('UPDATE bank_feed_transactions SET debit_paise = 2 WHERE company_id = $1 AND id = $2', [a.companyId, line.id])));
  await assert.rejects(app.unitOfWork(a.companyId, () => app.requireUnitOfWork(a.companyId).sql.query('DELETE FROM bank_feed_transactions WHERE company_id = $1 AND id = $2', [a.companyId, line.id])));
  assert.deepEqual(await store.transactions(a.companyId, c.id), [line]);
});
