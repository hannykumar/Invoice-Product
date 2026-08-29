/**
 * Issue #12 [E12] — the mock is gone.
 *
 * Issue #9 was built against `permissiveInventory`, which always said yes. This wires the real
 * stock service into the real sales service and runs the user example from the issue:
 *
 *   "After buying 100 boxes and selling 70, a second sale of 70 is blocked because only 30 remain
 *    unless an authorised override is recorded."
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  asId,
  fixedClock,
  isoDate,
  quantityFromString,
  rupees,
  toDecimalString,
  type CompanyId,
} from '@invoice/kernel';
import {
  buildDefaultChart,
  defaultChartIdFactory,
  InMemoryAuditPort,
  InMemoryLedgerStore,
  LedgerService,
  partyBalance,
  permissionPortFromActor,
  trialBalance,
  type Account,
  type ActorContext,
} from '@invoice/ledger';
import { GstCalculator, InMemoryDeclaredRates, InMemoryMasterData, RateTable } from '@invoice/gst-calc';
import { RulesEngine, shippedRegistry } from '@invoice/rules-engine';
import { InMemorySalesRepository, SalesService, noComplianceHooks } from '@invoice/sales';
import { createDefaultUnitRegistry, formatQuantity, quantity, type UnitRegistry } from '../../masters/src/units.ts';
import { InMemoryInventoryStore } from '../src/repository.ts';
import { InventoryService } from '../src/service.ts';
import { salesInventoryAdapter } from '../src/sales-adapter.ts';
import type { StockItem, StockMasterData, Warehouse } from '../src/ports.ts';

const COMPANY: CompanyId = asId<'Company'>('till-co');
const OWNER = asId<'User'>('till-owner');
const ABC = asId<'Party'>('abc');

const PERMISSIONS = [
  'ledger.setup', 'ledger.post.sale', 'ledger.reverse',
  'sales.draft.write', 'sales.finalise', 'sales.cancel',
  'inventory.move', 'inventory.adjust', 'inventory.transfer', 'inventory.override_negative',
  'sales.approve',
];

const actor: ActorContext = { companyId: COMPANY, branchId: asId<'Branch'>('kb'), userId: OWNER, permissions: PERMISSIONS };

const STOCK_ITEMS: StockItem[] = [
  { itemId: 'APL-BOX-10', name: 'Apple box, 10 kg', baseUnit: 'BOX', tracksBatches: false, tracksSerials: false },
];
const WAREHOUSES: Warehouse[] = [{ warehouseId: 'narela', name: 'Narela godown' }];

class StockMasters implements StockMasterData {
  readonly #registry: UnitRegistry = createDefaultUnitRegistry();
  item(_c: CompanyId, itemId: string): StockItem | undefined {
    return STOCK_ITEMS.find((i) => i.itemId === itemId);
  }
  warehouse(_c: CompanyId, warehouseId: string): Warehouse | undefined {
    return WAREHOUSES.find((w) => w.warehouseId === warehouseId);
  }
  units(): UnitRegistry {
    return this.#registry;
  }
}

let counter = 0;

const makeTill = async (options: { negativeStock?: 'BLOCK' | 'WARN_WITH_OVERRIDE' } = {}) => {
  const store = new InMemoryLedgerStore();
  const salesRepo = new InMemorySalesRepository();
  const inventoryStore = new InMemoryInventoryStore();
  store.join(salesRepo).join(inventoryStore);
  const audit = new InMemoryAuditPort();
  const clock = fixedClock('2026-08-29T10:00:00.000Z');
  counter += 1;
  let n = 0;
  const idFactory = (): string => `i${counter}-${String((n += 1)).padStart(6, '0')}`;

  const ledger = new LedgerService({ store, permissions: permissionPortFromActor, audit, clock, idFactory });
  const customer: Account = {
    id: asId<'Account'>(`${COMPANY}:acc:1201`), companyId: COMPANY, code: '1201', name: 'ABC Traders',
    type: 'ASSET', parentId: asId<'Account'>(`${COMPANY}:acc:1200`), isGroup: false, active: true,
    partyId: ABC, systemRole: null,
  };
  await ledger.initialiseCompany(actor, {
    booksStartDate: isoDate('2026-04-01'),
    accounts: [...buildDefaultChart(COMPANY, defaultChartIdFactory(COMPANY)), customer],
  });

  const inventory = new InventoryService({
    store, inventory: inventoryStore, masterData: new StockMasters(),
    permissions: permissionPortFromActor, audit, clock,
    policy: { negativeStock: options.negativeStock ?? 'BLOCK', reservationMinutes: 120, valuationMethod: 'WEIGHTED_AVERAGE' },
    idFactory,
  });

  const taxMasters = new InMemoryMasterData();
  taxMasters.putCompany({ companyId: COMPANY, gstin: '07AAAAA0000A1Z4', stateCode: '07', registration: 'REGULAR' });
  taxMasters.putParty(COMPANY, { partyId: ABC, gstin: '07DDDDD3333D1ZV', stateCode: '07', registration: 'REGULAR' });
  taxMasters.putItem(COMPANY, {
    itemId: 'APL-BOX-10', name: 'Apple box, 10 kg', kind: 'GOODS', hsnOrSac: '0808',
    treatment: 'NIL_RATED', reverseCharge: false, baseUnit: 'BOX',
  });

  const calculator = new GstCalculator({
    masterData: taxMasters,
    rates: new RateTable([]),
    gstEngine: new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.gst', mode: 'production' }),
    mode: 'production',
    declaredRates: new InMemoryDeclaredRates(),
  });

  const sales = new SalesService({
    store, ledger, calculator, repository: salesRepo,
    inventory: salesInventoryAdapter(inventory, { defaultWarehouseId: 'narela' }),
    compliance: noComplianceHooks,
    permissions: permissionPortFromActor, audit, clock,
    policy: {
      series: { prefix: 'INV', branchCode: 'KB', padding: 5 },
      approvalRequiredAtOrAbove: null, cancellationWindowDays: 7,
      allowCancelAfterGovernmentRegistration: false, defaultDueDays: 30, roundToWholeRupee: true,
    },
    idFactory,
  });

  return { store, sales, inventory, ledger, audit };
};

const sellBoxes = (till: Awaited<ReturnType<typeof makeTill>>, key: string, boxes: string) =>
  till.sales.createDraft(actor, {
    idempotencyKey: key,
    input: {
      partyId: ABC,
      customerType: 'B2B',
      supplyKind: 'GOODS',
      documentDate: isoDate('2026-04-12'),
      lines: [{
        lineId: 'l1', itemId: 'APL-BOX-10',
        quantity: quantityFromString(boxes, 'BOX'), unitPrice: rupees(800), priceBasis: 'EXCLUSIVE',
        warehouseId: 'narela',
      }],
    },
  });

test('buy 100, sell 70, and the second sale of 70 is blocked — the user example, end to end', async () => {
  const till = await makeTill();
  await till.inventory.recordMovement(actor, {
    idempotencyKey: 'buy-100', itemId: 'APL-BOX-10', warehouseId: 'narela', kind: 'PURCHASE_IN',
    quantity: quantity('100', 'BOX'), unitCost: rupees(500),
    documentDate: isoDate('2026-04-04'), source: { kind: 'purchase_invoice', id: 'NF/1187', number: 'NF/1187' },
  });

  const first = await sellBoxes(till, 'sale-1', '70');
  const submitted = await till.sales.submitForApproval(actor, first.id);
  assert.equal(submitted.state, 'PENDING_APPROVAL', 'seventy boxes are there, so the bill goes forward');

  const manager: ActorContext = { ...actor, userId: asId<'User'>('manager') };
  const issued = await till.sales.finalise(manager, { idempotencyKey: 'f1', invoiceId: first.id });
  assert.equal(issued.invoice.state, 'FINAL');

  const afterFirst = await till.inventory.balance(actor, { itemId: 'APL-BOX-10', warehouseId: 'narela' });
  assert.equal(formatQuantity(afterFirst.physical), '30.000 BOX');
  assert.equal(formatQuantity(afterFirst.available), '30.000 BOX');

  // The second sale of seventy.
  const second = await sellBoxes(till, 'sale-2', '70');
  const blocked = await till.sales.submitForApproval(actor, second.id);
  assert.equal(blocked.state, 'NEEDS_INFO');
  assert.equal(blocked.problems[0]?.messageId, 'stock.not_enough');
  assert.match(
    blocked.problems[0]?.message['en-IN'] ?? '',
    /You have 30\.000 BOX of Apple box, 10 kg at Narela godown\. This bill needs 70\.000 BOX, so 40\.000 BOX are missing\./,
  );

  assert.ok((await trialBalance(till.store.read(), COMPANY)).balanced);
  const owed = await partyBalance(till.store.read(), COMPANY, ABC);
  assert.equal(toDecimalString(owed.balance), '56000.00');
});

test('an unfinished bill holds the stock, so a second till cannot promise the same goods', async () => {
  const till = await makeTill();
  await till.inventory.recordMovement(actor, {
    idempotencyKey: 'buy-30', itemId: 'APL-BOX-10', warehouseId: 'narela', kind: 'PURCHASE_IN',
    quantity: quantity('30', 'BOX'), documentDate: isoDate('2026-04-04'),
    source: { kind: 'purchase_invoice', id: 'p', number: null },
  });

  const first = await sellBoxes(till, 'sale-1', '30');
  await till.sales.submitForApproval(actor, first.id);

  const second = await sellBoxes(till, 'sale-2', '30');
  const blocked = await till.sales.submitForApproval(actor, second.id);
  assert.equal(blocked.state, 'NEEDS_INFO', 'the first bill is holding all thirty');
  assert.match(blocked.problems[0]?.message['en-IN'] ?? '', /You have 0\.000 BOX/);
});

test('cancelling an issued bill puts the goods back on the shelf', async () => {
  const till = await makeTill();
  await till.inventory.recordMovement(actor, {
    idempotencyKey: 'buy-100', itemId: 'APL-BOX-10', warehouseId: 'narela', kind: 'PURCHASE_IN',
    quantity: quantity('100', 'BOX'), documentDate: isoDate('2026-04-04'),
    source: { kind: 'purchase_invoice', id: 'p', number: null },
  });
  const draft = await sellBoxes(till, 'sale-1', '70');
  await till.sales.finalise(actor, { idempotencyKey: 'f1', invoiceId: draft.id });
  assert.equal(formatQuantity((await till.inventory.balance(actor, { itemId: 'APL-BOX-10', warehouseId: 'narela' })).physical), '30.000 BOX');

  await till.sales.cancel(actor, {
    idempotencyKey: 'c1', invoiceId: draft.id, reason: 'Customer changed the order', today: isoDate('2026-04-14'),
  });

  const afterCancel = await till.inventory.balance(actor, { itemId: 'APL-BOX-10', warehouseId: 'narela' });
  assert.equal(formatQuantity(afterCancel.physical), '100.000 BOX');
  const movements = await till.inventory.movementsFor(actor, { itemId: 'APL-BOX-10' });
  assert.equal(movements.length, 3, 'the sale is still on the record, undone rather than removed');
  assert.ok((await trialBalance(till.store.read(), COMPANY)).balanced);
  const owed = await partyBalance(till.store.read(), COMPANY, ABC);
  assert.equal(toDecimalString(owed.balance), '0.00');
});

test('a business that allows it can oversell, and the override is on the record', async () => {
  const till = await makeTill({ negativeStock: 'WARN_WITH_OVERRIDE' });
  await till.inventory.recordMovement(actor, {
    idempotencyKey: 'buy-30', itemId: 'APL-BOX-10', warehouseId: 'narela', kind: 'PURCHASE_IN',
    quantity: quantity('30', 'BOX'), documentDate: isoDate('2026-04-04'),
    source: { kind: 'purchase_invoice', id: 'p', number: null },
  });

  // The hold still refuses, because holding is about what can be promised.
  const draft = await sellBoxes(till, 'sale-1', '70');
  const blocked = await till.sales.submitForApproval(actor, draft.id);
  assert.equal(blocked.state, 'NEEDS_INFO');

  // The override belongs on the movement, where a person names it and takes responsibility.
  const overridden = await till.inventory.recordMovement(actor, {
    idempotencyKey: 'oversell', itemId: 'APL-BOX-10', warehouseId: 'narela', kind: 'SALE_OUT',
    quantity: quantity('70', 'BOX'), documentDate: isoDate('2026-04-12'),
    source: { kind: 'sales_invoice', id: draft.id, number: null },
    negativeOverride: { reason: 'Goods are in the van, supplier bill still coming' },
  });
  assert.equal(overridden.negativeOverride?.allowedBy, OWNER);
  const balance = await till.inventory.balance(actor, { itemId: 'APL-BOX-10', warehouseId: 'narela' });
  assert.equal(formatQuantity(balance.physical), '-40.000 BOX', 'the shortfall is visible, not hidden');
  assert.equal(
    till.audit.events.filter((e) => e.action === 'inventory.negative_stock_allowed').length,
    1,
  );
});

test('a services bill never touches stock', async () => {
  const till = await makeTill();
  const draft = await till.sales.createDraft(actor, {
    idempotencyKey: 'svc',
    input: {
      partyId: ABC, customerType: 'B2B', supplyKind: 'SERVICES', documentDate: isoDate('2026-04-12'),
      placeOfSupplyStateCode: '07',
      lines: [{ lineId: 'l1', itemId: 'APL-BOX-10', quantity: quantityFromString('1', 'BOX'), unitPrice: rupees(500), priceBasis: 'EXCLUSIVE' }],
    },
  });
  await till.sales.submitForApproval(actor, draft.id);
  assert.equal((await till.inventory.movementsFor(actor, {})).length, 0);
});
