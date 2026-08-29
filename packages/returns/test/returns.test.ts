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
  type OriginalSalesDocument, type SalesReturnCommand,
} from '../src/index.ts';

const COMPANY = asId<'Company'>('returns-company');
const OTHER = asId<'Company'>('returns-other');
const CUSTOMER = asId<'Party'>('returns-customer');
const actor: ActorContext = {
  companyId: COMPANY, branchId: asId<'Branch'>('main'), userId: asId<'User'>('priya'),
  permissions: ['ledger.setup', 'ledger.post.sale', 'ledger.post.credit_note', 'returns.create', 'inventory.move'],
};

class Masters implements StockMasterData {
  readonly #units = createDefaultUnitRegistry();
  readonly #items: StockItem[] = [{ itemId: 'APPLE', name: 'Apple box', baseUnit: 'BOX', tracksBatches: false, tracksSerials: false }];
  readonly #warehouses: Warehouse[] = [{ warehouseId: 'shop', name: 'Main shop' }, { warehouseId: 'damaged', name: 'Damaged stock' }];
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

const command = (overrides: Partial<SalesReturnCommand> = {}): SalesReturnCommand => ({
  idempotencyKey: 'return-apples-10', originalInvoiceId: 'invoice-70', documentDate: isoDate('2026-08-30'),
  reason: 'Ten boxes were damaged in transit.',
  lines: [{ originalLineId: 'line-apples', quantity: quantityFromString('10', 'BOX'), disposition: 'ACCEPTED' }],
  ...overrides,
});

test('a partial sales return credits the customer, reverses GST and puts accepted goods back atomically', async () => {
  const f = await setup();
  const preview = await f.service.previewSales(actor, command());
  assert.equal(toDecimalString(preview.totals.taxableValue), '1000.00');
  assert.equal(toDecimalString(preview.totals.cgst), '90.00');
  assert.equal(toDecimalString(preview.totals.sgst), '90.00');
  assert.equal(toDecimalString(preview.totals.total), '1180.00');
  assert.equal(preview.complianceStatus, 'PENDING_ADJUSTMENT');

  const result = await f.service.postSales(actor, command());
  assert.equal(result.deduplicated, false);
  assert.match(result.note.number, /^CN\/000001$/);
  assert.equal(result.note.originalDocument.number, 'INV/KB/00070');
  const customer = await partyBalance(f.store.read(), COMPANY, CUSTOMER);
  assert.equal(toDecimalString(customer.balance), '7080.00');
  const stock = await f.inventory.balance(actor, { itemId: 'APPLE', warehouseId: 'shop' });
  assert.equal(stock.physical.scaled, quantityFromString('10', 'BOX').scaled);
  assert.equal(f.audit.events.filter((event) => event.action === 'return.sales_posted').length, 1);
});

test('a retry returns the same note and never doubles stock or credit', async () => {
  const f = await setup();
  const first = await f.service.postSales(actor, command());
  const retried = await f.service.postSales(actor, command());
  assert.equal(retried.deduplicated, true);
  assert.equal(retried.note.id, first.note.id);
  const stock = await f.inventory.balance(actor, { itemId: 'APPLE', warehouseId: 'shop' });
  assert.equal(stock.physical.scaled, quantityFromString('10', 'BOX').scaled);
  assert.equal((await f.notes.listForOriginal(COMPANY, 'invoice-70')).length, 1);
});

test('partial returns share one eligibility ceiling, including concurrent attempts', async () => {
  const f = await setup();
  await f.service.postSales(actor, command());
  await assert.rejects(
    f.service.previewSales(actor, command({ idempotencyKey: 'too-many', lines: [{ originalLineId: 'line-apples', quantity: quantityFromString('61', 'BOX'), disposition: 'ACCEPTED' }] })),
    (error: any) => error.code === 'RETURN_QUANTITY_EXCEEDS_ELIGIBLE',
  );
  const attempts = await Promise.allSettled([
    f.service.postSales(actor, command({ idempotencyKey: 'forty-a', lines: [{ originalLineId: 'line-apples', quantity: quantityFromString('40', 'BOX'), disposition: 'ACCEPTED' }] })),
    f.service.postSales(actor, command({ idempotencyKey: 'forty-b', lines: [{ originalLineId: 'line-apples', quantity: quantityFromString('40', 'BOX'), disposition: 'ACCEPTED' }] })),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);
});

test('scrapped and replacement dispositions leave no sellable stock but keep both movements', async () => {
  for (const disposition of ['SCRAPPED', 'REPLACEMENT'] as const) {
    const f = await setup();
    const result = await f.service.postSales(actor, command({
      idempotencyKey: `return-${disposition}`, lines: [{ originalLineId: 'line-apples', quantity: quantityFromString('10', 'BOX'), disposition }],
    }));
    const stock = await f.inventory.balance(actor, { itemId: 'APPLE', warehouseId: 'shop' });
    assert.equal(stock.physical.scaled, 0n);
    const movements = await f.inventory.movementsFor(actor, { itemId: 'APPLE', warehouseId: 'shop' });
    assert.deepEqual(movements.map((movement) => movement.kind), ['SALES_RETURN_IN', disposition === 'SCRAPPED' ? 'ADJUSTMENT_OUT' : 'SALE_OUT']);
    assert.ok(movements.every((movement) => movement.source.id === result.note.id));
  }
});

test('an inventory refusal rolls back the credit note, customer credit and return record', async () => {
  const f = await setup();
  await assert.rejects(
    f.service.postSales(actor, command({ lines: [{ originalLineId: 'line-apples', quantity: quantityFromString('10', 'BOX'), disposition: 'ACCEPTED', warehouseId: 'missing' }] })),
    (error: any) => error.code === 'STOCK_WAREHOUSE_UNKNOWN',
  );
  assert.equal((await f.notes.listForOriginal(COMPANY, 'invoice-70')).length, 0);
  const creditNotes = await f.store.read().vouchers.list(COMPANY, { types: ['CREDIT_NOTE'] });
  assert.equal(creditNotes.length, 0);
  const customer = await partyBalance(f.store.read(), COMPANY, CUSTOMER);
  assert.equal(toDecimalString(customer.balance), '8260.00');
});

test('another company cannot discover or return this company\'s invoice', async () => {
  const f = await setup();
  const outsider = { ...actor, companyId: OTHER };
  await assert.rejects(f.service.previewSales(outsider, command()), (error: any) => error.code === 'RETURN_ORIGINAL_NOT_FOUND');
});
