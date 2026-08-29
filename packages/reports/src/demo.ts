/**
 * Issue #35 [E35] — a month of a real business, reported, that you can open in a browser.
 *
 * Nothing here is staged. Stock is bought in, bills are raised and issued through the sales
 * service, money is taken — a part payment, a cheque that has not cleared, an advance against no
 * bill — and then the reports are asked for. Every figure on the page comes out of the same code
 * a real business would run, and every total opens into the entries behind it.
 *
 *   npm run demo:reports
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  asId,
  fixedClock,
  formatINR,
  isoDate,
  quantityFromString,
  rupees,
  type BranchId,
  type CompanyId,
  type Money,
  type PartyId,
} from '@invoice/kernel';
import {
  InMemoryAuditPort,
  InMemoryLedgerStore,
  LedgerService,
  buildDefaultChart,
  defaultChartIdFactory,
  permissionPortFromActor,
  type Account,
  type ActorContext,
} from '@invoice/ledger';
import { FIXTURE_RATE_TABLE, GstCalculator, InMemoryMasterData, type ItemTaxClassification } from '@invoice/gst-calc';
import { RulesEngine, shippedRegistry } from '@invoice/rules-engine';
import { DEFAULT_SALES_POLICY, InMemorySalesRepository, SalesService, noComplianceHooks } from '@invoice/sales';
import {
  InMemoryInventoryStore,
  InventoryService,
  salesInventoryAdapter,
  type StockItem,
  type StockMasterData,
  type Warehouse,
} from '@invoice/inventory';
import {
  InMemoryPaymentRepository,
  ReceivablesService,
  type DocumentLedgerPort,
  type OpenDocument,
} from '@invoice/receivables';
import { createDefaultUnitRegistry, type UnitRegistry } from '../../masters/src/units.ts';
import { duesFrom, namesFrom, purchasesNotBuiltYet } from './ports.ts';
import { ReportService } from './service.ts';
import { renderPack } from './render.ts';
import { exportReport, registerTable, trialBalanceTable } from './export.ts';

const COMPANY: CompanyId = asId<'Company'>('demo-sharma');
const KAROL_BAGH: BranchId = asId<'Branch'>('kb');
const NARELA: BranchId = asId<'Branch'>('narela');
const ABC: PartyId = asId<'Party'>('abc-traders');
const GURUGRAM: PartyId = asId<'Party'>('gurugram-fresh');
const OWNER = asId<'User'>('demo-owner');

const PERMISSIONS = [
  'ledger.setup', 'ledger.post.sale', 'ledger.post.receipt', 'ledger.post.journal', 'ledger.reverse',
  'sales.draft.write', 'sales.finalise', 'sales.approve', 'sales.cancel',
  'inventory.move', 'inventory.adjust', 'inventory.transfer',
  'payments.record', 'payments.allocate',
  'reports.view.financial', 'reports.view.sales', 'reports.view.purchase', 'reports.view.stock',
  'reports.view.dues', 'reports.view.gst', 'reports.view.exceptions', 'reports.export',
];

const actorAt = (branchId: BranchId): ActorContext => ({
  companyId: COMPANY,
  branchId,
  userId: OWNER,
  permissions: PERMISSIONS,
});

const ITEMS: ItemTaxClassification[] = [
  { itemId: 'APL-BOX-10', name: 'Apple box, 10 kg', kind: 'GOODS', hsnOrSac: '0808', treatment: 'NIL_RATED', reverseCharge: false, baseUnit: 'BOX' },
  { itemId: 'CRATE-P', name: 'Plastic crate', kind: 'GOODS', hsnOrSac: '3923', treatment: 'TAXABLE', reverseCharge: false, baseUnit: 'PCS' },
];

const STOCK_ITEMS: StockItem[] = [
  { itemId: 'APL-BOX-10', name: 'Apple box, 10 kg', baseUnit: 'BOX', tracksBatches: false, tracksSerials: false },
  { itemId: 'CRATE-P', name: 'Plastic crate', baseUnit: 'PCS', tracksBatches: false, tracksSerials: false },
];

const WAREHOUSES: Warehouse[] = [
  { warehouseId: 'shop', name: 'Karol Bagh shop' },
  { warehouseId: 'godown', name: 'Narela godown' },
];

class Masters implements StockMasterData {
  readonly #registry: UnitRegistry = createDefaultUnitRegistry();
  item(_companyId: CompanyId, itemId: string): StockItem | undefined {
    return STOCK_ITEMS.find((i) => i.itemId === itemId);
  }
  warehouse(_companyId: CompanyId, warehouseId: string): Warehouse | undefined {
    return WAREHOUSES.find((w) => w.warehouseId === warehouseId);
  }
  units(): UnitRegistry {
    return this.#registry;
  }
}

const NAMES: Record<string, string> = { [ABC]: 'ABC Traders', [GURUGRAM]: 'Gurugram Fresh Mart' };

class IssuedBills implements DocumentLedgerPort {
  readonly #repository: InMemorySalesRepository;
  constructor(repository: InMemorySalesRepository) {
    this.#repository = repository;
  }
  async #all(companyId: CompanyId): Promise<OpenDocument[]> {
    const invoices = (await this.#repository.list(companyId)).filter((i) => i.state === 'FINAL');
    return invoices.map((invoice) => ({
      documentId: invoice.id,
      kind: 'SALES_INVOICE' as const,
      number: invoice.number ?? invoice.id,
      partyId: invoice.partyId,
      date: invoice.documentDate,
      dueDate: invoice.dueDate,
      value: invoice.pricing?.totals.invoiceValue ?? rupees(0),
      side: 'RECEIVABLE' as const,
    }));
  }
  async openDocuments(companyId: CompanyId, partyId: PartyId): Promise<readonly OpenDocument[]> {
    return (await this.#all(companyId)).filter((d) => d.partyId === partyId);
  }
  async parties(companyId: CompanyId): Promise<readonly PartyId[]> {
    return [...new Set((await this.#all(companyId)).map((d) => d.partyId))];
  }
  async nameOf(_companyId: CompanyId, partyId: PartyId): Promise<string> {
    return NAMES[partyId] ?? partyId;
  }
}

const partyAccount = (party: PartyId, code: string, name: string): Account => ({
  id: asId<'Account'>(`${COMPANY}:acc:${code}`),
  companyId: COMPANY,
  code,
  name,
  type: 'ASSET',
  parentId: asId<'Account'>(`${COMPANY}:acc:1200`),
  isGroup: false,
  active: true,
  partyId: party,
  systemRole: null,
});

const main = async (): Promise<void> => {
  const store = new InMemoryLedgerStore();
  const salesRepository = new InMemorySalesRepository();
  const inventoryStore = new InMemoryInventoryStore();
  const paymentRepository = new InMemoryPaymentRepository();
  store.join(salesRepository);
  store.join(inventoryStore);
  store.join(paymentRepository);

  const audit = new InMemoryAuditPort();
  const clock = fixedClock('2026-08-29T10:30:00.000Z');
  let n = 0;
  const idFactory = (): string => `demo-${String((n += 1)).padStart(6, '0')}`;

  const ledger = new LedgerService({ store, permissions: permissionPortFromActor, audit, clock, idFactory });
  await ledger.initialiseCompany(actorAt(KAROL_BAGH), {
    booksStartDate: isoDate('2026-04-01'),
    accounts: [
      ...buildDefaultChart(COMPANY, defaultChartIdFactory(COMPANY)),
      partyAccount(ABC, '1201', 'ABC Traders'),
      partyAccount(GURUGRAM, '1202', 'Gurugram Fresh Mart'),
    ],
  });

  const masterData = new InMemoryMasterData();
  masterData.putCompany({ companyId: COMPANY, gstin: '07AAAAA0000A1Z4', stateCode: '07', registration: 'REGULAR' });
  masterData
    .putParty(COMPANY, { partyId: ABC, gstin: '07DDDDD3333D1ZV', stateCode: '07', registration: 'REGULAR' })
    .putParty(COMPANY, { partyId: GURUGRAM, gstin: '06BBBBB1111B1ZR', stateCode: '06', registration: 'REGULAR' });
  for (const item of ITEMS) masterData.putItem(COMPANY, item);

  const inventory = new InventoryService({
    store,
    inventory: inventoryStore,
    masterData: new Masters(),
    permissions: permissionPortFromActor,
    audit,
    clock,
    policy: { negativeStock: 'BLOCK', reservationMinutes: 120, valuationMethod: 'WEIGHTED_AVERAGE' },
    idFactory,
  });

  const sales = new SalesService({
    store,
    ledger,
    calculator: new GstCalculator({
      masterData,
      rates: FIXTURE_RATE_TABLE,
      gstEngine: new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.gst', mode: 'development' }),
      mode: 'development',
    }),
    repository: salesRepository,
    inventory: salesInventoryAdapter(inventory, { defaultWarehouseId: 'shop' }),
    compliance: noComplianceHooks,
    permissions: permissionPortFromActor,
    audit,
    clock,
    policy: { ...DEFAULT_SALES_POLICY, series: { prefix: 'INV', branchCode: 'KB', padding: 5 } },
    idFactory,
  });

  const documents = new IssuedBills(salesRepository);
  const receivables = new ReceivablesService({
    store, ledger, repository: paymentRepository, documents,
    permissions: permissionPortFromActor, audit, clock, idFactory,
  });

  const reports = new ReportService({
    store,
    sales: salesRepository,
    inventory: inventoryStore,
    stockMasterData: new Masters(),
    dues: duesFrom(documents, receivables),
    // The purchase side is GPT 3's issue #17 and is not built. The page says so rather than
    // showing an empty table an owner would read as "I bought nothing this month".
    purchases: purchasesNotBuiltYet,
    names: namesFrom({
      parties: NAMES,
      items: { 'APL-BOX-10': 'Apple box, 10 kg', 'CRATE-P': 'Plastic crate' },
      warehouses: { shop: 'Karol Bagh shop', godown: 'Narela godown' },
      branches: { [KAROL_BAGH]: 'Karol Bagh shop', [NARELA]: 'Narela godown' },
    }),
    permissions: permissionPortFromActor,
    audit,
    clock,
  });

  const buy = async (itemId: string, warehouseId: string, amount: string, unit: string, cost: Money, when: string, key: string) => {
    await inventory.recordMovement(actorAt(KAROL_BAGH), {
      idempotencyKey: key,
      itemId,
      warehouseId,
      kind: 'PURCHASE_IN',
      quantity: { micro: quantityFromString(amount, unit).scaled, unitCode: unit },
      documentDate: isoDate(when),
      source: { kind: 'purchase_invoice', id: key, number: key.toUpperCase() },
      unitCost: cost,
    });
  };

  const bill = async (
    partyId: PartyId,
    when: string,
    due: string,
    lines: readonly { itemId: string; amount: string; unit: string; price: Money; warehouseId?: string }[],
    branchId: BranchId,
    key: string,
  ) => {
    const actor = actorAt(branchId);
    const draft = await sales.createDraft(actor, {
      idempotencyKey: key,
      input: {
        partyId,
        customerType: 'B2B',
        supplyKind: 'GOODS',
        documentDate: isoDate(when),
        dueDate: isoDate(due),
        lines: lines.map((line, index) => ({
          lineId: `l${index + 1}`,
          itemId: line.itemId,
          quantity: quantityFromString(line.amount, line.unit),
          unitPrice: line.price,
          priceBasis: 'EXCLUSIVE' as const,
          warehouseId: line.warehouseId ?? 'shop',
        })),
      },
    });
    const result = await sales.finalise(actor, { invoiceId: draft.id, idempotencyKey: `${key}-final` });
    return result.invoice;
  };

  await buy('CRATE-P', 'shop', '300', 'PCS', rupees(50), '2026-04-03', 'buy-crates-shop');
  await buy('CRATE-P', 'godown', '100', 'PCS', rupees(55), '2026-04-04', 'buy-crates-godown');
  await buy('APL-BOX-10', 'shop', '100', 'BOX', rupees(300), '2026-04-02', 'buy-apples');

  const first = await bill(ABC, '2026-04-10', '2026-05-10', [{ itemId: 'CRATE-P', amount: '20', unit: 'PCS', price: rupees(100) }], KAROL_BAGH, 'bill-a');
  const second = await bill(GURUGRAM, '2026-04-15', '2026-05-15', [{ itemId: 'CRATE-P', amount: '30', unit: 'PCS', price: rupees(120) }], KAROL_BAGH, 'bill-b');
  await bill(ABC, '2026-05-05', '2026-06-04', [{ itemId: 'CRATE-P', amount: '10', unit: 'PCS', price: rupees(110), warehouseId: 'godown' }], NARELA, 'bill-c');

  await receivables.recordPayment(actorAt(KAROL_BAGH), {
    idempotencyKey: 'pay-part',
    direction: 'RECEIPT',
    partyId: ABC,
    mode: 'CASH',
    amount: rupees(1000),
    date: isoDate('2026-04-20'),
    allocations: [{ documentId: first.id, documentNumber: first.number ?? first.id, amount: rupees(1000) }],
  });

  await receivables.recordPayment(actorAt(KAROL_BAGH), {
    idempotencyKey: 'pay-cheque',
    direction: 'RECEIPT',
    partyId: GURUGRAM,
    mode: 'CHEQUE',
    amount: rupees(2000),
    date: isoDate('2026-05-02'),
    cheque: { number: '004521', chequeDate: isoDate('2026-05-02'), bankName: 'HDFC Bank' },
    allocations: [{ documentId: second.id, documentNumber: second.number ?? second.id, amount: rupees(2000) }],
  });

  await receivables.recordPayment(actorAt(KAROL_BAGH), {
    idempotencyKey: 'pay-advance',
    direction: 'RECEIPT',
    partyId: ABC,
    mode: 'CASH',
    amount: rupees(500),
    date: isoDate('2026-05-06'),
  });

  const filter = { from: isoDate('2026-04-01'), to: isoDate('2026-05-31') };
  const owner = actorAt(KAROL_BAGH);
  const pack = await reports.pack(owner, filter);

  const outDir = join(process.cwd(), 'tmp', 'reports');
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];

  for (const locale of ['en-IN', 'hi-IN'] as const) {
    const file = join(outDir, `sharma-fruit-traders-${locale}.html`);
    writeFileSync(file, renderPack(pack, 'Sharma Fruit Traders', locale), 'utf8');
    written.push(file);
  }

  // One shop on its own, to show the branch filter is a real filter and not a label.
  const narelaOnly = await reports.pack(owner, { ...filter, branchId: NARELA });
  const narelaFile = join(outDir, 'narela-godown-only-en-IN.html');
  writeFileSync(narelaFile, renderPack(narelaOnly, 'Sharma Fruit Traders — Narela godown', 'en-IN'), 'utf8');
  written.push(narelaFile);

  const csv = join(outDir, 'sales-register.csv');
  writeFileSync(csv, exportReport(pack.sales, registerTable(pack.sales.body), 'CSV'), 'utf8');
  written.push(csv);
  const json = join(outDir, 'trial-balance.json');
  writeFileSync(json, exportReport(pack.trialBalance, trialBalanceTable(pack.trialBalance.body), 'JSON'), 'utf8');
  written.push(json);

  console.log(`Sharma Fruit Traders, ${filter.from} to ${filter.to}\n`);
  console.log(`  ${pack.profitAndLoss.body.sentence['en-IN']}`);
  console.log(`  ${pack.balanceSheet.body.sentence['en-IN']}`);
  console.log(`  ${pack.stock.body.sentence['en-IN']}`);
  console.log(`  ${pack.receivables.body.sentence['en-IN']}`);
  console.log(`  ${pack.gst.body.sentence['en-IN']}`);
  console.log(`\nDo the books hold together? ${pack.trialBalance.body.balanced ? 'Yes' : 'No'} — both sides come to ${formatINR(pack.trialBalance.body.totalDebits.amount)}.`);
  console.log(`Bills in the period: ${pack.sales.body.rows.length}. In the Narela godown alone: ${narelaOnly.sales.body.rows.length}.\n`);
  console.log('Things worth a second look:');
  for (const problem of pack.exceptions.body.exceptions) console.log(`  - ${problem.what['en-IN']}`);
  console.log('\nOpen any of these in a browser. Click a total to see the entries behind it.\n');
  for (const file of written) console.log(`  ${file}`);
};

await main();
