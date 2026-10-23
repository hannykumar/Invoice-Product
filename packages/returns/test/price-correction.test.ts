/**
 * Issue #293 — a price changed after the sale, with nothing coming back: a credit note for a lower
 * price (CGST Act s.34(1)), a debit note for a higher one (s.34(3)), and goods returned afterwards
 * credited at the price the customer finally paid.
 *
 * The bill: 70 boxes of apples at ₹100 = ₹7,000, CGST 9% ₹630, SGST 9% ₹630, total ₹8,260.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  asId, fixedClock, isoDate, money, quantityFromString, rupees, toDecimalString,
  type AccountId, type CompanyId, type PartyId,
} from '@invoice/kernel';
import {
  buildDefaultChart, defaultChartIdFactory, InMemoryAuditPort, InMemoryLedgerStore,
  LedgerService, partyBalance, permissionPortFromActor, type Account, type ActorContext,
} from '@invoice/ledger';
import {
  InMemoryInventoryStore, InventoryService,
  type StockItem, type StockMasterData, type Warehouse,
} from '@invoice/inventory';
import { createDefaultUnitRegistry } from '../../masters/src/units.ts';
import {
  InMemoryReturnNoteRepository, ReturnService, returnInventoryAdapter,
  type OriginalSalesDocument, type SalesPriceCorrectionCommand,
} from '../src/index.ts';

const COMPANY = asId<'Company'>('returns-company');
const OTHER = asId<'Company'>('returns-other');
const CUSTOMER = asId<'Party'>('returns-customer');
const actor: ActorContext = {
  companyId: COMPANY, branchId: asId<'Branch'>('main'), userId: asId<'User'>('priya'),
  permissions: ['ledger.setup', 'ledger.post.sale', 'ledger.post.credit_note', 'ledger.post.debit_note', 'ledger.post.locked_period', 'periods.lock', 'periods.hard_lock', 'returns.create', 'inventory.move'],
};

class Masters implements StockMasterData {
  readonly #units = createDefaultUnitRegistry();
  readonly #items: StockItem[] = [{ itemId: 'APPLE', name: 'Apple box', baseUnit: 'BOX', tracksBatches: false, tracksSerials: false }];
  readonly #warehouses: Warehouse[] = [{ warehouseId: 'shop', name: 'Main shop' }, { warehouseId: 'damaged', name: 'Damaged stock', sellable: false }];
  item(_companyId: CompanyId, itemId: string) { return this.#items.find((item) => item.itemId === itemId); }
  warehouse(_companyId: CompanyId, warehouseId: string) { return this.#warehouses.find((warehouse) => warehouse.warehouseId === warehouseId); }
  units() { return this.#units; }
}

const original = (): OriginalSalesDocument => ({
  id: 'invoice-70', companyId: COMPANY, number: 'INV/KB/00070', date: isoDate('2026-08-01'),
  partyId: CUSTOMER, state: 'FINAL', governmentRegistered: true,
  lines: [{
    lineId: 'line-apples', itemId: 'APPLE', description: 'Apple box', supplyKind: 'GOODS',
    quantity: quantityFromString('70', 'BOX'), warehouseId: 'shop', taxableValue: rupees(7000),
    cgst: rupees(630), sgst: rupees(630), utgst: money(0n), igst: money(0n), cess: money(0n), total: rupees(8260),
  }],
});

interface Fixture {
  service: ReturnService;
  ledger: LedgerService;
  store: InMemoryLedgerStore;
  inventory: InventoryService;
  notes: InMemoryReturnNoteRepository;
  audit: InMemoryAuditPort;
  customerAccount: AccountId;
}

let fixtureNumber = 0;
const setup = async (): Promise<Fixture> => {
  fixtureNumber += 1;
  const store = new InMemoryLedgerStore();
  const audit = new InMemoryAuditPort();
  let id = 0;
  const nextId = () => `returns-${fixtureNumber}-${++id}`;
  const ledger = new LedgerService({ store, permissions: permissionPortFromActor, audit, clock: fixedClock('2026-08-30T10:00:00.000Z'), idFactory: nextId });
  const chart = buildDefaultChart(COMPANY, defaultChartIdFactory(COMPANY));
  const receivables = chart.find((account) => account.systemRole === 'TRADE_RECEIVABLES');
  assert.ok(receivables);
  const customerAccount = asId<'Account'>('returns-customer-account');
  const customer: Account = {
    id: customerAccount, companyId: COMPANY, code: '1201', name: 'Delhi Fresh Mart', type: 'ASSET',
    parentId: receivables.id, isGroup: false, active: true, partyId: CUSTOMER, systemRole: null,
  };
  await ledger.initialiseCompany(actor, { booksStartDate: isoDate('2026-04-01'), accounts: [...chart, customer] });
  const role = (name: string): AccountId => {
    const account = chart.find((candidate) => candidate.systemRole === name);
    assert.ok(account); return account.id;
  };
  await ledger.postVoucher(actor, {
    idempotencyKey: 'original-sale', type: 'SALE', date: isoDate('2026-08-01'),
    source: { kind: 'sales_invoice', id: 'invoice-70', number: 'INV/KB/00070' },
    lines: [
      { accountId: customerAccount, partyId: CUSTOMER, debit: rupees(8260), credit: money(0n) },
      { accountId: role('SALES_GOODS'), debit: money(0n), credit: rupees(7000) },
      { accountId: role('OUTPUT_CGST'), debit: money(0n), credit: rupees(630) },
      { accountId: role('OUTPUT_SGST'), debit: money(0n), credit: rupees(630) },
    ],
  });

  const inventoryStore = new InMemoryInventoryStore();
  store.join(inventoryStore);
  const inventory = new InventoryService({
    store, inventory: inventoryStore, masterData: new Masters(), permissions: permissionPortFromActor,
    audit, clock: fixedClock('2026-08-30T10:00:00.000Z'), idFactory: nextId,
  });
  const notes = new InMemoryReturnNoteRepository();
  store.join(notes);
  const source = original();
  const service = new ReturnService({
    store, ledger, repository: notes,
    sales: { async findSalesDocument(companyId, invoiceId) { return companyId === COMPANY && invoiceId === source.id ? source : null; } },
    inventory: returnInventoryAdapter(inventory), permissions: permissionPortFromActor, audit,
    clock: fixedClock('2026-08-30T10:00:00.000Z'), idFactory: nextId,
  });
  return { service, ledger, store, inventory, notes, audit, customerAccount };
};


const correction = (overrides: Partial<SalesPriceCorrectionCommand> = {}): SalesPriceCorrectionCommand => ({
  idempotencyKey: 'price-apples-95', originalInvoiceId: 'invoice-70', originalLineId: 'line-apples',
  documentDate: isoDate('2026-08-30'), reason: 'Rate agreed was ₹95 a box, not ₹100.', newUnitPrice: rupees(95),
  ...overrides,
});
/** The same correction typed as an amount off rather than a new rate. */
const amountOff = (amount: ReturnType<typeof rupees>, overrides: Partial<SalesPriceCorrectionCommand> = {}): SalesPriceCorrectionCommand => {
  const { newUnitPrice: _price, ...rest } = correction(overrides);
  return { ...rest, amountOff: amount };
};
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

test('#293: a lower price makes a credit note with tax on the difference, and moves no stock', async () => {
  const f = await setup();
  const preview = await f.service.previewPriceCorrection(actor, correction());
  assert.equal(preview.kind, 'SALES_RETURN');
  // 70 × (₹100 − ₹95) = ₹350; CGST and SGST 9% each = ₹31.50; total ₹413.
  assert.equal(toDecimalString(preview.totals.taxableValue), '350.00');
  assert.equal(toDecimalString(preview.totals.cgst), '31.50');
  assert.equal(toDecimalString(preview.totals.sgst), '31.50');
  assert.equal(toDecimalString(preview.totals.total), '413.00');
  const { note } = await f.service.postPriceCorrection(actor, correction());
  assert.match(note.number, /^CN\/26-27\/0000001$/);
  assert.equal(note.priceCorrection, true);
  assert.equal(note.originalDocument.number, 'INV/KB/00070');
  assert.equal(toDecimalString(note.lines[0]!.unitPrice!), '5.00');
  const customer = await partyBalance(f.store.read(), COMPANY, CUSTOMER);
  assert.equal(toDecimalString(customer.balance), '7847.00');
  const stock = await f.inventory.balance(actor, { itemId: 'APPLE', warehouseId: 'shop' });
  assert.equal(stock.physical.scaled, 0n, 'a price correction never moves goods');
  assert.equal(f.audit.events.filter((event) => event.action === 'return.sales_price_corrected').length, 1);
});

test('#293: "amount off" credits that amount before GST', async () => {
  const f = await setup();
  const preview = await f.service.previewPriceCorrection(actor, amountOff(rupees(700)));
  assert.equal(toDecimalString(preview.totals.taxableValue), '700.00');
  assert.equal(toDecimalString(preview.totals.total), '826.00');
});

test('#293: a higher price makes a debit note to the customer, numbered in the debit-note series', async () => {
  const f = await setup();
  const { note } = await f.service.postPriceCorrection(actor, correction({ idempotencyKey: 'price-up', newUnitPrice: rupees(110), reason: 'Under-charged: rate is ₹110.' }));
  assert.equal(note.kind, 'SALES_DEBIT_NOTE');
  assert.match(note.number, /^DN\/26-27\/0000001$/);
  assert.equal(toDecimalString(note.totals.taxableValue), '700.00');
  assert.equal(toDecimalString(note.totals.total), '826.00');
  const customer = await partyBalance(f.store.read(), COMPANY, CUSTOMER);
  assert.equal(toDecimalString(customer.balance), '9086.00');
});

test('#293: a retry is the same note; wrong input is refused and nothing is posted', async () => {
  const f = await setup();
  const first = await f.service.postPriceCorrection(actor, correction());
  const again = await f.service.postPriceCorrection(actor, correction());
  assert.equal(again.deduplicated, true);
  assert.equal(again.note.id, first.note.id);
  assert.equal((await f.notes.list(COMPANY)).length, 1);
  await assert.rejects(f.service.previewPriceCorrection(actor, correction({ idempotencyKey: 'same', newUnitPrice: rupees(95) })), code('PRICE_CORRECTION_NO_CHANGE'));
  await assert.rejects(f.service.previewPriceCorrection(actor, correction({ idempotencyKey: 'both', amountOff: rupees(1) })), code('PRICE_CORRECTION_ONE_FIGURE'));
  await assert.rejects(f.service.previewPriceCorrection(actor, (() => { const { newUnitPrice: _price, ...rest } = correction({ idempotencyKey: 'neither' }); return rest; })()), code('PRICE_CORRECTION_ONE_FIGURE'));
  await assert.rejects(f.service.previewPriceCorrection(actor, amountOff(rupees(6651), { idempotencyKey: 'huge' })), code('PRICE_CORRECTION_MORE_THAN_CHARGED'));
  await assert.rejects(f.service.previewPriceCorrection(actor, correction({ idempotencyKey: 'no-reason', reason: ' ' })), code('PRICE_CORRECTION_REASON_REQUIRED'));
  await assert.rejects(f.service.previewPriceCorrection(actor, correction({ idempotencyKey: 'no-line', originalLineId: 'nope' })), code('RETURN_LINE_NOT_FOUND'));
  await assert.rejects(f.service.previewPriceCorrection(actor, correction({ idempotencyKey: 'late', documentDate: isoDate('2027-12-01'), newUnitPrice: rupees(90) })), code('RETURN_CREDIT_NOTE_TOO_LATE'));
  await assert.rejects(f.service.previewPriceCorrection({ ...actor, companyId: OTHER }, correction({ idempotencyKey: 'other' })), code('RETURN_ORIGINAL_NOT_FOUND'));
  await assert.rejects(f.service.previewPriceCorrection({ ...actor, permissions: [] }, correction({ idempotencyKey: 'clerk' })));
  assert.equal((await f.notes.list(COMPANY)).length, 1);
});

test('#293: a debit note has no 30 November limit (s.34(3) sets none)', async () => {
  const f = await setup();
  const preview = await f.service.previewPriceCorrection(actor, correction({ idempotencyKey: 'late-up', documentDate: isoDate('2027-12-01'), newUnitPrice: rupees(101) }));
  assert.equal(preview.kind, 'SALES_DEBIT_NOTE');
});

test('#293: goods returned after a price cut are credited at the cut price, and the price note never uses up quantity', async () => {
  const f = await setup();
  await f.service.postPriceCorrection(actor, correction());
  const back = await f.service.previewSales(actor, {
    idempotencyKey: 'return-after-cut', originalInvoiceId: 'invoice-70', documentDate: isoDate('2026-08-30'), reason: 'Ten boxes came back.',
    lines: [{ originalLineId: 'line-apples', quantity: quantityFromString('70', 'BOX'), disposition: 'ACCEPTED' }],
  });
  // All 70 boxes are still returnable, at ₹95: ₹6,650 + 18% = ₹7,847 — exactly what is still owed.
  assert.equal(toDecimalString(back.totals.taxableValue), '6650.00');
  assert.equal(toDecimalString(back.totals.total), '7847.00');
});

test('#293: two corrections at once both count: the second sees the first', async () => {
  const f = await setup();
  const [a, b] = await Promise.allSettled([
    f.service.postPriceCorrection(actor, amountOff(rupees(4000), { idempotencyKey: 'cut-a' })),
    f.service.postPriceCorrection(actor, amountOff(rupees(4000), { idempotencyKey: 'cut-b' })),
  ]);
  assert.equal([a, b].filter((outcome) => outcome.status === 'fulfilled').length, 1, 'the bill is only worth ₹7,000, so only one ₹4,000 cut fits');
  const customer = await partyBalance(f.store.read(), COMPANY, CUSTOMER);
  assert.equal(toDecimalString(customer.balance), toDecimalString(money(826000n - 472000n)));
});
