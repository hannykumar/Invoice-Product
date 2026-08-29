/**
 * Issue #72 — one synthetic company composed from the real domain services.
 *
 * This is deliberately an in-memory demo surface. It proves the browser is talking to the same
 * services and invariants as tests/workers; it is not production authentication or persistence.
 */
import { asId, isoDate, money, quantityFromString, type IsoDate, type PartyId } from '@invoice/kernel';
import { permissionPortFromActor, type Account } from '@invoice/ledger';
import { GstCalculator, FIXTURE_RATE_TABLE, InMemoryMasterData } from '@invoice/gst-calc';
import { RulesEngine, shippedRegistry } from '@invoice/rules-engine';
import { InMemorySalesRepository, noComplianceHooks, permissiveInventory, SalesService } from '@invoice/sales';
import { InMemoryPaymentRepository, ReceivablesService, type DocumentLedgerPort, type OpenDocument } from '@invoice/receivables';
import {
  ReportService,
  duesFrom,
  namesFrom,
  purchasesFrom,
  type Figure,
  type PurchaseDocument,
  type ReportFilter,
} from '@invoice/reports';
import { createDefaultUnitRegistry } from '../../../packages/masters/src/units.ts';
import type { StockItem, StockMasterData, Warehouse } from '@invoice/inventory';
import { DEFAULT_SALES_POLICY } from '../../../packages/sales/src/policy.ts';
import { COMPANY, SUPPLIER, ALL_PERMISSIONS as PURCHASE_PERMISSIONS, actorWith, clearedVerdict, makeShop, purchase, steelLine } from '../../../packages/purchasing/src/posting-fixtures.ts';
import { lineTaxableValue, taxOn } from '../../../packages/purchasing/src/recompute.ts';
import { formatQuantity } from '../../../packages/masters/src/units.ts';
import type { PurchasePostingPreview } from '../../../packages/purchasing/src/posting-types.ts';
import { purchaseDocumentLedger } from '../../../packages/purchasing/src/posting-adapters.ts';
import { quantity } from '../../../packages/masters/src/units.ts';

const CUSTOMER = asId<'Party'>('party-abc');
const DEMO_PERMISSIONS = [
  ...PURCHASE_PERMISSIONS,
  'ledger.post.sale', 'ledger.post.receipt', 'ledger.post.payment', 'ledger.post.journal',
  'sales.draft.write', 'sales.finalise', 'sales.approve', 'sales.cancel',
  'payments.record', 'payments.allocate', 'payments.reverse', 'payments.write_off',
  'reports.view.financial', 'reports.view.sales', 'reports.view.purchase', 'reports.view.stock',
  'reports.view.dues', 'reports.view.gst', 'reports.view.exceptions', 'reports.export',
];

const paise = (value: unknown): bigint => {
  const normalized = String(value ?? '').replace(/,/g, '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error('Enter a valid amount greater than zero.');
  const [whole = '0', fraction = ''] = normalized.split('.');
  const result = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  if (result <= 0n) throw new Error('Enter a valid amount greater than zero.');
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
 * The purchase side, read live from the posted bills.
 *
 * Every field a register prints is already on a posted bill — the supplier, the invoice number,
 * the tax split, the total — so this is a rename, not a second source of truth. Only POSTED bills
 * count; a draft is not a purchase.
 */
const livePurchaseReadPort = (shop: Awaited<ReturnType<typeof makeShop>>) => ({
  available: true,
  async list(companyId: unknown, from: IsoDate, to: IsoDate): Promise<readonly PurchaseDocument[]> {
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
const previewEffects = (preview: PurchasePostingPreview): string[] => {
  const tax = preview.tax;
  const claimable = tax.cgstPaise + tax.sgstPaise + tax.igstPaise + tax.cessPaise;
  const effects = preview.receipts.map((receipt) => `Stock: +${formatQuantity(receipt.quantity)} in Peenya godown`);
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
  private readonly shop: Awaited<ReturnType<typeof makeShop>>;
  private readonly actor: ReturnType<typeof actorWith>;
  private readonly sales: SalesService;
  private readonly salesRepository: InMemorySalesRepository;
  private readonly payments: ReceivablesService;
  private readonly paymentRepository: InMemoryPaymentRepository;
  private readonly documents: DocumentLedgerPort;
  private readonly reportService: ReportService;

  private constructor(
    shop: Awaited<ReturnType<typeof makeShop>>,
    actor: ReturnType<typeof actorWith>,
    sales: SalesService,
    salesRepository: InMemorySalesRepository,
    payments: ReceivablesService,
    paymentRepository: InMemoryPaymentRepository,
    documents: DocumentLedgerPort,
    reportService: ReportService,
  ) {
    this.shop = shop;
    this.actor = actor;
    this.sales = sales;
    this.salesRepository = salesRepository;
    this.payments = payments;
    this.paymentRepository = paymentRepository;
    this.documents = documents;
    this.reportService = reportService;
  }

  static async create(): Promise<DemoApplication> {
    const shop = await makeShop();
    const actor = actorWith(DEMO_PERMISSIONS);
    await shop.ledger.openPartyAccount(actor, { partyId: CUSTOMER, name: 'ABC Traders', kind: 'CUSTOMER' });
    await shop.store.transaction(COMPANY, async (uow) => {
      const bankParent = await uow.accounts.findByCode(COMPANY, '1120');
      const bank: Account = {
        id: asId<'Account'>('sampoorna:acc:1121'), companyId: COMPANY, code: '1121', name: 'HDFC Current Account',
        type: 'ASSET', parentId: bankParent?.id ?? null, isGroup: false, active: true, partyId: null, systemRole: null,
      };
      await uow.accounts.insertMany([bank]);
    });

    const salesRepository = new InMemorySalesRepository();
    const paymentRepository = new InMemoryPaymentRepository();
    shop.store.join(salesRepository).join(paymentRepository);
    const masters = new InMemoryMasterData();
    masters.putCompany({ companyId: COMPANY, gstin: '29AAAAA0000A1ZR', stateCode: '29', registration: 'REGULAR' });
    masters.putParty(COMPANY, { partyId: CUSTOMER, gstin: '29BBBBB1111B1Z4', stateCode: '29', registration: 'REGULAR' });
    masters.putItem(COMPANY, { itemId: 'SOAP', name: 'Herbal Bath Soap 100g', kind: 'GOODS', hsnOrSac: '0808', treatment: 'NIL_RATED', reverseCharge: false, baseUnit: 'PCS' });
    const calculator = new GstCalculator({ masterData: masters, rates: FIXTURE_RATE_TABLE, gstEngine: new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.gst', mode: 'development' }), mode: 'development' });
    const sales = new SalesService({ store: shop.store, ledger: shop.ledger, calculator, repository: salesRepository, inventory: permissiveInventory, compliance: noComplianceHooks, permissions: { require(subject, permission) { if (!subject.permissions.includes(permission)) throw new Error(`Missing permission ${permission}.`); } }, audit: shop.audit, clock: { now: () => new Date() }, policy: { ...DEFAULT_SALES_POLICY, series: { prefix: 'INV', branchCode: 'WEB', padding: 5 } } });

    const purchases = purchaseDocumentLedger(shop.bills, async () => 'Shree Ram Steels Private Limited');
    const documents: DocumentLedgerPort = {
      async openDocuments(companyId, partyId) {
        const purchaseDocuments = await purchases.openDocuments(companyId, partyId);
        const invoices = await salesRepository.list(companyId, { partyId, state: 'FINAL' });
        const saleDocuments: OpenDocument[] = invoices.map((invoice) => ({ documentId: invoice.id, kind: 'SALES_INVOICE', number: invoice.number ?? invoice.id, partyId, date: invoice.documentDate, dueDate: invoice.dueDate, value: invoice.pricing?.totals.invoiceValue ?? money(0n), side: 'RECEIVABLE' }));
        return [...purchaseDocuments, ...saleDocuments];
      },
      async parties(companyId) { return [...new Set([...(await purchases.parties(companyId)), CUSTOMER])] as readonly PartyId[]; },
      async nameOf(companyId, partyId) { return partyId === CUSTOMER ? 'ABC Traders' : purchases.nameOf(companyId, partyId); },
    };
    const payments = new ReceivablesService({ store: shop.store, ledger: shop.ledger, repository: paymentRepository, documents, permissions: { require(subject, permission) { if (!subject.permissions.includes(permission)) throw new Error(`Missing permission ${permission}.`); } }, audit: shop.audit, clock: { now: () => new Date() } });

    // Reports read the same live company: the ledger every module posts to, the sales invoices
    // sales issues, the stock movements purchases receive, the positions receivables derives. No
    // figure below is written by hand; it is folded from what the other services recorded.
    const reportService = new ReportService({
      store: shop.store,
      sales: salesRepository,
      inventory: shop.inventory,
      stockMasterData: demoStockMasterData(),
      dues: duesFrom(documents, payments),
      // The purchase side is real here (#17 posts bills), so the register reads the posted bills
      // live rather than the "not built yet" placeholder the package ships for lanes without it.
      // Live, not a snapshot, so a bill recorded through the web form shows up on the next report.
      purchases: livePurchaseReadPort(shop),
      names: namesFrom({
        parties: { [CUSTOMER]: 'ABC Traders', [SUPPLIER]: 'Shree Ram Steels Private Limited' },
        items: { TMT12: 'TMT Steel Bar 12mm' },
        warehouses: { 'wh-main': 'Peenya godown' },
      }),
      permissions: permissionPortFromActor,
      audit: shop.audit,
      clock: { now: () => new Date() },
    });

    const app = new DemoApplication(shop, actor, sales, salesRepository, payments, paymentRepository, documents, reportService);
    await app.seed();
    return app;
  }

  private async seed(): Promise<void> {
    await this.recordSale({ party: 'ABC Traders', item: 'Herbal Bath Soap 100g', quantity: '4', rate: '250', date: '2026-08-29', terms: '30', reference: 'seed-sale', notes: 'Synthetic opening demo sale' });
  }

  async dashboard() {
    const sales = await this.salesRepository.list(COMPANY, { state: 'FINAL' });
    const purchases = await this.shop.bills.list(COMPANY);
    const payments = await this.paymentRepository.list(COMPANY);
    const supplier = await this.payments.position(this.actor, SUPPLIER as PartyId, isoDate('2026-08-29'));
    const customer = await this.payments.position(this.actor, CUSTOMER, isoDate('2026-08-29'));
    const stock = await this.shop.inventoryService.balance(this.actor, { itemId: 'TMT12', warehouseId: 'wh-main' });
    return {
      company: { id: COMPANY, name: 'Sampoorna Traders', location: 'Bengaluru · Peenya godown' },
      metrics: {
        salesToday: jsonAmount(sales.reduce((sum, invoice) => sum + (invoice.pricing?.totals.invoiceValue.minor ?? 0n), 0n)),
        customersOwe: jsonAmount(customer.totalOutstanding.minor),
        purchasesMonth: jsonAmount(purchases.filter((bill) => bill.state === 'POSTED').reduce((sum, bill) => sum + bill.totalPaise, 0n)),
        needsAttention: (stock.physical.scaled <= 0n ? 1 : 0) + supplier.documents.filter((position) => position.daysOverdue > 0).length,
      },
      stock: { itemId: 'TMT12', name: 'TMT Steel Bar 12mm', quantity: Number(stock.physical.scaled) / 1_000_000, unit: stock.physical.unit },
      supplier: { id: SUPPLIER, name: 'Shree Ram Steels Private Limited', outstanding: jsonAmount(supplier.totalOutstanding.minor), documents: supplier.documents.map((position) => ({ id: position.document.documentId, number: position.document.number, dueDate: position.document.dueDate, outstanding: jsonAmount(position.outstanding.minor), status: position.status })) },
      customer: { id: CUSTOMER, name: 'ABC Traders', outstanding: jsonAmount(customer.totalOutstanding.minor), documents: customer.documents.map((position) => ({ id: position.document.documentId, number: position.document.number, dueDate: position.document.dueDate, outstanding: jsonAmount(position.outstanding.minor), status: position.status })) },
      activity: [
        ...sales.map((invoice) => ({ id: invoice.id, kind: 'sale', title: `${invoice.number} · ABC Traders`, amount: jsonAmount(invoice.pricing?.totals.invoiceValue.minor ?? 0n), status: 'Recorded' })),
        ...purchases.map((bill) => ({ id: bill.id, kind: 'purchase', title: `${bill.invoiceNumber} · ${bill.supplierName}`, amount: jsonAmount(bill.totalPaise), status: bill.state === 'POSTED' ? 'Recorded' : bill.state })),
        ...payments.map((payment) => ({ id: payment.id, kind: 'payment', title: `${payment.mode.replace('_', ' ')} · ABC Traders`, amount: jsonAmount(payment.amount.minor), status: payment.state === 'RECORDED' ? 'Recorded' : payment.state })),
      ].reverse(),
    };
  }

  /**
   * The report pack, over the whole first year of the demo company's books, as figures a screen can
   * render. Every number is folded from the same records the dashboard and the forms mutate; drill
   * rows are carried so a total on screen can be opened into the entries behind it.
   */
  async reports() {
    const filter: ReportFilter = { from: isoDate('2026-04-01'), to: isoDate('2027-03-31') };
    const pack = await this.reportService.pack(this.actor, filter);
    const drill = (figure: Figure) =>
      figure.contributors.map((c) => ({ date: c.date, number: c.sourceNumber, description: c.description, amount: jsonAmount(c.amount.minor) }));

    return {
      period: { from: filter.from, to: filter.to },
      trialBalance: {
        title: pack.trialBalance.header.title['en-IN'],
        balanced: pack.trialBalance.body.balanced,
        totalDebits: jsonAmount(pack.trialBalance.body.totalDebits.amount.minor),
        totalCredits: jsonAmount(pack.trialBalance.body.totalCredits.amount.minor),
        difference: jsonAmount(pack.trialBalance.body.difference.minor),
        rows: pack.trialBalance.body.rows.map((r) => ({ code: r.code, name: r.name, closing: jsonAmount(r.closing.amount.minor), side: r.side })),
      },
      profitAndLoss: {
        title: pack.profitAndLoss.header.title['en-IN'],
        sentence: pack.profitAndLoss.body.sentence['en-IN'],
        income: { total: jsonAmount(pack.profitAndLoss.body.income.total.amount.minor), rows: pack.profitAndLoss.body.income.rows.map((r) => ({ name: r.name, amount: jsonAmount(r.movement.amount.minor) })), drill: drill(pack.profitAndLoss.body.income.total) },
        expenses: { total: jsonAmount(pack.profitAndLoss.body.expenses.total.amount.minor), rows: pack.profitAndLoss.body.expenses.rows.map((r) => ({ name: r.name, amount: jsonAmount(r.movement.amount.minor) })) },
        result: jsonAmount(pack.profitAndLoss.body.result.amount.minor),
      },
      balanceSheet: {
        title: pack.balanceSheet.header.title['en-IN'],
        sentence: pack.balanceSheet.body.sentence['en-IN'],
        balanced: pack.balanceSheet.body.balanced,
        totalAssets: jsonAmount(pack.balanceSheet.body.totalAssets.amount.minor),
        totalClaims: jsonAmount(pack.balanceSheet.body.totalClaims.amount.minor),
      },
      sales: {
        title: pack.sales.header.title['en-IN'],
        sentence: pack.sales.body.sentence['en-IN'],
        total: jsonAmount(pack.sales.body.total.amount.minor),
        rows: pack.sales.body.rows.map((r) => ({ date: r.date, number: r.number, party: r.partyName, taxable: jsonAmount(r.taxableValue.minor), total: jsonAmount(r.total.minor) })),
      },
      purchases: {
        title: pack.purchases.header.title['en-IN'],
        sentence: pack.purchases.body.sentence['en-IN'],
        available: pack.purchases.body.available,
        total: jsonAmount(pack.purchases.body.total.amount.minor),
        rows: pack.purchases.body.rows.map((r) => ({ date: r.date, number: r.number, party: r.partyName, taxable: jsonAmount(r.taxableValue.minor), total: jsonAmount(r.total.minor) })),
      },
      stock: {
        title: pack.stock.header.title['en-IN'],
        sentence: pack.stock.body.sentence['en-IN'],
        value: jsonAmount(pack.stock.body.value.amount.minor),
        rows: pack.stock.body.rows.map((r) => ({ item: r.itemName, warehouse: r.warehouseName, unit: r.unitCode, closing: r.closing, available: r.available, value: jsonAmount(r.value.minor) })),
      },
      dues: {
        receivables: { title: pack.receivables.header.title['en-IN'], sentence: pack.receivables.body.sentence['en-IN'], total: jsonAmount(pack.receivables.body.total.amount.minor), rows: pack.receivables.body.rows.map((r) => ({ party: r.partyName, outstanding: jsonAmount(r.outstanding.minor), onAccount: jsonAmount(r.onAccount.minor), oldestDaysOverdue: r.oldestDaysOverdue })) },
        payables: { sentence: pack.payables.body.sentence['en-IN'], total: jsonAmount(pack.payables.body.total.amount.minor), rows: pack.payables.body.rows.map((r) => ({ party: r.partyName, outstanding: jsonAmount(r.outstanding.minor), oldestDaysOverdue: r.oldestDaysOverdue })) },
      },
      gst: {
        title: pack.gst.header.title['en-IN'],
        sentence: pack.gst.body.sentence['en-IN'],
        collected: jsonAmount(pack.gst.body.totalCollected.amount.minor),
        alreadyPaid: jsonAmount(pack.gst.body.totalAlreadyPaid.amount.minor),
        difference: jsonAmount(pack.gst.body.difference.minor),
        caution: pack.gst.body.caution['en-IN'],
      },
      exceptions: {
        title: pack.exceptions.header.title['en-IN'],
        clean: pack.exceptions.body.clean,
        sentence: pack.exceptions.body.sentence['en-IN'],
        items: pack.exceptions.body.exceptions.map((e) => ({ code: e.code, severity: e.severity, what: e.what['en-IN'], why: e.why['en-IN'], amount: e.amount === null ? null : jsonAmount(e.amount.minor) })),
      },
    };
  }

  previewPurchase(input: Record<string, unknown>) {
    const approved = this.purchaseInput(input);
    const preview = this.shop.posting.preview(this.actor, approved);
    return { state: 'preview', title: 'Ready to record', message: preview.summary, amount: jsonAmount(preview.totalPaise), effects: previewEffects(preview), token: approved.id };
  }

  async recordPurchase(input: Record<string, unknown>) {
    const approved = this.purchaseInput(input);
    const result = await this.shop.posting.post(this.actor, approved, `web:${approved.id}`);
    const state = await this.dashboard();
    return { state: 'recorded', deduplicated: result.deduplicated, title: result.deduplicated ? 'Already recorded once' : 'Purchase recorded', message: result.deduplicated ? 'The existing bill was returned. Stock and the supplier balance were not doubled.' : result.bill.summary, stock: state.stock, supplier: state.supplier };
  }

  async previewSale(input: Record<string, unknown>) {
    const draft = await this.sales.createDraft(this.actor, { idempotencyKey: `web-sale:${String(input.reference || crypto.randomUUID())}`, input: this.saleInput(input) });
    if (draft.pricing === null) throw new Error(draft.problems.map((problem) => problem.message['en-IN']).join(' '));
    return { state: 'preview', title: 'Sale checked', message: draft.pricing.explanation['en-IN'], amount: jsonAmount(draft.pricing.totals.invoiceValue.minor), token: draft.id, effects: ['A numbered invoice will be issued.', 'The customer balance will increase.'] };
  }

  async recordSale(input: Record<string, unknown>) {
    const preview = await this.previewSale(input);
    const final = await this.sales.finalise(this.actor, { idempotencyKey: `web-sale-final:${preview.token}`, invoiceId: preview.token });
    return { state: 'recorded', deduplicated: final.deduplicated, title: final.deduplicated ? 'Sale already recorded once' : 'Sale recorded', message: `${final.invoice.number} was issued.`, invoice: { id: final.invoice.id, number: final.invoice.number, amount: jsonAmount(final.invoice.pricing?.totals.invoiceValue.minor ?? 0n) } };
  }

  async previewPayment(input: Record<string, unknown>) {
    const amount = paise(input.amount);
    const customer = await this.payments.position(this.actor, CUSTOMER, isoDate(String(input.date)));
    return { state: 'preview', title: 'Payment checked', message: `₹${jsonAmount(amount).toFixed(2)} will reduce what ABC Traders owes.`, amount: jsonAmount(amount), token: String(input.reference || crypto.randomUUID()), effects: [`Outstanding now: ₹${jsonAmount(customer.totalOutstanding.minor).toFixed(2)}`, input.invoice ? 'The selected invoice will be settled by this amount.' : 'The money will remain visibly on account.'] };
  }

  async recordPayment(input: Record<string, unknown>) {
    const amountMinor = paise(input.amount);
    const invoice = String(input.invoice ?? '');
    const open = invoice ? (await this.documents.openDocuments(COMPANY, CUSTOMER)).find((document) => document.documentId === invoice) : undefined;
    const amountToAllocate = open === undefined ? 0n : (amountMinor < open.value.minor ? amountMinor : open.value.minor);
    const payment = await this.payments.recordPayment(this.actor, { idempotencyKey: `web-payment:${String(input.reference || `${input.date}:${amountMinor}`)}`, direction: 'RECEIPT', partyId: CUSTOMER, mode: 'CASH', amount: money(amountMinor), date: isoDate(String(input.date)), reference: String(input.reference || '') || null, ...(open === undefined ? {} : { allocations: [{ documentId: open.documentId, documentNumber: open.number, amount: money(amountToAllocate) }] }) });
    const position = await this.payments.position(this.actor, CUSTOMER, isoDate(String(input.date)));
    return { state: 'recorded', title: 'Payment recorded', message: `₹${jsonAmount(payment.amount.minor).toFixed(2)} was recorded once.`, paymentId: payment.id, customerOutstanding: jsonAmount(position.totalOutstanding.minor) };
  }

  /**
   * Builds a real purchase line from what the person actually typed.
   *
   * The GST rate, the item and the supplier's state all come from the form, so the tax split,
   * the stock receipt and the "this total does not match its own lines" refusal are the real
   * ones from #17 rather than a fixed line that always adds up.
   */
  private purchaseInput(input: Record<string, unknown>) {
    const reference = String(input.reference ?? '').trim();
    if (!reference) throw new Error('Enter the supplier bill number.');
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
    if (rate <= 0n) throw new Error('Enter either the bill amount, or the price of one and how many.');

    // Exactly the arithmetic #16 and #17 both use, so the figure on screen is the posted one.
    const taxable = lineTaxableValue(qty.scaled, rate);
    const tax = taxOn(taxable, gstBasisPoints);
    // A typed bill total is checked against what the lines come to; a blank one is taken from them.
    const total = pricePerUnit && typedTotal > 0n ? typedTotal : taxable + tax;

    return purchase({
      id: `web-purchase:${reference}`,
      sourceDocumentId: `web-document:${reference}`,
      verdict: clearedVerdict({
        draftId: `web:${reference}`,
        fingerprint: `web:${reference}`,
        taxCheck: {
          basis: 'RULES_ENGINE',
          intraState,
          ruleSetVersion: 'gst-2026.1',
          ruleId: intraState ? 'POS.INTRASTATE' : 'POS.INTERSTATE',
          explanation: intraState ? 'The supplier and the godown are in the same state.' : 'The supplier is in another state.',
        },
      }),
      supplierName: String(input.party || 'Shree Ram Steels Private Limited'),
      invoiceNumber: reference,
      invoiceDate: date,
      invoiceTotalPaise: total,
      creditDays: 30,
      lines: [steelLine({
        itemId,
        description: item.description,
        hsnSac: item.hsnSac,
        supplyKind: item.kind,
        warehouseId: item.kind === 'GOODS' ? 'wh-main' : undefined,
        batchId: item.batchId,
        quantity: qty,
        ratePaise: rate,
        taxableValuePaise: taxable,
        gstRateBasisPoints: gstBasisPoints,
      })],
    });
  }

  private saleInput(input: Record<string, unknown>) {
    const date = isoDate(String(input.date));
    const terms = Number(input.terms ?? 0);
    return { partyId: CUSTOMER, customerType: 'B2B' as const, supplyKind: 'GOODS' as const, documentDate: date, dueDate: isoDate(daysAfter(date, Number.isFinite(terms) ? terms : 0)), deliveryStateCode: '29', lines: [{ lineId: 'line-1', itemId: 'SOAP', quantity: quantityFromString(String(input.quantity), 'PCS'), unitPrice: money(paise(input.rate)), priceBasis: 'EXCLUSIVE' as const, note: String(input.item || 'Herbal Bath Soap 100g') }], narration: String(input.notes || '') || null };
  }
}

let demoPromise: Promise<DemoApplication> | undefined;
export const demoApplication = (): Promise<DemoApplication> => (demoPromise ??= DemoApplication.create());
