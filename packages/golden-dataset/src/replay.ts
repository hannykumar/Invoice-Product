/**
 * Issue #43 [E43] — running a fixture through the real modules.
 *
 * Nothing here re-implements what a module does. A fixture's events are turned into calls on the
 * genuine ledger, sales, inventory and GST services, and whatever they produce is read back. That
 * is what makes the dataset worth having: if a module's behaviour drifts, the golden file stops
 * matching, and the failure points at the module rather than at a copy of it kept here.
 *
 * The replay is deterministic by construction — a fixed clock, fixed ids, and dates that come from
 * the fixture rather than from today — so the same file gives the same answer on any machine and
 * on any day.
 */
import {
  asId,
  fixedClock,
  fromDecimalString,
  isoDate,
  quantityFromString,
  toDecimalString,
  type CompanyId,
  DomainError,
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
  trialBalance,
  type Account,
  type ActorContext,
} from '@invoice/ledger';
import { GstCalculator, InMemoryDeclaredRates, InMemoryMasterData, RateTable } from '@invoice/gst-calc';
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
import { createDefaultUnitRegistry, type UnitRegistry } from '../../masters/src/units.ts';
import { InMemoryPaymentRepository, ReceivablesService, type DocumentLedgerPort, type OpenDocument } from '@invoice/receivables';
import type { GoldenFixture } from './schema.ts';

/** Everything the replay observed, in the same shape the fixture states its expectations in. */
export interface ReplayResult {
  readonly trialBalanceBalanced: boolean;
  readonly totalDebits: string;
  readonly totalCredits: string;
  readonly accounts: readonly { code: string; name: string; balance: string }[];
  readonly stock: readonly { itemId: string; physical: string; unit: string }[];
  readonly tax: { taxableValue: string; cgst: string; sgst: string; igst: string; total: string };
  /**
   * Tax per invoice line, in paise. The document totals are re-summed from the components, so a
   * line whose own parts disagree with its own total is invisible at that level — this is the
   * granularity a correctness gate has to look at (issue #48).
   */
  readonly taxLines: readonly {
    documentNumber: string;
    lineId: string;
    cgst: bigint; sgst: bigint; utgst: bigint; igst: bigint; cess: bigint; totalTax: bigint;
  }[];
  readonly refusals: readonly string[];
  /** Each refusal with the reason it gave, so a fixture can pin why and not merely that. */
  readonly refusalDetails: readonly { ref: string; code: string; message: string }[];
  /** Bill numbers issued, so a later scenario can refer to them. */
  readonly issued: readonly { ref: string; number: string; value: string }[];
}

const PERMISSIONS = [
  'ledger.setup', 'ledger.post.sale', 'ledger.post.receipt', 'ledger.post.payment', 'ledger.post.journal', 'ledger.reverse',
  'sales.draft.write', 'sales.finalise', 'sales.approve', 'sales.cancel',
  'inventory.move', 'inventory.adjust', 'inventory.transfer',
  'payments.record', 'payments.allocate',
];

const money = (value: string): Money => fromDecimalString(value);

class FixtureMasters implements StockMasterData {
  readonly #registry: UnitRegistry = createDefaultUnitRegistry();
  readonly #items: StockItem[];
  readonly #warehouse: Warehouse;
  constructor(items: StockItem[], warehouse: Warehouse) {
    this.#items = items;
    this.#warehouse = warehouse;
  }
  item(_companyId: CompanyId, itemId: string): StockItem | undefined {
    return this.#items.find((i) => i.itemId === itemId);
  }
  warehouse(_companyId: CompanyId, warehouseId: string): Warehouse | undefined {
    return this.#warehouse.warehouseId === warehouseId ? this.#warehouse : undefined;
  }
  units(): UnitRegistry {
    return this.#registry;
  }
}

/**
 * Runs one fixture end to end and reports what the modules actually did.
 *
 * A refusal is recorded rather than thrown: a fixture that says "this oversale must be refused" is
 * asserting a behaviour, and a replay that stopped at the refusal could not go on to check that
 * the books were left untouched by it.
 */
export const replay = async (fixture: GoldenFixture): Promise<ReplayResult> => {
  const companyId = asId<'Company'>(fixture.company.companyId);
  const actor: ActorContext = {
    companyId,
    branchId: asId<'Branch'>('main'),
    userId: asId<'User'>('golden-owner'),
    permissions: PERMISSIONS,
  };

  const store = new InMemoryLedgerStore();
  const salesRepository = new InMemorySalesRepository();
  const inventoryStore = new InMemoryInventoryStore();
  const paymentRepository = new InMemoryPaymentRepository();
  store.join(salesRepository).join(inventoryStore).join(paymentRepository);

  const audit = new InMemoryAuditPort();
  const clock = fixedClock('2026-08-29T10:00:00.000Z');
  let sequence = 0;
  const idFactory = (): string => `gold-${String((sequence += 1)).padStart(6, '0')}`;

  const ledger = new LedgerService({ store, permissions: permissionPortFromActor, audit, clock, idFactory });
  const partyAccounts: Account[] = fixture.parties.map((party) => ({
    id: asId<'Account'>(`${companyId}:acc:${party.accountCode}`),
    companyId,
    code: party.accountCode,
    name: party.name,
    type: party.role === 'CUSTOMER' ? 'ASSET' : 'LIABILITY',
    parentId: asId<'Account'>(`${companyId}:acc:${party.role === 'CUSTOMER' ? '1200' : '2100'}`),
    isGroup: false,
    active: true,
    partyId: asId<'Party'>(party.partyId),
    systemRole: null,
  }));
  await ledger.initialiseCompany(actor, {
    booksStartDate: isoDate(fixture.company.booksStartDate),
    accounts: [...buildDefaultChart(companyId, defaultChartIdFactory(companyId)), ...partyAccounts],
  });

  // Master data: the company, its customers, and what it sells.
  const masterData = new InMemoryMasterData();
  masterData.putCompany({ companyId, gstin: fixture.company.gstin, stateCode: fixture.company.stateCode, registration: 'REGULAR' });
  for (const party of fixture.parties) {
    masterData.putParty(companyId, {
      partyId: asId<'Party'>(party.partyId),
      gstin: party.gstin,
      stateCode: party.stateCode,
      registration: party.gstin === null ? 'UNKNOWN' : 'REGULAR',
    });
  }
  for (const item of fixture.items) {
    masterData.putItem(companyId, {
      itemId: item.itemId,
      name: item.name,
      kind: item.kind,
      hsnOrSac: item.hsnOrSac,
      treatment: item.treatment,
      reverseCharge: false,
      baseUnit: item.baseUnit,
    });
  }

  // Rates the business itself declared (#54 option C), which is what production actually supports.
  // Each carries who said so and on what footing, exactly as a real declaration must.
  const declaredRates = new InMemoryDeclaredRates();
  for (const item of fixture.items) {
    if (item.treatment !== 'TAXABLE' || item.hsnOrSac === null || item.ratePercent === undefined) continue;
    declaredRates.declare({
      companyId,
      code: item.hsnOrSac,
      kind: item.kind,
      ratePercentTimes100: BigInt(Math.round(item.ratePercent * 100)),
      effectiveFrom: isoDate(fixture.company.booksStartDate),
      effectiveTo: null,
      declaredBy: 'golden-owner',
      declaredOn: fixture.company.booksStartDate as ReturnType<typeof isoDate>,
      basis: 'The rate this example business states it charges.',
    });
  }

  const calculator = new GstCalculator({
    masterData,
    rates: new RateTable([]),
    declaredRates,
    gstEngine: new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.gst', mode: 'development' }),
    mode: 'development',
  });

  const stockItems: StockItem[] = fixture.items.map((item) => ({
    itemId: item.itemId,
    name: item.name,
    baseUnit: item.baseUnit,
    tracksBatches: false,
    tracksSerials: false,
  }));
  const masters = new FixtureMasters(stockItems, { warehouseId: fixture.company.warehouseId, name: fixture.company.warehouseName });
  const inventory = new InventoryService({
    store,
    inventory: inventoryStore,
    masterData: masters,
    permissions: permissionPortFromActor,
    audit,
    clock,
    policy: { negativeStock: 'BLOCK', reservationMinutes: 120, valuationMethod: 'WEIGHTED_AVERAGE' },
    idFactory,
  });

  const sales = new SalesService({
    store,
    ledger,
    calculator,
    repository: salesRepository,
    inventory: salesInventoryAdapter(inventory, { defaultWarehouseId: fixture.company.warehouseId }),
    compliance: noComplianceHooks,
    permissions: permissionPortFromActor,
    audit,
    clock,
    policy: { ...DEFAULT_SALES_POLICY, series: { prefix: 'INV', branchCode: 'GD', padding: 5 } },
    idFactory,
  });

  const documents: DocumentLedgerPort = {
    async openDocuments(company, partyId) {
      const invoices = await salesRepository.list(company, { partyId, state: 'FINAL' });
      return invoices.map(
        (invoice): OpenDocument => ({
          documentId: invoice.id,
          kind: 'SALES_INVOICE',
          number: invoice.number ?? invoice.id,
          partyId,
          date: invoice.documentDate,
          dueDate: invoice.dueDate,
          value: invoice.pricing?.totals.invoiceValue ?? money('0.00'),
          side: 'RECEIVABLE',
        }),
      );
    },
    async parties() {
      return fixture.parties.map((p) => asId<'Party'>(p.partyId));
    },
    async nameOf(_company, partyId) {
      return fixture.parties.find((p) => p.partyId === partyId)?.name ?? partyId;
    },
  };
  const receivables = new ReceivablesService({
    store, ledger, repository: paymentRepository, documents,
    permissions: permissionPortFromActor, audit, clock, idFactory,
  });

  const refusals: string[] = [];
  const refusalDetails: { ref: string; code: string; message: string }[] = [];
  const issued: { ref: string; number: string; value: string }[] = [];
  const invoiceByRef = new Map<string, string>();

  for (const event of fixture.events) {
    if (event.kind === 'stock_in') {
      await inventory.recordMovement(actor, {
        idempotencyKey: `golden:${event.ref}`,
        itemId: event.itemId,
        warehouseId: fixture.company.warehouseId,
        kind: 'PURCHASE_IN',
        quantity: quantityFromString(event.quantity, event.unit),
        documentDate: isoDate(event.on),
        source: { kind: 'purchase_invoice', id: event.ref, number: event.ref },
        unitCost: money(event.unitCost),
      });
      continue;
    }

    if (event.kind === 'sale' || event.kind === 'sale_refused') {
      // Whether this is goods or a service comes from the item, not from an assumption: a service
      // holds no stock, so asking inventory to reserve one is refused for want of goods that never
      // existed. A fixture selling design work is not selling anything out of a godown.
      const kindOf = (itemId: string) => fixture.items.find((i) => i.itemId === itemId)?.kind ?? 'GOODS';
      const supplyKind = kindOf(event.lines[0]?.itemId ?? '') === 'SERVICES' ? ('SERVICES' as const) : ('GOODS' as const);
      const draftInput = {
        partyId: asId<'Party'>(event.partyId),
        customerType: 'B2B' as const,
        supplyKind,
        documentDate: isoDate(event.on),
        dueDate: isoDate(event.dueOn),
        lines: event.lines.map((line, index) => ({
          lineId: `l${index + 1}`,
          itemId: line.itemId,
          quantity: quantityFromString(line.quantity, line.unit),
          unitPrice: money(line.unitPrice),
          priceBasis: 'EXCLUSIVE' as const,
          ...(kindOf(line.itemId) === 'SERVICES' ? {} : { warehouseId: fixture.company.warehouseId }),
        })),
      };
      try {
        const draft = await sales.createDraft(actor, { idempotencyKey: `golden:${event.ref}`, input: draftInput });
        const result = await sales.finalise(actor, { idempotencyKey: `golden:${event.ref}:final`, invoiceId: draft.id });
        invoiceByRef.set(event.ref, result.invoice.id);
        issued.push({
          ref: event.ref,
          number: result.invoice.number ?? result.invoice.id,
          value: toDecimalString(result.invoice.pricing?.totals.invoiceValue ?? money('0.00')),
        });
      } catch (error) {
        // A refusal is data, not a crash: the fixture asserts it happened and that nothing moved.
        const code = error instanceof DomainError ? error.code : 'UNEXPECTED_ERROR';
        const message = error instanceof Error ? error.message : String(error);
        refusals.push(code);
        refusalDetails.push({ ref: event.ref, code, message });
      }
      continue;
    }

    if (event.kind === 'payment') {
      const against = event.againstRef === null ? undefined : invoiceByRef.get(event.againstRef);
      const open = against === undefined ? undefined : (await documents.openDocuments(companyId, asId<'Party'>(event.partyId))).find((d) => d.documentId === against);
      await receivables.recordPayment(actor, {
        idempotencyKey: `golden:${event.ref}`,
        direction: 'RECEIPT',
        partyId: asId<'Party'>(event.partyId),
        mode: 'CASH',
        amount: money(event.amount),
        date: isoDate(event.on),
        reference: event.ref,
        ...(open === undefined
          ? {}
          : { allocations: [{ documentId: open.documentId, documentNumber: open.number, amount: money(event.amount) }] }),
      });
      continue;
    }

    if (event.kind === 'cancel_sale') {
      const invoiceId = invoiceByRef.get(event.cancels);
      if (invoiceId === undefined) {
        refusals.push('GOLDEN_CANCEL_TARGET_MISSING');
        continue;
      }
      await sales.cancel(actor, {
        idempotencyKey: `golden:${event.ref}`,
        invoiceId,
        today: isoDate(event.on),
        reason: event.reason,
      });
    }
  }

  // What the books say now, read from the ledger rather than tracked alongside it.
  const balances = await trialBalance(store.read(), companyId);
  const accounts = balances.rows
    .map((row) => ({ code: row.account.code, name: row.account.name, balance: toDecimalString(row.balance) }))
    .sort((a, b) => a.code.localeCompare(b.code));

  const stock: { itemId: string; physical: string; unit: string }[] = [];
  for (const item of fixture.items) {
    if (item.kind !== 'GOODS') continue;
    const balance = await inventory.balance(actor, { itemId: item.itemId, warehouseId: fixture.company.warehouseId });
    stock.push({
      itemId: item.itemId,
      physical: String(Number(balance.physical.scaled) / 1_000_000),
      unit: balance.physical.unit,
    });
  }

  // Tax is summed from the issued bills, which is where the calculator recorded it.
  const finalInvoices = (await salesRepository.list(companyId)).filter((invoice) => invoice.state === 'FINAL');
  const sumOf = (pick: (totals: NonNullable<(typeof finalInvoices)[number]['pricing']>['totals']) => Money): string => {
    const total = finalInvoices.reduce((running, invoice) => {
      const totals = invoice.pricing?.totals;
      return totals === undefined ? running : running + pick(totals).minor;
    }, 0n);
    return toDecimalString({ currency: 'INR', minor: total });
  };

  const taxLines = finalInvoices.flatMap((invoice) =>
    (invoice.pricing?.lines ?? []).map((line) => ({
      documentNumber: invoice.number ?? invoice.id,
      lineId: line.lineId,
      cgst: line.cgst.minor,
      sgst: line.sgst.minor,
      utgst: line.utgst.minor,
      igst: line.igst.minor,
      cess: line.cess.minor,
      totalTax: line.totalTax.minor,
    })),
  );

  return {
    trialBalanceBalanced: balances.balanced,
    totalDebits: toDecimalString(balances.totalDebit),
    totalCredits: toDecimalString(balances.totalCredit),
    accounts,
    stock,
    tax: {
      taxableValue: sumOf((t) => t.taxableValue),
      cgst: sumOf((t) => t.cgst),
      sgst: sumOf((t) => t.sgst),
      igst: sumOf((t) => t.igst),
      total: sumOf((t) => t.totalTax),
    },
    taxLines,
    refusals,
    refusalDetails,
    issued,
  };
};
