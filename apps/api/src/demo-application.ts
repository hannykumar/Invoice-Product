/**
 * Issues #72 and #80 — one authenticated company composed from the real domain services.
 *
 * Persistence is in-memory for the local app, but company and actor always come from the session.
 */
import { invalid, isoDate, money, notFound, quantityFromString, sum, type CompanyId, type PartyId } from '@invoice/kernel';
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
import { ComplianceRegister } from '@invoice/compliance-register';
import { AssistantService, describeIntent } from '../../../packages/assistant/src/service.ts';
import type { BlockedDocument, BlockedDocumentPort, BlockingReason } from '../../../packages/assistant/src/ports.ts';
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
import {
  ActionAgentService,
  InMemoryAgentPlanStore,
  ToolRegistry,
  cancelInvoiceTool,
  findUnpaidTool,
  sendReminderTool,
  stopRemindingTool,
  totalOwedTool,
  AGENT_DISCLAIMER,
  type AgentPlan,
  type AgentReport,
  type PartyDirectoryPort,
} from '@invoice/action-agent';
import { AuditLog, PlatformCommandService } from '../../../packages/platform/src/index.ts';
import {
  InMemoryServiceInvoiceRepository,
  InMemorySubscriptionRepository,
  InMemoryUsageRepository,
  SubscriptionService,
  alwaysPays,
  type Entitlement,
  type Plan,
} from '@invoice/subscriptions';
import {
  ChannelNotificationTransport,
  InAppNotificationAdapter,
  NotificationService,
  NotificationTemplateRegistry,
  type Notification,
  type NotificationTransport,
  type Permission,
  type RequestContext,
} from '../../../packages/platform/src/index.ts';
import {
  CollectionsService,
  InMemoryReminderRepository,
  notificationReminderTransport,
  receivablesPositions,
  registerReminderTemplates,
  type PartyContactPort,
  type ReminderCandidate,
  type Reminder,
} from '@invoice/collections';
import { showQuantity } from '../../../packages/purchasing/src/matching.ts';
import type { SupplierRiskAssessment } from '../../../packages/purchasing/src/supplier-risk-types.ts';
import { DEMO_REGISTRATIONS } from './company-shop.ts';
import type { EInvoiceRecord } from '../../../packages/gst/src/einvoice-types.ts';
import type { EInvoiceDocument, EInvoiceLine, PartyDetails } from '../../../packages/gst/src/payload.ts';
import type {
  ConsignmentLine, EwayBillRecord, Movement, MovementParty, MovementReason, VehicleAssignment,
} from '../../../packages/transport/src/types.ts';
import { describeExpiry, describeTimeLeft } from '../../../packages/transport/src/validity.ts';
import { outstandingOf } from '../../../packages/transport/src/suitability-service.ts';
import { platePhoto } from '../../../packages/transport/src/suitability-adapters.ts';
import { SYNTHETIC_VAHAN_ROWS } from '../../../packages/transport/src/vehicle-record-adapters.ts';
import { PERMITTED_VEHICLE_FIELD_NAMES } from '../../../packages/transport/src/vehicle-record-types.ts';
import { readVehicleClass, readWeightKg } from '../../../packages/transport/src/vehicle-record.ts';
import { VEHICLE_CLASS_NAMES } from '../../../packages/transport/src/suitability-types.ts';
import type {
  ShipmentFacts, TransportDetails, VehicleClass, VehicleEvidence, VehicleSuitabilityAssessment,
} from '../../../packages/transport/src/suitability-types.ts';
import { CURRENT_STATE_RULES, jurisdictionCounts } from '../../../packages/transport/src/rules.ts';
import type { GoodsReceipt, MatchResult, PurchaseOrder } from '../../../packages/purchasing/src/matching-types.ts';
import {
  InMemoryReturnNoteRepository, ReturnService, purchaseReturnSource, returnInventoryAdapter, salesReturnSource,
} from '../../../packages/returns/src/index.ts';
import { BankFeedService, SyntheticBankFeedProvider, type BankFeedConnection, type BankFeedContext } from '../../../packages/bank-feeds/src/index.ts';
import { itcInwardTaxPort } from '../../../packages/itc/src/adapters.ts';
import type { ItcWorkspace, ReconciliationLine } from '../../../packages/itc/src/types.ts';
import { ITC_PERMISSIONS, totalTaxOf as totalItcTaxOf } from '../../../packages/itc/src/types.ts';
import {
  GstReturnService, InMemoryReturnPreparations, ledgerBookTaxPort, ledgerInwardTaxPort,
  returnNoteToDocument, salesInvoiceToDocument, taxPeriod, taxPeriodOf, totalTaxOf,
  type OutwardDocument, type OutwardSupplyPort, type ReturnWorkspace, type TaxPeriod,
} from '@invoice/gst-returns';
import { standardRecurringJobs, type RecurringJobDefinition } from '../../../ops/operations/src/index.ts';

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

/**
 * Issue #23 — where a reminder ends up in this demo.
 *
 * The one thing here that is not the real module: WhatsApp, SMS and email have no provider on a
 * developer's machine, so the message is rendered through GPT 2's real template registry and kept
 * where the screen can show it. Nothing about the decision to send it is faked.
 */
class DemoReminderOutbox implements NotificationTransport {
  readonly messages: { channel: string; to: string; subject: string; body: string; at: string }[] = [];
  private readonly templates: NotificationTemplateRegistry;
  constructor(templates: NotificationTemplateRegistry) { this.templates = templates; }
  async send(notification: Notification): Promise<void> {
    const rendered = this.templates.render(notification);
    this.messages.unshift({ channel: notification.channel, to: notification.recipientId, subject: rendered.subject, body: rendered.body, at: new Date(notification.scheduledAt).toISOString() });
  }
}

export class DemoApplication {
  private readonly config: CompanySeed;
  private readonly shop: Awaited<ReturnType<typeof createCompanyShop>>;
  private readonly sales: SalesService;
  private readonly salesRepository: InMemorySalesRepository;
  private readonly payments: ReceivablesService;
  private readonly paymentRepository: InMemoryPaymentRepository;
  private readonly documents: DocumentLedgerPort;
  private readonly reportService: ReportService;
  private readonly assistant: AssistantService;
  private readonly terms: TradeTermsService;
  private readonly returns: ReturnService;
  private readonly returnNotes: InMemoryReturnNoteRepository;
  private readonly subscriptions: SubscriptionService;
  private readonly collections: CollectionsService;
  private readonly notifications: NotificationService;
  private readonly outbox: DemoReminderOutbox;
  private readonly bankFeeds: BankFeedService;
  private readonly agent: ActionAgentService;
  private readonly agentAudit: AuditLog;
  private readonly gstReturns: GstReturnService;

  private constructor(
    config: CompanySeed,
    shop: Awaited<ReturnType<typeof createCompanyShop>>,
    sales: SalesService,
    salesRepository: InMemorySalesRepository,
    payments: ReceivablesService,
    paymentRepository: InMemoryPaymentRepository,
    documents: DocumentLedgerPort,
    reportService: ReportService,
    assistant: AssistantService,
    terms: TradeTermsService,
    returns: ReturnService,
    returnNotes: InMemoryReturnNoteRepository,
    collections: CollectionsService,
    notifications: NotificationService,
    outbox: DemoReminderOutbox,
    bankFeeds: BankFeedService,
    subscriptions: SubscriptionService,
    agent: ActionAgentService,
    agentAudit: AuditLog,
    gstReturns: GstReturnService,
  ) {
    this.config = config;
    this.shop = shop;
    this.sales = sales;
    this.salesRepository = salesRepository;
    this.payments = payments;
    this.paymentRepository = paymentRepository;
    this.documents = documents;
    this.reportService = reportService;
    this.assistant = assistant;
    this.terms = terms;
    this.returns = returns;
    this.returnNotes = returnNotes;
    this.subscriptions = subscriptions;
    this.agent = agent;
    this.agentAudit = agentAudit;
    this.collections = collections;
    this.notifications = notifications;
    this.outbox = outbox;
    this.bankFeeds = bankFeeds;
    this.gstReturns = gstReturns;
  }

  static async create(config: CompanySeed): Promise<DemoApplication> {
    const shop = await createCompanyShop(config);
    const salesRepository = new InMemorySalesRepository();
    const paymentRepository = new InMemoryPaymentRepository();
    const returnNotes = new InMemoryReturnNoteRepository();
    shop.store.join(salesRepository).join(paymentRepository).join(returnNotes);
    const masters = new InMemoryMasterData();
    masters.putCompany({ companyId: config.companyId, gstin: config.gstin, stateCode: config.gstin.slice(0, 2), registration: 'REGULAR' });
    masters.putParty(config.companyId, { partyId: config.customerId, gstin: config.customerGstin, stateCode: config.customerGstin.slice(0, 2), registration: 'REGULAR' });
    // Soap is a taxed good (#116). It was previously nil-rated against `0808`, which is fresh
    // apples — copied from the reports fixture, where that HSN belongs to a box of apples. Every
    // GST figure in the local app was therefore zero, and no screen involving tax could be looked
    // at. `3923` sits on both sides of its 1 July rate change in `FIXTURE_RATE_TABLE`, so the demo
    // also exercises an effective-date boundary rather than a single flat rate.
    masters.putItem(config.companyId, { itemId: 'SOAP', name: 'Herbal Bath Soap 100g', kind: 'GOODS', hsnOrSac: '3923', treatment: 'TAXABLE', reverseCharge: false, baseUnit: 'PCS' });
    const calculator = new GstCalculator({ masterData: masters, rates: FIXTURE_RATE_TABLE, gstEngine: new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.gst', mode: 'development' }), mode: 'development' });
    const sales = new SalesService({ store: shop.store, ledger: shop.ledger, calculator, repository: salesRepository, inventory: permissiveInventory, compliance: noComplianceHooks, permissions: permissionPortFromActor, audit: shop.audit, clock: { now: () => new Date() }, policy: { ...DEFAULT_SALES_POLICY, series: { prefix: 'INV', branchCode: 'WEB', padding: 5 } } });

    const purchases = purchaseDocumentLedger(shop.bills, async () => config.supplierName);
    const documents: DocumentLedgerPort = {
      async openDocuments(companyId, partyId) {
        const notes = await returnNotes.list(companyId);
        const returnedValue = (documentId: string, kind: 'SALES_RETURN' | 'PURCHASE_RETURN') =>
          notes.filter((note) => note.kind === kind && note.originalDocument.id === documentId)
            .reduce((total, note) => total + note.totals.total.minor, 0n);
        const purchaseDocuments = (await purchases.openDocuments(companyId, partyId)).map((document) => ({
          ...document, value: money(document.value.minor - returnedValue(document.documentId, 'PURCHASE_RETURN')),
        }));
        const invoices = await salesRepository.list(companyId, { partyId, state: 'FINAL' });
        const saleDocuments: OpenDocument[] = invoices.map((invoice) => ({ documentId: invoice.id, kind: 'SALES_INVOICE', number: invoice.number ?? invoice.id, partyId, date: invoice.documentDate, dueDate: invoice.dueDate, value: money((invoice.pricing?.totals.invoiceValue.minor ?? 0n) - returnedValue(invoice.id, 'SALES_RETURN')), side: 'RECEIVABLE' }));
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

    const returns = new ReturnService({
      store: shop.store, ledger: shop.ledger, repository: returnNotes,
      sales: salesReturnSource(salesRepository, async (companyId, documentId) =>
        (await shop.eInvoices.findByDocumentId(companyId, documentId))?.status === 'REGISTERED'),
      purchases: purchaseReturnSource(shop.bills),
      inventory: returnInventoryAdapter(shop.inventoryService), permissions: permissionPortFromActor,
      audit: shop.audit, clock: { now: () => new Date() },
    });


    /**
     * Issue #34 — why a particular bill is held up, worked out from this live company rather than
     * described by a fixture: the bill is looked up in the sales repository, its lines are checked
     * against what the stock ledger actually says, and the place-of-supply question is put to the
     * rules engine with this bill's own facts.
     */
    const blocked: BlockedDocumentPort = {
      async find(companyId: CompanyId, reference: string): Promise<BlockedDocument | null> {
        const invoices = await salesRepository.list(companyId);
        const invoice = invoices.find(
          (candidate) => (candidate.number ?? '').toUpperCase() === reference.toUpperCase() || candidate.id === reference,
        );
        if (invoice === undefined) return null;

        const reasons: BlockingReason[] = [];
        if (invoice.state !== 'FINAL' && invoice.state !== 'CANCELLED') {
          for (const line of invoice.lines) {
            const balance = await shop.inventoryService.balance(shop.setupActor, { itemId: line.itemId, warehouseId: 'wh-main' });
            if (balance.available.scaled >= line.quantity.scaled) continue;
            reasons.push({
              code: 'STOCK_SHORTFALL',
              what: {
                'en-IN': `There is not enough ${line.itemId} in ${config.location}: the bill needs ${formatQuantity(line.quantity)} and ${formatQuantity(balance.available)} is free to sell.`,
                'hi-IN': `${config.location} mein ${line.itemId} kam hai: bill ko ${formatQuantity(line.quantity)} chahiye aur bechne ke liye ${formatQuantity(balance.available)} hai.`,
              },
              nextStep: {
                'en-IN': 'Receive more stock, or reduce the quantity on the bill.',
                'hi-IN': 'Aur maal mangwayein, ya bill ki maatra kam karein.',
              },
              action: 'purchase',
            });
          }
          reasons.push({
            code: 'RULE_CHECK',
            what: {
              'en-IN': 'Which state this sale counts in has to be settled before the bill goes out.',
              'hi-IN': 'Bill jaane se pehle tay karna hoga ki yeh bikri kis rajya ki hai.',
            },
            nextStep: {
              'en-IN': 'Check the delivery address on the bill.',
              'hi-IN': 'Bill par delivery ka pata dekh lein.',
            },
            action: 'sale',
            topic: 'gst.place_of_supply',
            facts: {
              'supply.type': 'GOODS',
              'supply.deliveryStateCode': config.customerGstin.slice(0, 2),
              'supply.supplierStateCode': config.gstin.slice(0, 2),
            },
          });
        }
        return {
          documentId: invoice.id,
          number: invoice.number,
          kind: 'SALES_INVOICE',
          date: invoice.documentDate,
          partyName: config.customerName,
          reasons,
        };
      },
    };

    const assistant = new AssistantService({
      reports: reportService,
      permissions: permissionPortFromActor,
      audit: shop.audit,
      clock: { now: () => new Date() },
      // Production mode: a rule that has not been reviewed cannot answer anybody's question.
      rules: new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.gst', mode: 'production' }),
      register: new ComplianceRegister(),
      blocked,
    });
    // Issue #23 [E23]: chasing overdue money. Receivables above it is the real service that has
    // just been composed; the notification service below it is GPT 2's real one from #39. This
    // module supplies only the decision about who is chased and how hard.
    const templates = new NotificationTemplateRegistry();
    registerReminderTemplates(templates);
    const outbox = new DemoReminderOutbox(templates);
    const notifications = new NotificationService(
      new ChannelNotificationTransport({ in_app: new InAppNotificationAdapter(), email: outbox, whatsapp: outbox, sms: outbox }),
      () => Date.now(),
      { maxPerWindow: 100, windowMs: 60_000 },
    );
    const reminderContext = (from: ActorContext): RequestContext => ({
      companyId: from.companyId,
      branchId: from.branchId ?? config.branchId,
      actorId: from.userId,
      // Sending is already gated by the collections permission the caller had to hold; this is the
      // infrastructure permission the notification service asks for, and nothing more.
      permissions: new Set<Permission>(['notification.send']),
      sessionId: `collections:${from.userId}`,
    });
    const reminderContacts: PartyContactPort = {
      async contact(_companyId, partyId) {
        return partyId === config.customerId
          ? { recipientId: `${config.customerName.toLowerCase().replace(/[^a-z]+/g, '-')}@example.invalid`, channels: ['whatsapp', 'email', 'in_app'] }
          : null;
      },
      async owner() { return { recipientId: config.setupUserId, channels: ['in_app', 'email'] }; },
    };
    const collections = new CollectionsService({
      businessName: config.name,
      receivables: receivablesPositions(payments, documents),
      contacts: reminderContacts,
      transport: notificationReminderTransport(notifications, reminderContext),
      repository: new InMemoryReminderRepository(),
      permissions: permissionPortFromActor,
      audit: shop.audit,
      // This demo company's whole world is 29 August 2026 — its bills, its payments, its due
      // dates. The reminder clock is pinned to the same afternoon so the screen shows the same day
      // the books are on. Quiet hours are a real rule evaluated against this clock; the package
      // tests drive a night and a morning through it.
      clock: { now: () => new Date('2026-08-29T10:00:00.000Z') },
    });

    const bankProvider = new SyntheticBankFeedProvider();
    bankProvider.addTransaction(`current-${config.companyId}`, { providerTransactionId: `upi-settlement-${config.companyId}`, bookedOn: '2026-08-29', description: 'UPI settlement from yesterday', amountMinor: 48_750_00n, direction: 'CREDIT', reference: 'SYNTHETIC-UTR-240829' });
    bankProvider.addTransaction(`current-${config.companyId}`, { providerTransactionId: `shop-rent-${config.companyId}`, bookedOn: '2026-08-29', description: 'Shop rent NEFT', amountMinor: 25_000_00n, direction: 'DEBIT', reference: 'SYNTHETIC-NEFT-240829' });
    const bankFeeds = new BankFeedService([bankProvider]);

    // Issue #42 [E42]: what this company's plan covers, and what it has used. The payment provider
    // is the mock one — no production credential is needed to run any of this — and the limits it
    // enforces are the real ones from the shipped catalogue.
    const subscriptions = new SubscriptionService({
      subscriptions: new InMemorySubscriptionRepository(),
      usage: new InMemoryUsageRepository(),
      invoices: new InMemoryServiceInvoiceRepository(),
      payments: alwaysPays(),
      permissions: permissionPortFromActor,
      audit: shop.audit,
      clock: { now: () => new Date('2026-08-29T10:00:00.000Z') },
    });
    // Issue #47 [E47]: the assistant doing authorised work. Every tool below is the real module
    // already composed above — #23 decides what a reminder should be and re-checks the bill at the
    // moment of sending, #34 grounds the total in one of #35's reports and carries its snapshot id,
    // and cancelling a bill is registered as prepare-only, so the assistant can never finish it.
    const agentAudit = new AuditLog();
    const agentCommands = new PlatformCommandService(agentAudit, [
      { action: 'agent.run', minimumRisk: 'medium', requiredPermission: 'approval.decide' },
    ]);
    const agentRegistry = new ToolRegistry()
      .register(findUnpaidTool(collections))
      .register(totalOwedTool(assistant))
      .register(sendReminderTool(collections))
      .register(stopRemindingTool(collections))
      .register(cancelInvoiceTool());
    const agentParties: PartyDirectoryPort = {
      async resolve(_actor, text) {
        const needle = text.trim().toLowerCase();
        const known = [{ partyId: String(config.customerId), name: config.customerName }];
        return known.filter((party) => party.name.toLowerCase().includes(needle) || needle.includes(party.name.toLowerCase()));
      },
      async nameOf(_actor, partyId) {
        return partyId === String(config.customerId) ? config.customerName : partyId;
      },
    };
    const agent = new ActionAgentService({
      registry: agentRegistry,
      commands: agentCommands,
      contextFor: (from: ActorContext) => ({
        companyId: from.companyId,
        branchId: from.branchId ?? config.branchId,
        actorId: from.userId,
        // The platform's own approval permission travels only when the person actually holds it,
        // so their policy decides, not this composition.
        permissions: new Set<Permission>([
          'notification.send',
          ...(from.permissions.includes('approval.decide') ? (['approval.decide'] as const) : []),
        ]),
        sessionId: `agent:${from.userId}`,
      }),
      parties: agentParties,
      store: new InMemoryAgentPlanStore(),
      permissions: permissionPortFromActor,
      clock: { now: () => new Date('2026-08-29T10:00:00.000Z') },
    });

    // Issue #30 — the GST return workspace, over this same live company.
    //
    // Every port here is the module that already holds the answer. The bills come from the sales
    // repository the till writes to, the credit notes from the returns module, the tax already
    // paid and the reconciliation figure from two *different* reads of the ledger — so the check
    // that the return agrees with the books is a real comparison of two sources and not a number
    // compared with itself. There is no `government` port, which is the point: this shop has no
    // licensed intermediary, and everything except the last button still works.
    const outwardSupplies: OutwardSupplyPort = {
      async documentsFor(companyId, period): Promise<readonly OutwardDocument[]> {
        const supplier = { gstin: config.gstin, stateCode: config.gstin.slice(0, 2) };
        const customer = {
          name: config.customerName,
          gstin: config.customerGstin,
          stateCode: config.customerGstin.slice(0, 2),
          unregisteredConfirmed: false,
        };
        const invoices = (await salesRepository.list(companyId, { state: 'FINAL' }))
          .filter((invoice) => taxPeriodOf(invoice.documentDate) === period);
        const documents = invoices.map((invoice) => salesInvoiceToDocument(
          {
            id: invoice.id, companyId: invoice.companyId, state: invoice.state, number: invoice.number,
            documentDate: invoice.documentDate, partyId: invoice.partyId, customerType: invoice.customerType,
            placeOfSupplyStateCode: invoice.pricing?.placeOfSupplyStateCode ?? invoice.placeOfSupplyStateCode,
            voucherId: invoice.voucherId,
            pricing: invoice.pricing === null ? null : {
              lines: invoice.pricing.lines.map((line) => ({
                lineId: line.lineId, itemId: line.itemId, itemName: line.itemName, hsnOrSac: line.hsnOrSac,
                quantity: showQuantity(line.quantity), ratePercentTimes100: line.ratePercentTimes100,
                taxableValue: line.taxableValue, cgst: line.cgst, sgst: line.sgst, utgst: line.utgst,
                igst: line.igst, cess: line.cess, reverseCharge: line.reverseCharge, rateBasis: line.rateBasis,
                treatment: line.treatment,
              })),
              totals: { invoiceTotal: invoice.pricing.totals.invoiceValue },
            },
          },
          customer,
          supplier,
        ));
        const notes = (await returnNotes.list(companyId))
          .filter((note) => note.kind === 'SALES_RETURN' && taxPeriodOf(note.documentDate) === period)
          .map((note) => returnNoteToDocument({
            ...note,
            lines: note.lines.map((noteLine) => ({ ...noteLine, quantity: showQuantity(noteLine.quantity) })),
          }, customer, supplier, {
            placeOfSupplyStateCode: config.gstin.slice(0, 2),
            hsnByItem: { SOAP: '3401', TMT12: '7214' },
          }));
        return [...documents, ...notes];
      },
    };
    const gstReturns = new GstReturnService({
      outward: outwardSupplies,
      // Issue #31. The credit side of the 3B is the reconciliation's conclusion, not a second read
      // of the ledger: a purchase the government's record does not carry is held back here and is
      // therefore held back on the return, by construction rather than by a rule that could differ.
      // The ledger read is still available as `ledgerInwardTaxPort` for the books comparison.
      inward: itcInwardTaxPort(shop.itc, (companyId) => ({
        companyId,
        branchId: config.branchId,
        userId: config.setupUserId,
        permissions: [ITC_PERMISSIONS.view],
      })),
      books: ledgerBookTaxPort(shop.store.read()),
      repository: new InMemoryReturnPreparations(),
      audit: shop.audit,
      clock: { now: () => new Date() },
    });

    const app = new DemoApplication(config, shop, sales, salesRepository, payments, paymentRepository, documents, reportService, assistant, terms, returns, returnNotes, collections, notifications, outbox, bankFeeds, subscriptions, agent, agentAudit, gstReturns);
    await app.seed();
    return app;
  }

  /** Periodic services composed by this local host; the scheduler supplies the service actor. */
  recurringJobs(): readonly RecurringJobDefinition[] {
    return standardRecurringJobs({
      notifications: { deliverDue: (context) => this.notifications.deliverDue(context) },
      ewayBills: {
        expiringWithin: (serviceActor, hours) => this.shop.ewayBill.expiringWithin(serviceActor as ActorContext, hours),
      },
      collections: {
        sendPlanned: (serviceActor, today) => this.collections.sendPlanned(serviceActor as ActorContext, isoDate(today)),
      },
    });
  }

  private async seed(): Promise<void> {
    await this.recordSale(this.shop.setupActor, { party: this.config.customerName, item: 'Herbal Bath Soap 100g', quantity: '4', rate: '250', date: '2026-08-29', terms: '30', reference: 'seed-sale', notes: 'Synthetic opening demo sale' });
    // Two older bills, so the Reminders screen has something to decide about on the demo's date.
    await this.recordSale(this.shop.setupActor, { party: this.config.customerName, item: 'Herbal Bath Soap 100g', quantity: '2', rate: '250', date: '2026-07-20', terms: '30', reference: 'seed-overdue-1', notes: 'Synthetic bill, ten days past its due date' });
    await this.recordSale(this.shop.setupActor, { party: this.config.customerName, item: 'Herbal Bath Soap 100g', quantity: '1', rate: '250', date: '2026-06-15', terms: '15', reference: 'seed-overdue-2', notes: 'Synthetic bill, two months past its due date' });
  }

  async dashboard(actor: ActorContext) {
    permissionPortFromActor.require(actor, 'dashboard.read', 'view this dashboard');
    const companyId = this.companyOf(actor);
    const sales = await this.salesRepository.list(companyId, { state: 'FINAL' });
    const purchases = await this.shop.bills.list(companyId);
    const payments = await this.paymentRepository.list(companyId);
    const returnNotes = await this.returnNotes.list(companyId);
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
        ...returnNotes.map((note) => ({ id: note.id, kind: 'return', title: `${note.number} · ${note.originalDocument.number}`, amount: jsonAmount(note.totals.total.minor), status: 'Recorded' })),
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
  /** Issue #34 — a question about this company's own books, answered from this company's reports. */
  async ask(actor: ActorContext, body: Record<string, unknown>) {
    this.companyOf(actor);
    const answer = await this.assistant.ask(actor, { question: String(body.question ?? '') });
    return {
      id: answer.id,
      question: answer.question,
      intent: answer.intent,
      state: answer.state,
      sentences: answer.sentences,
      amounts: answer.amounts.map((amount) => ({
        what: amount.what,
        formatted: amount.formatted,
        value: jsonAmount(amount.amount.minor),
        reportId: amount.reportId,
        from: amount.from,
        to: amount.to,
        records: amount.drillDown.length,
        drill: amount.drillDown.slice(0, 8).map((record) => ({
          date: record.date,
          number: record.sourceNumber,
          description: record.description,
          amount: jsonAmount(record.amount.minor),
        })),
      })),
      compliance: answer.compliance.map((citation) => ({
        certainty: citation.certainty,
        asOfDate: citation.asOfDate,
        effectiveFrom: citation.effectiveFrom,
        ruleId: citation.ruleId,
        source: citation.source,
        missing: citation.missing,
      })),
      period: answer.period,
      assumptions: answer.assumptions,
      withheld: answer.withheld,
      nextSteps: answer.nextSteps,
      sourcesUsed: answer.sourcesUsed,
      disclaimer: answer.disclaimer,
    };
  }

  /** The questions this assistant can answer, so the screen offers real examples, not invented ones. */
  static assistantExamples() {
    return AssistantService.supportedIntents().map((intent) => ({ intent, label: describeIntent(intent) }));
  }

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
      // A register has three totals and they are three different facts (#116). `total` is what the
      // customer was billed; `taxable` is what the business earned; `tax` is what it collected for
      // the government and owes them. Only `taxable` reconciles to income — GST is a liability, not
      // earnings — so all three are published rather than leaving a caller to assume.
      sales: {
        title: pack.sales.header.title,
        sentence: pack.sales.body.sentence,
        total: jsonAmount(pack.sales.body.total.amount.minor),
        taxable: jsonAmount(pack.sales.body.taxableValue.amount.minor),
        tax: jsonAmount(pack.sales.body.tax.amount.minor),
        taxableDrill: drill(pack.sales.body.taxableValue),
        rows: pack.sales.body.rows.map((r) => ({ date: r.date, number: r.number, party: r.partyName, taxable: jsonAmount(r.taxableValue.minor), tax: jsonAmount(sum([r.cgst, r.sgst, r.igst, r.cess]).minor), total: jsonAmount(r.total.minor) })),
      },
      purchases: {
        title: pack.purchases.header.title,
        sentence: pack.purchases.body.sentence,
        available: pack.purchases.body.available,
        total: jsonAmount(pack.purchases.body.total.amount.minor),
        taxable: jsonAmount(pack.purchases.body.taxableValue.amount.minor),
        tax: jsonAmount(pack.purchases.body.tax.amount.minor),
        rows: pack.purchases.body.rows.map((r) => ({ date: r.date, number: r.number, party: r.partyName, taxable: jsonAmount(r.taxableValue.minor), tax: jsonAmount(sum([r.cgst, r.sgst, r.igst, r.cess]).minor), total: jsonAmount(r.total.minor) })),
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

  // ------------------------------------------------------- issue #23: chasing what is still owed

  private reminderDate(input: Record<string, unknown>): IsoDate {
    return isoDate(String(input.today ?? '2026-08-29'));
  }

  private candidateJson(candidate: ReminderCandidate) {
    return {
      documentId: candidate.documentId,
      partyId: candidate.partyId,
      partyName: candidate.partyName,
      decision: candidate.decision,
      reason: candidate.reason,
      level: candidate.level,
      channel: candidate.channel,
      step: candidate.step?.code ?? null,
      explanation: candidate.explanation,
      bill: candidate.snapshot.documentNumber,
      outstanding: jsonAmount(candidate.snapshot.outstanding.minor),
      daysOverdue: candidate.snapshot.daysOverdue,
    };
  }

  private reminderJson(reminder: Reminder) {
    return {
      id: reminder.id,
      bill: reminder.snapshot.documentNumber,
      documentId: reminder.documentId,
      state: reminder.state,
      level: reminder.level,
      channel: reminder.channel,
      audience: reminder.audience,
      message: reminder.message,
      outstanding: jsonAmount(reminder.snapshot.outstanding.minor),
      daysOverdue: reminder.snapshot.daysOverdue,
      asOf: reminder.snapshot.asOf,
      failureReason: reminder.failureReason,
      sentAt: reminder.sentAt,
    };
  }

  /** Everything the Reminders screen shows: the plan, what was sent, promises and disputes. */
  async reminders(actor: ActorContext, input: Record<string, unknown> = {}) {
    this.companyOf(actor);
    const today = this.reminderDate(input);
    const plan = await this.collections.plan(actor, today);
    return {
      asOf: today,
      summary: plan.summary,
      counts: { toSend: plan.toSend, toEscalate: plan.toEscalate, skipped: plan.skipped },
      candidates: plan.candidates.map((candidate) => this.candidateJson(candidate)),
      history: (await this.collections.history(actor)).map((reminder) => this.reminderJson(reminder)),
      promises: (await this.collections.promises(actor, today)).map((view) => ({
        id: view.promise.id,
        documentId: view.promise.documentId,
        amount: jsonAmount(view.promise.amount.minor),
        promisedOn: view.promise.promisedOn,
        outcome: view.outcome,
        explanation: view.explanation,
      })),
      disputes: (await this.collections.disputes(actor)).map((dispute) => ({
        id: dispute.id, documentId: dispute.documentId, reason: dispute.reason, state: dispute.state,
      })),
      outbox: this.outbox.messages.slice(0, 10),
    };
  }

  async sendReminder(actor: ActorContext, input: Record<string, unknown>) {
    this.companyOf(actor);
    const reminder = await this.collections.send(actor, {
      documentId: String(input.documentId ?? ''),
      today: this.reminderDate(input),
    });
    return {
      state: reminder.state === 'SENT' ? 'recorded' : 'recorded',
      title: reminder.state === 'SENT' ? 'Reminder sent' : `Reminder ${reminder.state.toLowerCase()}`,
      message: reminder.state === 'FAILED'
        ? (reminder.failureReason ?? 'The message could not be delivered.')
        : reminder.message['en-IN'],
      reminder: this.reminderJson(reminder),
    };
  }

  async sendAllReminders(actor: ActorContext, input: Record<string, unknown>) {
    this.companyOf(actor);
    const sent = await this.collections.sendPlanned(actor, this.reminderDate(input));
    return {
      state: 'recorded',
      title: sent.length === 0 ? 'Nothing needed sending' : `${sent.length} reminder${sent.length === 1 ? '' : 's'} handled`,
      message: sent.length === 0
        ? 'Every open bill was deliberately left alone today. The reasons are on this screen.'
        : `${sent.filter((r) => r.state === 'SENT').length} sent, ${sent.filter((r) => r.state !== 'SENT').length} not delivered.`,
      reminders: sent.map((reminder) => this.reminderJson(reminder)),
    };
  }

  async retryReminder(actor: ActorContext, input: Record<string, unknown>) {
    this.companyOf(actor);
    const reminder = await this.collections.retry(actor, String(input.reminderId ?? ''), this.reminderDate(input));
    return { state: 'recorded', title: `Reminder ${reminder.state.toLowerCase()}`, message: reminder.failureReason ?? reminder.message['en-IN'], reminder: this.reminderJson(reminder) };
  }

  async recordPromiseToPay(actor: ActorContext, input: Record<string, unknown>) {
    this.companyOf(actor);
    const promise = await this.collections.recordPromise(actor, {
      partyId: this.config.customerId,
      documentId: String(input.documentId ?? ''),
      amount: money(paise(input.amount)),
      promisedOn: isoDate(String(input.promisedOn ?? '')),
      note: input.note === undefined ? null : String(input.note),
    });
    return { state: 'recorded', title: 'Promise recorded', message: `Reminders for this bill are paused until ${promise.promisedOn}.` };
  }

  async raiseBillDispute(actor: ActorContext, input: Record<string, unknown>) {
    this.companyOf(actor);
    await this.collections.raiseDispute(actor, {
      partyId: this.config.customerId,
      documentId: input.documentId === undefined || input.documentId === '' ? null : String(input.documentId),
      reason: String(input.reason ?? ''),
    });
    return { state: 'recorded', title: 'Dispute recorded', message: 'This bill will not be chased until the dispute is closed.' };
  }

  async resolveBillDispute(actor: ActorContext, input: Record<string, unknown>) {
    this.companyOf(actor);
    await this.collections.resolveDispute(actor, String(input.disputeId ?? ''), String(input.resolution ?? 'Settled with the customer.'));
    return { state: 'recorded', title: 'Dispute closed', message: 'The bill goes back into the reminder ladder at the rung its age has reached.' };
  }

  async stopReminders(actor: ActorContext, input: Record<string, unknown>) {
    this.companyOf(actor);
    await this.collections.optOut(actor, this.config.customerId, String(input.reason ?? ''));
    return { state: 'recorded', title: 'Reminders stopped', message: `${this.config.customerName} will not receive automatic reminders.` };
  }

  async resumeReminders(actor: ActorContext, _input: Record<string, unknown> = {}) {
    this.companyOf(actor);
    await this.collections.resumeReminders(actor, this.config.customerId);
    return { state: 'recorded', title: 'Reminders started again', message: `${this.config.customerName} will receive automatic reminders again.` };
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
    // Issue #42: the plan is checked before the bill is issued, and counted only after it was.
    // In that order, because a bill that failed to post is not a bill, and charging somebody's
    // allowance for the product's own failure would be the wrong way round.
    const usageDate = isoDate(this.shop.clock.now().toISOString().slice(0, 10));
    await this.subscriptions.require(actor, 'sales.issue_invoice', usageDate);
    const preview = await this.previewSale(actor, input);
    const final = await this.sales.finalise(actor, { idempotencyKey: `web-sale-final:${preview.token}`, invoiceId: preview.token });
    await this.subscriptions.recordUsage(actor, {
      meter: 'invoices',
      // The invoice's own id, so a retried request counts the same bill once.
      idempotencyKey: `invoice:${final.invoice.id}`,
      note: 'a bill was issued',
      on: usageDate,
    });
    return { state: 'recorded', deduplicated: final.deduplicated, title: final.deduplicated ? 'Sale already recorded once' : 'Sale recorded', message: `${final.invoice.number} was issued.`, invoice: { id: final.invoice.id, number: final.invoice.number, amount: jsonAmount(final.invoice.pricing?.totals.invoiceValue.minor ?? 0n) } };
  }

  // ------------------------------------------------ issue #47: letting the assistant do the work

  private agentPlanJson(plan: AgentPlan) {
    return {
      id: plan.id,
      request: plan.request,
      intent: plan.intent,
      evidence: plan.evidence,
      state: plan.state,
      summary: plan.summary,
      needsApproval: plan.needsApproval,
      fingerprint: plan.fingerprint,
      instructionFlag: plan.instructionFlag,
      steps: plan.steps.map((step) => ({
        stepId: step.stepId,
        tool: step.tool,
        kind: step.kind,
        risk: step.risk,
        executability: step.executability,
        describe: step.describe,
        party: step.party,
        amount: step.amount === null ? null : jsonAmount(step.amount.minor),
      })),
      refusals: plan.refusals.map((refusal) => ({ code: refusal.code, reason: refusal.reason, tool: refusal.tool })),
    };
  }

  private agentReportJson(report: AgentReport) {
    return {
      planId: report.planId,
      state: report.state,
      summary: report.summary,
      handedBack: report.handedBack,
      steps: report.steps.map((step) => ({
        stepId: step.stepId,
        tool: step.tool,
        state: step.state,
        describe: step.describe,
        statement: step.evidence?.statement ?? null,
        details: step.evidence?.details ?? {},
        failure: step.failure,
        retryable: step.retryable,
      })),
    };
  }

  /** What this person is allowed to have the assistant do. Never more than they hold themselves. */
  agentCapabilities(actor: ActorContext) {
    this.companyOf(actor);
    return { tools: this.agent.capabilities(actor), disclaimer: AGENT_DISCLAIMER };
  }

  async agentPlan(actor: ActorContext, input: Record<string, unknown>) {
    this.companyOf(actor);
    const plan = await this.agent.plan(actor, {
      text: String(input.request ?? ''),
      today: isoDate(String(input.today ?? '2026-08-29')),
    });
    // Planning looks at nothing; the preview is where the request meets the books, so both run
    // together for the screen. Neither of them writes anything.
    return this.agentPlanJson(await this.agent.preview(actor, plan.id));
  }

  async agentApprove(actor: ActorContext, input: Record<string, unknown>) {
    this.companyOf(actor);
    const plan = await this.agent.approve(actor, String(input.planId ?? ''), String(input.fingerprint ?? ''));
    return { state: 'recorded', title: 'Approved', message: 'The assistant will do exactly what you saw.', plan: this.agentPlanJson(plan) };
  }

  async agentExecute(actor: ActorContext, input: Record<string, unknown>) {
    this.companyOf(actor);
    const report = await this.agent.execute(actor, String(input.planId ?? ''), {
      fingerprint: String(input.fingerprint ?? ''),
      idempotencyKey: String(input.idempotencyKey ?? input.planId ?? ''),
    });
    return {
      state: 'recorded',
      title: report.state === 'DONE' ? 'Done' : report.state === 'PARTLY_DONE' ? 'Partly done' : 'Nothing was done',
      message: report.summary['en-IN'],
      report: this.agentReportJson(report),
    };
  }

  async agentHistory(actor: ActorContext) {
    this.companyOf(actor);
    const plans = await this.agent.plans(actor);
    return {
      plans: await Promise.all(plans.map(async (plan) => ({
        ...this.agentPlanJson(plan),
        report: await this.agent.report(actor, plan.id).then((report) => (report === null ? null : this.agentReportJson(report))),
      }))),
      // The trail is GPT 2's audit log, not a second copy kept for the screen.
      audit: this.agentAudit
        .forCompany({ companyId: actor.companyId, branchId: String(actor.branchId ?? ''), actorId: actor.userId, permissions: new Set(), sessionId: 'read' })
        .slice(-20)
        .map((event) => ({ action: event.action, at: event.occurredAt, detail: event.after ?? {} })),
    };
  }

  // ------------------------------------------------------------ issue #42: the plan and its use

  private planJson(plan: Plan) {
    return {
      id: plan.id,
      name: plan.name,
      description: plan.description,
      monthlyPrice: jsonAmount(plan.monthlyPrice.minor),
      trialDays: plan.trialDays,
      graceDays: plan.graceDays,
      limits: plan.limits.map((limit) => ({ meter: limit.meter, perMonth: limit.perMonth === null ? null : Number(limit.perMonth) })),
    };
  }

  private entitlementJson(entitlement: Entitlement) {
    return {
      capability: entitlement.capability,
      outcome: entitlement.outcome,
      essential: entitlement.essential,
      state: entitlement.state,
      reason: entitlement.reason,
      used: entitlement.used === null ? null : Number(entitlement.used),
      limit: entitlement.limit === null ? null : Number(entitlement.limit),
    };
  }

  async subscriptionAccount(actor: ActorContext, input: Record<string, unknown> = {}) {
    this.companyOf(actor);
    const today = isoDate(this.shop.clock.now().toISOString().slice(0, 10));
    const account = await this.subscriptions.account(actor, today);
    // What the plan would say about a few things a person actually does, so the screen can show
    // the promise being kept rather than merely printed.
    const checks = ['sales.issue_invoice', 'assistant.ask', 'gst.compliance_warning', 'supplier.risk_warning', 'data.export'];
    return {
      state: account.state,
      stateWords: account.stateWords,
      writingStopsOn: account.writingStopsOn,
      promise: account.promise,
      plan: this.planJson(account.plan),
      plans: this.subscriptions.plans().map((plan) => this.planJson(plan)),
      usage: account.usage.map((total) => ({
        meter: total.meter,
        label: total.label,
        used: Number(total.used),
        limit: total.limit === null ? null : Number(total.limit),
        remaining: total.remaining === null ? null : Number(total.remaining),
      })),
      invoices: account.invoices.map((invoice) => ({
        id: invoice.id, period: invoice.period, state: invoice.state,
        net: jsonAmount(invoice.net.minor), gst: jsonAmount(invoice.gst.minor), total: jsonAmount(invoice.total.minor),
        issuedOn: invoice.issuedOn, dueOn: invoice.dueOn, paidOn: invoice.paidOn, failureReason: invoice.failureReason,
      })),
      checks: await Promise.all(checks.map(async (capability) => this.entitlementJson(await this.subscriptions.check(actor, capability, today)))),
      history: account.subscription.history,
    };
  }

  async changeSubscriptionPlan(actor: ActorContext, input: Record<string, unknown>) {
    this.companyOf(actor);
    const today = isoDate(this.shop.clock.now().toISOString().slice(0, 10));
    const planId = String(input.planId ?? '');
    const existing = await this.subscriptions.account(actor, today);
    const subscription = existing.subscription.id.startsWith('implied:')
      ? await this.subscriptions.start(actor, { planId, on: today })
      : await this.subscriptions.changePlan(actor, { planId, on: today, reason: String(input.reason ?? 'Changed from the account screen') });
    return {
      state: 'recorded',
      title: 'Plan changed',
      message: `This business is now on the ${subscription.planId} plan. Nothing that was already recorded has changed.`,
    };
  }

  async issueSubscriptionInvoice(actor: ActorContext, input: Record<string, unknown>) {
    this.companyOf(actor);
    const today = isoDate(this.shop.clock.now().toISOString().slice(0, 10));
    const invoice = await this.subscriptions.issueServiceInvoice(actor, { period: today.slice(0, 7), on: today });
    const paid = invoice.state === 'PAID' ? invoice : await this.subscriptions.chargeServiceInvoice(actor, invoice.id, today);
    return {
      state: 'recorded',
      title: paid.state === 'PAID' ? 'Paid' : 'Payment did not go through',
      message: paid.state === 'PAID'
        ? `Subscription paid for ${paid.period}.`
        : (paid.failureReason ?? 'The payment could not be taken. Nothing about your books has changed.'),
    };
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

  // Issue #24 — explicit provider permission and incremental imports. Imported lines remain drafts
  // for the bank reconciliation engine; these endpoints never post ledger entries or move money.
  async bankFeedWorkspace(actor: ActorContext) {
    const context = this.bankContext(actor);
    return {
      providers: [{ id: 'sandbox-aa', name: 'Sandbox authorised bank feed' }],
      connections: this.bankFeeds.connections(context).map((connection) => ({
        ...this.bankConnectionJson(connection),
        accounts: this.bankFeeds.accounts(context, connection.id).map((account) => ({ ...account, balancePaise: account.balancePaise?.toString() ?? null })),
        transactions: this.bankFeeds.transactions(context, connection.id).map((transaction) => ({ ...transaction, debitPaise: transaction.debitPaise.toString(), creditPaise: transaction.creditPaise.toString() })),
      })),
    };
  }

  async startBankFeedConsent(actor: ActorContext, input: Record<string, unknown>) {
    const connection = await this.bankFeeds.startConsent(this.bankContext(actor), { provider: String(input.provider ?? ''), redirectUri: String(input.redirectUri ?? '') });
    return { state: 'draft', connection: this.bankConnectionJson(connection) };
  }

  async completeBankFeedConsent(actor: ActorContext, input: Record<string, unknown>) {
    const connection = await this.bankFeeds.completeConsent(this.bankContext(actor), String(input.connectionId ?? ''), String(input.authorizationCode ?? ''));
    return { state: 'success', connection: this.bankConnectionJson(connection) };
  }

  async syncBankFeed(actor: ActorContext, input: Record<string, unknown>) {
    const connectionId = String(input.connectionId ?? '');
    const result = await this.bankFeeds.sync(this.bankContext(actor), connectionId, String(input.idempotencyKey ?? `web-bank-sync:${connectionId}:${new Date().toISOString().slice(0, 10)}`));
    return { state: 'success', imported: result.imported, duplicates: result.duplicates, connection: this.bankConnectionJson(result.connection) };
  }

  async disconnectBankFeed(actor: ActorContext, input: Record<string, unknown>) {
    const connectionId = String(input.connectionId ?? '');
    const connection = await this.bankFeeds.disconnect(this.bankContext(actor), connectionId, String(input.idempotencyKey ?? `web-bank-disconnect:${connectionId}`));
    return { state: 'success', connection: this.bankConnectionJson(connection), message: 'Bank access was disconnected. Previously imported transactions remain available for your records.' };
  }

  private bankContext(actor: ActorContext): BankFeedContext { this.companyOf(actor); return { companyId: String(actor.companyId), actorId: String(actor.userId), permissions: new Set(actor.permissions) }; }
  private bankConnectionJson(connection: BankFeedConnection) { return { ...connection }; }

  // ------------------------------------------------------------------ issue #30: GST returns
  //
  // One screen for a month. The two returns, the questions that stop it, whether it agrees with the
  // books, and the file to upload. The workspace object the service returns is already shaped for a
  // person, so this is a rename into JSON rather than a second set of decisions.

  private gstPeriodOf(input: Record<string, unknown>): TaxPeriod {
    const raw = String(input.period ?? '').trim();
    if (raw === '') {
      // Default to the month before today, which is the one a business is actually filing.
      const now = new Date();
      const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      return taxPeriod(previous.toISOString().slice(0, 7));
    }
    return taxPeriod(raw);
  }

  private gstInput(input: Record<string, unknown>) {
    return {
      period: this.gstPeriodOf(input),
      gstin: this.config.gstin,
      supplierStateCode: this.config.gstin.slice(0, 2),
    };
  }

  private gstWorkspaceJson(workspace: ReturnWorkspace) {
    return {
      state: 'gst-return' as const,
      period: workspace.period,
      periodLabel: workspace.periodLabel,
      gstin: workspace.gstin,
      status: workspace.state,
      statusLabel: workspace.stateLabel['en-IN'],
      summary: workspace.sentence['en-IN'],
      // Whether a snapshot has actually been taken and stored. Looking at what a month *would* say
      // is free and needs nothing stored, so this is not the same as `mayApprove`: a month nobody
      // has prepared has nothing to approve, and the screen must not offer to.
      prepared: workspace.preparation !== null,
      mayApprove: workspace.mayApprove,
      whyNotApprovable: workspace.whyNotApprovable.map((reason) => reason['en-IN']),
      counts: workspace.counts,
      approvedAt: workspace.preparation?.approval?.approvedAt ?? null,
      exportedAt: workspace.preparation?.exportedAt ?? null,
      // Every table, with its rows and — on every row — the bills behind it.
      sections: workspace.gstr1.sections.map((section) => ({
        id: section.id,
        name: section.name['en-IN'],
        sentence: section.sentence['en-IN'],
        taxableValue: jsonAmount(section.totals.taxableValue.minor),
        tax: jsonAmount(totalTaxOf(section.totals).minor),
        rows: section.rows.map((row) => ({
          label: row.documentNumber ?? row.placeOfSupplyStateCode ?? '—',
          counterparty: row.counterpartyName,
          date: row.documentDate,
          rate: row.ratePercentTimes100 === null ? null : Number(row.ratePercentTimes100) / 100,
          taxableValue: jsonAmount(row.amounts.taxableValue.minor),
          tax: jsonAmount(totalTaxOf(row.amounts).minor),
          sources: row.sources.map((source) => ({
            number: source.number, date: source.date, voucherId: source.voucherId,
            amount: jsonAmount(source.amount.minor),
          })),
        })),
      })),
      reasons: workspace.reasons.map((reason) => ({ sourceId: reason.sourceId, section: reason.section, reason: reason.reason['en-IN'] })),
      gstr3b: {
        summary: workspace.gstr3b.sentence['en-IN'],
        caution: workspace.gstr3b.caution['en-IN'],
        outward: workspace.gstr3b.outward.map((box) => ({
          boxId: box.boxId, label: box.label['en-IN'],
          taxableValue: jsonAmount(box.amounts.taxableValue.minor),
          tax: jsonAmount(totalTaxOf(box.amounts).minor),
        })),
        heads: workspace.gstr3b.heads.map((head) => ({
          head: head.head,
          liability: jsonAmount(head.liability.minor),
          credit: jsonAmount(head.credit.minor),
          difference: jsonAmount(head.difference.minor),
        })),
      },
      reconciliation: {
        agrees: workspace.reconciliation.agrees,
        sentence: workspace.reconciliation.sentence['en-IN'],
        heads: workspace.reconciliation.heads.map((head) => ({
          head: head.head,
          onTheReturn: jsonAmount(head.onTheReturn.minor),
          inTheBooks: jsonAmount(head.inTheBooks.minor),
          agrees: head.agrees,
        })),
      },
      // The bills that are in the books but cannot go on the return until somebody answers.
      exceptions: workspace.exceptions.map((exception) => ({
        number: exception.document.number,
        party: exception.document.partyName,
        amount: jsonAmount(exception.document.invoiceValue.minor),
        questions: exception.findings.map((finding) => ({ message: finding.message['en-IN'], whatToDo: finding.whatToDo['en-IN'] })),
      })),
      findings: workspace.findings.map((finding) => ({
        code: finding.code, severity: finding.severity,
        message: finding.message['en-IN'], whatToDo: finding.whatToDo['en-IN'],
        document: finding.source?.number ?? null,
      })),
      drift: workspace.drift === null ? null : {
        message: workspace.drift.message['en-IN'],
        added: workspace.drift.documentsAdded.map((document) => document.number),
        removed: workspace.drift.documentsRemoved.map((document) => document.number),
        changed: workspace.drift.documentsChanged.map((document) => document.number),
      },
    };
  }

  // ------------------------------------------------------------------ issue #31: the purchase comparison
  //
  // One screen for a month: what our books hold, what the suppliers told the government, and the
  // difference. The workspace object is already shaped for a person, so this is a rename into JSON
  // rather than a second set of decisions — including the decision that matters most, which is that
  // a bill the portal does not carry contributes nothing to the credit until somebody says so.

  private itcLineJson(line: ReconciliationLine) {
    const document = line.book ?? line.portal;
    return {
      key: line.key,
      supplier: line.book?.supplierName ?? line.portal?.supplierName ?? 'Unknown supplier',
      gstin: line.book?.supplierGstin ?? line.portal?.supplierGstin ?? null,
      number: document?.number ?? '—',
      date: document?.documentDate ?? null,
      kind: document?.kind ?? 'INVOICE',
      status: line.status,
      statusLabel: line.statusLabel['en-IN'],
      outcome: line.outcome,
      outcomeLabel: line.outcomeLabel['en-IN'],
      sentence: line.sentence['en-IN'],
      matchNote: line.matchNote['en-IN'],
      claimable: jsonAmount(totalItcTaxOf(line.claimable).minor),
      heldBack: jsonAmount(totalItcTaxOf(line.heldBack).minor),
      // The whole of "match decisions show evidence": every field, both sides, and the verdict.
      evidence: line.evidence.map((row) => ({
        field: row.field,
        label: row.label['en-IN'],
        ours: row.ours,
        theirs: row.theirs,
        verdict: row.verdict,
        difference: row.difference === null ? null : jsonAmount(row.difference.minor),
      })),
      findings: line.findings.map((finding) => ({
        code: finding.code, severity: finding.severity,
        message: finding.message['en-IN'], whatToDo: finding.whatToDo['en-IN'],
      })),
      decision: line.decision === null ? null : {
        kind: line.decision.kind,
        reason: line.decision.reason,
        decidedAt: line.decision.decidedAt,
        stale: line.decisionStale,
      },
      portalSource: line.portal?.source ?? null,
    };
  }

  private itcWorkspaceJson(workspace: ItcWorkspace) {
    return {
      state: 'itc' as const,
      period: workspace.period,
      periodLabel: workspace.periodLabel,
      summary: workspace.sentence['en-IN'],
      portalDataPresent: workspace.portalDataPresent,
      lastImport: workspace.lastImport === null ? null : {
        source: workspace.lastImport.source,
        fileName: workspace.lastImport.fileName,
        importedAt: workspace.lastImport.importedAt,
        sentence: workspace.lastImport.sentence['en-IN'],
        rejected: workspace.lastImport.rejected.map((row) => row.reason),
      },
      counts: workspace.counts,
      outcomeCounts: workspace.outcomeCounts,
      claimable: jsonAmount(totalItcTaxOf(workspace.claimable).minor),
      heldBack: jsonAmount(totalItcTaxOf(workspace.heldBack).minor),
      atRisk: jsonAmount(totalItcTaxOf(workspace.atRisk).minor),
      lines: workspace.lines.map((line) => this.itcLineJson(line)),
      findings: workspace.findings
        .filter((finding) => finding.lineKey === null)
        .map((finding) => ({ code: finding.code, severity: finding.severity, message: finding.message['en-IN'], whatToDo: finding.whatToDo['en-IN'] })),
      returnLinkage: {
        allOtherItc: jsonAmount(totalItcTaxOf(workspace.returnLinkage.allOtherItc).minor),
        reverseChargeItc: jsonAmount(totalItcTaxOf(workspace.returnLinkage.reverseChargeItc).minor),
        importItc: jsonAmount(totalItcTaxOf(workspace.returnLinkage.importItc).minor),
        reversedItc: jsonAmount(totalItcTaxOf(workspace.returnLinkage.reversedItc).minor),
        caution: workspace.returnLinkage.caution['en-IN'],
      },
    };
  }

  async itcWorkspace(actor: ActorContext, input: Record<string, unknown>) {
    return this.itcWorkspaceJson(await this.shop.itc.workspace(actor, this.gstPeriodOf(input)));
  }

  /**
   * Imports the GSTR-2B or IMS file the business downloaded from the portal.
   *
   * The file arrives as text in the request rather than as an upload, because the local app has no
   * file store and because a person should be able to see what they are importing. The reader is
   * the same one the download path uses.
   */
  async importItcFile(actor: ActorContext, input: Record<string, unknown>) {
    const period = this.gstPeriodOf(input);
    const batch = await this.shop.itc.importFile(actor, {
      period,
      content: String(input.content ?? ''),
      ...(String(input.fileName ?? '').trim() === '' ? {} : { fileName: String(input.fileName).trim() }),
      expectedGstin: this.config.gstin,
    });
    return {
      ...this.itcWorkspaceJson(await this.shop.itc.workspace(actor, period)),
      imported: batch.sentence['en-IN'],
    };
  }

  /**
   * One row read off the portal and typed in by hand.
   *
   * Kept beside the file import rather than hidden behind it: a shop looking at the portal on a
   * phone often cannot download anything, and a feature that only works with the file does not
   * work on the days it is needed.
   */
  async addTypedItcRecord(actor: ActorContext, input: Record<string, unknown>) {
    const period = this.gstPeriodOf(input);
    const batch = await this.shop.itc.addTypedRecord(actor, {
      period,
      record: {
        supplierGstin: String(input.gstin ?? ''),
        supplierName: String(input.supplierName ?? ''),
        kind: String(input.kind ?? 'INVOICE'),
        number: String(input.number ?? ''),
        documentDate: String(input.date ?? ''),
        taxableValue: String(input.taxableValue ?? '0'),
        cgst: String(input.cgst ?? '0'),
        sgst: String(input.sgst ?? '0'),
        igst: String(input.igst ?? '0'),
        invoiceValue: String(input.invoiceValue ?? '0'),
        itcAvailableOnPortal: String(input.itcAvailable ?? 'Y'),
      },
    });
    return {
      ...this.itcWorkspaceJson(await this.shop.itc.workspace(actor, period)),
      imported: batch.sentence['en-IN'],
    };
  }

  async decideItcLine(actor: ActorContext, input: Record<string, unknown>) {
    const period = this.gstPeriodOf(input);
    const kind = String(input.decision ?? 'PENDING').toUpperCase();
    const workspace = await this.shop.itc.decide(actor, {
      period,
      lineKey: String(input.lineKey ?? ''),
      kind: kind === 'ACCEPT' ? 'ACCEPT' : kind === 'REJECT' ? 'REJECT' : 'PENDING',
      reason: String(input.reason ?? ''),
      idempotencyKey: `web-itc:${period}:${String(input.lineKey ?? '')}:${kind}:${String(input.reference ?? Date.now())}`,
    });
    return this.itcWorkspaceJson(workspace);
  }

  async gstReturnWorkspace(actor: ActorContext, input: Record<string, unknown>) {
    return this.gstWorkspaceJson(await this.gstReturns.workspace(actor, this.gstInput(input)));
  }

  async prepareGstReturn(actor: ActorContext, input: Record<string, unknown>) {
    const request = this.gstInput(input);
    return this.gstWorkspaceJson(await this.gstReturns.prepare(actor, {
      ...request,
      idempotencyKey: `web-gstr:${request.period}:${String(input.reference ?? request.period)}`,
    }));
  }

  async approveGstReturn(actor: ActorContext, input: Record<string, unknown>) {
    const note = String(input.note ?? '').trim();
    return this.gstWorkspaceJson(await this.gstReturns.approve(actor, {
      ...this.gstInput(input),
      ...(note === '' ? {} : { note }),
    }));
  }

  async reopenGstReturn(actor: ActorContext, input: Record<string, unknown>) {
    await this.gstReturns.reopen(actor, this.gstPeriodOf(input), String(input.reason ?? ''));
    return this.gstWorkspaceJson(await this.gstReturns.workspace(actor, this.gstInput(input)));
  }

  /**
   * The file a shop with no licensed intermediary uploads by hand.
   *
   * It comes back as JSON in the response rather than as a download, so the screen can show what is
   * in it before anybody saves it. A person about to hand a file to the government should be able
   * to look at it first.
   */
  async exportGstReturn(actor: ActorContext, input: Record<string, unknown>) {
    const returnType = String(input.returnType ?? 'GSTR1') === 'GSTR3B' ? 'GSTR3B' as const : 'GSTR1' as const;
    const file = await this.gstReturns.exportFile(actor, { ...this.gstInput(input), returnType });
    return {
      state: 'gst-export' as const,
      title: `${returnType === 'GSTR1' ? 'GSTR-1' : 'GSTR-3B'} file ready`,
      message: file.sentence['en-IN'],
      fileName: file.fileName,
      payload: file.payload,
    };
  }

  async returnDocuments(actor: ActorContext) {
    const companyId = this.companyOf(actor);
    permissionPortFromActor.require(actor, 'returns.create', 'view bills eligible for return');
    const returned = async (id: string, kind: 'SALES_RETURN' | 'PURCHASE_RETURN', lineId: string) =>
      (await this.returnNotes.listForOriginal(companyId, id)).filter((note) => note.kind === kind)
        .flatMap((note) => note.lines).filter((line) => line.originalLineId === lineId)
        .reduce((total, line) => total + line.quantity.scaled, 0n);
    const sales = await this.salesRepository.list(companyId, { state: 'FINAL' });
    const purchases = (await this.shop.bills.list(companyId)).filter((bill) => bill.state === 'POSTED');
    return {
      documents: [
        ...(await Promise.all(sales.map(async (invoice) => ({
          kind: 'SALES_RETURN', id: invoice.id, number: invoice.number, party: this.config.customerName,
          date: invoice.documentDate,
          lines: await Promise.all(invoice.lines.map(async (line) => ({
            id: line.lineId, item: line.note ?? line.itemId,
            quantity: Number(line.quantity.scaled) / 1_000_000, unit: line.quantity.unit,
            returned: Number(await returned(invoice.id, 'SALES_RETURN', line.lineId)) / 1_000_000,
          }))),
        })))),
        ...(await Promise.all(purchases.map(async (bill) => ({
          kind: 'PURCHASE_RETURN', id: bill.id, number: bill.invoiceNumber, party: bill.supplierName,
          date: bill.invoiceDate,
          lines: await Promise.all(bill.lines.map(async (line) => ({
            id: String(line.lineNumber), item: line.description,
            quantity: Number(line.quantity.scaled) / 1_000_000, unit: line.quantity.unit,
            returned: Number(await returned(bill.id, 'PURCHASE_RETURN', String(line.lineNumber))) / 1_000_000,
          }))),
        })))),
      ],
    };
  }

  async previewReturn(actor: ActorContext, input: Record<string, unknown>) {
    const command = this.returnInput(input);
    const preview = command.kind === 'SALES_RETURN'
      ? await this.returns.previewSales(actor, command.command)
      : await this.returns.previewPurchase(actor, command.command);
    return {
      state: 'preview', title: command.kind === 'SALES_RETURN' ? 'Customer return checked' : 'Supplier return checked',
      message: preview.summary, amount: jsonAmount(preview.totals.total.minor), token: command.command.idempotencyKey,
      effects: [
        command.kind === 'SALES_RETURN' ? 'A credit note will reduce what the customer owes.' : 'A debit note will reduce what you owe the supplier.',
        command.kind === 'SALES_RETURN' ? 'Accepted goods will go back into stock.' : 'Returned goods will leave stock.',
        preview.complianceStatus === 'PENDING_ADJUSTMENT' ? 'The registered document needs a compliance adjustment.' : 'No government-document adjustment is needed.',
      ],
    };
  }

  async recordReturn(actor: ActorContext, input: Record<string, unknown>) {
    const command = this.returnInput(input);
    const result = command.kind === 'SALES_RETURN'
      ? await this.returns.postSales(actor, command.command)
      : await this.returns.postPurchase(actor, command.command);
    return {
      state: 'recorded', deduplicated: result.deduplicated,
      title: result.deduplicated ? 'Return already recorded once' : 'Return recorded',
      message: result.note.summary, note: { id: result.note.id, number: result.note.number, kind: result.note.kind, amount: jsonAmount(result.note.totals.total.minor) },
    };
  }

  // ------------------------------------------------- issue #18: order, delivery, three-way match

  /** The catalogue the purchase screens share, so an item means the same thing on all of them. */
  private static readonly CATALOGUE: Record<string, { description: string; hsnSac: string; unit: string; kind: 'GOODS' | 'SERVICES'; batchId?: string }> = {
    TMT12: { description: 'TMT Steel Bar 12mm', hsnSac: '72142090', unit: 'KGS', kind: 'GOODS' },
    SOAP: { description: 'Herbal Bath Soap 100g', hsnSac: '34011190', unit: 'BOX', kind: 'GOODS' },
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

  // ------------------------------------------------ issue #27: e-way bills for goods on the road

  /**
   * Turns a sales invoice and what the dispatch clerk typed into one movement of goods.
   *
   * The bill and the lorry are deliberately separate things. The invoice says who is being charged;
   * the form says where the goods are actually going, how far, and on which vehicle. Both go in,
   * and the rules decide from the movement rather than from the bill.
   */
  private async movementFor(actor: ActorContext, invoiceId: string, input: Record<string, unknown>): Promise<Movement> {
    const companyId = this.companyOf(actor);
    const invoice = await this.salesRepository.findById(companyId, invoiceId);
    if (invoice === null) throw notFound('API_INVOICE_NOT_FOUND', 'We could not find that bill.');
    if (invoice.state !== 'FINAL' || invoice.number === null) {
      throw invalid('API_INVOICE_NOT_FINAL', 'This bill has not been issued yet, so there is nothing to move against it.');
    }
    const pricing = invoice.pricing;
    if (pricing === null) throw invalid('API_INVOICE_NOT_PRICED', 'This bill has no tax worked out on it yet.');

    const consignor: MovementParty = {
      legalName: this.config.name,
      gstin: this.config.gstin,
      address1: this.config.location,
      place: this.config.location.split('·')[0]?.trim() ?? this.config.location,
      pincode: '560058',
      stateCode: this.config.gstin.slice(0, 2),
    };
    const billTo: MovementParty = {
      legalName: this.config.customerName,
      gstin: this.config.customerGstin,
      address1: 'Customer address on file',
      place: 'Bengaluru',
      pincode: '560001',
      stateCode: this.config.customerGstin.slice(0, 2),
    };

    // Where the goods really go. Left off entirely when the form did not say, so the rules read the
    // buyer's own address rather than a made-up delivery address.
    const shipToState = String(input.shipToState ?? '').trim();
    const shipToPlace = String(input.shipToPlace ?? '').trim();
    const shipTo: MovementParty | undefined = shipToState === '' ? undefined : {
      legalName: `${this.config.customerName} — delivery address`,
      gstin: this.config.customerGstin,
      address1: 'Delivery address given on the movement',
      place: shipToPlace === '' ? 'Delivery address' : shipToPlace,
      pincode: '500037',
      stateCode: shipToState,
    };

    const lines: ConsignmentLine[] = pricing.lines.map((line) => ({
      description: line.itemName,
      hsnCode: line.hsnOrSac ?? '',
      quantity: (Number(line.quantity.scaled) / 1_000_000).toString(),
      unit: line.quantity.unit,
      taxableValuePaise: line.taxableValue.minor,
      cgstPaise: line.cgst.minor,
      sgstPaise: line.sgst.minor,
      igstPaise: line.igst.minor,
      cessPaise: line.cess.minor,
    }));

    const distance = String(input.distanceKm ?? '').trim();
    const vehicleNumber = String(input.vehicle ?? '').trim();
    const withinSameCity = String(input.withinSameCity ?? '').trim();
    const vehicle: VehicleAssignment | undefined = vehicleNumber === '' ? undefined : {
      registrationNumber: vehicleNumber,
      vehicleType: input.oversized === 'yes' ? 'ODC' : 'REGULAR',
      fromPlace: consignor.place,
      fromStateCode: consignor.stateCode,
    };

    return {
      movementId: invoice.id,
      reason: (String(input.reason ?? 'SUPPLY') as MovementReason),
      consignor,
      billTo,
      ...(shipTo === undefined ? {} : { shipTo }),
      documents: [{
        documentId: invoice.id,
        documentType: 'TAX_INVOICE',
        documentNumber: invoice.number,
        documentDate: invoice.documentDate,
        lines,
      }],
      transportMode: 'ROAD',
      vehicleType: input.oversized === 'yes' ? 'ODC' : 'REGULAR',
      conveyance: 'OWN_VEHICLE',
      // Blank means "we have not been told", which stays a question rather than becoming a zero.
      ...(distance === '' ? {} : { approximateDistanceKm: Number(distance) }),
      ...(withinSameCity === '' ? {} : { withinSameCity: withinSameCity === 'yes' }),
      ...(vehicle === undefined ? {} : { vehicle }),
    };
  }

  private static ewayJson(record: EwayBillRecord, now: Date) {
    return {
      state: 'eway' as const,
      status: record.status,
      title: record.status === 'ACTIVE'
        ? 'The goods may move'
        : record.status === 'PART_A_ONLY'
          ? 'Raised, but no vehicle yet'
          : record.status === 'EXPIRED'
            ? 'This e-way bill has run out'
            : record.status === 'CANCELLED'
              ? 'Cancelled with the portal'
              : record.status === 'REJECTED'
                ? 'Marked as not your consignment'
                : record.status === 'PENDING'
                  ? 'Waiting for the portal'
                  : 'No e-way bill',
      message: record.message,
      documentNumber: record.documentNumber,
      applicability: {
        outcome: record.applicability.outcome,
        reason: record.applicability.reason,
        ruleId: record.applicability.ruleId,
        sourceRef: record.applicability.sourceRef ?? null,
        effectiveFrom: record.applicability.effectiveFrom ?? null,
        facts: record.applicability.appliedFacts.map((fact) => ({ label: fact.label, value: fact.value })),
      },
      ewayBillNumber: record.acknowledgement?.ewayBillNumber ?? null,
      generatedAt: record.acknowledgement?.generatedAt ?? null,
      validUntil: record.acknowledgement?.validUntil ?? null,
      // The same moment written the way a driver reads it: Indian wall-clock, not a UTC stamp.
      validUntilLabel: record.acknowledgement?.validUntil === undefined ? null : describeExpiry(record.acknowledgement.validUntil),
      cancellableUntilLabel: record.cancellableUntil === undefined ? null : describeExpiry(record.cancellableUntil),
      timeLeft: record.acknowledgement?.validUntil === undefined || record.status !== 'ACTIVE'
        ? null
        : describeTimeLeft(record.acknowledgement.validUntil, now),
      consignmentValue: jsonAmount(record.consignmentValuePaise),
      vehicles: record.vehicleLegs.map((leg) => ({
        number: leg.registrationNumber, from: leg.fromPlace, reason: leg.reason, at: leg.recordedAt,
      })),
      cancellableUntil: record.cancellableUntil ?? null,
      consolidatedTripNumber: record.consolidatedTripNumber ?? null,
      failure: record.failure ?? null,
      raw: record,
    };
  }

  /** Whether these goods need an e-way bill at all, and what would be sent. Writes nothing. */
  async previewEwayBill(actor: ActorContext, input: Record<string, unknown>) {
    const movement = await this.movementFor(actor, String(input.invoice ?? ''), input);
    const preview = await this.shop.ewayBill.preview(actor, movement);
    return {
      state: 'preview' as const,
      title: preview.applicability.outcome === 'REQUIRED'
        ? (preview.ready ? (preview.vehicleReady ? 'Ready to raise' : 'Ready, but no vehicle yet') : 'Something is missing')
        : preview.applicability.outcome === 'CANNOT_DECIDE' ? 'We need one more fact' : 'No e-way bill needed',
      message: preview.summary,
      outcome: preview.applicability.outcome,
      reason: preview.applicability.reason,
      ruleId: preview.applicability.ruleId,
      sourceRef: preview.applicability.sourceRef ?? null,
      effectiveFrom: preview.applicability.effectiveFrom ?? null,
      facts: preview.applicability.appliedFacts.map((fact) => ({ label: fact.label, value: fact.value })),
      threshold: preview.applicability.thresholdApplied === undefined ? null : {
        scope: preview.applicability.thresholdApplied.scope,
        amount: jsonAmount(preview.applicability.thresholdApplied.thresholdPaise),
        note: preview.applicability.thresholdApplied.note ?? null,
      },
      ready: preview.ready,
      vehicleReady: preview.vehicleReady,
      validityDays: preview.validityDays ?? null,
      consignmentValue: jsonAmount(preview.consignmentValuePaise),
      problems: preview.problems.map((problem) => ({ field: problem.field, message: problem.message })),
      documentNumber: movement.documents[0]?.documentNumber ?? '',
    };
  }

  /** Raises the e-way bill with the portal, once. */
  async generateEwayBill(actor: ActorContext, input: Record<string, unknown>) {
    const movement = await this.movementFor(actor, String(input.invoice ?? ''), input);
    const record = await this.shop.ewayBill.generate(actor, movement);
    return DemoApplication.ewayJson(record, this.shop.clock.now());
  }

  /** Part B: the lorry going on, or a different lorry after a breakdown. */
  async updateEwayVehicle(actor: ActorContext, input: Record<string, unknown>) {
    const number = String(input.vehicle ?? '').trim();
    if (number === '') throw invalid('API_VEHICLE_REQUIRED', 'Enter the vehicle number that is carrying the goods.');
    const vehicle: VehicleAssignment = {
      registrationNumber: number,
      vehicleType: input.oversized === 'yes' ? 'ODC' : 'REGULAR',
      fromPlace: String(input.fromPlace ?? this.config.location.split('·')[0]?.trim() ?? 'Bengaluru'),
      fromStateCode: String(input.fromState ?? this.config.gstin.slice(0, 2)),
      ...(String(input.changeReason ?? '') === '' ? {} : { reason: String(input.changeReason) as NonNullable<VehicleAssignment['reason']> }),
      ...(String(input.changeNote ?? '') === '' ? {} : { reasonNote: String(input.changeNote) }),
    };
    const record = await this.shop.ewayBill.updateVehicle(actor, String(input.invoice ?? ''), vehicle);
    return DemoApplication.ewayJson(record, this.shop.clock.now());
  }

  async extendEwayValidity(actor: ActorContext, input: Record<string, unknown>) {
    const record = await this.shop.ewayBill.extendValidity(actor, String(input.invoice ?? ''), {
      currentPlace: String(input.currentPlace ?? ''),
      currentStateCode: String(input.currentState ?? ''),
      remainingDistanceKm: Number(String(input.remainingKm ?? '0')),
      reason: String(input.reason ?? ''),
    });
    return DemoApplication.ewayJson(record, this.shop.clock.now());
  }

  async cancelEwayBill(actor: ActorContext, input: Record<string, unknown>) {
    const record = await this.shop.ewayBill.cancel(actor, String(input.invoice ?? ''), {
      reasonCode: (String(input.reasonCode ?? 'OTHERS') as 'OTHERS'),
      reason: String(input.reason ?? ''),
    });
    return DemoApplication.ewayJson(record, this.shop.clock.now());
  }

  async rejectEwayBill(actor: ActorContext, input: Record<string, unknown>) {
    const record = await this.shop.ewayBill.reject(actor, String(input.invoice ?? ''), {
      reasonCode: (String(input.reasonCode ?? 'NOT_MY_CONSIGNMENT') as 'NOT_MY_CONSIGNMENT'),
      reason: String(input.reason ?? ''),
    });
    return DemoApplication.ewayJson(record, this.shop.clock.now());
  }

  /** Asks the portal what it actually holds, for when a call timed out. */
  async reconcileEwayBill(actor: ActorContext, input: Record<string, unknown>) {
    const record = await this.shop.ewayBill.reconcile(actor, String(input.invoice ?? ''));
    return DemoApplication.ewayJson(record, this.shop.clock.now());
  }

  /** Part A as a file, for the day the portal is down and the lorry still has to leave. */
  async ewayOfflineJson(actor: ActorContext, input: Record<string, unknown>) {
    const movement = await this.movementFor(actor, String(input.invoice ?? ''), input);
    const json = await this.shop.ewayBill.offlineJson(actor, movement);
    return {
      state: 'offline' as const,
      fileName: `ewaybill-${(movement.documents[0]?.documentNumber ?? 'movement').replace(/\//g, '-')}.json`,
      json,
    };
  }

  /**
   * Every state and its own e-way bill limit, for the picker on the screen.
   *
   * The list is the rule table itself, so choosing a state on screen and the rule that decides the
   * movement can never drift apart.
   */
  static ewayStates() {
    return {
      // 28 states and 8 union territories to pick from; the rest of the rows are codes that are no
      // longer issued, kept so an old document still resolves, and marked as such on the screen.
      counts: jurisdictionCounts(),
      states: CURRENT_STATE_RULES.map((rule) => ({
        code: rule.scope,
        name: rule.stateName,
        kind: rule.kind,
        // An exemption has no limit to show, and showing ₹50,000 against it would be a lie.
        limit: rule.exemptAnyValue === true ? null : jsonAmount(rule.thresholdPaise),
        exemptAnyValue: rule.exemptAnyValue === true,
        intraCityLimit: rule.intraCityThresholdPaise === undefined ? null : jsonAmount(rule.intraCityThresholdPaise),
        intraCityExempt: rule.intraCityExemptAnyValue === true,
        effectiveFrom: rule.effectiveFrom,
        sourceRef: rule.sourceRef,
        sourceKind: rule.sourceKind,
        note: rule.note ?? null,
      })),
    };
  }

  /** What is on the road right now, for the dispatch desk. */
  async ewayBillsOnTheRoad(actor: ActorContext) {
    const rows = await this.shop.ewayBill.onTheRoad(actor);
    return {
      consignments: rows.map((row) => ({
        movementId: row.record.movementId,
        documentNumber: row.record.documentNumber,
        ewayBillNumber: row.record.acknowledgement?.ewayBillNumber ?? null,
        status: row.record.status,
        vehicle: row.record.vehicleLegs[row.record.vehicleLegs.length - 1]?.registrationNumber ?? null,
        validUntil: row.record.acknowledgement?.validUntil ?? null,
        timeLeft: row.timeLeft,
      })),
    };
  }

  // ------------------------------------------- issue #29: what the registering authority holds

  /**
   * One number plate, typed in, answered by the registering authority.
   *
   * This is the whole of issue #29 on a screen: a masked, dated classification, who answered, and
   * — when we could not ask — which of the reasons it was, never dressed up as "nothing wrong".
   */
  async lookupVehicleRecord(actor: ActorContext, input: Record<string, unknown>) {
    this.companyOf(actor);
    const result = await this.shop.vehicleRecords.verify(actor, String(input.vehicle ?? ''));
    const consent = await this.shop.vehicleRecords.consentStatus(actor);
    const connected = consent !== null && consent.revokedAt === undefined;
    const base = {
      state: 'vehicle-record' as const,
      vehicle: String(input.vehicle ?? '').toUpperCase().replace(/[\s-]/g, ''),
      kind: result.kind,
      message: result.summary,
      // What the business agreed the government service may be asked for, on the screen that uses
      // it, so nobody has to take our word for what is being read.
      consent: connected
        ? { fields: (consent?.fields ?? []).map((field) => PERMITTED_VEHICLE_FIELD_NAMES[field]), purpose: consent?.purpose ?? null, expiresOn: consent?.expiresOn ?? null }
        : null,
    };
    if (result.kind === 'FOUND') {
      return {
        ...base,
        title: `${base.vehicle} is on the registering authority's record`,
        provider: result.provenance.provider,
        providerReference: result.provenance.providerReference,
        retrievedAt: result.provenance.retrievedAt,
        freshness: result.freshness,
        fromCache: result.fromCache,
        facts: DemoApplication.vehicleRecordFacts(result.evidence),
      };
    }
    if (result.kind === 'NOT_FOUND') {
      return {
        ...base,
        title: `The authority holds no vehicle with the number ${base.vehicle}`,
        provider: result.provenance.provider,
        providerReference: result.provenance.providerReference,
        retrievedAt: result.provenance.retrievedAt,
        freshness: null,
        fromCache: result.fromCache,
        facts: [],
      };
    }
    return {
      ...base,
      title: 'This vehicle has not been checked',
      code: result.code,
      retryable: result.retryable,
      provider: null,
      providerReference: null,
      retrievedAt: result.checkedAt,
      freshness: result.lastKnown?.freshness ?? null,
      fromCache: false,
      facts: result.lastKnown === undefined ? [] : DemoApplication.vehicleRecordFacts(result.lastKnown.evidence),
      lastKnownAt: result.lastKnown?.provenance.retrievedAt ?? null,
    };
  }

  /** The permitted fields, in plain words, in the order a person would read them. */
  private static vehicleRecordFacts(evidence: VehicleEvidence) {
    const rows: { label: string; value: string }[] = [
      { label: 'What kind of vehicle', value: evidence.vehicleClass === undefined ? 'The record does not say' : VEHICLE_CLASS_NAMES[evidence.vehicleClass] },
      { label: 'Body', value: evidence.bodyType ?? 'The record does not say' },
      { label: 'May carry', value: evidence.ratedPayloadKg === undefined ? 'Not stated on the record' : `${evidence.ratedPayloadKg} kg` },
      { label: 'Weight loaded / empty', value: `${evidence.grossVehicleWeightKg ?? '—'} kg / ${evidence.unladenWeightKg ?? '—'} kg` },
      { label: 'Permit', value: evidence.permitType ?? 'The record does not say' },
      { label: 'Permit valid until', value: evidence.permitValidUpto ?? 'Not stated' },
      { label: 'Fitness certificate until', value: evidence.fitnessValidUpto ?? 'Not stated' },
      { label: 'Insurance until', value: evidence.insuranceValidUpto ?? 'Not stated' },
      { label: 'Registration status', value: evidence.registrationStatus ?? 'Not stated' },
      { label: 'Registered to (masked)', value: evidence.registeredOwnerName ?? 'Not read' },
    ];
    return rows;
  }

  // ------------------------------------------- issue #28: is this lorry able to carry this load

  /**
   * The vehicles this screen can be tried against.
   *
   * The list is the synthetic authority's own rows plus the shop's own lorry, so what the picker
   * offers and what the check reads can never drift apart.
   */
  static vehicleChoices() {
    return {
      vehicles: [
        ...SYNTHETIC_VAHAN_ROWS.map((row) => {
          const number = String(row.rc_regn_no);
          // The label is worked out the same way the check works it out, so the picker can never
          // promise a class the lookup does not read.
          const read = readVehicleClass(row.rc_vh_class_desc, readWeightKg(row.rc_gvw));
          return {
            number,
            label: `${number} · ${read === null ? 'a class we do not recognise' : VEHICLE_CLASS_NAMES[read.vehicleClass]}`,
            knownTo: 'the registering authority',
          };
        }),
        { number: 'KA09OW5566', label: 'KA09OW5566 · your own closed van (not on the authority\'s record)', knownTo: 'your vehicle list only' },
        { number: 'KA88XX0001', label: 'KA88XX0001 · a number nobody holds', knownTo: 'nobody' },
      ],
      // The classes a person can type when neither record holds the vehicle.
      classes: Object.entries(VEHICLE_CLASS_NAMES).map(([value, label]) => ({ value, label })),
      // What the yard's camera can be made to see, so the comparison can be tried both ways.
      photos: [
        { value: '', label: 'No photograph' },
        { value: 'plate:KA01AB1234@0.96', label: 'A clear photo of KA01AB1234' },
        { value: 'plate:KA02GV3344@0.94', label: 'A clear photo of a different lorry' },
        { value: 'plate:KAO1AB1Z34@0.88', label: 'A photo read as KAO1AB1Z34 (look-alike characters)' },
        { value: 'blurred', label: 'A photo nothing can be read from' },
      ],
    };
  }

  private static vehicleJson(assessment: VehicleSuitabilityAssessment) {
    const outstanding = outstandingOf(assessment.findings, assessment.overrides);
    return {
      state: 'vehicle' as const,
      id: assessment.id,
      outcome: assessment.outcome,
      // An overridden check still says BLOCK — that is what was found — but the heading has to say
      // where the movement actually stands, or a dispatch clerk reads a stopped lorry.
      title: assessment.clearedToMove && assessment.overrides.length > 0
        ? 'Sent out on somebody\'s authority'
        : assessment.outcome === 'BLOCK'
        ? 'This load cannot go on this vehicle'
        : assessment.outcome === 'CANNOT_DECIDE'
          ? 'This has not been checked all the way through'
          : assessment.outcome === 'WARN'
            ? 'It can go, with something worth a look'
            : 'Nothing found against this movement',
      message: assessment.summary,
      clearedToMove: assessment.clearedToMove,
      vehicle: assessment.transport.vehicleNumber ?? null,
      findings: assessment.findings.map((finding) => ({
        code: finding.code,
        severity: finding.severity,
        title: finding.title,
        reason: finding.reason,
        ruleId: finding.ruleId,
        sourceRef: finding.sourceRef ?? null,
        overridable: finding.overridable,
        evidenceSource: finding.evidenceSource ?? null,
        facts: finding.appliedFacts.map((fact) => ({ label: fact.label, value: fact.value })),
        // What the screen offers a button for: still standing, and allowed to be overridden.
        outstanding: outstanding.some((row) => row.code === finding.code),
      })),
      // Every reading, with its source on it, exactly as the check stored it.
      evidence: assessment.evidence.map((item) => ({
        source: item.source,
        retrievedAt: item.retrievedAt,
        vehicleClass: item.vehicleClass === undefined ? null : VEHICLE_CLASS_NAMES[item.vehicleClass],
        bodyType: item.bodyType ?? null,
        ratedPayloadKg: item.ratedPayloadKg ?? null,
        grossVehicleWeightKg: item.grossVehicleWeightKg ?? null,
        unladenWeightKg: item.unladenWeightKg ?? null,
        permitType: item.permitType ?? null,
        permitValidUpto: item.permitValidUpto ?? null,
        fitnessValidUpto: item.fitnessValidUpto ?? null,
        registrationStatus: item.registrationStatus ?? null,
        reference: item.reference ?? null,
      })),
      capacity: assessment.capacity === undefined ? null : {
        capacityKg: assessment.capacity.capacityKg,
        basis: assessment.capacity.basis,
        source: assessment.capacity.source,
      },
      plate: assessment.plate === undefined ? null : {
        verdict: assessment.plate.verdict,
        readBy: assessment.plate.readBy,
        readNumber: assessment.plate.readNumber ?? null,
        declaredNumber: assessment.plate.declaredNumber,
        confidence: assessment.plate.confidence ?? null,
        explanation: assessment.plate.explanation,
      },
      overrides: assessment.overrides.map((entry) => ({
        findingCodes: [...entry.findingCodes],
        reason: entry.reason,
        by: entry.byUserId,
        at: entry.at,
      })),
      outstanding: outstanding.length,
    };
  }

  /** Checks the load against the lorry. Writes the assessment; changes nothing about the goods. */
  async checkVehicle(actor: ActorContext, input: Record<string, unknown>) {
    const movementId = String(input.invoice ?? '').trim();
    if (movementId === '') throw invalid('API_MOVEMENT_REQUIRED', 'Choose which bill is being sent out.');
    const weight = String(input.weightKg ?? '').trim();
    const distance = String(input.distanceKm ?? '').trim();

    const transport: TransportDetails = {
      mode: 'ROAD',
      vehicleNumber: String(input.vehicle ?? '').trim(),
      movementDate: this.shop.clock.now().toISOString().slice(0, 10),
      interState: String(input.interState ?? 'no') === 'yes',
      ...(String(input.transporterId ?? '').trim() === '' ? {} : { transporterId: String(input.transporterId).trim() }),
      // Blank stays blank: an unentered distance is a missing fact, never a zero.
      ...(distance === '' ? {} : { distanceKm: Number(distance) }),
    };
    const shipment: ShipmentFacts = {
      ...(weight === '' ? {} : { grossWeightKg: Number(weight) }),
      ...(String(input.coldChain ?? '') === 'yes' ? { requiresColdChain: true } : {}),
      ...(String(input.hazardous ?? '') === 'yes' ? { hazardous: true } : {}),
    };

    const photo = String(input.platePhoto ?? '').trim();
    // A yard with no camera still gets its plate checked: whatever somebody read off the lorry
    // runs through the same comparison, recorded as a person's reading rather than a machine's.
    const typedPlate = String(input.plateTyped ?? '').trim();
    // And a vehicle neither record holds can have its class and capacity typed in for this one
    // movement. Typed facts fill gaps; they never overrule the registering authority.
    const declaredClass = String(input.declaredClass ?? '').trim();
    const declaredCapacity = String(input.declaredCapacityKg ?? '').trim();
    const declared = declaredClass === '' && declaredCapacity === '' ? undefined : {
      ...(declaredClass === '' ? {} : { vehicleClass: declaredClass as VehicleClass }),
      ...(declaredCapacity === '' ? {} : { ratedPayloadKg: Number(declaredCapacity) }),
    };

    const assessment = await this.shop.vehicleSuitability.assess(actor, {
      movementId,
      transport,
      shipment,
      ...(photo === '' ? {} : { platePhoto: platePhoto(photo, this.shop.clock.now().toISOString()) }),
      ...(typedPlate === '' ? {} : { plateReadByHand: typedPlate }),
      ...(declared === undefined ? {} : { declared }),
    });
    return DemoApplication.vehicleJson(assessment);
  }

  /**
   * A person answering for named findings.
   *
   * The evidence and the findings are untouched by this; the override is stored beside them with
   * the reason, and the screen goes on showing what was found.
   */
  async overrideVehicleCheck(actor: ActorContext, input: Record<string, unknown>) {
    const codes = String(input.findingCodes ?? '').split(',').map((code) => code.trim()).filter((code) => code !== '');
    const assessment = await this.shop.vehicleSuitability.override(actor, String(input.checkId ?? ''), {
      findingCodes: codes,
      reason: String(input.reason ?? ''),
    });
    return DemoApplication.vehicleJson(assessment);
  }

  /** The dispatch desk's queue: movements a vehicle problem is holding back. */
  async blockedVehicleChecks(actor: ActorContext) {
    const rows = await this.shop.vehicleSuitability.blocked(actor);
    return {
      held: rows.map((row) => ({
        movementId: row.movementId,
        vehicle: row.transport.vehicleNumber ?? null,
        outcome: row.outcome,
        summary: row.summary,
        outstanding: outstandingOf(row.findings, row.overrides).map((finding) => finding.title),
      })),
    };
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
    return { partyId: this.config.customerId, customerType: 'B2B' as const, supplyKind: 'GOODS' as const, documentDate: date, dueDate: isoDate(daysAfter(date, Number.isFinite(terms) ? terms : 0)), deliveryStateCode: this.config.gstin.slice(0, 2), lines: [{ lineId: 'line-1', itemId: 'SOAP', warehouseId: 'wh-main', quantity: quantityFromString(String(input.quantity), 'PCS'), unitPrice: money(paise(input.rate)), priceBasis: 'EXCLUSIVE' as const, note: String(input.item || 'Herbal Bath Soap 100g') }], narration: String(input.notes || '') || null };
  }

  private returnInput(input: Record<string, unknown>) {
    const kind = String(input.kind) === 'PURCHASE_RETURN' ? 'PURCHASE_RETURN' as const : 'SALES_RETURN' as const;
    const documentId = String(input.documentId ?? '').trim();
    const lineId = String(input.lineId ?? '').trim();
    if (documentId === '' || lineId === '') throw invalid('RETURN_DOCUMENT_REQUIRED', 'Choose the original bill and item being returned.');
    const quantity = quantityFromString(String(input.quantity ?? ''), String(input.unit ?? 'PCS'));
    const shared = {
      idempotencyKey: `web-return:${String(input.reference || `${kind}:${documentId}:${lineId}:${input.date}`)}`,
      documentDate: isoDate(String(input.date)), reason: String(input.reason ?? ''),
      lines: [{ originalLineId: lineId, quantity, disposition: String(input.disposition ?? 'ACCEPTED') as 'ACCEPTED' | 'DAMAGED' | 'SCRAPPED' | 'REPLACEMENT', warehouseId: 'wh-main' }],
    };
    return kind === 'SALES_RETURN'
      ? { kind, command: { ...shared, originalInvoiceId: documentId } }
      : { kind, command: { ...shared, originalBillId: documentId } };
  }

  private companyOf(actor: ActorContext): CompanyId {
    if (actor.companyId !== this.config.companyId) throw invalid('API_TENANT_MISMATCH', 'This company is not available in your session.');
    return actor.companyId;
  }
}
