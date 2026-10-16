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
import { randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import { fixedClock, isoDate, money, quantityFromString, rupees, type AccountId, type CompanyId, type PartyId } from '@invoice/kernel';
import {
  buildDefaultChart, InMemoryAuditPort, LedgerService, PostgresLedgerStore, permissionPortFromActor, type ActorContext,
} from '@invoice/ledger';
import {
  noReturnInventory, PostgresReturnNoteRepository, ReturnService,
  type OriginalPurchaseDocument, type OriginalReturnLine, type OriginalSalesDocument,
} from '../src/index.ts';
import type { TransactionalExecutor } from '../../platform/src/database.ts';
import { returnsContract, type ReturnsHarness } from './returns-contract.ts';

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
    // Issue #249 — the supplier's credit note, added after the return, is saved and read back.
    const dn = saved.find((note) => note.number === 'DN/26-27/0000001');
    assert.equal(dn?.supplierCreditNote, null);
    await service.recordSupplierCreditNote(actor, { noteId: dn!.id, number: 'SUP-CN-7', date: isoDate('2026-04-12') });
    assert.deepEqual((await repository.findById(company, dn!.id))?.supplierCreditNote, { number: 'SUP-CN-7', date: '2026-04-12' });
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

// Issue #366 — the repository contract, on a login that is only a member of invoice_app, so
// row-level security is really in force. The owner connection only sets the scene.
const skip = url === undefined && 'DATABASE_URL is not set';
const login = `invoice_app_returns_${randomBytes(6).toString('hex')}`;
let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let harness: ReturnsHarness;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import('../../platform/src/database.ts');
  const { migrate } = await import('../../platform/src/migrations.ts');
  owner = createDatabase(url);
  await migrate(owner);
  const password = randomBytes(18).toString('hex');
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  const appUrl = new URL(url);
  appUrl.username = login;
  appUrl.password = password;
  app = createDatabase(appUrl.toString());
  const store = new PostgresLedgerStore(app);
  harness = {
    repository: new PostgresReturnNoteRepository(store),
    unitOfWork: (companyId, work) => store.transaction(companyId, () => work()),
    company: async () => {
      const ids = {
        companyId: crypto.randomUUID() as CompanyId, partyId: crypto.randomUUID() as PartyId, itemId: crypto.randomUUID(),
        warehouseId: crypto.randomUUID(), userId: crypto.randomUUID() as ActorContext['userId'],
      };
      await owner.query('INSERT INTO companies (id, legal_name) VALUES ($1, $2)', [ids.companyId, 'Synthetic Returns Traders']);
      await owner.query('INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)', [ids.userId, `returns-${ids.userId}@example.invalid`, 'Synthetic clerk']);
      for (const [id, kind] of [[ids.partyId, 'party'], [ids.itemId, 'item'], [ids.warehouseId, 'warehouse']]) {
        await owner.query('INSERT INTO master_records (id, company_id, kind) VALUES ($1, $2, $3)', [id, ids.companyId, kind]);
      }
      return ids;
    },
  };
});
after(async () => {
  await app?.close();
  if (owner !== undefined) { await owner.query(`DROP ROLE IF EXISTS ${login}`); await owner.close(); }
});

returnsContract('postgres', () => harness, skip);

test('postgres: a write outside a unit of work throws NO_UNIT_OF_WORK and saves nothing', { skip }, async () => {
  const scene = await harness.company();
  const id = crypto.randomUUID();
  const line = {
    originalLineId: 'line-1', itemId: scene.itemId, description: 'Synthetic bars', supplyKind: 'GOODS' as const,
    quantity: quantityFromString('1', 'NOS'), disposition: 'ACCEPTED' as const, warehouseId: scene.warehouseId, batchId: null,
    serialNumbers: [], replacementSerialNumbers: [], hsnOrSac: null, ratePercentTimes100: null, unitPrice: null,
    amounts: { taxableValue: rupees(1), cgst: money(0n), sgst: money(0n), utgst: money(0n), igst: money(0n), cess: money(0n), ineligibleTax: money(0n), reverseChargeTax: money(0n), total: rupees(1) },
  };
  const note = {
    id, companyId: scene.companyId, kind: 'PURCHASE_RETURN' as const, number: 'DN/26-27/0000001', documentDate: isoDate('2026-04-10'),
    originalDocument: { id: 'bill-1', number: 'SUP/1', date: isoDate('2026-04-05') }, partyId: scene.partyId, reason: 'Synthetic',
    lines: [line], totals: line.amounts, voucherId: crypto.randomUUID() as never, complianceStatus: 'NOT_APPLICABLE' as const,
    createdBy: scene.userId, createdAt: '2026-04-10T05:30:00.000Z', idempotencyKey: `outside-${id}`, summary: 'Synthetic', supplierCreditNote: null,
  };
  const noUnitOfWork = (error: unknown) => (error as { code?: string }).code === 'NO_UNIT_OF_WORK';
  await assert.rejects(harness.repository.insert(note), noUnitOfWork);
  assert.equal(await harness.repository.findById(scene.companyId, id), null);
  await harness.unitOfWork(scene.companyId, () => harness.repository.insert(note));
  await assert.rejects(harness.repository.setSupplierCreditNote(scene.companyId, id, { number: 'S-1', date: isoDate('2026-04-12') }), noUnitOfWork);
  assert.equal((await harness.repository.findById(scene.companyId, id))?.supplierCreditNote, null);
});

test('postgres: a line is an item or a charge, never both and never neither', { skip }, async () => {
  const scene = await harness.company();
  const noteId = crypto.randomUUID();
  await app.unitOfWork(scene.companyId, ({ sql }) => sql.query(
    `INSERT INTO return_notes (id, company_id, kind, number, document_date, original_document_id, original_document_number,
       original_document_date, party_id, reason, taxable_value_paise, total_paise, voucher_id, compliance_status, created_by,
       idempotency_key, summary)
     VALUES ($1, $2, 'SALES_RETURN', 'CN/26-27/0000001', '2026-04-10', 'sale-1', 'INV/1', '2026-04-05', $3, 'Synthetic', 0, 0, $4,
       'NOT_APPLICABLE', $5, 'check', 'Synthetic')`,
    [noteId, scene.companyId, scene.partyId, crypto.randomUUID(), scene.userId],
  ));
  const line = (lineId: string, itemId: string | null, chargeKind: string | null) => app.unitOfWork(scene.companyId, ({ sql }) => sql.query(
    `INSERT INTO return_note_lines (return_note_id, company_id, original_line_id, item_id, charge_kind, description, supply_kind,
       quantity_micro, quantity_unit, disposition, taxable_value_paise, total_paise)
     VALUES ($1, $2, $3, $4, $5, 'Synthetic', 'SERVICES', 1, 'NOS', 'ACCEPTED', 0, 0)`,
    [noteId, scene.companyId, lineId, itemId, chargeKind],
  ));
  const refused = (error: unknown) => (error as { code?: string }).code === '23514';
  await assert.rejects(line('both', scene.itemId, 'freight'), refused);
  await assert.rejects(line('neither', null, null), refused);
  await assert.rejects(line('bad-kind', null, 'Freight!'), refused);
  await line('item', scene.itemId, null);
  await line('charge', null, 'other');
  // The foreign keys carry the company: another company's item is not this company's item.
  const other = await harness.company();
  await assert.rejects(line('foreign-item', other.itemId, null), (error: unknown) => (error as { code?: string }).code === '23503');
});
