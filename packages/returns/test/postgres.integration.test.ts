/**
 * Issue #201 — on PostgreSQL, credit and debit note numbers never repeat inside a financial year.
 *
 * `return_notes` has UNIQUE(company_id, kind, number), so a counter scoped by calendar year makes
 * the January note fail to save. This runs the real ReturnService and LedgerService on a real
 * database: the note number comes from `ledger_sequence` inside the transaction that posts it.
 *
 * Needs DATABASE_URL. Without it the test is skipped locally, and fails in CI so it can never
 * pass there by not running.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixedClock, isoDate, money, quantityFromString, rupees, type AccountId, type CompanyId, type PartyId } from '@invoice/kernel';
import {
  buildDefaultChart, InMemoryAuditPort, LedgerService, PostgresLedgerStore, permissionPortFromActor, type ActorContext,
} from '@invoice/ledger';
import {
  noReturnInventory, PostgresReturnNoteRepository, ReturnService,
  type OriginalPurchaseDocument, type OriginalReturnLine, type OriginalSalesDocument,
} from '../src/index.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the return-note database test runs.');

test('note numbers run through one financial year on PostgreSQL without a unique-constraint failure', { skip: url === undefined && 'DATABASE_URL is not set' }, async () => {
  const { createDatabase } = await import('../../platform/src/database.ts');
  const { migrate } = await import('../../platform/src/migrations.ts');
  const db = createDatabase(url);
  try {
    await migrate(db);
    // A fresh synthetic company per run, so reruns against the same database start their own series.
    const company = crypto.randomUUID() as CompanyId;
    const user = crypto.randomUUID();
    const customer = crypto.randomUUID() as PartyId;
    const supplier = crypto.randomUUID() as PartyId;
    const item = crypto.randomUUID();
    await db.query('INSERT INTO companies (id, legal_name) VALUES ($1, $2)', [company, 'Synthetic Returns Traders']);
    await db.query('INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)', [user, `returns-${user}@example.invalid`, 'Synthetic clerk']);
    for (const [id, kind] of [[customer, 'party'], [supplier, 'party'], [item, 'item']]) {
      await db.query('INSERT INTO master_records (id, company_id, kind) VALUES ($1, $2, $3)', [id, company, kind]);
    }

    const actor: ActorContext = {
      companyId: company, branchId: null, userId: user as ActorContext['userId'],
      permissions: ['ledger.setup', 'ledger.post.credit_note', 'ledger.post.debit_note', 'returns.create', 'periods.hard_lock'],
    };
    const store = new PostgresLedgerStore(db);
    const audit = new InMemoryAuditPort();
    const clock = fixedClock('2027-04-02T10:00:00.000Z');
    const ledger = new LedgerService({ store, permissions: permissionPortFromActor, audit, clock });
    const accountIds = new Map<string, string>();
    const chart = buildDefaultChart(company, (code) => {
      if (!accountIds.has(code)) accountIds.set(code, crypto.randomUUID());
      return accountIds.get(code) as AccountId;
    });
    await ledger.initialiseCompany(actor, { booksStartDate: isoDate('2026-04-01'), accounts: chart });
    await ledger.openPartyAccount(actor, { partyId: customer, name: 'Synthetic Customer', kind: 'CUSTOMER' });
    await ledger.openPartyAccount(actor, { partyId: supplier, name: 'Synthetic Supplier', kind: 'SUPPLIER' });

    const line: OriginalReturnLine = {
      lineId: 'line-1', itemId: item, description: 'Repair service', supplyKind: 'SERVICES',
      quantity: quantityFromString('10', 'NOS'), warehouseId: null, taxableValue: rupees(1000),
      cgst: rupees(90), sgst: rupees(90), utgst: money(0n), igst: money(0n), cess: money(0n), total: rupees(1180),
    };
    const sale: OriginalSalesDocument = {
      id: 'sale-1', companyId: company, number: 'INV/26-27/0000001', date: isoDate('2026-04-05'),
      partyId: customer, state: 'FINAL', governmentRegistered: false, lines: [line],
    };
    const bill: OriginalPurchaseDocument = {
      id: 'bill-1', companyId: company, number: 'SUP/77', date: isoDate('2026-04-05'), partyId: supplier,
      partyName: 'Synthetic Supplier', state: 'FINAL', reverseCharge: false, governmentRegistered: false,
      lines: [{ ...line, ineligibleTax: money(0n) }],
    };
    const repository = new PostgresReturnNoteRepository(store);
    const service = new ReturnService({
      store, ledger, repository, inventory: noReturnInventory, permissions: permissionPortFromActor, audit, clock,
      sales: { async findSalesDocument(companyId, id) { return companyId === company && id === sale.id ? sale : null; } },
      purchases: { async findPurchaseDocument(companyId, id) { return companyId === company && id === bill.id ? bill : null; } },
    });
    const one = [{ originalLineId: 'line-1', quantity: quantityFromString('1', 'NOS'), disposition: 'ACCEPTED' as const }];
    const credit = async (date: string) => (await service.postSales(actor, {
      idempotencyKey: `cn-${date}`, originalInvoiceId: sale.id, documentDate: isoDate(date), reason: 'Service redone', lines: one,
    })).note.number;
    const debit = async (date: string) => (await service.postPurchase(actor, {
      idempotencyKey: `dn-${date}`, originalBillId: bill.id, documentDate: isoDate(date), reason: 'Service not delivered', lines: one,
    })).note.number;

    // Issue #201 steps 1–2: the dates from #185, crossing 1 January inside 2026-27.
    const year = ['2026-04-10', '2026-06-05', '2027-01-08', '2027-02-02'];
    const credits: string[] = [];
    for (const date of year) credits.push(await credit(date));
    assert.deepEqual(credits, ['CN/26-27/0000001', 'CN/26-27/0000002', 'CN/26-27/0000003', 'CN/26-27/0000004']);
    const debits: string[] = [];
    for (const date of year) debits.push(await debit(date));
    assert.deepEqual(debits, ['DN/26-27/0000001', 'DN/26-27/0000002', 'DN/26-27/0000003', 'DN/26-27/0000004']);

    // Step 3: 1 April starts the next financial year's series.
    assert.equal(await credit('2027-04-01'), 'CN/27-28/0000001');

    // Step 4: the number is taken inside the posting's transaction. A posting refused after the
    // number was drawn (a closed month) rolls the counter back with it, so no number is burnt.
    await ledger.setPeriodState(actor, { monthKey: '2027-03', state: 'HARD_LOCKED', reason: 'March return filed' });
    await assert.rejects(credit('2027-03-15'));
    assert.equal(await credit('2027-04-02'), 'CN/27-28/0000002');

    // What was saved is what the database holds, read back through the same repository.
    const saved = await repository.list(company);
    assert.deepEqual(saved.map((note) => note.number).sort(), [...credits, 'CN/27-28/0000001', 'CN/27-28/0000002', ...debits].sort());
    const first = saved.find((note) => note.number === 'CN/26-27/0000001');
    assert.equal(first?.documentDate, '2026-04-10');
    assert.equal(first?.lines[0]?.quantity.scaled, 1_000000n);
    assert.equal(first?.totals.total.minor, 11800n);
    const counters = await db.query(
      "SELECT scope, value FROM ledger_sequence WHERE company_id = $1 AND (scope LIKE 'sales-return:%' OR scope LIKE 'purchase-return:%') ORDER BY scope",
      [company],
    );
    assert.deepEqual(counters.rows.map((r) => [r.scope, Number(r.value)]), [
      ['purchase-return:DN::2026-27', 4], ['sales-return:CN::2026-27', 4], ['sales-return:CN::2027-28', 2],
    ]);
  } finally {
    await db.close();
  }
});
