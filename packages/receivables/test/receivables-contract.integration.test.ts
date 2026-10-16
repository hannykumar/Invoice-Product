/**
 * Issue #366 — the receivables contract on a real PostgreSQL, through the tables of #365.
 *
 * The repositories run as the application's own role (a login that is only a member of
 * `invoice_app`), so row-level security, the column grants and the freeze triggers are really in
 * force. The owner only sets the scene: companies, people, master records, issued bills and proformas.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import { DomainError, money, type PartyId } from '@invoice/kernel';
import type { SqlExecutor, TransactionalExecutor } from '../../platform/src/database.ts';
import type { AdvanceRepository } from '../src/advance.ts';
import type { PaymentRepository } from '../src/ports.ts';
import { openShop, receivablesContract, type ShopIds, type World } from './receivables-contract.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the receivables database tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let payments: PaymentRepository;
let advances: AdvanceRepository;
let ledgerStore: typeof import('@invoice/ledger').PostgresLedgerStore;
const login = `invoice_app_receivables_${randomBytes(6).toString('hex')}`;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import('../../platform/src/database.ts');
  const { migrate } = await import('../../platform/src/migrations.ts');
  const { PostgresAdvanceRepository, PostgresPaymentRepository } = await import('../src/postgres-repository.ts');
  ({ PostgresLedgerStore: ledgerStore } = await import('@invoice/ledger'));
  owner = createDatabase(url);
  await migrate(owner);
  const password = randomBytes(18).toString('hex');
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  const appUrl = new URL(url);
  appUrl.username = login;
  appUrl.password = password;
  app = createDatabase(appUrl.toString());
  payments = new PostgresPaymentRepository(app);
  advances = new PostgresAdvanceRepository(app);
});
after(async () => {
  await app?.close();
  if (owner !== undefined) { await owner.query(`DROP ROLE IF EXISTS ${login}`); await owner.close(); }
});

const insert = (sql: SqlExecutor, table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row);
  return sql.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_c, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
};
const asOwner = <T>(companyId: string, work: (sql: SqlExecutor) => Promise<T>) => owner.tenantTransaction(companyId, work);

/** ₹300.00 of crates plus 18% GST: ₹354.00 — as packages/sales/test/sales-schema.integration.test.ts builds it. */
const PRICED = { pricing: '{}', line_count: 1, taxable_value_paise: 30_000, cgst_paise: 2_700, sgst_paise: 2_700, utgst_paise: 0, igst_paise: 0, cess_paise: 0, total_tax_paise: 5_400, reverse_charge_tax_paise: 0, round_off_paise: 0, invoice_value_paise: 35_400 };
const header = (ids: ShopIds, id: string, over: Record<string, unknown>) => ({
  id, company_id: ids.companyId, document_date: '2026-04-10', party_id: ids.customer, customer_type: 'B2B', supply_kind: 'GOODS',
  round_to_whole_rupee: true, created_by: ids.userId, idempotency_key: `doc:${id}`, version: 0, ...PRICED, financial_year: '2026-27', ...over,
});
const line = (ids: ShopIds, foreignKey: string, id: string) => ({
  company_id: ids.companyId, [foreignKey]: id, line_id: 'l1', line_no: 1, item_id: ids.item, warehouse_id: ids.warehouse,
  quantity_micro: 3_000_000, unit_code: 'PCS', unit_price_paise: 10_000, price_basis: 'EXCLUSIVE',
  item_name: 'Plastic crate', hsn_or_sac: '3923', rate_bp: 1800, taxable_value_paise: 30_000, cgst_paise: 2_700, sgst_paise: 2_700,
});

const world = (): World => ({
  store: new ledgerStore(app),
  payments, advances,
  unit: (companyId, work) => app.unitOfWork(companyId, () => work()),
  async seedCompany(ids) {
    await owner.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Receivables Traders')", [ids.companyId]);
    await owner.query("INSERT INTO branches (id, company_id, name) VALUES ($1, $2, 'Main shop')", [ids.branch, ids.companyId]);
    await owner.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Synthetic clerk')", [ids.userId, `receivables-${ids.userId}@example.invalid`]);
    await asOwner(ids.companyId, (sql) => sql.query(
      "INSERT INTO master_records (id, company_id, kind) VALUES ($1, $5, 'party'), ($2, $5, 'party'), ($3, $5, 'item'), ($4, $5, 'warehouse')",
      [ids.customer, ids.supplier, ids.item, ids.warehouse, ids.companyId],
    ));
  },
  async seedBill(ids, billId, number, voucherId) {
    await asOwner(ids.companyId, async (sql) => {
      await insert(sql, 'sales_invoices', header(ids, billId, { state: 'FINAL', number, voucher_id: voucherId, finalised_by: ids.userId, finalised_at: '2026-04-10T11:04:00Z' }));
      await insert(sql, 'sales_invoice_lines', line(ids, 'invoice_id', billId));
      await insert(sql, 'document_settlements', { company_id: ids.companyId, document_kind: 'SALES_INVOICE', document_id: billId, document_number: number, party_id: ids.customer, side: 'RECEIVABLE', document_date: '2026-04-10', value_paise: 35_400 });
    });
  },
  async seedProforma(ids, proformaId, number) {
    await asOwner(ids.companyId, async (sql) => {
      await insert(sql, 'presale_documents', header(ids, proformaId, { state: 'ISSUED', kind: 'PROFORMA', number, supply_kind: 'SERVICES', purpose: 'Advance for crate repairs', document_date: '2026-04-05' }));
      await insert(sql, 'presale_document_lines', line(ids, 'document_id', proformaId));
    });
  },
  async settled(companyId, billId) {
    const { rows } = await app.tenantTransaction(companyId, (sql) => sql.query(
      "SELECT allocated_paise FROM document_settlements WHERE company_id = $1 AND document_kind = 'SALES_INVOICE' AND document_id = $2", [companyId, billId]));
    return BigInt(String(rows[0]?.allocated_paise));
  },
});

receivablesContract('postgres', () => world(), skip);

const one = async (companyId: string, text: string, values: unknown[] = []) =>
  (await app.tenantTransaction(companyId, (sql) => sql.query(text, values))).rows[0] as Record<string, unknown>;

test('postgres: a write outside a unit of work is refused, not committed on its own', { skip }, async () => {
  const s = await openShop(world());
  const p = s.payment();
  const noUnit = (error: unknown) => (error as { code?: string }).code === 'NO_UNIT_OF_WORK';
  await assert.rejects(payments.insert(p), noUnit);
  await assert.rejects(payments.update({ ...p, version: 2 }, 1), noUnit);
  const proforma = await s.proforma();
  const adv = s.advance(p.id, proforma.id);
  await assert.rejects(advances.insert(adv), noUnit);
  await assert.rejects(advances.update({ ...adv, version: 2 }, 1), noUnit);
  assert.equal(await payments.findById(s.companyId, p.id), null);
});

test('postgres: what a payment settled is kept as rows; a bounce releases them and the figures follow', { skip }, async () => {
  const s = await openShop(world());
  const bill = await s.issueBill();
  const recorded = await s.receivables.recordPayment(s.actor, {
    idempotencyKey: 'pg-cheque', direction: 'RECEIPT', partyId: s.ids.customer as PartyId, mode: 'CHEQUE', amount: money(50_000n), date: '2026-04-11' as never,
    cheque: { number: '7788', chequeDate: '2026-04-11' as never }, allocations: [{ documentId: bill.id, documentNumber: bill.number, amount: money(35_400n) }],
  });
  const figures = () => one(s.companyId,
    `SELECT p.allocated_paise::text AS payment, p.cheque_state, d.status, d.allocated_paise::text AS bill,
            (SELECT count(*)::int FROM payment_allocations a WHERE a.payment_id = p.id AND a.released_at IS NOT NULL) AS released,
            (SELECT count(*)::int FROM cheque_events e WHERE e.payment_id = p.id) AS steps
       FROM payments p, document_settlements d WHERE p.company_id = $1 AND p.id = $2 AND d.document_id = $3`, [s.companyId, recorded.id, bill.id]);
  assert.deepEqual(await figures(), { payment: '35400', cheque_state: 'PENDING', status: 'SETTLED', bill: '35400', released: 0, steps: 1 });
  await s.receivables.recordChequeEvent(s.actor, recorded.id, 'BOUNCED', { on: '2026-04-13' as never, note: 'Signature differs' }, recorded.version);
  assert.deepEqual(await figures(), { payment: '0', cheque_state: 'BOUNCED', status: 'OPEN', bill: '0', released: 1, steps: 2 }, 'released, never deleted');
});

test('postgres: two payments applied to one bill at the same moment never pay it more than its value', { skip }, async () => {
  const s = await openShop(world());
  const bill = await s.issueBill();
  const record = (key: string) => s.receivables.recordPayment(s.actor, { idempotencyKey: key, direction: 'RECEIPT', partyId: s.ids.customer as PartyId, mode: 'CASH', amount: money(35_400n), date: '2026-04-11' as never });
  const [first, second] = [await record('pg-a'), await record('pg-b')];
  // Each checked what the bill still owed before the other saved: only the database can refuse the second.
  const outcomes = await Promise.allSettled([first, second].map((p) =>
    s.receivables.allocate(s.actor, p.id, [{ documentId: bill.id, documentNumber: bill.number, amount: money(35_400n) }], p.version)));
  assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
  const reason = (outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult).reason;
  assert.ok(reason instanceof DomainError && reason.code === 'ALLOCATION_EXCEEDS_OUTSTANDING', String(reason));
  assert.equal(await world().settled?.(s.companyId, bill.id), 35_400n);
  const loser = outcomes[0]?.status === 'rejected' ? first : second;
  assert.deepEqual((await payments.findById(s.companyId, loser.id))?.allocations, [], 'the refused allocation left nothing behind');
});

test('postgres: row-level security hides one company from another even without a company filter', { skip }, async () => {
  const w = world();
  const [a, b] = [await openShop(w), await openShop(w)];
  await a.unit(() => payments.insert(a.payment()));
  assert.equal(Number((await one(b.companyId, 'SELECT count(*)::int AS n FROM payments')).n), 0);
  assert.equal(Number((await one(a.companyId, 'SELECT count(*)::int AS n FROM payments')).n), 1);
});

test('postgres: a refund and an allocation of one receipt at the same moment never use more than it (#367)', { skip }, async () => {
  const s = await openShop(world());
  const bill = await s.issueBill();
  const receipt = await s.receivables.recordPayment(s.actor, { idempotencyKey: 'pg-r', direction: 'RECEIPT', partyId: s.ids.customer as PartyId, mode: 'CASH', amount: money(35_400n), date: '2026-04-11' as never });
  // Each checks what is unused before the others save: only the database can refuse the excess.
  const outcomes = await Promise.allSettled([
    s.receivables.allocate(s.actor, receipt.id, [{ documentId: bill.id, documentNumber: bill.number, amount: money(35_400n) }], receipt.version),
    ...['pg-refund-1', 'pg-refund-2'].map((key) => s.receivables.recordPayment(s.actor, {
      idempotencyKey: key, direction: 'PAYMENT', partyId: s.ids.customer as PartyId, mode: 'CASH', amount: money(35_400n), date: '2026-04-12' as never, refundOf: receipt.id,
    })),
  ]);
  assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1, outcomes.map((o) => o.status === 'rejected' ? String((o as PromiseRejectedResult).reason) : 'ok').join(' | '));
  for (const o of outcomes.filter((x) => x.status === 'rejected')) {
    const reason = (o as PromiseRejectedResult).reason;
    assert.ok(reason instanceof DomainError && ['ALLOCATION_EXCEEDS_PAYMENT', 'PAYMENT_REFUND_EXCEEDS', 'PAYMENT_CONCURRENT_EDIT'].includes(reason.code), String(reason));
  }
  const used = await one(s.companyId, 'SELECT (allocated_paise + refunded_paise)::text AS used FROM payments WHERE company_id = $1 AND id = $2', [s.companyId, receipt.id]);
  assert.equal(used.used, '35400');
});
