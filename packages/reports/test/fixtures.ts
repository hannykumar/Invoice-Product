/**
 * Issue #35 [E35] — the golden dataset the reports are checked against.
 *
 * This is not a set of hand-written figures. It is a real business run through the real modules:
 * stock bought into two godowns, bills raised and issued through `SalesService`, money taken
 * through `ReceivablesService`, including a part payment, a cheque that has not cleared and money
 * that arrived against no bill at all. Every report is then checked against what those modules
 * recorded, which is the only way "totals reconcile to the ledger" can mean anything.
 *
 * Sharma Fruit Traders, Delhi: two shops, apples and crates, one customer in Delhi and one in
 * Haryana so both kinds of GST appear.
 */
import {
  asId,
  fixedClock,
  isoDate,
  quantityFromString,
  rupees,
  type BranchId,
  type CompanyId,
  type IsoDate,
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
import { InMemorySalesRepository, SalesService, DEFAULT_SALES_POLICY, noComplianceHooks } from '@invoice/sales';
import {
  InMemoryInventoryStore,
  InventoryService,
  salesInventoryAdapter,
  type StockItem,
  type StockMasterData,
  type Warehouse,
} from '@invoice/inventory';
import { InMemoryPaymentRepository, ReceivablesService, type DocumentLedgerPort, type OpenDocument } from '@invoice/receivables';
import { createDefaultUnitRegistry, type UnitRegistry } from '../../masters/src/units.ts';
import { duesFrom, namesFrom, purchasesFrom, type PurchaseDocument } from '../src/ports.ts';
import { ReportService } from '../src/service.ts';

export const SHARMA: CompanyId = asId<'Company'>('reports-sharma');
export const OTHER: CompanyId = asId<'Company'>('reports-other');
export const KAROL_BAGH: BranchId = asId<'Branch'>('kb');
export const NARELA: BranchId = asId<'Branch'>('narela');
export const ABC: PartyId = asId<'Party'>('abc-traders');
export const GURUGRAM: PartyId = asId<'Party'>('gurugram-fresh');
export const NASHIK: PartyId = asId<'Party'>('nashik-farms');
export const PRIYA = asId<'User'>('reports-priya');

export const ALL_PERMISSIONS = [
  'ledger.setup',
  'ledger.post.sale',
  'ledger.post.receipt',
  'ledger.post.payment',
  'ledger.post.journal',
  'ledger.post.purchase',
  'ledger.reverse',
  'sales.draft.write',
  'sales.finalise',
  'sales.approve',
  'sales.cancel',
  'inventory.move',
  'inventory.adjust',
  'inventory.transfer',
  'payments.record',
  'payments.allocate',
  'payments.reverse',
  'payments.write_off',
  'reports.view.financial',
  'reports.view.sales',
  'reports.view.purchase',
  'reports.view.stock',
  'reports.view.dues',
  'reports.view.gst',
  'reports.view.exceptions',
  'reports.export',
];

export const actorWith = (
  permissions: readonly string[],
  options: { companyId?: CompanyId; branchId?: BranchId } = {},
): ActorContext => ({
  companyId: options.companyId ?? SHARMA,
  branchId: options.branchId ?? KAROL_BAGH,
  userId: PRIYA,
  permissions,
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

/**
 * Issued bills, as the receivables module wants to see them.
 *
 * This is the join #20's contract says the caller makes: sales invoices come from #9, purchase
 * bills will come from #17. It lives in the fixture rather than in the package because deciding
 * what an open document is belongs to the modules that own the documents.
 */
export class SalesDocuments implements DocumentLedgerPort {
  readonly #repository: InMemorySalesRepository;
  readonly #extra: OpenDocument[];
  readonly #names: Record<string, string>;

  constructor(repository: InMemorySalesRepository, extra: OpenDocument[], names: Record<string, string>) {
    this.#repository = repository;
    this.#extra = extra;
    this.#names = names;
  }

  async #all(companyId: CompanyId): Promise<OpenDocument[]> {
    const invoices = (await this.#repository.list(companyId)).filter((i) => i.state === 'FINAL');
    return [
      ...invoices.map((invoice) => ({
        documentId: invoice.id,
        kind: 'SALES_INVOICE' as const,
        number: invoice.number ?? invoice.id,
        partyId: invoice.partyId,
        date: invoice.documentDate,
        dueDate: invoice.dueDate,
        value: invoice.pricing?.totals.invoiceValue ?? rupees(0),
        side: 'RECEIVABLE' as const,
      })),
      ...this.#extra,
    ];
  }

  async openDocuments(companyId: CompanyId, partyId: PartyId): Promise<readonly OpenDocument[]> {
    return (await this.#all(companyId)).filter((d) => d.partyId === partyId);
  }

  async parties(companyId: CompanyId): Promise<readonly PartyId[]> {
    return [...new Set((await this.#all(companyId)).map((d) => d.partyId))];
  }

  async nameOf(_companyId: CompanyId, partyId: PartyId): Promise<string> {
    return this.#names[partyId] ?? partyId;
  }
}

const partyAccount = (companyId: CompanyId, party: PartyId, code: string, name: string, receivable: boolean): Account => ({
  id: asId<'Account'>(`${companyId}:acc:${code}`),
  companyId,
  code,
  name,
  type: receivable ? 'ASSET' : 'LIABILITY',
  parentId: asId<'Account'>(`${companyId}:acc:${receivable ? '1200' : '2100'}`),
  isGroup: false,
  active: true,
  partyId: party,
  systemRole: null,
});

export const PARTY_NAMES: Record<string, string> = {
  [ABC]: 'ABC Traders',
  [GURUGRAM]: 'Gurugram Fresh Mart',
  [NASHIK]: 'Nashik Farms',
};

export interface Business {
  readonly reports: ReportService;
  readonly ledger: LedgerService;
  readonly sales: SalesService;
  readonly inventory: InventoryService;
  readonly receivables: ReceivablesService;
  readonly store: InMemoryLedgerStore;
  readonly salesRepository: InMemorySalesRepository;
  readonly inventoryStore: InMemoryInventoryStore;
  readonly audit: InMemoryAuditPort;
  readonly actor: ActorContext;
  readonly documents: SalesDocuments;
}

let counter = 0;

export const makeBusiness = async (
  options: { companyId?: CompanyId; purchases?: readonly PurchaseDocument[]; extraDocuments?: OpenDocument[] } = {},
): Promise<Business> => {
  const companyId = options.companyId ?? SHARMA;
  const store = new InMemoryLedgerStore();
  const salesRepository = new InMemorySalesRepository();
  const inventoryStore = new InMemoryInventoryStore();
  const paymentRepository = new InMemoryPaymentRepository();
  store.join(salesRepository);
  store.join(inventoryStore);
  store.join(paymentRepository);

  const audit = new InMemoryAuditPort();
  const clock = fixedClock('2026-08-29T10:00:00.000Z');
  counter += 1;
  let n = 0;
  const idFactory = (): string => `r${counter}-${String((n += 1)).padStart(8, '0')}`;

  const ledger = new LedgerService({ store, permissions: permissionPortFromActor, audit, clock, idFactory });
  const accounts: Account[] = [
    ...buildDefaultChart(companyId, defaultChartIdFactory(companyId)),
    partyAccount(companyId, ABC, '1201', 'ABC Traders', true),
    partyAccount(companyId, GURUGRAM, '1202', 'Gurugram Fresh Mart', true),
    partyAccount(companyId, NASHIK, '2101', 'Nashik Farms', false),
  ];
  await ledger.initialiseCompany(actorWith(ALL_PERMISSIONS, { companyId }), {
    booksStartDate: isoDate('2026-04-01'),
    accounts,
  });

  const masterData = new InMemoryMasterData();
  masterData.putCompany({ companyId, gstin: '07AAAAA0000A1Z4', stateCode: '07', registration: 'REGULAR' });
  masterData
    .putParty(companyId, { partyId: ABC, gstin: '07DDDDD3333D1ZV', stateCode: '07', registration: 'REGULAR' })
    .putParty(companyId, { partyId: GURUGRAM, gstin: '06BBBBB1111B1ZR', stateCode: '06', registration: 'REGULAR' });
  for (const item of ITEMS) masterData.putItem(companyId, item);

  const inventory = new InventoryService({
    store,
    inventory: inventoryStore,
    masterData: new Masters(),
    permissions: permissionPortFromActor,
    audit,
    clock,
    policy: { negativeStock: 'BLOCK', reservationMinutes: 60, valuationMethod: 'WEIGHTED_AVERAGE' },
    idFactory,
  });

  const calculator = new GstCalculator({
    masterData,
    rates: FIXTURE_RATE_TABLE,
    gstEngine: new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.gst', mode: 'development' }),
    mode: 'development',
  });

  const sales = new SalesService({
    store,
    ledger,
    calculator,
    repository: salesRepository,
    inventory: salesInventoryAdapter(inventory, { defaultWarehouseId: 'shop' }),
    compliance: noComplianceHooks,
    permissions: permissionPortFromActor,
    audit,
    clock,
    policy: { ...DEFAULT_SALES_POLICY, series: { prefix: 'INV', branchCode: 'KB', padding: 5 } },
    idFactory,
  });

  const documents = new SalesDocuments(salesRepository, options.extraDocuments ?? [], PARTY_NAMES);
  const receivables = new ReceivablesService({
    store,
    ledger,
    repository: paymentRepository,
    documents,
    permissions: permissionPortFromActor,
    audit,
    clock,
    idFactory,
  });

  const reports = new ReportService({
    store,
    sales: salesRepository,
    inventory: inventoryStore,
    stockMasterData: new Masters(),
    dues: duesFrom(documents, receivables),
    purchases: purchasesFrom(options.purchases ?? []),
    names: namesFrom({
      parties: PARTY_NAMES,
      items: { 'APL-BOX-10': 'Apple box, 10 kg', 'CRATE-P': 'Plastic crate' },
      warehouses: { shop: 'Karol Bagh shop', godown: 'Narela godown' },
      branches: { [KAROL_BAGH]: 'Karol Bagh shop', [NARELA]: 'Narela godown' },
    }),
    permissions: permissionPortFromActor,
    audit,
    clock,
  });

  return {
    reports,
    ledger,
    sales,
    inventory,
    receivables,
    store,
    salesRepository,
    inventoryStore,
    audit,
    actor: actorWith(ALL_PERMISSIONS, { companyId }),
    documents,
  };
};

export const qty = (value: string, unit: string) => quantityFromString(value, unit);
export const on = (date: string): IsoDate => isoDate(date);
export const inr = (whole: number, paise = 0): Money => rupees(whole, paise);

/** Buys stock in, so a sale has something to leave with and something to be valued at. */
export const buyStock = async (
  business: Business,
  input: { itemId: string; warehouseId: string; quantity: string; unit: string; unitCost: Money; on: string; key: string },
): Promise<void> => {
  await business.inventory.recordMovement(business.actor, {
    idempotencyKey: input.key,
    itemId: input.itemId,
    warehouseId: input.warehouseId,
    kind: 'PURCHASE_IN',
    quantity: { micro: quantityFromString(input.quantity, input.unit).scaled, unitCode: input.unit },
    documentDate: isoDate(input.on),
    source: { kind: 'purchase_invoice', id: input.key, number: input.key },
    unitCost: input.unitCost,
  });
};

/** Raises a bill and issues it, exactly as a shop would. */
export const issueBill = async (
  business: Business,
  input: {
    partyId: PartyId;
    on: string;
    due: string;
    lines: readonly { itemId: string; quantity: string; unit: string; price: Money; warehouseId?: string }[];
    branchId?: BranchId;
    key: string;
  },
): Promise<{ id: string; number: string | null; value: Money }> => {
  const actor = actorWith(ALL_PERMISSIONS, { companyId: business.actor.companyId, branchId: input.branchId ?? KAROL_BAGH });
  const draft = await business.sales.createDraft(actor, {
    idempotencyKey: input.key,
    input: {
      partyId: input.partyId,
      customerType: 'B2B',
      supplyKind: 'GOODS',
      documentDate: isoDate(input.on),
      dueDate: isoDate(input.due),
      lines: input.lines.map((line, index) => ({
        lineId: `l${index + 1}`,
        itemId: line.itemId,
        quantity: quantityFromString(line.quantity, line.unit),
        unitPrice: line.price,
        priceBasis: 'EXCLUSIVE' as const,
        warehouseId: line.warehouseId ?? 'shop',
      })),
    },
  });
  const result = await business.sales.finalise(actor, { invoiceId: draft.id, idempotencyKey: `${input.key}-final` });
  const invoice = result.invoice;
  return { id: invoice.id, number: invoice.number, value: invoice.pricing?.totals.invoiceValue ?? rupees(0) };
};

/**
 * Two months of ordinary trading, with the awkward parts a real month has: a part payment, a
 * cheque that has not cleared, money that arrived against no bill, a bill still waiting to go out,
 * and a second shop so the branch filter has something to filter.
 */
export const aBusyMonth = async (): Promise<Business> => {
  const business = await makeBusiness();

  await buyStock(business, { itemId: 'CRATE-P', warehouseId: 'shop', quantity: '300', unit: 'PCS', unitCost: inr(50), on: '2026-04-03', key: 'buy-crates-shop' });
  await buyStock(business, { itemId: 'CRATE-P', warehouseId: 'godown', quantity: '100', unit: 'PCS', unitCost: inr(55), on: '2026-04-04', key: 'buy-crates-godown' });
  await buyStock(business, { itemId: 'APL-BOX-10', warehouseId: 'shop', quantity: '100', unit: 'BOX', unitCost: inr(300), on: '2026-04-02', key: 'buy-apples' });

  const billA = await issueBill(business, {
    partyId: ABC,
    on: '2026-04-10',
    due: '2026-05-10',
    key: 'bill-a',
    lines: [{ itemId: 'CRATE-P', quantity: '20', unit: 'PCS', price: inr(100) }],
  });
  const billB = await issueBill(business, {
    partyId: GURUGRAM,
    on: '2026-04-15',
    due: '2026-05-15',
    key: 'bill-b',
    lines: [{ itemId: 'CRATE-P', quantity: '30', unit: 'PCS', price: inr(120) }],
  });
  await issueBill(business, {
    partyId: ABC,
    on: '2026-05-05',
    due: '2026-06-04',
    key: 'bill-c',
    branchId: NARELA,
    lines: [{ itemId: 'CRATE-P', quantity: '10', unit: 'PCS', price: inr(110), warehouseId: 'godown' }],
  });

  // A part payment: it settles some of one bill and must never mark it paid.
  await business.receivables.recordPayment(business.actor, {
    idempotencyKey: 'pay-abc-part',
    direction: 'RECEIPT',
    partyId: ABC,
    mode: 'CASH',
    amount: inr(1000),
    date: on('2026-04-20'),
    allocations: [{ documentId: billA.id, documentNumber: billA.number ?? billA.id, amount: inr(1000) }],
  });

  // A cheque. Taken, not yet cleared, and therefore not money.
  await business.receivables.recordPayment(business.actor, {
    idempotencyKey: 'pay-gurugram-cheque',
    direction: 'RECEIPT',
    partyId: GURUGRAM,
    mode: 'CHEQUE',
    amount: inr(2000),
    date: on('2026-05-02'),
    cheque: { number: '004521', chequeDate: on('2026-05-02'), bankName: 'HDFC Bank' },
    allocations: [{ documentId: billB.id, documentNumber: billB.number ?? billB.id, amount: inr(2000) }],
  });

  // Money with no bill against it. It waits, visibly, until someone says what it is for.
  await business.receivables.recordPayment(business.actor, {
    idempotencyKey: 'pay-abc-advance',
    direction: 'RECEIPT',
    partyId: ABC,
    mode: 'CASH',
    amount: inr(500),
    date: on('2026-05-06'),
  });

  // A bill that has been started and not yet given to anyone.
  const waiting = await business.sales.createDraft(actorWith(ALL_PERMISSIONS), {
    idempotencyKey: 'bill-waiting',
    input: {
      partyId: ABC,
      customerType: 'B2B',
      supplyKind: 'GOODS',
      documentDate: on('2026-05-08'),
      dueDate: on('2026-06-07'),
      lines: [
        {
          lineId: 'l1',
          itemId: 'CRATE-P',
          quantity: qty('5', 'PCS'),
          unitPrice: inr(100),
          priceBasis: 'EXCLUSIVE',
          warehouseId: 'shop',
        },
      ],
    },
  });
  await business.sales.submitForApproval(actorWith(ALL_PERMISSIONS), waiting.id);

  return business;
};
