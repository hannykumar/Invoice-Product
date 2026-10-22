/**
 * Issue #366 — the ledger store on a real PostgreSQL, connected as the application role so the
 * row-level security of migration `…_ledger_…_row_level_security` and the freeze rules of #368 are
 * really in force.
 *
 *  - The same contract suite the in-memory store passes (ledger-store-contract.ts).
 *  - Row-level security hides another company's books even from a query with no filter.
 *  - A write outside a unit of work is refused, and a write for another company inside one is too.
 *  - `'main'` is stored as NULL in the uuid `branch_id`, whoever writes it.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import { asId, isoDate, type CompanyId } from '@invoice/kernel';
import type { TransactionalExecutor } from '../../platform/src/database.ts';
import { PostgresLedgerStore } from '../src/adapters/postgres.ts';
import type { Voucher } from '../src/domain/voucher.ts';
import { cashSale, ledgerStoreContract, openBooks, type LedgerHarness } from './ledger-store-contract.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the ledger database tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';

const TABLES = ['account', 'voucher', 'journal_line', 'fiscal_period', 'ledger_sequence', 'ledger_settings', 'idempotency_record'];

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
const login = `invoice_app_test_${randomBytes(6).toString('hex')}`;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import('../../platform/src/database.ts');
  const { migrate } = await import('../../platform/src/migrations.ts');
  owner = createDatabase(url);
  await migrate(owner);
  // What a deployment does once: a login for the server, with nothing but membership of invoice_app.
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

const harness = (): LedgerHarness & { store: PostgresLedgerStore } => ({
  store: new PostgresLedgerStore(app),
  company: async () => ({ companyId: asId<'Company'>(crypto.randomUUID()), userId: asId<'User'>(crypto.randomUUID()) }),
});

ledgerStoreContract('postgres as the application role', harness, skip);

const code = (expected: string) => (error: unknown): boolean => (error as { code?: string }).code === expected;

test('row-level security hides another company\'s books from a query with no filter at all', { skip }, async () => {
  const h = harness();
  const mine = await openBooks(h);
  const theirs = await openBooks(h);
  const { voucher } = await cashSale(mine, '2026-04-10', 1180);
  await cashSale(theirs, '2026-04-10', 50);
  for (const table of TABLES) {
    const seen = await app.tenantTransaction(theirs.actor.companyId, (sql) => sql.query(`SELECT DISTINCT company_id FROM ${table}`));
    assert.deepEqual(seen.rows.map((r) => r.company_id), [theirs.actor.companyId], `${table} shows only the company in force`);
    const unset = await app.query(`SELECT count(*)::int AS n FROM ${table}`);
    assert.equal(unset.rows[0]?.n, 0, `${table} shows nothing to a connection that names no company`);
  }
  const lines = await app.tenantTransaction(theirs.actor.companyId, (sql) => sql.query('SELECT id FROM journal_line WHERE voucher_id = $1', [voucher.id]));
  assert.deepEqual(lines.rows, []);
  // The owner sees both, so the rows really are there.
  const both = await owner.query('SELECT count(DISTINCT company_id)::int AS n FROM voucher WHERE company_id = ANY($1::uuid[])', [[mine.actor.companyId, theirs.actor.companyId]]);
  assert.equal(both.rows[0]?.n, 2);
});

test('a write outside a unit of work is refused, and so is a write for another company inside one', { skip }, async () => {
  const h = harness();
  const mine = await openBooks(h);
  const theirs = await openBooks(h);
  const companyId = mine.actor.companyId;
  const { voucher } = await cashSale(mine, '2026-04-10', 300);
  const read = h.store.read();
  await assert.rejects(read.sequences.next(companyId, 'SALE:2026-27'), code('NO_UNIT_OF_WORK'));
  await assert.rejects(read.settings.put({ companyId, booksStartDate: isoDate('2020-04-01') }), code('NO_UNIT_OF_WORK'));
  await assert.rejects(read.idempotency.remember(companyId, 'k', 'v'), code('NO_UNIT_OF_WORK'));
  await assert.rejects(read.vouchers.markReversed(companyId, voucher.id, voucher.id, 'no'), code('NO_UNIT_OF_WORK'));
  await assert.rejects(read.vouchers.insert({ ...voucher, id: asId<'Voucher'>(crypto.randomUUID()) }), code('NO_UNIT_OF_WORK'));
  await assert.rejects(read.periods.upsertState(companyId, '2026-04', '2026-27', 'OPEN', null, null, null), code('NO_UNIT_OF_WORK'));
  await assert.rejects(read.accounts.insertMany([{ ...(await read.accounts.findById(companyId, mine.cash))!, id: asId<'Account'>(crypto.randomUUID()), code: '9999' }]), code('NO_UNIT_OF_WORK'));
  assert.throws(() => h.store.writeSql(companyId), code('NO_UNIT_OF_WORK'));
  assert.equal((await read.settings.get(companyId))?.booksStartDate, '2026-04-01', 'nothing was changed');

  // Inside one company's unit of work, a row naming another company is refused by the database.
  const other = theirs.actor.companyId as CompanyId;
  await assert.rejects(h.store.transaction(companyId, (uow) => uow.settings.put({ companyId: other, booksStartDate: isoDate('2020-04-01') })), code('42501'));
  await assert.rejects(h.store.transaction(companyId, (uow) => uow.sequences.next(other, 'SALE:2026-27')), code('42501'));
  // And reading through `read()` from inside it, for the other company, is refused rather than mixed.
  await assert.rejects(h.store.transaction(companyId, () => h.store.read().vouchers.list(other, {})), code('TENANT_ISOLATION'));
  assert.equal((await h.store.read().settings.get(other))?.booksStartDate, '2026-04-01');
});

test("'main' is stored as NULL in the uuid branch column even when written straight through the port", { skip }, async () => {
  const h = harness();
  const b = await openBooks(h);
  const { voucher } = await cashSale(b, '2026-04-10', 250);
  const id = asId<'Voucher'>(crypto.randomUUID());
  const copy: Voucher = {
    ...voucher, id, branchId: asId<'Branch'>('main'), number: `${voucher.number}-copy`, idempotencyKey: crypto.randomUUID(),
    lines: voucher.lines.map((l) => ({ ...l, id: asId<'JournalLine'>(crypto.randomUUID()), voucherId: id })),
  };
  await h.store.transaction(b.actor.companyId, (uow) => uow.vouchers.insert(copy));
  const stored = await app.tenantTransaction(b.actor.companyId, (sql) => sql.query('SELECT branch_id FROM voucher WHERE id = $1', [id]));
  assert.deepEqual(stored.rows, [{ branch_id: null }]);
  assert.equal((await h.store.read().vouchers.findById(b.actor.companyId, id))?.branchId, null);
});
