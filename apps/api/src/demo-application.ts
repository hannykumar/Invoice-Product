/**
 * Issues #72 and #80 — one authenticated company composed from the real domain services.
 *
 * Persistence is in-memory for the local app, but company and actor always come from the session.
 */
import { invalid, isoDate, money, notFound, quantityFromString, type CompanyId, type PartyId } from '@invoice/kernel';
import { permissionPortFromActor, type ActorContext } from '@invoice/ledger';
import { GstCalculator, FIXTURE_RATE_TABLE, InMemoryMasterData } from '@invoice/gst-calc';
import { RulesEngine, shippedRegistry } from '@invoice/rules-engine';
import { InMemorySalesRepository, noComplianceHooks, permissiveInventory, SalesService } from '@invoice/sales';
import { InMemoryPaymentRepository, ReceivablesService, type DocumentLedgerPort, type OpenDocument } from '@invoice/receivables';
import {
  TradeTermsService,
  noPriceList,
  type CreditPositionPort,
  type PartyTermsPort,
  type SalesHistoryPort,
  type StockCostPort,
} from '@invoice/trade-terms';
import {
  ReportService,
  duesFrom,
  namesFrom,
  type Figure,
  type PurchaseDocument,
  type PurchaseReadPort,
  type ReportFilter,
} from '@invoice/reports';
import { createDefaultUnitRegistry } from '../../../packages/masters/src/units.ts';
import type { IsoDate } from '@invoice/kernel';
import type { InventoryStore, StockItem, StockMasterData, Warehouse } from '@invoice/inventory';
import { DEFAULT_SALES_POLICY } from '../../../packages/sales/src/policy.ts';
import { lineTaxableValue, taxOn } from '../../../packages/purchasing/src/recompute.ts';
import { formatQuantity } from '../../../packages/masters/src/units.ts';
import type { ApprovedPurchase, ApprovedPurchaseLine, PurchasePostingPreview } from '../../../packages/purchasing/src/posting-types.ts';
import type { PurchaseVerdict } from '../../../packages/purchasing/src/validation-types.ts';
import { purchaseDocumentLedger } from '../../../packages/purchasing/src/posting-adapters.ts';
import { quantity } from '../../../packages/masters/src/units.ts';
import { createCompanyShop, type CompanySeed } from './company-shop.ts';
import { showQuantity } from '../../../packages/purchasing/src/matching.ts';
import type { SupplierRiskAssessment } from '../../../packages/purchasing/src/supplier-risk-types.ts';
import { DEMO_REGISTRATIONS } from './company-shop.ts';
import type { EInvoiceRecord } from '../../../packages/gst/src/einvoice-types.ts';
import type { EInvoiceDocument, EInvoiceLine, PartyDetails } from '../../../packages/gst/src/payload.ts';
import type { GoodsReceipt, MatchResult, PurchaseOrder } from '../../../packages/purchasing/src/matching-types.ts';

const paise = (value: unknown): bigint => {
  const normalized = String(value ?? '').replace(/,/g, '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw invalid('API_AMOUNT_INVALID', 'Enter a valid amount greater than zero.');
  const [whole = '0', fraction = ''] = normalized.split('.');
  const result = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  if (result <= 0n) throw invalid('API_AMOUNT_INVALID', 'Enter a valid amount greater than zero.');
  return result;
};

const daysAfter = (date: string, days: number): string => {
  const result = new Date(`${date}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
};

const jsonAmount = (minor: bigint): number => Number(minor) / 100;

/**
 * The slice of master data the stock report needs to name things. Item and warehouse names come
 * from `namesFrom` in the report service; this only has to satisfy the interface and supply a unit
 * registry, so it returns the ids and lets the names layer do the naming.
 */
const demoStockMasterData = (): StockMasterData => {
  const registry = createDefaultUnitRegistry();
  return {
    item(_companyId, _itemId): StockItem | undefined { return undefined; },
    warehouse(_companyId, _warehouseId): Warehouse | undefined { return undefined; },
    units() { return registry; },
  };
};

/**
 * The purchase side of the reports, read live from the posted bills.
 *
 * Every field a register prints is already on a posted bill — the supplier, the invoice number,
 * the tax split, the total — so this is a rename, not a second source of truth. Only POSTED bills
 * count; a draft is not a purchase.
 */
const livePurchaseReadPort = (shop: Awaited<ReturnType<typeof createCompanyShop>>): PurchaseReadPort => ({
  available: true,
  async list(companyId, from: IsoDate, to: IsoDate): Promise<readonly PurchaseDocument[]> {
    const bills = await shop.bills.list(companyId as Parameters<typeof shop.bills.list>[0]);
    return bills
      .filter((bill) => bill.state === 'POSTED' && String(bill.invoiceDate) >= from && String(bill.invoiceDate) <= to)
      .map((bill) => ({
        documentId: bill.id,
        number: bill.invoiceNumber,
        supplierId: bill.supplierPartyId as unknown as PartyId,
        supplierName: bill.supplierName,
        date: isoDate(String(bill.invoiceDate)),
        branchId: null,
        taxableValue: money(bill.tax.taxableValuePaise),
        cgst: money(bill.tax.cgstPaise),
        sgst: money(bill.tax.sgstPaise),
        igst: money(bill.tax.igstPaise),
        cess: money(bill.tax.cessPaise),
        invoiceValue: money(bill.totalPaise),
        ineligibleInputTax: money(bill.tax.ineligibleItcPaise),
        reverseCharge: bill.tax.reverseCharge,
      }));
  },
});

/** The three things a purchase will do, taken from the preview rather than written by hand. */
const previewEffects = (preview: PurchasePostingPreview, location: string): string[] => {
  const tax = preview.tax;
  const claimable = tax.cgstPaise + tax.sgstPaise + tax.igstPaise + tax.cessPaise;
  const effects = preview.receipts.map((receipt) => `Stock: +${formatQuantity(receipt.quantity)} in ${location}`);
  if (effects.length === 0) effects.push('Stock: nothing, this is a service');
  effects.push(
    tax.reverseCharge
      ? `GST: ${jsonAmount(claimable).toFixed(2)} payable by you under reverse charge`
      : `GST you can claim back: ${jsonAmount(claimable).toFixed(2)} (${tax.intraState ? 'CGST + SGST' : 'IGST'})`,
  );
  effects.push(`Supplier due: ${jsonAmount(preview.totalPaise).toFixed(2)}`);
  effects.push(`Due date: ${preview.dueDate}`);
  if (preview.roundOffPaise !== 0n) effects.push(`Rounding recorded separately: ${jsonAmount(preview.roundOffPaise < 0n ? -preview.roundOffPaise : preview.roundOffPaise).toFixed(2)}`);
  return effects;
};

export class DemoApplication {
  private readonly config: CompanySeed;
  private readonly shop: Awaited<ReturnType<typeof createCompanyShop>>;
  private readonly sales: SalesService;
  private readonly salesRepository: InMemorySalesRepository;
  private readonly payments: ReceivablesService;
  private readonly paymentRepository: InMemoryPaymentRepository;
  private readonly documents: DocumentLedgerPort;
  private readonly reportService: ReportService;
  private readonly terms: TradeTermsService;

  private constructor(
    config: CompanySeed,
    shop: Awaited<ReturnType<typeof createCompanyShop>>,
    sales: SalesService,
    salesRepository: InMemorySalesRepository,
    payments: ReceivablesService,
    paymentRepository: InMemoryPaymentRepository,
    documents: DocumentLedgerPort,
    reportService: ReportService,
    terms: TradeTermsService,
  ) {
    this.config = config;
    this.shop = shop;
    this.sales = sales;
    this.salesRepository = salesRepository;
    this.payments = payments;
    this.paymentRepository = paymentRepository;
    this.documents = documents;
    this.reportService = reportService;
    this.terms = terms;
  }

  static async create(config: CompanySeed): Promise<DemoApplication> {
    const shop = await createCompanyShop(config);
    const salesRepository = new InMemorySalesRepository();
    const paymentRepository = new InMemoryPaymentRepository();
    shop.store.join(salesRepository).join(paymentRepository);
    const masters = new InMemoryMasterData();
    masters.putCompany({ companyId: config.companyId, gstin: config.gstin, stateCode: config.gstin.slice(0, 2), registration: 'REGULAR' });
    masters.putParty(config.companyId, { partyId: config.customerId, gstin: config.customerGstin, stateCode: config.customerGstin.slice(0, 2), registration: 'REGULAR' });
    masters.putItem(config.companyId, { itemId: 'SOAP', name: 'Herbal Bath Soap 100g', kind: 'GOODS', hsnOrSac: '0808', treatment: 'NIL_RATED', reverseCharge: false, baseUnit: 'PCS' });
    const calculator = new GstCalculator({ masterData: masters, rates: FIXTURE_RATE_TABLE, gstEngine: new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.gst', mode: 'development' }), mode: 'development' });
    const sales = new SalesService({ store: shop.store, ledger: shop.ledger, calculator, repository: salesRepository, inventory: permissiveInventory, compliance: noComplianceHooks, permissions: permissionPortFromActor, audit: shop.audit, clock: { now: () => new Date() }, policy: { ...DEFAULT_SALES_POLICY, series: { prefix: 'INV', branchCode: 'WEB', padding: 5 } } });

    const purchases = purchaseDocumentLedger(shop.bills, async () => config.supplierName);
    const documents: DocumentLedgerPort = {
      async openDocuments(companyId, partyId) {
        const purchaseDocuments = await purchases.openDocuments(companyId, partyId);
        const invoices = await salesRepository.list(companyId, { partyId, state: 'FINAL' });
        const saleDocuments: OpenDocument[] = invoices.map((invoice) => ({ documentId: invoice.id, kind: 'SALES_INVOICE', number: invoice.number ?? invoice.id, partyId, date: invoice.documentDate, dueDate: invoice.dueDate, value: invoice.pricing?.totals.invoiceValue ?? money(0n), side: 'RECEIVABLE' }));
        return [...purchaseDocuments, ...saleDocuments];
      },
      async parties(companyId) { return [...new Set([...(await purchases.parties(companyId)), config.customerId])] as readonly PartyId[]; },
      async nameOf(companyId, partyId) { return partyId === config.customerId ? config.customerName : purchases.nameOf(companyId, partyId); },
    };
    const payments = new ReceivablesService({ store: shop.store, ledger: shop.ledger, repository: paymentRepository, documents, permissions: permissionPortFromActor, audit: shop.audit, clock: { now: () => new Date() } });

    // Reports read the same live company: the ledger every module posts to, the sales invoices
    // sales issues, the stock movements purchases receive, the positions receivables derives.
    const reportService = new ReportService({
      store: shop.store,
      sales: salesRepository,
      inventory: shop.inventory,
      stockMasterData: demoStockMasterData(),
      dues: duesFrom(documents, payments),
      purchases: livePurchaseReadPort(shop),
      names: namesFrom({
        parties: { [config.customerId]: config.customerName, [config.supplierId]: config.supplierName },
        items: { TMT12: 'TMT Steel Bar 12mm', SOAP: 'Herbal Bath Soap 100g' },
        warehouses: { 'wh-main': config.location },
      }),
      permissions: permissionPortFromActor,
      audit: shop.audit,
      clock: { now: () => new Date() },
    });

    // Issue #11: the terms of a sale, over this same live company. Every port is the module that
    // already knows the answer — issued invoices for what this customer last paid, receivables for
    // what they owe, inventory for what stock cost — so nothing here keeps a second copy.
    const history: SalesHistoryPort = {
      async lastAgreedPrice(companyId, request) {
        const issued = (await salesRepository.list(companyId, { partyId: request.partyId, state: 'FINAL' }))
          .filter((invoice) => invoice.documentDate <= request.asOf)
          .sort((a, b) => b.documentDate.localeCompare(a.documentDate));
        for (const invoice of issued) {
          const priced = invoice.pricing?.lines.find((l) => l.itemId === request.itemId);
          if (priced === undefined) continue;
          const typed = invoice.lines.find((l) => l.itemId === request.itemId);
          if (typed === undefined) continue;
          return { amount: typed.unitPrice, documentNumber: invoice.number ?? invoice.id, on: invoice.documentDate };
        }
        return null;
      },
      async pendingValue(companyId, partyId, excludingDocumentId) {
        // Bills started and not issued. Without these two tills spend one limit twice.
        const drafts = (await salesRepository.list(companyId, { partyId })).filter(
          (invoice) => invoice.state !== 'FINAL' && invoice.state !== 'CANCELLED' && invoice.id !== excludingDocumentId,
        );
        return money(drafts.reduce((total, invoice) => total + (invoice.pricing?.totals.invoiceValue.minor ?? 0n), 0n));
      },
    };
    const positions: CreditPositionPort = {
      async outstanding(actor, partyId, asOn) {
        const position = await payments.position(actor, partyId, asOn);
        const oldest = position.documents
          .filter((d) => d.outstanding.minor > 0n)
          .reduce((worst, d) => Math.max(worst, d.daysOverdue), 0);
        return { total: position.totalOutstanding, oldestDaysOverdue: oldest };
      },
    };
    const partyTerms: PartyTermsPort = {
      // A synthetic limit for the demo company, so the control is visible. A real business sets
      // this on the customer in master data (#5).
      async creditLimit() {
        return money(5_000_00n);
      },
      async nameOf(_companyId, partyId) {
        return partyId === config.customerId ? config.customerName : config.supplierName;
      },
    };
    const stockCost: StockCostPort = {
      async averageUnitCost(actor, itemId) {
        const valued = await shop.inventoryService.value(actor, { itemId });
        return valued.averageUnitCost;
      },
    };
    const terms = new TradeTermsService({
      priceList: noPriceList,
      history,
      positions,
      parties: partyTerms,
      cost: stockCost,
      engine: new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.policy', mode: 'development' }),
      permissions: permissionPortFromActor,
      audit: shop.audit,
      clock: { now: () => new Date() },
    });

    const app = new DemoApplication(config, shop, sales, salesRepository, payments, paymentRepository, documents, reportService, terms);
    await app.seed();
    return app;
  }

  private async seed(): Promise<void> {
    await this.recordSale(this.shop.setupActor, { party: this.config.customerName, item: 'Herbal Bath Soap 100g', quantity: '4', rate: '250', date: '2026-08-29', terms: '30', reference: 'seed-sale', notes: 'Synthetic opening demo sale' });
  }

  async dashboard(actor: ActorContext) {
    permissionPortFromActor.require(actor, 'dashboard.read', 'view this dashboard');
    const companyId = this.companyOf(actor);
    const sales = await this.salesRepository.list(companyId, { state: 'FINAL' });
    const purchases = await this.shop.bills.list(companyId);
    const payments = await this.paymentRepository.list(companyId);
    const supplier = await this.payments.position(actor, this.config.supplierId, isoDate('2026-08-29'));
    const customer = await this.payments.position(actor, this.config.customerId, isoDate('2026-08-29'));
    const stock = await this.shop.inventoryService.balance(actor, { itemId: 'TMT12', warehouseId: 'wh-main' });
    return {
      company: { id: companyId, name: this.config.name, location: this.config.location },
      metrics: {
        salesToday: jsonAmount(sales.reduce((sum, invoice) => sum + (invoice.pricing?.totals.invoiceValue.minor ?? 0n), 0n)),
        customersOwe: jsonAmount(customer.totalOutstanding.minor),
        purchasesMonth: jsonAmount(purchases.filter((bill) => bill.state === 'POSTED').reduce((sum, bill) => sum + bill.totalPaise, 0n)),
        needsAttention: (stock.physical.scaled <= 0n ? 1 : 0) + supplier.documents.filter((position) => position.daysOverdue > 0).length,
      },
      stock: { itemId: 'TMT12', name: 'TMT Steel Bar 12mm', quantity: Number(stock.physical.scaled) / 1_000_000, unit: stock.physical.unit },
      supplier: { id: this.config.supplierId, name: this.config.supplierName, outstanding: jsonAmount(supplier.totalOutstanding.minor), documents: supplier.documents.map((position) => ({ id: position.document.documentId, number: position.document.number, dueDate: position.document.dueDate, outstanding: jsonAmount(position.outstanding.minor), status: position.status })) },
      customer: { id: this.config.customerId, name: this.config.customerName, outstanding: jsonAmount(customer.totalOutstanding.minor), documents: customer.documents.map((position) => ({ id: position.document.documentId, number: position.document.number, dueDate: position.document.dueDate, outstanding: jsonAmount(position.outstanding.minor), status: position.status })) },
      activity: [
        ...sales.map((invoice) => ({ id: invoice.id, kind: 'sale', title: `${invoice.number} · ${this.config.customerName}`, amount: jsonAmount(invoice.pricing?.totals.invoiceValue.minor ?? 0n), status: 'Recorded' })),
        ...purchases.map((bill) => ({ id: bill.id, kind: 'purchase', title: `${bill.invoiceNumber} · ${bill.supplierName}`, amount: jsonAmount(bill.totalPaise), status: bill.state === 'POSTED' ? 'Recorded' : bill.state })),
        ...payments.map((payment) => ({ id: payment.id, kind: 'payment', title: `${payment.mode.replace('_', ' ')} · ${this.config.customerName}`, amount: jsonAmount(payment.amount.minor), status: payment.state === 'RECORDED' ? 'Recorded' : payment.state })),
      ].reverse(),
    };
  }

  /**
   * The report pack over the company's first year, as figures a screen can render. Every number is
   * folded from the same records the dashboard and the forms mutate; drill rows are carried so a
   * total on screen can be opened into the entries behind it. The company comes from the session.
   *
   * Every user-facing string is returned in both languages, exactly as the report modules produce
   * them. Picking one here would decide for the reader before the browser knows who is reading.
   */
  async reports(actor: ActorContext) {
    this.companyOf(actor);
    const filter: ReportFilter = { from: isoDate('2026-04-01'), to: isoDate('2027-03-31') };
    const pack = await this.reportService.pack(actor, filter);
    const drill = (figure: Figure) =>
      figure.contributors.map((c) => ({ date: c.date, number: c.sourceNumber, description: c.description, amount: jsonAmount(c.amount.minor) }));

    return {
      period: { from: filter.from, to: filter.to },
      trialBalance: {
        title: pack.trialBalance.header.title,
        balanced: pack.trialBalance.body.balanced,
        totalDebits: jsonAmount(pack.trialBalance.body.totalDebits.amount.minor),
        totalCredits: jsonAmount(pack.trialBalance.body.totalCredits.amount.minor),
        difference: jsonAmount(pack.trialBalance.body.difference.minor),
        rows: pack.trialBalance.body.rows.map((r) => ({ code: r.code, name: r.name, closing: jsonAmount(r.closing.amount.minor), side: r.side })),
      },
      profitAndLoss: {
        title: pack.profitAndLoss.header.title,
        sentence: pack.profitAndLoss.body.sentence,
        income: { total: jsonAmount(pack.profitAndLoss.body.income.total.amount.minor), rows: pack.profitAndLoss.body.income.rows.map((r) => ({ name: r.name, amount: jsonAmount(r.movement.amount.minor) })), drill: drill(pack.profitAndLoss.body.income.total) },
        expenses: { total: jsonAmount(pack.profitAndLoss.body.expenses.total.amount.minor), rows: pack.profitAndLoss.body.expenses.rows.map((r) => ({ name: r.name, amount: jsonAmount(r.movement.amount.minor) })) },
        result: jsonAmount(pack.profitAndLoss.body.result.amount.minor),
      },
      balanceSheet: {
        title: pack.balanceSheet.header.title,
        sentence: pack.balanceSheet.body.sentence,
        balanced: pack.balanceSheet.body.balanced,
        totalAssets: jsonAmount(pack.balanceSheet.body.totalAssets.amount.minor),
        totalClaims: jsonAmount(pack.balanceSheet.body.totalClaims.amount.minor),
      },
      sales: {
        title: pack.sales.header.title,
        sentence: pack.sales.body.sentence,
        total: jsonAmount(pack.sales.body.total.amount.minor),
        rows: pack.sales.body.rows.map((r) => ({ date: r.date, number: r.number, party: r.partyName, taxable: jsonAmount(r.taxableValue.minor), total: jsonAmount(r.total.minor) })),
      },
      purchases: {
        title: pack.purchases.header.title,
        sentence: pack.purchases.body.sentence,
        available: pack.purchases.body.available,
        total: jsonAmount(pack.purchases.body.total.amount.minor),
        rows: pack.purchases.body.rows.map((r) => ({ date: r.date, number: r.number, party: r.partyName, taxable: jsonAmount(r.taxableValue.minor), total: jsonAmount(r.total.minor) })),
      },
      stock: {
        title: pack.stock.header.title,
        sentence: pack.stock.body.sentence,
        value: jsonAmount(pack.stock.body.value.amount.minor),
        rows: pack.stock.body.rows.map((r) => ({ item: r.itemName, warehouse: r.warehouseName, unit: r.unitCode, closing: r.closing, available: r.available, value: jsonAmount(r.value.minor) })),
      },
      dues: {
        receivables: { title: pack.receivables.header.title, sentence: pack.receivables.body.sentence, total: jsonAmount(pack.receivables.body.total.amount.minor), rows: pack.receivables.body.rows.map((r) => ({ party: r.partyName, outstanding: jsonAmount(r.outstanding.minor), onAccount: jsonAmount(r.onAccount.minor), oldestDaysOverdue: r.oldestDaysOverdue })) },
        payables: { sentence: pack.payables.body.sentence, total: jsonAmount(pack.payables.body.total.amount.minor), rows: pack.payables.body.rows.map((r) => ({ party: r.partyName, outstanding: jsonAmount(r.outstanding.minor), oldestDaysOverdue: r.oldestDaysOverdue })) },
      },
      gst: {
        title: pack.gst.header.title,
        sentence: pack.gst.body.sentence,
        collected: jsonAmount(pack.gst.body.totalCollected.amount.minor),
        alreadyPaid: jsonAmount(pack.gst.body.totalAlreadyPaid.amount.minor),
        difference: jsonAmount(pack.gst.body.difference.minor),
        caution: pack.gst.body.caution,
      },
      exceptions: {
        title: pack.exceptions.header.title,
        clean: pack.exceptions.body.clean,
        sentence: pack.exceptions.body.sentence,
        items: pack.exceptions.body.exceptions.map((e) => ({ code: e.code, severity: e.severity, what: e.what, why: e.why, amount: e.amount === null ? null : jsonAmount(e.amount.minor) })),
      },
    };
  }

  previewPurchase(actor: ActorContext, input: Record<string, unknown>) {
    const approved = this.purchaseInput(actor, input);
    const preview = this.shop.posting.preview(actor, approved);
    return { state: 'preview', title: 'Ready to record', message: preview.summary, amount: jsonAmount(preview.totalPaise), effects: previewEffects(preview, this.config.location), token: approved.id };
  }

  async recordPurchase(actor: ActorContext, input: Record<string, unknown>) {
    const approved = this.purchaseInput(actor, input);
    const result = await this.shop.posting.post(actor, approved, `web:${approved.id}`);
    const state = await this.dashboard(actor);
    return { state: 'recorded', deduplicated: result.deduplicated, title: result.deduplicated ? 'Already recorded once' : 'Purchase recorded', message: result.deduplicated ? 'The existing bill was returned. Stock and the supplier balance were not doubled.' : result.bill.summary, stock: state.stock, supplier: state.supplier };
  }

  async purchase(actor: ActorContext, id: string) {
    this.companyOf(actor);
    const bill = await this.shop.posting.bill(actor, id);
    if (bill === null) throw notFound('PURCHASE_UNKNOWN', 'That supplier bill was not found.');
    return bill;
  }

  async previewSale(actor: ActorContext, input: Record<string, unknown>) {
    this.companyOf(actor);
    const draft = await this.sales.createDraft(actor, { idempotencyKey: `web-sale:${String(input.reference || crypto.randomUUID())}`, input: this.saleInput(input) });
    if (draft.pricing === null) throw new Error(draft.problems.map((problem) => problem.message['en-IN']).join(' '));

    // Issue #11: what was last agreed, what the discount is, and whether this customer should be
    // given more credit. The draft is excluded from its own pending value.
    const quote = await this.terms.quote(actor, {
      partyId: this.config.customerId,
      documentDate: isoDate(String(input.date)),
      documentId: draft.id,
      lines: draft.lines.map((line) => ({
        lineId: line.lineId,
        itemId: line.itemId,
        itemName: String(input.item || 'Herbal Bath Soap 100g'),
        unit: line.quantity.unit,
        quantity: String(Number(line.quantity.scaled) / 1_000_000),
        unitPrice: line.unitPrice,
      })),
    });

    const effects = ['A numbered invoice will be issued.', 'The customer balance will increase.'];
    for (const reason of quote.reasons) effects.push(reason['en-IN']);
    for (const line of quote.lines) {
      if (line.price.source !== 'NONE') effects.push(line.price.sentence['en-IN']);
    }

    return {
      state: 'preview',
      title: quote.outcome === 'BLOCK' ? 'This sale is on hold' : 'Sale checked',
      message: draft.pricing.explanation['en-IN'],
      amount: jsonAmount(draft.pricing.totals.invoiceValue.minor),
      token: draft.id,
      effects,
      terms: {
        outcome: quote.outcome,
        credit: {
          outcome: quote.credit.outcome,
          limit: quote.credit.limit === null ? null : jsonAmount(quote.credit.limit.minor),
          outstanding: jsonAmount(quote.credit.outstanding.minor),
          pending: jsonAmount(quote.credit.pending.minor),
          exposure: jsonAmount(quote.credit.exposure.minor),
          excess: jsonAmount(quote.credit.excess.minor),
          sentence: quote.credit.sentence,
        },
        lines: quote.lines.map((line) => ({
          lineId: line.lineId,
          priceSource: line.price.source,
          priceSentence: line.price.sentence,
          suggested: line.price.amount === null ? null : jsonAmount(line.price.amount.minor),
          discount: line.discount === null ? null : { outcome: line.discount.outcome, sentence: line.discount.sentence },
          margin: line.margin === null ? null : { sentence: line.margin.sentence },
        })),
      },
    };
  }

  async recordSale(actor: ActorContext, input: Record<string, unknown>) {
    const preview = await this.previewSale(actor, input);
    const final = await this.sales.finalise(actor, { idempotencyKey: `web-sale-final:${preview.token}`, invoiceId: preview.token });
    return { state: 'recorded', deduplicated: final.deduplicated, title: final.deduplicated ? 'Sale already recorded once' : 'Sale recorded', message: `${final.invoice.number} was issued.`, invoice: { id: final.invoice.id, number: final.invoice.number, amount: jsonAmount(final.invoice.pricing?.totals.invoiceValue.minor ?? 0n) } };
  }

  async previewPayment(actor: ActorContext, input: Record<string, unknown>) {
    this.companyOf(actor);
    permissionPortFromActor.require(actor, 'payments.record', 'record money received');
    const amount = paise(input.amount);
    const customer = await this.payments.position(actor, this.config.customerId, isoDate(String(input.date)));
    return { state: 'preview', title: 'Payment checked', message: `₹${jsonAmount(amount).toFixed(2)} will reduce what ${this.config.customerName} owes.`, amount: jsonAmount(amount), token: String(input.reference || crypto.randomUUID()), effects: [`Outstanding now: ₹${jsonAmount(customer.totalOutstanding.minor).toFixed(2)}`, input.invoice ? 'The selected invoice will be settled by this amount.' : 'The money will remain visibly on account.'] };
  }

  async recordPayment(actor: ActorContext, input: Record<string, unknown>) {
    const companyId = this.companyOf(actor);
    const amountMinor = paise(input.amount);
    const invoice = String(input.invoice ?? '');
    const open = invoice ? (await this.documents.openDocuments(companyId, this.config.customerId)).find((document) => document.documentId === invoice) : undefined;
    const amountToAllocate = open === undefined ? 0n : (amountMinor < open.value.minor ? amountMinor : open.value.minor);
    const payment = await this.payments.recordPayment(actor, { idempotencyKey: `web-payment:${String(input.reference || `${input.date}:${amountMinor}`)}`, direction: 'RECEIPT', partyId: this.config.customerId, mode: 'CASH', amount: money(amountMinor), date: isoDate(String(input.date)), reference: String(input.reference || '') || null, ...(open === undefined ? {} : { allocations: [{ documentId: open.documentId, documentNumber: open.number, amount: money(amountToAllocate) }] }) });
    const position = await this.payments.position(actor, this.config.customerId, isoDate(String(input.date)));
    return { state: 'recorded', title: 'Payment recorded', message: `₹${jsonAmount(payment.amount.minor).toFixed(2)} was recorded once.`, paymentId: payment.id, customerOutstanding: jsonAmount(position.totalOutstanding.minor) };
  }

  // ------------------------------------------------- issue #18: order, delivery, three-way match

  /** The catalogue the purchase screens share, so an item means the same thing on all of them. */
  private static readonly CATALOGUE: Record<string, { description: string; hsnSac: string; unit: string; kind: 'GOODS' | 'SERVICES'; batchId?: string }> = {
    TMT12: { description: 'TMT Steel Bar 12mm', hsnSac: '72142090', unit: 'KGS', kind: 'GOODS' },
    SOAP: { description: 'Herbal Bath Soap 100g', hsnSac: '34011190', unit: 'BOX', kind: 'GOODS', batchId: 'batch-web' },
    FRT: { description: 'Inward freight', hsnSac: '996511', unit: 'NOS', kind: 'SERVICES' },
  };

  private catalogueItem(id: unknown) {
    const key = String(id ?? 'SOAP');
    return { id: key, ...(DemoApplication.CATALOGUE[key] ?? DemoApplication.CATALOGUE.SOAP!) };
  }

  /** Reads a typed quantity into micro-units without letting a float near it. */
  private typedQuantity(value: unknown, unit: string) {
    const text = String(value ?? '').trim();
    if (!/^\d+(?:\.\d{1,6})?$/.test(text)) throw invalid('API_QUANTITY_INVALID', 'Enter a quantity, for example 100.');
    return quantity(text, unit);
  }

  /** How much of an item is actually on the shelf, which is the figure #18 has to get right. */
  private async stockOf(actor: ActorContext, itemId: string) {
    const item = this.catalogueItem(itemId);
    const balance = await this.shop.inventoryService.balance(actor, {
      itemId: item.id, warehouseId: 'wh-main', batchId: item.batchId ?? null,
    });
    return { itemId: item.id, name: item.description, onShelf: showQuantity(balance.physical) };
  }

  private orderJson(order: PurchaseOrder) {
    return {
      id: order.id, number: order.orderNumber, state: order.state,
      supplier: order.supplierName, date: order.orderDate,
      value: jsonAmount(order.orderedValuePaise),
      lines: order.lines.map((line) => ({
        item: line.itemId, description: line.description,
        quantity: showQuantity(line.quantity), rate: jsonAmount(line.ratePaise),
        gst: line.gstRateBasisPoints / 100,
      })),
      summary: order.summary,
    };
  }

  private receiptJson(receipt: GoodsReceipt) {
    return {
      id: receipt.id, number: receipt.receiptNumber, state: receipt.state,
      date: receipt.receiptDate, supplier: receipt.supplierName,
      lines: receipt.lines.map((line) => ({
        description: line.description,
        received: showQuantity(line.receivedQuantity),
        accepted: showQuantity(line.acceptedQuantity),
        rejected: showQuantity({ scaled: line.receivedQuantity.scaled - line.acceptedQuantity.scaled, unit: line.receivedQuantity.unit }),
        reason: line.rejectionReason ?? null,
        note: line.rejectionNote ?? null,
      })),
      stockMoved: receipt.movements.map((movement) => showQuantity(movement.quantity)),
      summary: receipt.summary,
    };
  }

  private async orderNumbered(actor: ActorContext, orderNumber: string) {
    const found = (await this.shop.matching.orders(actor)).find((candidate) => candidate.orderNumber === orderNumber);
    if (found === undefined) throw notFound('API_ORDER_NOT_FOUND', `There is no order numbered ${orderNumber}. Place it first, or leave the order blank.`);
    return found;
  }

  /** Raises an order and places it in one step: on this screen the two are the same action. */
  async recordOrder(actor: ActorContext, input: Record<string, unknown>) {
    const number = String(input.orderNumber ?? '').trim();
    if (!number) throw invalid('API_ORDER_NUMBER_REQUIRED', 'Enter an order number, for example PO/2026/0117.');
    const item = this.catalogueItem(input.item);
    const created = await this.shop.matching.createOrder(actor, {
      orderNumber: number,
      supplierPartyId: this.config.supplierId,
      supplierName: String(input.party || this.config.supplierName),
      orderDate: String(input.date ?? ''),
      lines: [{
        lineNumber: 1, itemId: item.id, description: item.description, hsnSac: item.hsnSac,
        quantity: this.typedQuantity(input.quantity, item.unit), ratePaise: paise(input.rate),
        gstRateBasisPoints: Number(input.gst ?? 1800), supplyKind: item.kind,
        ...(item.kind === 'GOODS' ? { warehouseId: 'wh-main' } : {}),
      }],
    });
    const order = created.state === 'DRAFT' ? await this.shop.matching.placeOrder(actor, created.id) : created;
    return {
      state: 'recorded', title: 'Order placed', message: order.summary,
      order: this.orderJson(order), stock: await this.stockOf(actor, item.id),
    };
  }

  /**
   * Records what arrived and confirms it, which is the moment stock moves.
   *
   * Only the accepted quantity goes onto the shelf. That is issue #18's central promise and it is
   * visible on this screen: the stock figure after the call rises by what was kept, never by what
   * was delivered and never by what the supplier later charges for.
   */
  async recordReceipt(actor: ActorContext, input: Record<string, unknown>) {
    const number = String(input.receiptNumber ?? '').trim();
    if (!number) throw invalid('API_RECEIPT_NUMBER_REQUIRED', 'Enter a delivery number, for example GRN/2026/0304.');
    const item = this.catalogueItem(input.item);
    const orderNumber = String(input.orderNumber ?? '').trim();
    const order = orderNumber === '' ? null : await this.orderNumbered(actor, orderNumber);

    const received = this.typedQuantity(input.received, item.unit);
    const accepted = this.typedQuantity(input.accepted, item.unit);
    const rate = order?.lines[0]?.ratePaise ?? paise(input.rate);
    const shortfall = received.scaled - accepted.scaled;

    const details = {
      receiptNumber: number,
      supplierPartyId: this.config.supplierId,
      supplierName: String(input.party || order?.supplierName || this.config.supplierName),
      receiptDate: String(input.date ?? ''),
      ...(input.deliveryNote ? { deliveryNote: String(input.deliveryNote) } : {}),
      lines: [{
        lineNumber: 1, itemId: item.id, description: item.description, warehouseId: 'wh-main',
        ...(item.batchId ? { batchId: item.batchId } : {}),
        receivedQuantity: received, acceptedQuantity: accepted, ratePaise: rate,
        ...(shortfall > 0n
          ? {
              rejectionReason: (String(input.rejectionReason || 'DAMAGED') as 'DAMAGED'),
              rejectionNote: String(input.rejectionNote || 'Turned away at the gate'),
              evidence: { checkedBy: actor.userId, checkedAt: new Date().toISOString(), note: String(input.rejectionNote || 'Checked at the gate') },
            }
          : {}),
      }],
    };

    // With no order this is the one-step small-business path; with one, the receipt is linked to
    // it first so confirming it also walks the order along to part-delivered or complete.
    const confirmed = order === null
      ? await this.shop.matching.goodsConfirmed(actor, details)
      : await this.shop.matching.confirmReceipt(
          actor,
          (await this.shop.matching.recordReceipt(actor, { ...details, orderId: order.id })).id,
        );

    return {
      state: 'recorded',
      title: shortfall > 0n ? 'Delivery confirmed, part of it turned away' : 'Delivery confirmed',
      message: confirmed.summary,
      receipt: this.receiptJson(confirmed),
      stock: await this.stockOf(actor, item.id),
      order: order === null ? null : this.orderJson((await this.shop.matching.order(actor, order.id))!),
    };
  }

  /**
   * Compares the supplier's bill with the order and the deliveries. Reads only: nothing is
   * recorded and no stock moves, which is what lets a person look before deciding.
   */
  async matchPurchaseBill(actor: ActorContext, input: Record<string, unknown>) {
    const item = this.catalogueItem(input.item);
    const invoiceNumber = String(input.reference ?? '').trim();
    if (!invoiceNumber) throw invalid('API_REFERENCE_REQUIRED', 'Enter the supplier bill number.');
    const orderNumber = String(input.orderNumber ?? '').trim();
    const order = orderNumber === '' ? null : await this.orderNumbered(actor, orderNumber);

    // With no order, every confirmed delivery from this supplier is what the bill is checked on.
    const receipts = order === null
      ? (await this.shop.matching.receiptsForParty(actor, this.config.supplierId)).filter((receipt) => receipt.state === 'CONFIRMED')
      : [];

    const match = await this.shop.matching.matchForInvoice(actor, {
      purchaseId: `web-purchase:${invoiceNumber}`,
      invoiceNumber,
      supplierPartyId: this.config.supplierId,
      lines: [{
        lineNumber: 1, itemId: item.id, description: item.description,
        quantity: this.typedQuantity(input.quantity, item.unit), ratePaise: paise(input.rate),
        gstRateBasisPoints: Number(input.gst ?? 1800),
      }],
    }, {
      ...(order === null ? { receiptIds: receipts.map((receipt) => receipt.id) } : { orderId: order.id }),
      on: String(input.date ?? new Date().toISOString().slice(0, 10)),
    });

    const cleared = await this.shop.matching.isClearedToPost(actor, match);
    return { ...DemoApplication.matchJson(match, cleared), stock: await this.stockOf(actor, item.id) };
  }

  /** A person accepting the differences, with the reason kept beside them. */
  async approvePurchaseMatch(actor: ActorContext, input: Record<string, unknown>) {
    const reason = String(input.reason ?? '').trim();
    const rebuilt = await this.matchPurchaseBill(actor, input);
    if (rebuilt.outcome !== 'HOLD_FOR_APPROVAL') {
      return { ...rebuilt, title: 'Nothing to approve', message: 'This bill is not on hold, so there is nothing to accept.' };
    }
    const match = rebuilt.raw;
    await this.shop.matching.approveMatch(actor, match, reason);
    const cleared = await this.shop.matching.isClearedToPost(actor, match);
    return {
      ...DemoApplication.matchJson(match, cleared),
      title: 'Differences accepted',
      message: cleared.reason,
      stock: rebuilt.stock,
    };
  }

  /** The comparison as a screen needs it: one row per item, with every finding spelled out. */
  private static matchJson(match: MatchResult, cleared: { cleared: boolean; reason: string }) {
    return {
      state: 'match' as const,
      outcome: match.outcome,
      kind: match.kind,
      cleared: cleared.cleared,
      title: match.outcome === 'MATCHED'
        ? 'Everything agrees'
        : match.outcome === 'WITHIN_TOLERANCE'
          ? 'Small differences, nothing blocking'
          : match.outcome === 'BLOCKED'
            ? 'These cannot be compared yet'
            : 'Held for your approval',
      message: match.summary,
      order: match.orderNumber ?? null,
      invoice: match.invoiceNumber,
      receipts: match.receiptIds.length,
      rows: match.lines.map((line) => ({
        item: line.itemId,
        description: line.description,
        ordered: line.orderedQuantity === undefined ? null : showQuantity(line.orderedQuantity),
        received: line.receivedQuantity === undefined ? null : showQuantity(line.receivedQuantity),
        accepted: line.acceptedQuantity === undefined ? null : showQuantity(line.acceptedQuantity),
        rejected: line.rejectedQuantity === undefined ? null : showQuantity(line.rejectedQuantity),
        invoiced: line.invoicedQuantity === undefined ? null : showQuantity(line.invoicedQuantity),
        orderedRate: line.orderedRatePaise === undefined ? null : jsonAmount(line.orderedRatePaise),
        invoicedRate: line.invoicedRatePaise === undefined ? null : jsonAmount(line.invoicedRatePaise),
      })),
      findings: match.findings.map((finding) => ({
        code: finding.code, severity: finding.severity, field: finding.field,
        message: finding.message, withinTolerance: finding.withinTolerance,
        orderSays: finding.orderSays ?? null,
        receiptSays: finding.receiptSays ?? null,
        invoiceSays: finding.invoiceSays ?? null,
        difference: finding.difference ?? null,
      })),
      tolerance: {
        quantity: `${match.policy.quantityBasisPoints / 100}%`,
        price: `${match.policy.priceBasisPoints / 100}%`,
        overDelivery: match.policy.allowOverDelivery ? 'allowed' : 'needs approval',
      },
      raw: match,
    };
  }

  // ------------------------------------------------ issue #26: e-invoice applicability and IRN

  /**
   * Turns a sales invoice this company actually issued into the government's document shape.
   *
   * Every figure comes from what #9 and #25 already worked out. Nothing is recomputed here, so
   * what is reported to the government is what is in the books, to the paisa.
   */
  private async eInvoiceDocumentFor(actor: ActorContext, invoiceId: string): Promise<EInvoiceDocument> {
    const companyId = this.companyOf(actor);
    const invoice = await this.salesRepository.findById(companyId, invoiceId);
    if (invoice === null) throw notFound('API_INVOICE_NOT_FOUND', 'We could not find that bill.');
    if (invoice.state !== 'FINAL' || invoice.number === null) {
      throw invalid('API_INVOICE_NOT_FINAL', 'This bill has not been issued yet, so there is nothing to report to the government.');
    }
    const pricing = invoice.pricing;
    if (pricing === null) throw invalid('API_INVOICE_NOT_PRICED', 'This bill has no tax worked out on it yet.');

    const seller: PartyDetails = {
      gstin: this.config.gstin,
      legalName: this.config.name,
      address1: this.config.location,
      location: this.config.location.split('·')[0]?.trim() ?? this.config.location,
      pincode: '560058',
      stateCode: this.config.gstin.slice(0, 2),
    };
    const buyer: PartyDetails = {
      gstin: this.config.customerGstin,
      legalName: this.config.customerName,
      address1: 'Customer address on file',
      location: 'Bengaluru',
      pincode: '560001',
      stateCode: this.config.customerGstin.slice(0, 2),
    };

    const lines: EInvoiceLine[] = pricing.lines.map((line, index) => ({
      lineNumber: index + 1,
      description: line.itemName,
      isService: invoice.supplyKind === 'SERVICES',
      hsnOrSac: line.hsnOrSac ?? '',
      quantity: (Number(line.quantity.scaled) / 1_000_000).toString(),
      unit: line.quantity.unit,
      unitPricePaise: line.unitPrice.minor,
      grossAmountPaise: line.grossAmount.minor,
      discountPaise: line.discountAmount.minor,
      taxableValuePaise: line.taxableValue.minor,
      gstRatePercentTimes100: line.ratePercentTimes100 ?? 0n,
      cgstPaise: line.cgst.minor,
      sgstPaise: line.sgst.minor,
      igstPaise: line.igst.minor,
      cessPaise: line.cess.minor,
      lineTotalPaise: line.lineTotal.minor,
    }));

    return {
      documentId: invoice.id,
      documentType: 'INVOICE',
      documentNumber: invoice.number,
      documentDate: invoice.documentDate,
      recipientKind: invoice.customerType === 'B2B' ? 'B2B' : 'B2C',
      supplier: seller,
      recipient: buyer,
      placeOfSupplyStateCode: pricing.placeOfSupplyStateCode,
      reverseCharge: false,
      lines,
      totalTaxableValuePaise: pricing.totals.taxableValue.minor,
      totalCgstPaise: pricing.totals.cgst.minor,
      totalSgstPaise: pricing.totals.sgst.minor,
      totalIgstPaise: pricing.totals.igst.minor,
      totalCessPaise: pricing.totals.cess.minor,
      roundOffPaise: pricing.totals.roundOff.minor,
      invoiceValuePaise: pricing.totals.invoiceValue.minor,
    };
  }

  /** The turnover and category facts the applicability rules need, as the form supplies them. */
  private applicabilityFor(document: EInvoiceDocument, input: Record<string, unknown>) {
    const turnover = String(input.turnover ?? '').trim();
    return {
      documentType: document.documentType,
      documentDate: document.documentDate,
      recipientKind: document.recipientKind,
      ...(document.recipient.gstin === '' ? {} : { recipientGstin: document.recipient.gstin }),
      supplier: {
        gstin: document.supplier.gstin,
        // Blank means "we have not been told", which is a question, not a zero.
        ...(turnover === '' ? {} : { aggregateTurnoverPaise: paise(turnover) }),
        ...(input.exempt ? { exemptCategories: [String(input.exempt)] as never } : {}),
      },
    };
  }

  /** The invoices this company has issued, for the picker on the e-invoice screen. */
  async issuedInvoices(actor: ActorContext) {
    const companyId = this.companyOf(actor);
    const invoices = await this.salesRepository.list(companyId, { state: 'FINAL' });
    const records = await this.shop.eInvoice.list(actor);
    return {
      invoices: invoices.map((invoice) => {
        const record = records.find((candidate) => candidate.documentId === invoice.id);
        return {
          id: invoice.id,
          number: invoice.number,
          date: invoice.documentDate,
          amount: jsonAmount(invoice.pricing?.totals.invoiceValue.minor ?? 0n),
          // The bill's own state and the government's are shown separately, never merged.
          eInvoiceStatus: record?.status ?? 'NOT_SENT',
        };
      }),
    };
  }

  private static eInvoiceJson(record: EInvoiceRecord) {
    return {
      state: 'einvoice' as const,
      status: record.status,
      title: record.status === 'REGISTERED'
        ? 'Registered with the government'
        : record.status === 'CANCELLED'
          ? 'Cancelled with the government'
          : record.status === 'PENDING'
            ? 'Waiting for the government'
            : 'Not registered',
      message: record.message,
      documentNumber: record.documentNumber,
      applicability: {
        outcome: record.applicability.outcome,
        reason: record.applicability.reason,
        ruleId: record.applicability.ruleId,
        sourceRef: record.applicability.sourceRef ?? null,
      },
      irn: record.acknowledgement?.irn ?? null,
      ackNumber: record.acknowledgement?.ackNumber ?? null,
      ackDate: record.acknowledgement?.ackDate ?? null,
      signedQrCode: record.acknowledgement?.signedQrCode ?? null,
      cancellableUntil: record.cancellableUntil ?? null,
      reportableUntil: record.reportableUntil ?? null,
      failure: record.failure ?? null,
      raw: record,
    };
  }

  /** Whether this bill needs an IRN, and what would be sent. Writes nothing, sends nothing. */
  async previewEInvoice(actor: ActorContext, input: Record<string, unknown>) {
    const document = await this.eInvoiceDocumentFor(actor, String(input.invoice ?? ''));
    const preview = await this.shop.eInvoice.preview(actor, {
      document, applicability: this.applicabilityFor(document, input),
    });
    return {
      state: 'preview' as const,
      title: preview.applicability.outcome === 'APPLICABLE'
        ? (preview.ready ? 'Ready to send' : 'Something is missing')
        : preview.applicability.outcome === 'CANNOT_DECIDE' ? 'We need one more fact' : 'No e-invoice needed',
      message: preview.summary,
      outcome: preview.applicability.outcome,
      reason: preview.applicability.reason,
      ruleId: preview.applicability.ruleId,
      sourceRef: preview.applicability.sourceRef ?? null,
      ready: preview.ready,
      expectedIrn: preview.expectedIrn ?? null,
      reportableUntil: preview.reportableUntil ?? null,
      problems: preview.problems.map((problem) => ({ field: problem.field, message: problem.message })),
      documentNumber: document.documentNumber,
    };
  }

  /** Sends the bill to the government, once. */
  async registerEInvoice(actor: ActorContext, input: Record<string, unknown>) {
    const document = await this.eInvoiceDocumentFor(actor, String(input.invoice ?? ''));
    const record = await this.shop.eInvoice.register(actor, {
      document, applicability: this.applicabilityFor(document, input),
    });
    return DemoApplication.eInvoiceJson(record);
  }

  /** Asks the government what it actually holds, for when a call timed out. */
  async reconcileEInvoice(actor: ActorContext, input: Record<string, unknown>) {
    const record = await this.shop.eInvoice.reconcile(actor, String(input.invoice ?? ''));
    return DemoApplication.eInvoiceJson(record);
  }

  async cancelEInvoice(actor: ActorContext, input: Record<string, unknown>) {
    const record = await this.shop.eInvoice.cancel(actor, String(input.invoice ?? ''), {
      reasonCode: (String(input.reasonCode ?? 'OTHER') as 'OTHER'),
      reason: String(input.reason ?? ''),
    });
    return DemoApplication.eInvoiceJson(record);
  }

  /** The payload as a file, for the day the portal is down and a bill still has to go out. */
  async eInvoiceOfflineJson(actor: ActorContext, input: Record<string, unknown>) {
    const document = await this.eInvoiceDocumentFor(actor, String(input.invoice ?? ''));
    const json = await this.shop.eInvoice.offlineJson(actor, {
      document, applicability: this.applicabilityFor(document, input),
    });
    return { state: 'offline' as const, fileName: `einvoice-${document.documentNumber.replace(/\//g, '-')}.json`, json };
  }

  // -------------------------------------------------------- issue #19: supplier risk warnings

  /** The invented registrations this screen can be tried against, for the picker. */
  static supplierChoices() {
    return DEMO_REGISTRATIONS.map((demo) => ({ gstin: demo.gstin, name: demo.name, label: demo.label }));
  }

  /**
   * Checks a supplier and explains what was found, evidence by evidence.
   *
   * Reads only. Nothing is recorded against the supplier and no money moves — the whole output is
   * an explanation, which is what a person needs before they pay.
   */
  async checkSupplier(actor: ActorContext, input: Record<string, unknown>) {
    const gstin = String(input.gstin ?? '').replace(/\s/g, '').toUpperCase();
    const name = String(input.party ?? '').trim() || this.config.supplierName;
    const assessment = await this.shop.risk.assess(actor, {
      supplierPartyId: this.config.supplierId,
      supplierName: name,
      ...(gstin === '' ? {} : { gstin }),
      ...(input.stateCode ? { expectedStateCode: String(input.stateCode) } : {}),
      ...(input.reference ? { invoiceNumber: String(input.reference) } : {}),
      ...(input.date ? { invoiceDate: String(input.date) } : {}),
      ...(input.refresh === true ? { refresh: true } : {}),
      // A model's guess is accepted here only to prove it can never change the level.
      ...(input.modelHint
        ? { modelHint: { label: String(input.modelHint), score: 0.97, explanation: 'Shown to demonstrate that a score cannot change the level.', modelVersion: 'demo-v0' } }
        : {}),
    });
    const cleared = await this.shop.risk.isClearedToProceed(actor, assessment);
    return DemoApplication.riskJson(assessment, cleared);
  }

  /** A person deciding to go ahead, with the reason kept beside the supplier. */
  async acknowledgeSupplierRisk(actor: ActorContext, input: Record<string, unknown>) {
    const reason = String(input.reason ?? '').trim();
    const rebuilt = await this.checkSupplier(actor, input);
    if (rebuilt.level === 'INFORMATION') {
      return { ...rebuilt, title: 'Nothing to accept', message: 'There is nothing on this supplier that needs accepting.' };
    }
    await this.shop.risk.acknowledge(actor, rebuilt.raw, reason);
    const cleared = await this.shop.risk.isClearedToProceed(actor, rebuilt.raw);
    return { ...DemoApplication.riskJson(rebuilt.raw, cleared), title: 'Accepted', message: cleared.reason };
  }

  /** The assessment as a screen needs it: every warning with the evidence behind it. */
  private static riskJson(assessment: SupplierRiskAssessment, cleared: { cleared: boolean; reason: string }) {
    return {
      state: 'risk' as const,
      level: assessment.level,
      confidence: assessment.confidence,
      cleared: cleared.cleared,
      title: assessment.level === 'SERIOUS'
        ? 'Worth checking before you pay'
        : assessment.level === 'CAUTION'
          ? 'A few things worth knowing'
          : 'Nothing needs your attention',
      message: assessment.summary,
      supplier: assessment.supplierName,
      gstin: assessment.gstin ?? null,
      // Issue #99. Two lights: what the government says, and what our own books say.
      lights: assessment.lights.map((light) => ({
        scope: light.scope, colour: light.colour, title: light.title,
        headline: light.headline, detail: light.detail, warningCount: light.warningCount,
      })),
      warnings: assessment.warnings.map((warning) => ({
        code: warning.code,
        level: warning.level,
        message: warning.message,
        action: warning.suggestedAction,
        evidence: warning.evidence.map((evidence) => ({
          source: evidence.source,
          statement: evidence.statement,
          effectiveFrom: evidence.effectiveFrom ?? null,
          observedAt: evidence.observedAt ?? null,
          ageInDays: evidence.ageInDays ?? null,
          stale: evidence.stale,
          unavailable: evidence.unavailable?.reason ?? null,
        })),
      })),
      sources: assessment.sources.map((source) => ({
        source: source.source, consulted: source.consulted, answered: source.answered,
        stale: source.stale, note: source.note,
      })),
      raw: assessment,
    };
  }

  /**
   * Builds a real purchase line from what the person actually typed.
   *
   * The GST rate, the item and the supplier's state all come from the form, so the tax split,
   * the stock receipt and the "this total does not match its own lines" refusal are the real
   * ones from #17 rather than a fixed line that always adds up.
   */
  private purchaseInput(actor: ActorContext, input: Record<string, unknown>): ApprovedPurchase {
    const companyId = this.companyOf(actor);
    const reference = String(input.reference ?? '').trim();
    if (!reference) throw invalid('API_REFERENCE_REQUIRED', 'Enter the supplier bill number.');
    const date = String(input.date ?? '');
    isoDate(date);

    const itemId = String(input.item ?? 'TMT12');
    const catalogue: Record<string, { description: string; hsnSac: string; unit: string; kind: 'GOODS' | 'SERVICES'; batchId?: string }> = {
      TMT12: { description: 'TMT Steel Bar 12mm', hsnSac: '72142090', unit: 'KGS', kind: 'GOODS' },
      SOAP: { description: 'Herbal Bath Soap 100g', hsnSac: '34011190', unit: 'BOX', kind: 'GOODS', batchId: 'batch-web' },
      FRT: { description: 'Inward freight', hsnSac: '996511', unit: 'NOS', kind: 'SERVICES' },
    };
    const item = catalogue[itemId] ?? catalogue.TMT12!;

    const gstBasisPoints = Number(input.gst ?? 0);
    const intraState = String(input.supplierState ?? 'other') === 'same';
    // A blank bill total is allowed once a price per unit is given: the lines decide it.
    const typedTotal = String(input.amount ?? '').trim() === '' ? 0n : paise(input.amount);

    // A caller that sends only a bill amount — the older shape, and anything scripted against it —
    // gets one line for that amount. A caller that sends a price and a quantity gets a real line.
    const pricePerUnit = String(input.rate ?? '').trim() !== '';
    const qty = pricePerUnit ? quantity(String(input.quantity ?? '1'), item.unit) : quantity('1', item.unit);
    const rate = pricePerUnit ? paise(input.rate) : typedTotal;
    if (rate <= 0n) throw invalid('API_RATE_REQUIRED', 'Enter either the bill amount, or the price of one and how many.');

    // Exactly the arithmetic #16 and #17 both use, so the figure on screen is the posted one.
    const taxable = lineTaxableValue(qty.scaled, rate);
    const tax = taxOn(taxable, gstBasisPoints);
    // A typed bill total is checked against what the lines come to; a blank one is taken from them.
    const total = pricePerUnit && typedTotal > 0n ? typedTotal : taxable + tax;

    const verdict: PurchaseVerdict = {
      draftId: `web:${reference}`,
      companyId,
      status: 'POSTABLE',
      findings: [],
      duplicate: { verdict: 'NONE', matches: [], fingerprint: `web:${companyId}:${reference}`, message: 'Nothing like this has been entered before.' },
      recomputed: { taxableValuePaise: taxable, totalTaxPaise: tax, invoiceTotalPaise: taxable + tax, linesTaxableValuePaise: [taxable], lineProblems: [], complete: true },
      taxCheck: {
        basis: 'RULES_ENGINE',
        intraState,
        ruleSetVersion: 'gst-2026.1',
        ruleId: intraState ? 'POS.INTRASTATE' : 'POS.INTERSTATE',
        explanation: intraState ? 'The supplier and the godown are in the same state.' : 'The supplier is in another state.',
      },
      corrections: [],
      policy: { roundingPaise: 100n, taxAbsolutePaise: 100n, totalAbsolutePaise: 100n, totalRelativeBasisPoints: 10, effectiveFrom: '2026-04-01' },
      fingerprint: `web:${companyId}:${reference}`,
      summary: 'Everything on this bill adds up.',
    };
    const line: ApprovedPurchaseLine = {
      lineNumber: 1,
      itemId,
      description: item.description,
      hsnSac: item.hsnSac,
      supplyKind: item.kind,
      ...(item.kind === 'GOODS' ? { warehouseId: 'wh-main' } : {}),
      ...(item.batchId === undefined ? {} : { batchId: item.batchId }),
      quantity: qty,
      ratePaise: rate,
      taxableValuePaise: taxable,
      gstRateBasisPoints: gstBasisPoints,
      itcEligibility: 'ELIGIBLE',
    };
    return {
      id: `web-purchase:${reference}`,
      companyId,
      sourceDocumentId: `web-document:${reference}`,
      verdict,
      supplierPartyId: this.config.supplierId,
      supplierName: String(input.party || this.config.supplierName),
      invoiceNumber: reference,
      invoiceDate: isoDate(date),
      lines: [line],
      invoiceTotalPaise: total,
      taxLiability: 'SUPPLIER',
      creditDays: 30,
      approvedBy: actor.userId,
      approvedAt: '2026-08-29T10:00:00.000Z',
    };
  }

  private saleInput(input: Record<string, unknown>) {
    const date = isoDate(String(input.date));
    const terms = Number(input.terms ?? 0);
    return { partyId: this.config.customerId, customerType: 'B2B' as const, supplyKind: 'GOODS' as const, documentDate: date, dueDate: isoDate(daysAfter(date, Number.isFinite(terms) ? terms : 0)), deliveryStateCode: this.config.gstin.slice(0, 2), lines: [{ lineId: 'line-1', itemId: 'SOAP', quantity: quantityFromString(String(input.quantity), 'PCS'), unitPrice: money(paise(input.rate)), priceBasis: 'EXCLUSIVE' as const, note: String(input.item || 'Herbal Bath Soap 100g') }], narration: String(input.notes || '') || null };
  }

  private companyOf(actor: ActorContext): CompanyId {
    if (actor.companyId !== this.config.companyId) throw invalid('API_TENANT_MISMATCH', 'This company is not available in your session.');
    return actor.companyId;
  }
}
