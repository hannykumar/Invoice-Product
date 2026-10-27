/**
 * Issues #72 and #80 — one authenticated company composed from the real domain services.
 *
 * Persistence is in-memory for the local app, but company and actor always come from the session.
 */
import { BooksDesk } from './books-entry-application.ts';
import { asId, conflict, DomainError, financialYearOf as financialYearName, financialYearRange, forbidden, formatDate, formatINR, invalid, notAllowed, indiaDateOf, isoDate, money, mulDiv, notFound, quantityFromString, sum, type CompanyId, type PartyId } from '@invoice/kernel';
import { appClock, appToday, currentFinancialYear, previousMonthOfToday } from './app-clock.ts';
import { InMemoryAuditPort, InMemoryLedgerStore, permissionPortFromActor, trialBalance, type ActorContext, type TransactionParticipant } from '@invoice/ledger';
import { GstCalculator, RateTable, foldChargesIntoGoods, type ComputedTaxLine, type Discount } from '@invoice/gst-calc';
import { RulesEngine, shippedRegistry } from '@invoice/rules-engine';
import { reportError, reportUnexpected } from '../../../packages/platform/src/error-reporting.ts';
import { ChallanService, InMemoryChallanRepository, InMemoryPreSaleRepository, InMemorySalesRepository, noComplianceHooks, PreSaleService, SALES_PERMISSIONS, SalesService, type CancelBlocker, type CancellationGuardPort, type InventoryPort, type ReservationRequest, type SalesInvoice } from '@invoice/sales';
import {
  brandedSnapshot,
  copiesFor,
  creditNotePdf,
  noteOriginalFromInvoice,
  renderCreditNote,
  toCreditNoteDocument,
  type CreditNoteDocument,
  amountInWords,
  captureSnapshot,
  copyMarking,
  escapeHtml,
  ewayBillPdf,
  ewayPrintBanner,
  invoicePdf,
  invoicePdfCopies,
  renderInvoiceCopies,
  qrSvg,
  renderEwayBill,
  renderInvoice,
  templateById,
  type TemplateDefinition,
  toInvoiceDocument,
  upiPaymentLink,
  type InvoiceDocument,
  type Locale,
  type PageFormat,
  type RenderableParty,
  type TemplateSnapshot,
} from '@invoice/invoice-templates';
import { brandingOf, saveUpiId, upiIdOf } from './branding-application.ts';
import { masterData as masterDataService, mastersContext } from './master-data.ts';
import {
  addShippingAddress,
  correctCustomerAddress,
  createTransporter,
  customerBillingAddress,
  requireAddressInState,
  deliveryDetails,
  printableEwayNumber,
  shippingChoices,
  transporters,
  type DeliveryDetails,
} from './delivery-application.ts';
import {
  billingAddressOf, suppliers,
  catalogueTaxReader,
  customers,
  createCustomer,
  createItem,
  createSupplier,
  resolveSupplier,
  suppliers as supplierParties,
  changeItemCode,
  editItem,
  readCatalogue,
  customerPrint,
  customerView,
  declaredRatesOf,
  OUTSIDE_INDIA,
  itemView,
  items as catalogueItems,
  resolveCustomer,
  resolveItem,
  seedCatalogue,
  creditLimitPaiseOf,
  setCustomerCreditLimit,
  isWalkIn,
  walkInCustomer,
} from './catalogue-application.ts';
import { COMPOSITION_LEGEND } from '@invoice/gst-returns';
import { CompositionDesk, filedCalendarQuarters } from './composition-application.ts';
import { COMPOSITION_NO_CREDIT_CLAUSE, schemeDuring, schemeOn } from './composition-scheme.ts';
import { businessDetailsOf, currentStates, dispatchFrom, eInvoiceExemptionOf, readBusinessDetails, requireIssuable, saveBusinessDetails, sellerPrint, turnoverAnswersOf, turnoverBandFor, writeOffLimitOf } from './business-details-application.ts';
import { approvalChallanTask, eInvoiceTask, ewayTask, doneReturnMonths, gstReturnTasks, lateCustomersTask, moneyCardFigures, recentBillRow, stockTask, turnoverTask, type HomeTask } from './home-application.ts';
import { turnoverAnswerOn, turnoverBandOn } from '../../../packages/masters/src/hsn-digits.ts';
import { validatePincodeForState } from '../../../packages/masters/src/validation.ts';
import { STATE_NAMES, consignmentFromChallan } from '@invoice/transport';
import { challanReason } from '@invoice/sales';
import { ChallanDesk, type ChallanFacts, type ChallanHooks } from './challan-application.ts';
import { PreSaleDesk } from './presale-application.ts';
import { AdvanceService, InMemoryAdvanceRepository, InMemoryPaymentRepository, ReceivablesService, settlementWords, validateSettlements, type BillSettlement, type DocumentLedgerPort, type DocumentPosition, type OpenDocument, type Payment, type PaymentMode, type AdvanceParticulars, type DocumentReference } from '@invoice/receivables';
import {
  TRADE_TERMS_PERMISSIONS,
  TradeTermsService,
  noPriceList,
  type TradeTermsQuote,
  type CreditPositionPort,
  type PartyTermsPort,
  type SalesHistoryPort,
  type StockCostPort,
} from '@invoice/trade-terms';
import {
  ReportService,
  ageingBody,
  duesFrom,
  type Figure,
  type StatementLine,
  type PurchaseDocument,
  type PurchaseReadPort,
  type ReportFilter,
} from '@invoice/reports';
import { ComplianceRegister } from '@invoice/compliance-register';
import { AssistantService, describeIntent } from '../../../packages/assistant/src/service.ts';
import type { BlockedDocument, BlockedDocumentPort, BlockingReason } from '../../../packages/assistant/src/ports.ts';
import { createDefaultUnitRegistry } from '../../../packages/masters/src/units.ts';
import type { IsoDate, Money, Quantity } from '@invoice/kernel';
import { salesInventoryAdapter, type InventoryStore, type StockItem, type StockMasterData, type Warehouse } from '@invoice/inventory';
import { DEFAULT_SALES_POLICY } from '../../../packages/sales/src/policy.ts';
import { lineTaxableValue, taxOn } from '../../../packages/purchasing/src/recompute.ts';
import { formatQuantity } from '../../../packages/masters/src/units.ts';
import { both, say, type Bilingual } from './language.ts';
import type { ApprovedPurchase, ApprovedPurchaseLine, PurchaseBill, PurchasePostingPreview } from '../../../packages/purchasing/src/posting-types.ts';
import { validatePurchase } from '../../../packages/purchasing/src/validate.ts';
import { rulesEngineTaxSplit } from '../../../packages/purchasing/src/rules-adapter.ts';
import { citeReverseChargeEntry, reverseChargeDecisionFor, type ReverseChargeDecision } from '../../../packages/purchasing/src/reverse-charge-notified.ts';
import { checkReverseChargeEntry, type RegisterParty, type ReverseChargeLine, type SelfInvoice } from '../../../packages/purchasing/src/reverse-charge-register.ts';
import { rcmTimeOfSupply, selfInvoiceDue, type RcmSupplyKind } from '../../../packages/purchasing/src/reverse-charge-timing.ts';
import { BLOCKED_CREDIT_REASONS, blockedCreditReasonFor } from '../../../packages/purchasing/src/blocked-credit.ts';
import type { Party, TaxDefault } from '../../../packages/masters/src/types.ts';
import { normaliseInvoiceNumber } from '../../../packages/purchasing/src/duplicates.ts';
import { formatPaise } from '../../../packages/purchasing/src/money.ts';
import { gstinStateCode, normaliseIdentifier } from '../../../packages/masters/src/validation.ts';
import { purchaseDocumentLedger } from '../../../packages/purchasing/src/posting-adapters.ts';
import { quantity } from '../../../packages/masters/src/units.ts';
import { createCompanyShop, type CompanySeed } from './company-shop.ts';
import { PUBLIC_ORIGINS } from './http-hardening.ts';
import { isLocal, MEMORY, type Persistence } from './persistence.ts';
import { PostgresSalesRepository, PostgresChallanRepository, PostgresPreSaleRepository } from '../../../packages/sales/src/postgres-repository.ts';
import { PostgresAdvanceRepository, PostgresPaymentRepository } from '../../../packages/receivables/src/postgres-repository.ts';
import { PostgresReturnPreparations } from '../../../packages/gst-returns/src/postgres-repository.ts';
import { PostgresReminderRepository } from '../../../packages/collections/src/postgres-repository.ts';
import { PostgresBankFeedStore } from '../../../packages/bank-feeds/src/postgres-store.ts';
import { PostgresServiceInvoiceRepository, PostgresSubscriptionRepository, PostgresUsageRepository } from '../../../packages/subscriptions/src/postgres-repository.ts';
import type { SalesRepository } from '../../../packages/sales/src/ports.ts';
import type { PaymentRepository } from '../../../packages/receivables/src/ports.ts';
import type { ReturnNoteRepository } from '../../../packages/returns/src/ports.ts';
import type { ReturnPreparationRepository } from '../../../packages/gst-returns/src/ports.ts';
import type { TransactionalExecutor } from '../../../packages/platform/src/database.ts';
import type { OutboxHandler } from '../../../packages/platform/src/outbox.ts';

/** Issue #345 — the outbox topic of the automatic e-invoice that follows a bill. */
export const EINVOICE_TOPIC = 'einvoice.generate';
import {
  ActionAgentService,
  InMemoryAgentPlanStore,
  PostgresAgentPlanStore,
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
import { CompanyTrailAuditLog, PlatformCommandService } from '../../../packages/platform/src/index.ts';
import { PostgresAuditLog } from '../../../packages/platform/src/postgres-audit.ts';
import { PostgresCommandService } from '../../../packages/platform/src/postgres-platform.ts';
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
  InMemoryNotificationStore,
  NotificationService,
  NotificationTemplateRegistry,
  type Notification,
  type NotificationTransport,
  type Permission,
  type RequestContext,
} from '../../../packages/platform/src/index.ts';
import { PostgresNotificationStore } from '../../../packages/platform/src/postgres-notifications.ts';
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
import { readableDate, reportingDeadline } from '../../../packages/gst/src/reporting-window.ts';
import { decideApplicability } from '../../../packages/gst/src/applicability.ts';
import type { EInvoiceDocument, EInvoiceLine, PartyDetails } from '../../../packages/gst/src/payload.ts';
import { EXPORT_SUPPLIES, checkExportParticulars, exportSupplyKindFor, type ExportParticulars } from '../../../packages/gst/src/export-supply.ts';
import type {
  ConsignmentDocument, ConsignmentLine, EwayBillRecord, Movement, MovementParty, MovementReason, VehicleAssignment,
} from '../../../packages/transport/src/types.ts';
import { describeExpiry, describeTimeLeft } from '../../../packages/transport/src/validity.ts';
import { decideEwayApplicability } from '../../../packages/transport/src/applicability.ts';
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
  InMemoryReturnNoteRepository, ReturnService, isChargeLine, isGoodsReturn, purchaseReturnSource, returnInventoryAdapter, salesReturnSource, type ReturnNote, type SalesReturnSourcePort,
} from '../../../packages/returns/src/index.ts';
import { BANK_RETURN_PATH, BankFeedService, InMemoryBankFeedStore, SyntheticBankFeedProvider, type BankFeedConnection, type BankFeedContext } from '../../../packages/bank-feeds/src/index.ts';
import { itcInwardTaxPort } from '../../../packages/itc/src/adapters.ts';
import type { ItcWorkspace, ReconciliationLine } from '../../../packages/itc/src/types.ts';
import { ITC_PERMISSIONS, sumAmounts as sumItcAmounts, totalTaxOf as totalItcTaxOf } from '../../../packages/itc/src/types.ts';
import { sumAmounts as sumReturnAmounts } from '../../../packages/gst-returns/src/types.ts';
import { formatClaimDate } from '../../../packages/itc/src/deadline.ts';
import {
  GstReturnService, InMemoryReturnPreparations, ledgerBookTaxPort, ledgerInputBookTaxPort, ledgerInwardTaxPort,
  formatTaxPeriod, returnNoteToDocument, salesInvoiceToDocument, taxPeriod, taxPeriodOf, totalTaxOf,
  type OutwardDocument, type OutwardLine, type OutwardSupplyPort, type ReturnWorkspace, type TaxPeriod,
} from '@invoice/gst-returns';
import { standardRecurringJobs, type RecurringJobDefinition } from '../../../ops/operations/src/index.ts';
import { DurableMap, persist } from './durable.ts';
// Issue #297 — the four packages the audit found finished but unreachable, composed here for real:
// the compliance calendar behind Home's "Coming up" and the deadlines routes, the bank
// reconciliation behind the Reconcile tab, and the rate advisor behind the item form's hint.
import {
  BankReconciliationService, InMemoryReconciliationStore, fromBankTransaction, fromPayment,
  type BookPayment, type ReconciliationMatch, type ReconciliationRun, type ReconciliationStore,
} from '../../../packages/bank-reconciliation/src/index.ts';
import { PostgresReconciliationStore } from '../../../packages/bank-reconciliation/src/postgres-store.ts';
import {
  CALENDAR_PERMISSIONS, CatalogueDefinitions, ComplianceCalendarService,
  eInvoiceBacklogSignals, InMemoryAlerts, InMemoryComplianceExceptions, InMemoryOccurrences,
  purchaseMismatchSignals, returnReadinessSignals,
  type CompanyProfilePort, type EInvoiceBacklogReader, type ReturnReadinessReader, type UnresolvedPurchaseReader,
} from '../../../packages/compliance-calendar/src/index.ts';
import { PostgresAlerts, PostgresComplianceExceptions, PostgresOccurrences } from '../../../packages/compliance-calendar/src/postgres.ts';
import { mastersLearning, mastersRegistry, RateAdvisorService, type TaxDefaultRegistryPort } from '../../../packages/rate-advisor/src/index.ts';
import { comingUpRows } from './home-application.ts';

/** Issue #233 — a GST return in one of these states has been approved (and perhaps filed); its month's bills are fixed. */
/** Issue #233 — the Returns screen's choice that credits a whole sales bill, charges included. */
const WHOLE_BILL = '__whole__';
/**
 * Issue #293 — a bill's service lines are services on a credit note too: never put back in a godown,
 * never told "goods will go back into stock". A bill is made as goods; the item list says which of
 * its lines are services.
 */
const servicesKeptOutOfStock = (source: SalesReturnSourcePort): SalesReturnSourcePort => ({
  async findSalesDocument(companyId, id) {
    const found = await source.findSalesDocument(companyId, id);
    if (found === null) return null;
    const services = new Set(catalogueItems(companyId).filter((item) => item.kind === 'service').map((item) => item.id));
    return { ...found, lines: found.lines.map((line) => (services.has(line.itemId) ? { ...line, supplyKind: 'SERVICES' as const, warehouseId: null } : line)) };
  },
});
/** Issue #293 — the Returns screen's "Price correction": a new price on a line, nothing coming back. */
const PRICE_CORRECTION = 'PRICE';
const LOCKED_RETURN_STATES: ReadonlySet<string> = new Set(['APPROVED', 'EXPORTED', 'SUBMITTING', 'FILED', 'SUBMISSION_FAILED']);
/** Issue #266 — a return in one of these states has left for the government; the words say how far. */
const SENT_RETURN_STATES: Readonly<Record<string, string>> = { EXPORTED: 'downloaded for filing', SUBMITTING: 'sent for filing', FILED: 'filed' };

const paise = (value: unknown): bigint => {
  const normalized = String(value ?? '').replace(/,/g, '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw invalid('API_AMOUNT_INVALID', 'Enter a valid amount greater than zero.');
  const [whole = '0', fraction = ''] = normalized.split('.');
  const result = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  if (result <= 0n) throw invalid('API_AMOUNT_INVALID', 'Enter a valid amount greater than zero.');
  return result;
};


// ------------------------------------------------------ issue #230: money received and money paid

/** A party's bills that still have something due, on the side this money settles. */
const openBillsOf = (documents: readonly DocumentPosition[], direction: 'RECEIPT' | 'PAYMENT'): DocumentPosition[] =>
  documents
    .filter((d) => d.document.side === (direction === 'RECEIPT' ? 'RECEIVABLE' : 'PAYABLE') && d.outstanding.minor > 0n)
    .sort((a, b) => a.document.date.localeCompare(b.document.date) || a.document.number.localeCompare(b.document.number));

/** The bills picked on the screen: a list, a JSON list, or the single bill older callers send. */
const billIdsOf = (input: Record<string, unknown>): string[] => {
  const raw = input.bills ?? input.invoices ?? input.invoice;
  if (raw === undefined || raw === null || raw === '') return [];
  if (Array.isArray(raw)) return raw.map(String).filter((id) => id !== '');
  const text = String(raw).trim();
  if (text.startsWith('[')) {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.map(String).filter((id) => id !== '') : [];
  }
  return [text];
};

/**
 * Issue #261 — the person's own click to pay a supplier before their bill. Only an explicit yes
 * counts; anything else, including nothing at all, is no.
 */
const chosenAsAdvance = (input: Record<string, unknown>): boolean =>
  input.advance === true || input.advance === 'yes' || input.advance === 'true';

/** The words on the choice, the same on the screen and in any refusal that points to it. */
const advanceChoiceLabel = (supplier: string) => ({ 'en-IN': `Record this as an advance to ${supplier}`, 'hi-IN': `इसे ${supplier} को अडवांस के रूप में दर्ज कीजिए` });

const advanceChoiceHelp = (supplier: string, openBills: number) => ({ 'en-IN': openBills === 0
  ? `You have no bill from ${supplier} yet. This money will be kept as an advance and taken off their next bill.`
  : `Whatever is not put against a bill ticked above will be kept as an advance and taken off ${supplier}'s next bill.`,
  'hi-IN': openBills === 0
  ? `${supplier} का अभी कोई बिल नहीं है। यह पैसा अडवांस के रूप में रखा जाएगा और उनके अगले बिल से घटा दिया जाएगा।`
  : `जो पैसा ऊपर टिक किए बिल पर नहीं लगेगा, वह अडवांस के रूप में रखा जाएगा और ${supplier} के अगले बिल से घटा दिया जाएगा।` });

/**
 * Issue #274 — a document number with its date, typed on Money paid: both or neither. `label` names
 * the pair in the refusal, the way the form names it.
 */
const typedReference = (numberValue: unknown, dateValue: unknown, label: string, code: string): DocumentReference | null => {
  const number = String(numberValue ?? '').trim();
  const dated = String(dateValue ?? '').trim();
  if (number === '' && dated === '') return null;
  if (number === '' || dated === '') throw invalid(code, `Enter both the ${label} number and its date, or leave both blank.`);
  if (number.length > 40) throw invalid(code, `The ${label} number is longer than 40 letters and digits. Check it and enter it again.`);
  return { number, date: isoDate(dated) };
};

/**
 * Issue #274 — what an advance to a supplier is paid against, from the Money paid form. A purchase
 * order (number and date) when there is one; otherwise the advance is against goods to be supplied.
 * The supplier's receipt voucher (CGST Act s.31(3)(d), CGST Rule 50) is theirs to issue, so it is
 * optional here and printed only when it was entered.
 */
const advanceParticularsOf = (input: Record<string, unknown>, paidOn: IsoDate): AdvanceParticulars => {
  const purchaseOrder = typedReference(input.purchaseOrderNumber, input.purchaseOrderDate, 'purchase order', 'ADVANCE_PURCHASE_ORDER_INCOMPLETE');
  if (purchaseOrder !== null && purchaseOrder.date > paidOn) {
    throw invalid('ADVANCE_PURCHASE_ORDER_AFTER_PAYMENT', `The purchase order is dated ${formatDate(purchaseOrder.date)}, after this payment on ${formatDate(paidOn)}. An advance against it is paid on or after the order's date. Check both dates.`);
  }
  const supplierReceiptVoucher = typedReference(input.supplierReceiptNumber, input.supplierReceiptDate, "supplier's receipt voucher", 'ADVANCE_RECEIPT_VOUCHER_INCOMPLETE');
  if (supplierReceiptVoucher !== null && supplierReceiptVoucher.date < paidOn) {
    throw invalid('ADVANCE_RECEIPT_VOUCHER_BEFORE_PAYMENT', `The supplier's receipt voucher is dated ${formatDate(supplierReceiptVoucher.date)}, before this payment on ${formatDate(paidOn)}. They issue it when they receive the money, so it cannot be earlier. Check both dates.`);
  }
  return { purchaseOrder, supplierReceiptVoucher };
};

/** Issue #274 — "purchase order no. PO-17 dated 25 Sep 2026", or "goods to be supplied" without one. */
const advanceAgainstWords = (particulars: AdvanceParticulars | undefined): string =>
  particulars?.purchaseOrder
    ? `purchase order no. ${particulars.purchaseOrder.number} dated ${formatDate(particulars.purchaseOrder.date)}`
    : 'goods to be supplied';

/**
 * Issue #274 — the narration of a payment voucher that pays an advance, in the standard form an
 * Indian accounts book uses: "Being advance paid to … against …". Nothing else is said.
 */
const advanceNarration = (input: {
  readonly party: string; readonly particulars: AdvanceParticulars | undefined;
  readonly how: string; readonly reference: string | null; readonly bills: readonly string[];
}): string => {
  const how = `by ${input.how}${input.reference === null ? '' : `, ref. ${input.reference}`}`;
  const against = advanceAgainstWords(input.particulars);
  return input.bills.length === 0
    ? `Being advance paid to ${input.party} against ${against}, ${how}.`
    : `Being payment made to ${input.party} against bill no. ${input.bills.join(', ')}, and advance paid against ${against}, ${how}.`;
};

/**
 * One entry on the screen is one payment, however many times Record is pressed. The screen sends a
 * fresh entry number for each new payment; a caller without one uses the bank's reference.
 */
const paymentKeyOf = (input: Record<string, unknown>): string => {
  const direction = String(input.direction ?? 'RECEIPT').trim().toUpperCase();
  const request = String(input.requestId ?? '').trim() || String(input.reference ?? '').trim();
  if (request === '') {
    throw invalid('PAYMENT_REQUEST_ID_REQUIRED', 'This payment has no entry number, so a second press could record it twice. Reload the page and enter it again.');
  }
  return `web-payment:${direction}:${request}`;
};

/**
 * Issue #392 — the key a screen sends for one bill, return or answer, so a retry is recognised. It is
 * never invented here and never taken from what the shopkeeper typed: an invented key turns a retry
 * into a second document, and a typed reference can belong to two real sales.
 */
const requestKeyOf = (input: Record<string, unknown>, code: string, what: string): string => {
  const request = String(input.requestId ?? '').trim();
  if (request === '') throw invalid(code, `This ${what} has no entry number, so a second press could record it twice. Reload the page and enter it again.`);
  return request;
};

// Money by UPI or bank transfer goes into, or comes out of, the business's current account.
const CURRENT_ACCOUNT = '1121';

/**
 * How the money moved, exactly as it was chosen. Nothing defaults to cash: a payment recorded as
 * cash that came by bank puts money in the drawer that is really in the bank.
 */
const paymentHow = (direction: 'RECEIPT' | 'PAYMENT', input: Record<string, unknown>): {
  mode: PaymentMode; bankAccountCode: string | null; words: { 'en-IN': string; 'hi-IN': string };
  cheque?: { number: string; chequeDate: IsoDate };
} => {
  const chosen = String(input.method ?? input.mode ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (chosen === '') throw invalid('PAYMENT_MODE_REQUIRED', 'Choose how the money was paid: UPI, cash, bank transfer or cheque.');
  if (chosen === 'CASH') return { mode: 'CASH', bankAccountCode: null, words: { 'en-IN': 'cash', 'hi-IN': 'नक़द' } };
  if (chosen === 'UPI') return { mode: 'UPI', bankAccountCode: CURRENT_ACCOUNT, words: { 'en-IN': 'UPI', 'hi-IN': 'UPI' } };
  if (chosen === 'BANK_TRANSFER') return { mode: 'BANK_TRANSFER', bankAccountCode: CURRENT_ACCOUNT, words: { 'en-IN': 'bank transfer', 'hi-IN': 'बैंक' } };
  if (chosen === 'CHEQUE') {
    const number = String(input.chequeNumber ?? '').trim();
    const dated = String(input.chequeDate ?? '').trim();
    if (number === '' || dated === '') throw invalid('PAYMENT_CHEQUE_DETAILS_REQUIRED', 'Enter the cheque number and the date written on the cheque.');
    const chequeDate = isoDate(dated);
    // A cheque received waits in "cheques in hand" until it clears; a cheque given is drawn on our bank.
    return { mode: 'CHEQUE', bankAccountCode: direction === 'PAYMENT' ? CURRENT_ACCOUNT : null, words: { 'en-IN': `cheque No. ${number} dated ${chequeDate}`, 'hi-IN': `चेक नं. ${number} दिनांक ${chequeDate}` }, cheque: { number, chequeDate } };
  }
  throw invalid('PAYMENT_MODE_INVALID', 'Choose how the money was paid: UPI, cash, bank transfer or cheque.');
};

const BALANCE_WILL_INCREASE = { 'en-IN': 'The customer balance will increase.', 'hi-IN': 'ग्राहक का बाक़ी बढ़ेगा।' };

/** Issue #288 — CGST Rule 46(e): from this taxable value an unregistered buyer must be named on the bill. */
const WALK_IN_LIMIT = 50_000_00n;

/**
 * Issue #288 — "Paid now": how the customer paid at the counter, and how much, when the bill is
 * recorded together with its receipt. `null` when the sale does not say (money to come later).
 * Nothing defaults to cash; an amount left out is the whole bill.
 */
const PAID_NOW: Readonly<Record<string, { mode: PaymentMode; bankAccountCode: string | null; words: { 'en-IN': string; 'hi-IN': string } }>> = {
  CASH: { mode: 'CASH', bankAccountCode: null, words: { 'en-IN': 'cash', 'hi-IN': 'नक़द' } },
  UPI: { mode: 'UPI', bankAccountCode: CURRENT_ACCOUNT, words: { 'en-IN': 'UPI', 'hi-IN': 'UPI' } },
  CARD: { mode: 'CARD', bankAccountCode: CURRENT_ACCOUNT, words: { 'en-IN': 'card', 'hi-IN': 'कार्ड' } },
};
type PaidNow = (typeof PAID_NOW)[string] & { readonly amount: bigint | null };
const paidNowOf = (input: Record<string, unknown>): PaidNow | null => {
  const chosen = String(input.paidBy ?? '').trim().toUpperCase();
  if (chosen === '') return null;
  const how = PAID_NOW[chosen];
  if (how === undefined) throw invalid('SALE_PAID_BY_INVALID', 'Say how the customer paid at the counter: cash, UPI or card.');
  return { ...how, amount: String(input.paidAmount ?? '').trim() === '' ? null : paise(input.paidAmount) };
};

/**
 * Issue #295 — the income-tax section a customer deducted tax under. Sections 192–194T of the
 * Income-tax Act 1961 read like "194C"/"194IA"; from 1 April 2026 the Income-tax Act 2025 carries
 * the same deductions under s.392 (salary) and s.393 (other payments, tables 1–3). Three digits
 * plus up to two letters covers both Acts' numbering.
 */
const TDS_SECTION = /^[0-9]{3}[A-Z]{0,2}$/;

/** The TDS sections the screen offers: the ones a shopkeeper's customer most often deducts. */
export const TDS_SECTIONS = ['194C', '194H', '194I', '194J', '194Q', '194A'] as const;

/**
 * Issue #295 — the quarter a TDS deduction counts in, as a Form 26AS lists them: an Indian
 * financial year's Q1 is April–June. "Q2-2026-27" is what the report and the voucher print.
 */
export const tdsQuarterOf = (date: string): string => {
  const month = Number(date.slice(5, 7));
  const year = Number(date.slice(0, 4));
  const fyStart = month >= 4 ? year : year - 1;
  const quarter = month >= 4 ? Math.floor((month - 4) / 3) + 1 : 4;
  return `Q${quarter}-${fyStart}-${String(fyStart + 1).slice(2)}`;
};

export interface PaymentSettlementPlan {
  /** Settlement rows passed to `payments.recordPayment` (TDS, discount-as-expense, write-off). */
  readonly settlements: BillSettlement[];
  /** Discounts chosen as GST credit notes — issued through returns before the payment is recorded. */
  readonly creditNotes: readonly {
    readonly position: DocumentPosition;
    readonly declared: bigint;
    /** The amount the note will actually credit (±1–2 paise of rounding), used for cash planning. */
    readonly noteTotal: bigint;
    readonly evidence: { agreedBeforeSupply: boolean; buyerReversedItc: boolean };
  }[];
}

/**
 * Issue #295 — reads the "how else this bill was settled" entries the Money received form sends:
 * one entry per bill, any of TDS deducted, discount allowed or a small write-off. A discount may
 * instead be a GST credit note (CGST Act s.34 via s.15(3)(b)); that is not a settlement row here
 * but a real note, listed in `creditNotes` for the app to issue.
 */
const paymentSettlementsOf = (input: Record<string, unknown>, direction: 'RECEIPT' | 'PAYMENT', open: readonly DocumentPosition[], date: string): PaymentSettlementPlan => {
  const raw = input.settlements;
  if (raw === undefined || raw === null || raw === '' || raw === '[]') return { settlements: [], creditNotes: [] };
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw invalid('PAYMENT_SETTLEMENTS_INVALID', 'The adjustments on this payment could not be read. Reload the page and enter them again.');
  }
  if (!Array.isArray(parsed)) throw invalid('PAYMENT_SETTLEMENTS_INVALID', 'The adjustments on this payment could not be read. Reload the page and enter them again.');
  if (direction !== 'RECEIPT' && parsed.length > 0) {
    throw invalid('SETTLEMENT_ON_MONEY_PAID', 'TDS, a discount or a write-off settles a bill on money received, never on money paid out.');
  }
  const settlements: BillSettlement[] = [];
  const creditNotes: PaymentSettlementPlan['creditNotes'][number][] = [];
  for (const entry of parsed) {
    const item = (entry ?? {}) as Record<string, unknown>;
    const billId = String(item.bill ?? '').trim();
    const position = open.find((d) => d.document.documentId === billId);
    if (position === undefined) {
      throw invalid('SETTLEMENT_BILL_NOT_THEIRS', 'An adjustment names a bill that is not open for this customer. Open the payment again and check the bills ticked.');
    }
    const number = position.document.number;
    const tds = (item.tds ?? null) as Record<string, unknown> | null;
    if (tds !== null) {
      const amount = paise(tds.amount);
      const section = String(tds.section ?? '').trim().toUpperCase();
      if (section !== '' && !TDS_SECTION.test(section)) {
        throw invalid('TDS_SECTION_INVALID', `The TDS section on ${number} should look like 194C, 194J or 194Q. Check the customer's certificate.`);
      }
      const quarter = String(tds.quarter ?? '').trim() || tdsQuarterOf(date);
      const certificate = String(tds.certificate ?? '').trim() || null;
      settlements.push({
        documentId: position.document.documentId, documentNumber: number, kind: 'TDS_DEDUCTED', amount: money(amount),
        tdsSection: section, tdsQuarter: quarter, tdsCertificate: certificate,
      });
    }
    const discount = (item.discount ?? null) as Record<string, unknown> | null;
    if (discount !== null) {
      const declared = paise(discount.amount);
      if (discount.creditNote === true || discount.creditNote === 'yes' || discount.creditNote === 'true') {
        const agreedBeforeSupply = discount.agreedBeforeSupply === true || discount.agreedBeforeSupply === 'yes' || discount.agreedBeforeSupply === 'true';
        const buyerReversedItc = discount.buyerReversedItc === true || discount.buyerReversedItc === 'yes' || discount.buyerReversedItc === 'true';
        if (!agreedBeforeSupply || !buyerReversedItc) {
          throw invalid('DISCOUNT_EVIDENCE_REQUIRED', `A GST credit note for the discount on ${number} needs both answers: the discount was agreed at or before the sale, and the customer has given back their GST credit on it. Without them, book the discount as an expense instead.`);
        }
        creditNotes.push({ position, declared, noteTotal: declared, evidence: { agreedBeforeSupply, buyerReversedItc } });
      } else {
        settlements.push({ documentId: position.document.documentId, documentNumber: number, kind: 'DISCOUNT_ALLOWED', amount: money(declared) });
      }
    }
    const writeOff = (item.writeOff ?? null) as Record<string, unknown> | null;
    if (writeOff !== null) {
      settlements.push({ documentId: position.document.documentId, documentNumber: number, kind: 'BALANCE_WRITTEN_OFF', amount: money(paise(writeOff.amount)) });
    }
  }
  return { settlements, creditNotes };
};

/**
 * Issue #295 — the TDS receivable report's rows: quarter, then customer, one line per deduction.
 * `nameOf` resolves the party as the app's own screens name them.
 */
const tdsRows = (
  entries: readonly { payment: Payment; settlement: BillSettlement }[],
  nameOf: (partyId: string) => string,
): { quarter: string; customer: string; bill: string; section: string | null; date: string; certificate: string | null; amount: number }[] =>
  entries
    .map(({ payment, settlement }) => ({
      quarter: settlement.tdsQuarter ?? tdsQuarterOf(payment.date),
      customer: nameOf(payment.partyId),
      bill: settlement.documentNumber,
      section: settlement.tdsSection ?? null,
      date: payment.date,
      certificate: settlement.tdsCertificate ?? null,
      amount: jsonAmount(settlement.amount.minor),
    }))
    .sort((a, b) => a.quarter.localeCompare(b.quarter) || a.customer.localeCompare(b.customer) || a.date.localeCompare(b.date));

const modeWords = (payment: Payment): string => {
  switch (payment.mode) {
    case 'CASH': return 'Cash';
    case 'UPI': return 'UPI';
    case 'BANK_TRANSFER': return 'Bank transfer';
    case 'CHEQUE': return `Cheque No. ${payment.cheque?.number ?? ''} dated ${payment.cheque?.chequeDate ?? ''}`;
    case 'CARD': return 'Card';
    default: return 'Other';
  }
};

/**
 * A receipt for money received, or a payment voucher for money paid: who, how much in figures and
 * in words, how it was paid, and which bills it settled. Only facts from the books are printed.
 *
 * Issue #274 — a payment voucher that pays an advance to a supplier carries the standard fields of
 * an advance payment and nothing invented: what it is against (the purchase order, or goods to be
 * supplied), the supplier's receipt voucher when entered, the narration "Being advance paid to …
 * against …", and, once the advance has been adjusted against their bill, the bill it was adjusted
 * against. It is our own accounts voucher. Issue #289, part 2b — when the payment pays a
 * reverse-charge bill, the voucher also carries CGST Rule 52's particulars for it, so it is the
 * payment voucher s.31(3)(g) requires at the time of payment.
 */
const paymentVoucherHtml = (input: {
  readonly payment: Payment;
  readonly number: string;
  readonly seller: RenderableParty;
  readonly party: RenderableParty;
  readonly bills: readonly { number: string; date: string | null; total: bigint | null; settled: bigint; adjusted: boolean }[];
  /** Issue #295 — TDS deducted, discount allowed or a balance written off on the bills. */
  readonly adjustments?: readonly { bill: string; kind: BillSettlement['kind']; amount: bigint; section: string | null; quarter: string | null; certificate: string | null }[];
  /** Issue #295 — the s.34 credit notes issued on the bills this receipt settled. */
  readonly creditNotes?: readonly { bill: string; number: string }[];
  /**
   * Issue #289, part 2b — the reverse-charge bills this payment pays. When there are any, this is
   * also the payment voucher of CGST s.31(3)(g), and carries Rule 52's particulars for them:
   * (e) description, (g) rate, (h) tax payable, (i) place of supply for an inter-State supply, and
   * (j) the supplier's signature. (a)-(d) and (f) are the voucher's own fields above.
   */
  readonly reverseCharge?: readonly { readonly bill: string; readonly interState: boolean; readonly placeOfSupply: string; readonly lines: readonly ReverseChargeLine[] }[];
}): string => {
  const { payment, seller, party } = input;
  const rcm = input.reverseCharge ?? [];
  // Rule 52(b): at most sixteen characters, unique for the financial year. The books' own number
  // ("PAYMENT/2026-27/000001", 22 characters) is too long, so a reverse-charge voucher shows the same
  // sequence in a short form ("PV/2627/000001") and names the books' number beside it.
  const short = rcm.length === 0 ? null : rule52VoucherNumber(input.number);
  const number = short ?? input.number;
  const receipt = payment.direction === 'RECEIPT';
  const advance = payment.advanceToSupplier === true;
  // Bills paid by this payment when it was made, and bills a later bill's entry adjusted the advance against.
  const bills = input.bills.filter((bill) => !bill.adjusted);
  const adjusted = input.bills.filter((bill) => bill.adjusted);
  const settled = bills.reduce((total, bill) => total + bill.settled, 0n);
  const onAccount = payment.amount.minor - settled;
  const adjustedTotal = adjusted.reduce((total, bill) => total + bill.settled, 0n);
  const printDate = (value: string | null) => (value === null || value === '' ? '' : formatDate(isoDate(value)));
  const block = (title: string, who: RenderableParty) =>
    `<td><strong>${escapeHtml(title)}</strong><br>${escapeHtml(who.name)}${who.addressLines.map((line) => `<br>${escapeHtml(line)}`).join('')}${who.gstin === null ? '' : `<br>GSTIN: ${escapeHtml(who.gstin)}`}${who.stateCode === '' ? '' : `<br>State: ${escapeHtml(who.stateName)} (${escapeHtml(who.stateCode)})`}</td>`;
  const particulars = payment.advanceParticulars;
  const facts: [string, string][] = [
    [receipt ? 'Receipt number' : 'Voucher number', number],
    ...(short !== null && short !== input.number ? [['Books voucher', input.number] as [string, string]] : []),
    ['Date', printDate(payment.date)],
    [receipt ? 'Received from' : 'Paid to', party.name],
    ['Amount', formatPaise(payment.amount.minor)],
    ['Amount in words', amountInWords(payment.amount)],
    ['Mode of payment', modeWords(payment)],
    ...(payment.reference === null ? [] : [['Reference', payment.reference] as [string, string]]),
    ...(advance && bills.length > 0 ? [['Advance', formatPaise(onAccount)] as [string, string]] : []),
    ...(advance ? [['Against', advanceAgainstWords(particulars).replace(/^./, (c) => c.toUpperCase())] as [string, string]] : []),
    ...(advance && particulars?.supplierReceiptVoucher
      ? [["Supplier's receipt voucher", `No. ${particulars.supplierReceiptVoucher.number} dated ${formatDate(particulars.supplierReceiptVoucher.date)}`] as [string, string]]
      : []),
  ];
  const billRow = (bill: { number: string; date: string | null; total: bigint | null; settled: bigint }) =>
    `<tr><td>${escapeHtml(bill.number)}</td><td>${escapeHtml(printDate(bill.date))}</td><td>${bill.total === null ? '' : formatPaise(bill.total)}</td><td>${formatPaise(bill.settled)}</td></tr>`;
  const billTable = advance
    ? bills.length === 0 ? '' : `<table><tr><th>Bill</th><th>Bill date</th><th>Bill amount</th><th>Settled by this payment</th></tr>${bills.map(billRow).join('')}</table>`
    : `<table><tr><th>Bill</th><th>Bill date</th><th>Bill amount</th><th>Settled by this payment</th></tr>${bills.length === 0 ? '<tr><td colspan="4">Not put against any bill.</td></tr>' : bills.map(billRow).join('')}</table>`;
  // Issue #295 — the adjustments this receipt settled bills by: TDS the customer kept (a
  // receivable from the government, matched with Form 26AS), a discount, a write-off, and the
  // credit note issued for a discount chosen the s.34 way.
  const adjustments = input.adjustments ?? [];
  const adjustmentWords = (item: NonNullable<typeof input.adjustments>[number]): string =>
    item.kind === 'TDS_DEDUCTED'
      ? `TDS deducted by the customer under s.${item.section}${item.quarter === null ? '' : ` (${item.quarter})`}${item.certificate === null ? '' : `, certificate ${item.certificate}`}`
      : item.kind === 'DISCOUNT_ALLOWED'
        ? 'Discount allowed'
        : 'Balance written off';
  const adjustmentTable = adjustments.length === 0 ? '' : `<table><tr><th>Bill</th><th>Settled without money</th><th>Amount</th></tr>
${adjustments.map((item) => `<tr><td>${escapeHtml(item.bill)}</td><td>${escapeHtml(adjustmentWords(item))}</td><td>${formatPaise(item.amount)}</td></tr>`).join('')}</table>`;
  const creditNotesPrinted = input.creditNotes ?? [];
  const creditNoteTable = creditNotesPrinted.length === 0 ? '' : `<table><tr><th>Bill</th><th>Credit note issued for the discount</th></tr>
${creditNotesPrinted.map((item) => `<tr><td>${escapeHtml(item.bill)}</td><td>${escapeHtml(item.number)}</td></tr>`).join('')}</table>`;
  const adjustedTable = !advance || adjusted.length === 0 ? '' : `<table><tr><th>Adjusted against bill</th><th>Bill date</th><th>Bill amount</th><th>Amount adjusted</th></tr>${adjusted.map(billRow).join('')}</table>
<p>Unadjusted advance: ${formatPaise(onAccount - adjustedTotal)}</p>`;
  const narration = advance
    ? `<p><strong>Narration:</strong> ${escapeHtml(advanceNarration({
      party: party.name, particulars, how: modeWords(payment).replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase()), reference: payment.reference, bills: bills.map((bill) => bill.number),
    }))}</p>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(number)}</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;color:#111}table{width:100%;border-collapse:collapse;margin:12px 0}td,th{border:1px solid #999;padding:6px;text-align:left;vertical-align:top}h1{font-size:20px;margin:0}</style></head><body>
<h1>${receipt ? 'Receipt' : 'PAYMENT VOUCHER'}</h1>
<table><tr>${block(receipt ? 'Received by' : 'Paid by', seller)}${block(receipt ? 'Received from' : 'Paid to', party)}</tr></table>
<table>${facts.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('')}</table>
${billTable}
${adjustmentTable}
${creditNoteTable}
${adjustedTable}
${!advance && onAccount > 0n ? `<p>On account, not yet put against a bill: ${formatPaise(onAccount)}</p>` : ''}
${narration}
${rcm.length === 0 ? '' : `<h2 style="font-size:16px">Supplies on which tax is payable on reverse charge</h2>
<p><small>Payment voucher under CGST section 31(3)(g) and Rule 52: the tax below is paid by ${escapeHtml(seller.name)}, the recipient, not by ${escapeHtml(party.name)}.</small></p>
<table><tr><th>Bill</th><th>Description</th><th>HSN/SAC</th><th>Taxable value</th><th>Rate</th><th>Tax payable</th>${rcm.some((bill) => bill.interState) ? '<th>Place of supply</th>' : ''}</tr>
${rcm.flatMap((bill) => bill.lines.map((line) => {
    const heads = bill.interState
      ? `IGST ${line.gstRateBasisPoints / 100}%`
      : `CGST ${line.gstRateBasisPoints / 200}% + SGST ${line.gstRateBasisPoints / 200}%`;
    const tax = bill.interState ? formatPaise(line.igstPaise) : `${formatPaise(line.cgstPaise)} + ${formatPaise(line.sgstPaise)}`;
    return `<tr><td>${escapeHtml(bill.bill)}</td><td>${escapeHtml(line.description)}</td><td>${escapeHtml(line.hsnSac)}</td><td>${formatPaise(line.taxableValuePaise)}</td><td>${heads}</td><td>${tax}</td>${rcm.some((other) => other.interState) ? `<td>${bill.interState ? escapeHtml(bill.placeOfSupply) : ''}</td>` : ''}</tr>`;
  })).join('')}</table>
<p style="margin-top:36px">Signature of the supplier or authorised representative: ____________________</p>`}
<p style="margin-top:48px;text-align:right">For ${escapeHtml(seller.name)}<br><br>Authorised signatory</p></body></html>`;
};

/**
 * Issue #289, part 2b — a books voucher number ("PAYMENT/2026-27/000001") in the short form CGST
 * Rule 52(b) allows: at most sixteen characters of letters, digits, hyphen and slash, unique for the
 * financial year. The sequence is the books' own, which is unique for the year, so the short form is
 * too. `null` when the number is not in the books' form, so nothing is invented for it.
 */
export const rule52VoucherNumber = (number: string): string | null => {
  const parts = /^[A-Z_]+\/(\d{2})(\d{2})-(\d{2})\/(\d+)$/.exec(number);
  if (parts === null) return /^[A-Za-z0-9/-]{1,16}$/.test(number) ? number : null;
  const short = `PV/${parts[2]}${parts[3]}/${parts[4]}`;
  return short.length <= 16 ? short : null;
};

/**
 * Issue #289, part 2b — the self-invoice: the tax invoice a registered buyer issues for a purchase
 * from a supplier who is not registered, on which the buyer pays the GST (CGST s.31(3)(f), within
 * 30 days — Rule 47A). It carries the particulars of CGST Rule 46 that apply to it, each from the
 * register, nothing invented: (a) the supplier's name and address (and GSTIN only if it has one),
 * (b) the number, (c) the date, (d) our name, address and GSTIN, (g) HSN/SAC, (h) description,
 * (i) quantity and unit, (j)/(k) value and taxable value, (l) rate, (m) tax by head, (n) place of
 * supply with the State, (p) that the tax is payable on reverse charge, and (q) a signature line.
 */
const selfInvoiceHtml = (invoice: SelfInvoice, bill: { number: string; date: string }): string => {
  const party = (title: string, who: RegisterParty) =>
    `<td><strong>${escapeHtml(title)}</strong><br>${escapeHtml(who.name)}${who.addressLines.map((line) => `<br>${escapeHtml(line)}`).join('')}<br>GSTIN: ${who.gstin === null ? 'Not registered' : escapeHtml(who.gstin)}${who.stateCode === '' ? '' : `<br>State: ${escapeHtml(who.stateName)} (${escapeHtml(who.stateCode)})`}</td>`;
  const heads = invoice.interState ? ['IGST'] : ['CGST', 'SGST'];
  const row = (line: SelfInvoice['lines'][number]) => {
    const rate = line.gstRateBasisPoints / 100;
    const taxCells = invoice.interState
      ? `<td>${rate}%</td><td>${formatPaise(line.igstPaise)}</td>`
      : `<td>${rate / 2}%</td><td>${formatPaise(line.cgstPaise)}</td><td>${rate / 2}%</td><td>${formatPaise(line.sgstPaise)}</td>`;
    return `<tr><td>${line.lineNumber}</td><td>${escapeHtml(line.description)}</td><td>${escapeHtml(line.hsnSac)}</td><td>${escapeHtml(line.quantity)}</td><td>${formatPaise(line.taxableValuePaise)}</td>${taxCells}</tr>`;
  };
  const tax = invoice.cgstPaise + invoice.sgstPaise + invoice.igstPaise + invoice.cessPaise;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(invoice.number)}</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;color:#111}table{width:100%;border-collapse:collapse;margin:12px 0}td,th{border:1px solid #999;padding:6px;text-align:left;vertical-align:top}h1{font-size:20px;margin:0}small{color:#444}</style></head><body>
<h1>TAX INVOICE</h1>
<p><small>Issued by the recipient for a supply received from a supplier who is not registered (CGST section 31(3)(f), Rule 47A).</small></p>
<table><tr>${party('Supplier', invoice.supplier)}${party('Recipient (issuer of this invoice)', invoice.recipient)}</tr></table>
<table>
<tr><th>Invoice number</th><td>${escapeHtml(invoice.number)}</td></tr>
<tr><th>Invoice date</th><td>${escapeHtml(formatDate(invoice.issuedOn))}</td></tr>
<tr><th>Date of receipt of the supply</th><td>${escapeHtml(formatDate(invoice.receivedOn))}</td></tr>
<tr><th>Supplier's document</th><td>${escapeHtml(bill.number)} dated ${escapeHtml(formatDate(isoDate(bill.date)))}</td></tr>
<tr><th>Place of supply</th><td>${escapeHtml(invoice.placeOfSupply.stateName)} (${escapeHtml(invoice.placeOfSupply.stateCode)})</td></tr>
<tr><th>Whether tax is payable on reverse charge</th><td>Yes</td></tr>
</table>
<table><tr><th>#</th><th>Description</th><th>HSN/SAC</th><th>Quantity</th><th>Taxable value</th>${heads.map((head) => `<th>${head} rate</th><th>${head}</th>`).join('')}</tr>
${invoice.lines.map(row).join('')}
<tr><th colspan="4">Total</th><th>${formatPaise(invoice.taxableValuePaise)}</th>${invoice.interState ? `<th></th><th>${formatPaise(invoice.igstPaise)}</th>` : `<th></th><th>${formatPaise(invoice.cgstPaise)}</th><th></th><th>${formatPaise(invoice.sgstPaise)}</th>`}</tr></table>
<p>Total value of supply: ${formatPaise(invoice.taxableValuePaise)}. Tax payable by the recipient on reverse charge: ${formatPaise(tax)} (${amountInWords(money(tax))}).</p>
<p style="margin-top:48px;text-align:right">For ${escapeHtml(invoice.recipient.name)}<br><br>Authorised signatory</p></body></html>`;
};

/** An optional amount on a sale: blank and zero both mean no charge. */
const optionalMoney = (value: unknown) => {
  const normalized = String(value ?? '').replace(/,/g, '').trim();
  if (normalized === '') return undefined;
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw invalid('API_AMOUNT_INVALID', 'Enter a valid amount, or leave it blank.');
  const [whole = '0', fraction = ''] = normalized.split('.');
  return money(BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2)));
};

const daysAfter = (date: string, days: number): string => {
  const result = new Date(`${date}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
};

const jsonAmount = (minor: bigint): number => Number(minor) / 100;

/**
 * Issue #293 — a sale line's discount, typed as rupees off the line (`discount`) or as a percentage
 * (`discountPercent`). CGST Act 2017 s.15(3)(a) (in force 1 July 2017): a discount given before or
 * at the time of supply and recorded on the invoice is not part of the value GST is charged on, so
 * the calculator takes it off before tax and the bill prints it in its Discount column.
 */
const lineDiscountOf = (row: Record<string, unknown>, gross: bigint): Discount | undefined => {
  const amountText = String(row.discount ?? '').replace(/,/g, '').trim();
  const percentText = String(row.discountPercent ?? '').trim();
  const amount = optionalMoney(amountText);
  if (percentText !== '' && !/^\d+(?:\.\d{1,2})?$/.test(percentText)) {
    throw invalid('SALE_DISCOUNT_PERCENT_INVALID', 'Type the discount as a percentage, like 5 or 7.5.');
  }
  const [whole = '0', fraction = ''] = percentText.split('.');
  const percent = percentText === '' ? 0n : BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  if (amount !== undefined && amount.minor > 0n && percent > 0n) {
    throw invalid('SALE_DISCOUNT_TWICE', 'Give the discount either in rupees or as a percentage, not both.');
  }
  if (percent > 10000n) throw invalid('SALE_DISCOUNT_TOO_LARGE', 'A discount cannot be more than 100%.');
  if (percent > 0n) return { kind: 'PERCENT', percentTimes100: percent };
  if (amount === undefined || amount.minor === 0n) return undefined;
  if (amount.minor > gross) {
    throw invalid('SALE_DISCOUNT_TOO_LARGE', `The discount (${formatPaise(amount.minor)}) is more than the line is worth (${formatPaise(gross)}).`);
  }
  return { kind: 'AMOUNT', amount };
};

/**
 * Issue #293 — a discount on the whole bill (`billDiscount`, in rupees), shared over the item lines
 * in proportion to what each is worth after its own discount, so each line's GST is worked on its
 * own reduced value (s.15(3)(a)). The last line takes the paise left over, so the shares add up.
 */
const withBillDiscount = <L extends { readonly quantity: { readonly scaled: bigint }; readonly unitPrice: { readonly minor: bigint }; readonly discount?: Discount }>(
  lines: readonly L[], billDiscount: unknown,
): L[] => {
  const off = optionalMoney(billDiscount);
  if (off === undefined || off.minor === 0n) return [...lines];
  const worth = lines.map((line) => {
    const gross = mulDiv(money(line.unitPrice.minor), line.quantity.scaled, 1_000_000n).minor;
    const own = line.discount === undefined ? 0n
      : line.discount.kind === 'AMOUNT' ? line.discount.amount.minor : mulDiv(money(gross), line.discount.percentTimes100, 10000n).minor;
    return { gross, own, net: gross - own };
  });
  const total = worth.reduce((sum, line) => sum + line.net, 0n);
  if (off.minor > total) {
    throw invalid('SALE_BILL_DISCOUNT_TOO_LARGE', `The items come to ${formatPaise(total)} before GST, so the discount on the bill cannot be more than that.`);
  }
  let left = off.minor;
  return lines.map((line, index) => {
    const facts = worth[index]!;
    const share = index === lines.length - 1 ? left : (off.minor * facts.net) / total;
    left -= share;
    const amount = facts.own + share;
    return amount === 0n ? line : { ...line, discount: { kind: 'AMOUNT' as const, amount: money(amount) } };
  });
};

/** Issue #306 — something that would stop a bill, said in both languages, as the live total carries it. */
interface Refusal {
  readonly code: string;
  readonly lineId?: string;
  readonly itemId?: string | undefined;
  readonly 'en-IN': string;
  readonly 'hi-IN': string;
}

/**
 * Issue #231 — a bill's lines as the e-way bill lists them. Freight and other charges are part of the
 * value of the goods they travel with, so each goods item carries its share (the same share the
 * printed HSN summary and GSTR-1 use) and no item is left without a goods code. State and
 * union-territory tax go in the one column the portal has for both.
 */
const consignmentLinesOf = (lines: readonly ComputedTaxLine[]): ConsignmentLine[] =>
  foldChargesIntoGoods(lines).map((item) => ({
    description: item.line.itemName,
    hsnCode: item.line.hsnOrSac ?? '',
    quantity: (Number(item.line.quantity.scaled) / 1_000_000).toString(),
    unit: item.line.quantity.unit,
    taxableValuePaise: item.taxableValue.minor,
    cgstPaise: item.cgst.minor,
    sgstPaise: item.sgst.minor + item.utgst.minor,
    igstPaise: item.igst.minor,
    cessPaise: item.cess.minor,
  }));


/** Micro-units as the plain decimal a person typed: 500000000n is "500". */
const plainQuantity = (scaled: bigint): string => {
  const whole = scaled / 1_000_000n;
  const fraction = (scaled % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`;
};

/** The Indian financial year a date falls in, by the year it starts: 27 Sep 2026 is in 2026. */
const financialYearOf = (date: string): number => {
  const year = Number(date.slice(0, 4));
  return Number(date.slice(5, 7)) >= 4 ? year : year - 1;
};

/** An address as typed: one line per row, blank rows dropped. Nothing is invented for it. */
const addressLines = (value: unknown): readonly string[] =>
  String(value ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');

const party = (stateCode: string, name: string, gstin: string, addressLines_: readonly string[]): RenderableParty => ({
  name, addressLines: addressLines_, gstin, stateCode, stateName: STATE_NAMES[stateCode] ?? stateCode,
});

/**
 * The slice of master data the stock report needs to name things. Item and warehouse names come
 * from `namesFrom` in the report service; this only has to satisfy the interface and supply a unit
 * registry, so it returns the ids and lets the names layer do the naming.
 */
const demoStockMasterData = (godowns: Pick<StockMasterData, 'warehouse'>): StockMasterData => {
  const registry = createDefaultUnitRegistry();
  return {
    item(_companyId, _itemId): StockItem | undefined { return undefined; },
    // Issue #292 — the company's own godowns, so the report knows which one is not for sale.
    warehouse(companyId, warehouseId): Warehouse | undefined { return godowns.warehouse(companyId, warehouseId); },
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

/** Issue #289, part 2b — what a reverse-charge bill adds to the register once it is posted. */
interface ReverseChargeEntryDraft {
  readonly receivedOn: IsoDate;
  readonly supplyKind: RcmSupplyKind;
  /** The lines on which we pay the GST: what the self-invoice covers. */
  readonly lineNumbers: readonly number[];
  readonly supplierRegistered: boolean;
  readonly notes: readonly string[];
}

/** The three things a purchase will do, taken from the preview rather than written by hand. */
const previewEffects = (preview: PurchasePostingPreview, location: string): string[] => {
  const tax = preview.tax;
  const claimable = tax.cgstPaise + tax.sgstPaise + tax.igstPaise + tax.cessPaise;
  const effects = preview.receipts.map((receipt) => `Stock: +${formatQuantity(receipt.quantity)} in ${location}`);
  if (effects.length === 0) effects.push('Stock: nothing, this is a service');
  effects.push(
    tax.reverseCharge
      ? `GST: ${formatPaise(claimable + tax.ineligibleItcPaise)} payable by you under reverse charge`
      : `GST you can claim back: ${formatPaise(claimable)} (${tax.intraState ? 'CGST + SGST' : 'IGST'})`,
  );
  // Issue #289, part 3 — tax CGST s.17(5) blocks: in the cost, not claimed.
  if (tax.ineligibleItcPaise > 0n) effects.push(`GST that cannot be claimed (CGST s.17(5)), added to cost: ${formatPaise(tax.ineligibleItcPaise)}`);
  effects.push(`Supplier due: ${formatPaise(preview.totalPaise)}`);
  effects.push(`Due date: ${preview.dueDate}`);
  if (preview.roundOffPaise !== 0n) effects.push(`Rounding recorded separately: ${formatPaise(preview.roundOffPaise < 0n ? -preview.roundOffPaise : preview.roundOffPaise)}`);
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
  private readonly salesRepository: SalesRepository;
  private readonly invoicePrints: DurableMap<{ document: InvoiceDocument; snapshot: TemplateSnapshot }>;
  /** Issue #186 — each credit or debit note's printed page, frozen the moment it is recorded. */
  private readonly notePrints: DurableMap<{ document: CreditNoteDocument; snapshot: TemplateSnapshot }>;
  /**
   * The movement each e-way bill was actually raised on, kept against its document.
   *
   * The driver's page must say what the portal was told, not what happens to be on the dispatch
   * form when somebody presses Print. Rebuilding it from the form means a reprint — and every PDF,
   * which never has a form behind it — quietly loses the ship-to address and the transaction type,
   * so the page in the driver's hand disagrees with the government's record for that number.
   */
  private readonly ewayMovements: DurableMap<Movement>;
  /**
   * Issue #182 — the delivery and reference answers, kept against the draft they were checked with
   * until the bill is issued and they are frozen onto it.
   */
  private readonly deliveries: DurableMap<DeliveryDetails>;
  /** Issue #233 — what stops a bill being cancelled; the same guard the sales service asks. */
  private cancelGuard: CancellationGuardPort = { async blockers() { return []; } };
  /**
   * Issue #266 — the GST returns as prepared on the GST returns screen, so a new bill is never
   * dated into a month whose return is already approved or filed.
   */
  private returnMonths: ReturnPreparationRepository = new InMemoryReturnPreparations();
  /** Issue #296 — the composition scheme: the setting, CMP-08 and GSTR-4. Set once the shop is built. */
  composition!: CompositionDesk;
  /**
   * Issue #143 — the export or SEZ particulars of a sale, kept against the draft and then the bill
   * (they share an id). The printed bill, the e-invoice and GSTR-1 all read this one entry.
   */
  private readonly exportSales: DurableMap<ExportParticulars>;
  private readonly payments: ReceivablesService;
  private readonly paymentRepository: PaymentRepository;
  private readonly documents: DocumentLedgerPort;
  private readonly reportService: ReportService;
  private readonly assistant: AssistantService;
  private readonly terms: TradeTermsService;
  private readonly returns: ReturnService;
  private readonly returnNotes: ReturnNoteRepository;
  private readonly subscriptions: SubscriptionService;
  private readonly collections: CollectionsService;
  private readonly notifications: NotificationService;
  private readonly outbox: DemoReminderOutbox;
  private readonly bankFeeds: BankFeedService;
  private readonly booksDesk: BooksDesk;
  private readonly agent: ActionAgentService;
  private readonly gstReturns: GstReturnService;
  // Issue #297 — the modules wired in by this issue.
  private readonly calendar: ComplianceCalendarService;
  private readonly reconciliation: BankReconciliationService;
  private readonly reconciliationStore: ReconciliationStore;
  private readonly rateAdvisor: RateAdvisorService;
  /** Issue #141 — delivery challans, for goods that move before the bill exists. */
  readonly challans: ChallanDesk;
  /** Issue #142 — quotations and proforma invoices, the papers sent before a sale. */
  readonly presale: PreSaleDesk;

  private constructor(
    config: CompanySeed,
    shop: Awaited<ReturnType<typeof createCompanyShop>>,
    sales: SalesService,
    salesRepository: SalesRepository,
    payments: ReceivablesService,
    paymentRepository: PaymentRepository,
    documents: DocumentLedgerPort,
    reportService: ReportService,
    assistant: AssistantService,
    terms: TradeTermsService,
    returns: ReturnService,
    returnNotes: ReturnNoteRepository,
    collections: CollectionsService,
    notifications: NotificationService,
    outbox: DemoReminderOutbox,
    bankFeeds: BankFeedService,
    subscriptions: SubscriptionService,
    agent: ActionAgentService,
    gstReturns: GstReturnService,
    challans: ChallanDesk,
    presale: PreSaleDesk,
    exportSales: DurableMap<ExportParticulars>,
    wired: {
      calendar: ComplianceCalendarService;
      reconciliation: BankReconciliationService;
      reconciliationStore: ReconciliationStore;
      rateAdvisor: RateAdvisorService;
    },
  ) {
    this.config = config;
    // Issue #340 — the copies frozen when a bill, note or e-way bill is issued, and what was said
    // about a draft's delivery, kept in the database too so a reprint after a restart is the same.
    const company = () => String(config.companyId);
    this.invoicePrints = new DurableMap('invoice_print', company, { frozen: true });
    this.notePrints = new DurableMap('note_print', company, { frozen: true });
    // Not frozen: an e-way bill cancelled and raised again for the same movement replaces it.
    this.ewayMovements = new DurableMap('eway_movement', company);
    this.deliveries = new DurableMap('sale_delivery', company);
    this.exportSales = exportSales;
    this.challans = challans;
    this.presale = presale;
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
    this.collections = collections;
    this.notifications = notifications;
    this.outbox = outbox;
    this.bankFeeds = bankFeeds;
    this.booksDesk = new BooksDesk({ ledger: shop.ledger, store: shop.store, companyId: config.companyId, gstin: config.gstin });
    this.gstReturns = gstReturns;
    this.calendar = wired.calendar;
    this.reconciliation = wired.reconciliation;
    this.reconciliationStore = wired.reconciliationStore;
    this.rateAdvisor = wired.rateAdvisor;
  }

  /**
   * Composes one company. In memory (`MEMORY`) it is the synthetic demo company, seeded with its
   * customer, items and three old bills. On PostgreSQL (issue #340) nothing is seeded, ever: the
   * company starts with an empty standard chart of accounts and keeps what its people enter.
   */
  static async create(config: CompanySeed, persistence: Persistence = MEMORY): Promise<DemoApplication> {
    const demo = persistence.kind === 'memory';
    const shop = await createCompanyShop(config, persistence);
    const pick = <M, P>(memory: () => M, postgres: (db: TransactionalExecutor) => P): M | P =>
      persistence.kind === 'memory' ? memory() : postgres(persistence.db);
    const participate = (...participants: readonly unknown[]): void => {
      if (shop.store instanceof InMemoryLedgerStore) for (const participant of participants) shop.store.join(participant as TransactionParticipant);
    };
    const salesRepository = pick(() => new InMemorySalesRepository(), (db) => new PostgresSalesRepository(db));
    const paymentRepository = pick(() => new InMemoryPaymentRepository(), (db) => new PostgresPaymentRepository(db));
    // Issue #249 — the shop holds the notes, so the purchase comparison reads the same ones.
    const returnNotes = shop.returnNotes;
    participate(salesRepository, paymentRepository);
    // Issue #289, part 2b — the first payment against a reverse-charge bill can bring its GST forward
    // (CGST s.12(3)(b), s.13(3)(a): the date the payment is entered in the books). An advance taken
    // off the bill counts from the day the advance was paid. A reversed payment counts for nothing.
    shop.setPaidOn(async (companyId, billId) => {
      const dates = (await paymentRepository.list(companyId))
        .filter((payment) => payment.direction === 'PAYMENT' && payment.state === 'RECORDED' && payment.allocations.some((allocation) => allocation.documentId === billId))
        .map((payment) => payment.date)
        .sort();
      return dates[0] ?? null;
    });
    // Issue #181 — the customers and items this company actually keeps, in `packages/masters`.
    // The screens add to the same records, so a customer added at the counter is a customer the
    // bill can be made out to a moment later. Only the demo company is given any to start with.
    if (demo) seedCatalogue(config.companyId, config.catalogue);
    const masters = catalogueTaxReader(config);
    // The rates are the ones this business declared (option C, #54), and nothing else. The fixture
    // rate table is gone from this app: it described itself as "not a statement of Indian law", and
    // a bill charged from it charged a rate nobody stands behind.
    const calculator = new GstCalculator({
      masterData: masters,
      rates: new RateTable([]),
      gstEngine: new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.gst', mode: 'production' }),
      mode: 'production',
      declaredRates: declaredRatesOf(config.companyId),
    });
    // Issue #229 — a bill takes its goods out of the same godown purchases put them into. Before
    // this the sales service was given a stand-in that said yes to everything and moved nothing,
    // so stock never went down and a business could sell steel it did not have.
    const godown = salesInventoryAdapter(shop.inventoryService, { defaultWarehouseId: shop.warehouseId });
    // A service is not kept in a godown, so its lines are never checked against stock or issued.
    const goodsLines = (request: ReservationRequest) => request.lines.filter((line) =>
      catalogueItems(request.companyId).find((item) => item.id === line.itemId)?.kind !== 'service');
    const goodsOnly: InventoryPort = {
      ...godown,
      async reserve(actor, request) {
        const lines = goodsLines(request);
        if (lines.length === 0) return { ok: true, reservationId: request.documentId };
        return godown.reserve(actor, { ...request, lines });
      },
      // Issue #306 — the same check for the live total, holding nothing.
      async check(actor, request) {
        const lines = goodsLines(request);
        if (lines.length === 0 || godown.check === undefined) return { ok: true, reservationId: request.documentId };
        return godown.check(actor, { ...request, lines });
      },
    };
    // Issue #233 — what stops an issued bill being cancelled, read from the modules that hold it.
    // The GST return's preparations are kept here so the guard reads the same record the GST returns
    // screen approves.
    const gstPreparations = pick(() => new InMemoryReturnPreparations(), (db) => new PostgresReturnPreparations(db));
    const cancellationGuard: CancellationGuardPort = {
      async blockers(_actor, invoice) {
        const found: CancelBlocker[] = [];
        const number = invoice.number ?? invoice.id;
        const period = taxPeriodOf(invoice.documentDate);
        const month = formatTaxPeriod(period);
        // A bill in an approved or filed month is already in the government's hands (or about to
        // be). Its correction is a credit note (CGST s.34), which goes into the month it is made.
        for (const returnType of ['GSTR1', 'GSTR3B'] as const) {
          const prepared = await gstPreparations.find(invoice.companyId, period, returnType);
          if (prepared === null || !LOCKED_RETURN_STATES.has(prepared.state)) continue;
          found.push({
            code: 'SALES_CANCEL_MONTH_APPROVED',
            message: both(`${number} cannot be cancelled: it is in the GST return for ${month}, which is ${prepared.state === 'FILED' ? 'filed' : 'approved'}. Make a credit note for the whole bill instead (Returns, choose "Whole bill"). The bill and the note both stay on record.`, `${number} को रद्द नहीं किया जा सकता: यह ${month} के GST रिटर्न में है, जो ${prepared.state === 'FILED' ? 'फ़ाइल हुआ' : 'मंज़ूर'} है। उसके बदले पूरे बिल का क्रेडिट नोट बनाइए (रिटर्न्स में "Whole bill" चुनिए)। बिल और नोट दोनों रिकॉर्ड में रहेंगे।`),
            clearable: null,
          });
          break;
        }
        // A credit note already points at this bill. Cancelling the bill would leave that note
        // reducing tax on a sale that was never reported.
        // Issue #293 — a debit note for a higher price points at the bill just the same.
        const notes = (await returnNotes.listForOriginal(invoice.companyId, invoice.id)).filter((note) => note.kind !== 'PURCHASE_RETURN');
        if (notes.length > 0) {
          found.push({
            code: 'SALES_CANCEL_HAS_CREDIT_NOTE',
            message: both(`${number} cannot be cancelled: ${notes.every((note) => note.kind === 'SALES_RETURN') ? 'credit note' : 'note'} ${notes.map((note) => note.number).join(', ')} has already been made against it. Make a credit note for the rest of the bill instead (Returns, choose "Whole bill").`, `${number} को रद्द नहीं किया जा सकता: उसके लिए ${notes.every((note) => note.kind === 'SALES_RETURN') ? 'क्रेडिट नोट' : 'नोट'} ${notes.map((note) => note.number).join(', ')} पहले से बना है। उसके बदले बाक़ी बिल का क्रेडिट नोट बनाइए (रिटर्न्स में "Whole bill" चुनिए)।`),
            clearable: null,
          });
        }
        // The government's windows are judged on the same clock the e-invoice and e-way services
        // cancel by, so this never promises a cancel the service would then refuse.
        const now = shop.clock.now().toISOString();
        // The government's copy must go first, inside its window, or it would show a sale we no
        // longer report. After the window only a credit note can correct it.
        const eInvoice = await shop.eInvoices.findByDocumentId(invoice.companyId, invoice.id);
        if (eInvoice?.status === 'PENDING') {
          found.push({
            code: 'SALES_CANCEL_EINVOICE_WAITING',
            message: both(`${number} has been sent for its e-invoice number and the government has not answered yet. Wait for the answer on the E-invoice screen, then cancel.`, `${number} का ई-इनवॉइस नंबर मँगाने के लिए भेजा गया है और सरकार का जवाब नहीं आया। ई-इनवॉइस स्क्रीन पर जवाब का इंतज़ार कीजिए, फिर रद्द कीजिए।`),
            clearable: null,
          });
        } else if (eInvoice?.status === 'REGISTERED') {
          const open = eInvoice.cancellableUntil === undefined || eInvoice.cancellableUntil > now;
          found.push(open
            ? {
              code: 'SALES_CANCEL_EINVOICE_ACTIVE',
              message: both(`${number} has a government e-invoice number (IRN). The e-invoice has to be cancelled with the government first, and that is allowed only within 24 hours of registering it. Cancel the e-invoice, then this bill.`, `${number} का सरकारी ई-इनवॉइस नंबर (IRN) है। पहले सरकार के साथ ई-इनवॉइस रद्द करना ज़रूरी है, जो सिर्फ़ रजिस्टर होने के 24 घंटे के अंदर हो सकता है। ई-इनवॉइस रद्द कीजिए, फिर यह बिल।`),
              clearable: 'EINVOICE',
            }
            : {
              code: 'SALES_CANCEL_EINVOICE_WINDOW_CLOSED',
              message: both(`${number} has a government e-invoice number, and the 24 hours in which the government allows it to be cancelled have passed. Make a credit note for the whole bill instead (Returns, choose "Whole bill").`, `${number} का सरकारी ई-इनवॉइस नंबर है, और जिस 24 घंटे में सरकार रद्द करने देती है वह बीत गया है। उसके बदले पूरे बिल का क्रेडिट नोट बनाइए (रिटर्न्स में "Whole bill" चुनिए)।`),
              clearable: null,
            });
        }
        const eway = await shop.ewayBills.findByMovementId(invoice.companyId, invoice.id);
        if (eway?.acknowledgement !== undefined && eway.status !== 'CANCELLED' && eway.status !== 'REJECTED') {
          const open = (eway.status === 'ACTIVE' || eway.status === 'PART_A_ONLY')
            && (eway.cancellableUntil === undefined || eway.cancellableUntil > now);
          found.push(open
            ? {
              code: 'SALES_CANCEL_EWAY_ACTIVE',
              message: both(`${number} has e-way bill ${eway.acknowledgement.ewayBillNumber}. It has to be cancelled on the portal first, which is allowed only within 24 hours of raising it. Cancel the e-way bill, then this bill.`, `${number} का ई-वे बिल ${eway.acknowledgement.ewayBillNumber} है। उसे पहले पोर्टल पर रद्द करना ज़रूरी है, जो सिर्फ़ बनाए जाने के 24 घंटे के अंदर हो सकता है। ई-वे बिल रद्द कीजिए, फिर यह बिल।`),
              clearable: 'EWAY_BILL',
            }
            : {
              code: 'SALES_CANCEL_EWAY_WINDOW_CLOSED',
              message: both(`${number} has e-way bill ${eway.acknowledgement.ewayBillNumber}, and it can no longer be cancelled on the portal, so the government holds these goods as moved. Make a credit note for the whole bill instead (Returns, choose "Whole bill").`, `${number} का ई-वे बिल ${eway.acknowledgement.ewayBillNumber} है, और उसे अब पोर्टल पर रद्द नहीं किया जा सकता, इसलिए सरकार के नज़दीक यह माल पहुंच गया। उसके बदले पूरे बिल का क्रेडिट नोट बनाइए (रिटर्न्स में "Whole bill" चुनिए)।`),
              clearable: null,
            });
        }
        return found;
      },
    };
    const sales = new SalesService({ store: shop.store, ledger: shop.ledger, calculator, repository: salesRepository, inventory: goodsOnly, compliance: noComplianceHooks, permissions: permissionPortFromActor, audit: shop.audit, clock: appClock, policy: { ...DEFAULT_SALES_POLICY, series: { prefix: 'INV', branchCode: '' } }, cancellationGuard });

    // Issue #230 — each supplier by their own name. Every supplier used to be called the built-in
    // one, so money owed to a second supplier was listed under the first supplier's name.
    const purchases = purchaseDocumentLedger(shop.bills, async (companyId, partyId) =>
      supplierParties(companyId).find((party) => party.id === partyId)?.legalName ?? config.supplierName);
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
        // Issue #293 — a debit note for a higher price adds to what is due on its bill.
        const debitedValue = (documentId: string) => notes.filter((note) => note.kind === 'SALES_DEBIT_NOTE' && note.originalDocument.id === documentId)
          .reduce((total, note) => total + note.totals.total.minor, 0n);
        const saleDocuments: OpenDocument[] = invoices.map((invoice) => ({ documentId: invoice.id, kind: 'SALES_INVOICE', number: invoice.number ?? invoice.id, partyId, date: invoice.documentDate, dueDate: invoice.dueDate, value: money((invoice.pricing?.totals.invoiceValue.minor ?? 0n) - returnedValue(invoice.id, 'SALES_RETURN') + debitedValue(invoice.id)), side: 'RECEIVABLE' }));
        return [...purchaseDocuments, ...saleDocuments];
      },
      async parties(companyId) {
        // Issue #261 — every supplier, not only those with a bill: an advance is paid before the bill.
        return [...new Set([
          ...(await purchases.parties(companyId)), ...customers(companyId).map((party) => party.id),
          String(config.supplierId), ...supplierParties(companyId).map((party) => party.id),
        ])] as unknown as readonly PartyId[];
      },
      async nameOf(companyId, partyId) {
        return customers(companyId).find((party) => party.id === partyId)?.legalName ?? purchases.nameOf(companyId, partyId);
      },
    };
    const payments = new ReceivablesService({ store: shop.store, ledger: shop.ledger, repository: paymentRepository, documents, permissions: permissionPortFromActor, audit: shop.audit, clock: appClock });

    // Reports read the same live company: the ledger every module posts to, the sales invoices
    // sales issues, the stock movements purchases receive, the positions receivables derives.
    const reportService = new ReportService({
      store: shop.store,
      sales: salesRepository,
      inventory: shop.inventory,
      stockMasterData: demoStockMasterData(shop.masters),
      dues: duesFrom(documents, payments),
      purchases: livePurchaseReadPort(shop),
      // Names are read from master data as they stand, so a customer or an item added today is
      // named in today's reports rather than showing as an id.
      names: {
        party: (companyId, partyId) => partyId === String(config.supplierId)
          ? config.supplierName
          : masterDataService().parties(mastersContext(companyId)).find((p) => p.id === partyId)?.legalName,
        // Purchases keep their own short item ids, so those fall back to the purchase catalogue.
        item: (companyId, itemId) => catalogueItems(companyId).find((item) => item.id === itemId)?.name
          ?? DemoApplication.CATALOGUE[itemId]?.description,
        warehouse: (companyId, warehouseId) => shop.masters.warehouse(companyId, warehouseId)?.name,
        branch: () => undefined,
      },
      permissions: permissionPortFromActor,
      audit: shop.audit,
      clock: appClock,
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
        // Issue #235 — only bills deliberately held back: sent for approval and waiting for it.
        // Every press of Review makes a draft, and a review that was changed, reviewed again or
        // walked away from is not a bill anybody meant to issue; counting those made a customer
        // look as if they owed money three times over.
        const held = (await salesRepository.list(companyId, { partyId, state: 'PENDING_APPROVAL' }))
          .filter((invoice) => invoice.id !== excludingDocumentId);
        return money(held.reduce((total, invoice) => total + (invoice.pricing?.totals.invoiceValue.minor ?? 0n), 0n));
      },
    };
    const positions: CreditPositionPort = {
      async outstanding(actor, partyId, asOn) {
        const position = await payments.position(actor, partyId, asOn);
        const oldest = position.documents
          .filter((d) => d.outstanding.minor > 0n)
          .reduce((worst, d) => Math.max(worst, d.daysOverdue), 0);
        // Issue #235 — what they owe after receipts and credit notes. Money of theirs we already hold
        // on account (paid ahead, or left over from a cancelled bill) is set against it.
        const owed = position.totalOutstanding.minor - position.onAccount.minor;
        return { total: money(owed > 0n ? owed : 0n), oldestDaysOverdue: oldest };
      },
    };
    const partyTerms: PartyTermsPort = {
      // Issue #235 — the limit the business set on this customer, and none when it set none. No
      // limit is never made up: a customer nobody gave a limit is not warned about one.
      async creditLimit(companyId, partyId) {
        const limit = customers(companyId).find((party) => party.id === partyId)?.creditLimitPaise;
        return limit === undefined || limit === null ? null : money(limit);
      },
      // Issue #181 — whoever this party actually is. Naming the supplier in a customer's credit
      // sentence told a shopkeeper the wrong business was over their limit.
      async nameOf(companyId, partyId) {
        if (partyId === config.supplierId) return config.supplierName;
        return customers(companyId).find((party) => party.id === partyId)?.legalName ?? String(partyId);
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
      clock: appClock,
    });

    const returns = new ReturnService({
      store: shop.store, ledger: shop.ledger, repository: returnNotes,
      sales: servicesKeptOutOfStock(salesReturnSource(salesRepository, async (companyId, documentId) =>
        (await shop.eInvoices.findByDocumentId(companyId, documentId))?.status === 'REGISTERED')),
      // Issue #186 — a supplier's bill line has no HSN of its own; the item list supplies it.
      purchases: purchaseReturnSource(shop.bills, (companyId, itemId) =>
        catalogueItems(companyId).find((item) => item.id === itemId)?.hsnSac ?? DemoApplication.CATALOGUE[itemId]?.hsnSac ?? null),
      inventory: returnInventoryAdapter(shop.inventoryService), permissions: permissionPortFromActor,
      audit: shop.audit, clock: appClock,
    });


    /**
     * Issue #34 — why a particular bill is held up, worked out from this live company rather than
     * described by a fixture: the bill is looked up in the sales repository, its lines are checked
     * against what the stock ledger actually says, and the place-of-supply question is put to the
     * rules engine with this bill's own facts.
     *
     * Issue #397 — every read here runs as the person who asked, never `shop.setupActor`. The
     * assistant has already checked they may see bills and stock before it asks.
     */
    const blocked: BlockedDocumentPort = {
      async find(actor: ActorContext, reference: string): Promise<BlockedDocument | null> {
        const companyId = actor.companyId;
        const invoices = await salesRepository.list(companyId);
        const invoice = invoices.find(
          (candidate) => (candidate.number ?? '').toUpperCase() === reference.toUpperCase() || candidate.id === reference,
        );
        if (invoice === undefined) return null;

        const reasons: BlockingReason[] = [];
        if (invoice.state !== 'FINAL' && invoice.state !== 'CANCELLED') {
          for (const line of invoice.lines) {
            const balance = await shop.inventoryService.balance(actor, { itemId: line.itemId, warehouseId: shop.warehouseId });
            if (balance.available.scaled >= line.quantity.scaled) continue;
            reasons.push({
              code: 'STOCK_SHORTFALL',
              what: {
                'en-IN': `There is not enough ${line.itemId} in ${config.location}: the bill needs ${formatQuantity(line.quantity)} and ${formatQuantity(balance.available)} is free to sell.`,
                'hi-IN': `${config.location} में ${line.itemId} कम है: बिल को ${formatQuantity(line.quantity)} चाहिए और बेचने के लिए ${formatQuantity(balance.available)} है।`,
              },
              nextStep: {
                'en-IN': 'Receive more stock, or reduce the quantity on the bill.',
                'hi-IN': 'और माल मँगाइए, या बिल की मात्रा कम कीजिए।',
              },
              action: 'purchase',
            });
          }
          reasons.push({
            code: 'RULE_CHECK',
            what: {
              'en-IN': 'Which state this sale counts in has to be settled before the bill goes out.',
              'hi-IN': 'बिल जाने से पहले तय करना होगा कि यह बिक्री किस राज्य की है।',
            },
            nextStep: {
              'en-IN': 'Check the delivery address on the bill.',
              'hi-IN': 'बिल पर डिलीवरी का पता देख लीजिए।',
            },
            action: 'sale',
            topic: 'gst.place_of_supply',
            facts: {
              'supply.type': 'GOODS',
              // Issue #237 — this bill's own place of supply, not the demo customer's state.
              'supply.deliveryStateCode': invoice.placeOfSupplyStateCode ?? billingAddressOf(companyId, invoice.partyId)?.stateCode ?? config.gstin.slice(0, 2),
              'supply.supplierStateCode': config.gstin.slice(0, 2),
            },
          });
        }
        return {
          documentId: invoice.id,
          number: invoice.number,
          kind: 'SALES_INVOICE',
          date: invoice.documentDate,
          // Issue #237 — the customer this bill is made out to.
          partyName: customers(companyId).find((party) => party.id === invoice.partyId)?.legalName ?? String(invoice.partyId),
          reasons,
        };
      },
    };

    const assistant = new AssistantService({
      reports: reportService,
      permissions: permissionPortFromActor,
      audit: shop.audit,
      clock: appClock,
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
      () => appClock.now().getTime(),
      { maxPerWindow: 100, windowMs: 60_000 },
      // Issue #366 — on PostgreSQL the notifications and their delivery timeline survive a restart.
      pick(() => new InMemoryNotificationStore(), (db) => new PostgresNotificationStore(db)),
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
      // Issue #237 — a reminder goes to the customer who owes the bill, on the phone or email saved
      // on that customer's own record. A customer with neither saved is not reminded (the plan says
      // why), rather than having the message sent to somebody else.
      async contact(companyId, partyId) {
        const party = customers(companyId).find((candidate) => candidate.id === partyId);
        if (party === undefined) return null;
        const phone = party.phones[0];
        if (phone !== undefined && phone !== '') return { recipientId: phone, channels: ['whatsapp', 'sms'] };
        const email = party.emails[0];
        if (email !== undefined && email !== '') return { recipientId: email, channels: ['email'] };
        // The seeded demo customer's own synthetic address, which exists only in the local outbox.
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
      transport: notificationReminderTransport(notifications, reminderContext, () => appClock.now().getTime()),
      repository: pick(() => new InMemoryReminderRepository(), (db) => new PostgresReminderRepository(db)),
      permissions: permissionPortFromActor,
      audit: shop.audit,
      // Issue #234 — the app's one real clock, so a reminder is judged on the day it is sent.
      // Quiet hours are a real rule evaluated against this clock; the package tests drive a night
      // and a morning through it.
      clock: appClock,
    });

    const bankProvider = new SyntheticBankFeedProvider();
    // Made-up bank lines are demo data: a real company's bank feed shows only its own bank's.
    if (demo) {
      bankProvider.addTransaction(`current-${config.companyId}`, { providerTransactionId: `upi-settlement-${config.companyId}`, bookedOn: '2026-08-29', description: 'UPI settlement from yesterday', amountMinor: 48_750_00n, direction: 'CREDIT', reference: 'SYNTHETIC-UTR-240829' });
      bankProvider.addTransaction(`current-${config.companyId}`, { providerTransactionId: `shop-rent-${config.companyId}`, bookedOn: '2026-08-29', description: 'Shop rent NEFT', amountMinor: 25_000_00n, direction: 'DEBIT', reference: 'SYNTHETIC-NEFT-240829' });
    }
    // Issue #402: the bank sends the customer back only to this app's start page — on the
    // public origins in KAROBAR_PUBLIC_ORIGINS, or on this machine in development. Never to an
    // address the browser names.
    const webPort = process.env.WEB_PORT ?? process.env.PORT ?? '4173';
    const bankReturnOrigins = PUBLIC_ORIGINS.size > 0 ? [...PUBLIC_ORIGINS] : isLocal(process.env.NODE_ENV) ? [`http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`] : [];
    const bankFeeds = new BankFeedService([bankProvider], undefined, pick(() => new InMemoryBankFeedStore(), (db) => new PostgresBankFeedStore(db)), { origins: bankReturnOrigins, path: BANK_RETURN_PATH });

    // Issue #42 [E42]: what this company's plan covers, and what it has used. The payment provider
    // is the mock one — no production credential is needed to run any of this — and the limits it
    // enforces are the real ones from the shipped catalogue.
    const subscriptions = new SubscriptionService({
      subscriptions: pick(() => new InMemorySubscriptionRepository(), (db) => new PostgresSubscriptionRepository(db)),
      usage: pick(() => new InMemoryUsageRepository(), (db) => new PostgresUsageRepository(db)),
      invoices: pick(() => new InMemoryServiceInvoiceRepository(), (db) => new PostgresServiceInvoiceRepository(db)),
      payments: alwaysPays(),
      permissions: permissionPortFromActor,
      audit: shop.audit,
      clock: appClock,
    });
    // Issue #47 [E47]: the assistant doing authorised work. Every tool below is the real module
    // already composed above — #23 decides what a reminder should be and re-checks the bill at the
    // moment of sending, #34 grounds the total in one of #35's reports and carries its snapshot id,
    // and cancelling a bill is registered as prepare-only, so the assistant can never finish it.
    // Issue #404 — over the company's own audit trail, so what the assistant was asked, who approved
    // which list and its command's lifecycle sit beside the reminders it sent. On PostgreSQL the
    // command records are kept with every other command of the company.
    const agentPolicies = [{ action: 'agent.run', minimumRisk: 'medium', requiredPermission: 'approval.decide' }] as const;
    const companyAudit = shop.audit;
    const agentCommands = companyAudit instanceof PostgresAuditLog
      ? new PostgresCommandService((persistence as Extract<Persistence, { kind: 'postgres' }>).db, companyAudit, agentPolicies)
      : new PlatformCommandService(new CompanyTrailAuditLog(companyAudit), agentPolicies);
    const agentRegistry = new ToolRegistry()
      .register(findUnpaidTool(collections))
      .register(totalOwedTool(assistant))
      .register(sendReminderTool(collections))
      .register(stopRemindingTool(collections))
      .register(cancelInvoiceTool());
    const agentParties: PartyDirectoryPort = {
      // Issue #237 — every customer of this business, not only the demo one.
      async resolve(actor, text) {
        const needle = text.trim().toLowerCase();
        const known = customers(actor.companyId).map((party) => ({ partyId: String(party.id), name: party.legalName }));
        return known.filter((party) => party.name.toLowerCase().includes(needle) || needle.includes(party.name.toLowerCase()));
      },
      async nameOf(actor, partyId) {
        return customers(actor.companyId).find((party) => party.id === partyId)?.legalName ?? partyId;
      },
    };
    const agent = new ActionAgentService({
      registry: agentRegistry,
      commands: agentCommands,
      audit: shop.audit,
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
      store: pick(() => new InMemoryAgentPlanStore(), (db) => new PostgresAgentPlanStore(db)),
      permissions: permissionPortFromActor,
      clock: appClock,
    });

    // Issue #30 — the GST return workspace, over this same live company.
    //
    // Every port here is the module that already holds the answer. The bills come from the sales
    // repository the till writes to, the credit notes from the returns module, the tax already
    // paid and the reconciliation figure from two *different* reads of the ledger — so the check
    // that the return agrees with the books is a real comparison of two sources and not a number
    // compared with itself. There is no `government` port, which is the point: this shop has no
    // licensed intermediary, and everything except the last button still works.
    /**
     * Issue #286 — advances for services carry GST when the money arrives (#165), and GSTR-1 reports
     * them in table 11: 11A for an advance received this month and not billed in the same month
     * (less any refund voucher), 11B for an advance from an earlier month used against this month's
     * bill. Goods advances carry no GST and are only counted in table 13 (`otherNumbersFor`).
     */
    const advanceDocumentsFor = async (
      companyId: CompanyId,
      period: string,
      supplier: { gstin: string; stateCode: string },
      customerOn: (partyId: string) => { name: string; gstin: string | null; stateCode: string },
    ): Promise<OutwardDocument[]> => {
      const inPeriod = (date: string) => taxPeriodOf(date as IsoDate) === period;
      const documents: OutwardDocument[] = [];
      for (const advance of await advanceRepository.list(companyId)) {
        const tax = advance.tax;
        if (tax === null) continue;
        const party = customerOn(String(advance.partyId));
        const of = (part: Money): OutwardLine[] => tax.lines.map((line, index) => {
          const scale = (value: Money) => mulDiv(value, part.minor, advance.amount.minor);
          return {
            lineId: `advance-rate-${index + 1}`, itemId: 'advance', description: advance.description, hsnOrSac: null,
            supplyKind: advance.supplyKind, unit: null, quantity: null, ratePercentTimes100: line.ratePercentTimes100,
            amounts: {
              taxableValue: scale(line.taxableValue), cgst: scale(line.cgst),
              sgst: money(scale(line.sgst).minor + scale(line.utgst).minor), igst: scale(line.igst), cess: scale(line.cess),
            },
            rateBasis: null, reverseCharge: line.reverseCharge,
          };
        });
        const base = {
          companyId: advance.companyId, treatment: 'REGULAR' as const,
          supplierGstin: supplier.gstin, supplierStateCode: supplier.stateCode,
          partyId: String(advance.partyId), partyName: party.name, counterpartyGstin: party.gstin,
          counterpartyStateCode: party.stateCode, placeOfSupplyStateCode: advance.placeOfSupplyStateCode,
          reverseCharge: false, unregisteredConfirmed: true,
        };
        // 11A — what of the advance was not billed in the month it arrived.
        if (inPeriod(advance.date)) {
          const billedSameMonth = advance.application !== null && inPeriod(advance.application.invoiceDate) ? advance.application.amount.minor : 0n;
          const open = money(advance.amount.minor - billedSameMonth);
          if (open.minor > 0n) {
            documents.push({ ...base, sourceKind: 'receipt_voucher', sourceId: advance.id, voucherId: advance.taxVoucherId, kind: 'ADVANCE_RECEIPT', number: advance.number, documentDate: advance.date, lines: of(open), invoiceValue: open });
          }
        }
        // 11A, less — a refund voucher takes back the tax paid on what is refunded.
        if (advance.refund !== null && inPeriod(advance.refund.date)) {
          documents.push({ ...base, sourceKind: 'refund_voucher', sourceId: `${advance.id}:refund`, voucherId: advance.refund.voucherId, kind: 'REFUND_VOUCHER', number: advance.refund.number, documentDate: advance.refund.date, lines: of(advance.refund.amount), invoiceValue: advance.refund.amount });
        }
        // 11B — an advance from an earlier month, used against a bill dated this month.
        if (advance.application !== null && inPeriod(advance.application.invoiceDate) && !inPeriod(advance.date)) {
          documents.push({ ...base, sourceKind: 'advance_adjustment', sourceId: `${advance.id}:applied`, voucherId: advance.application.voucherId, kind: 'ADVANCE_ADJUSTED', number: `${advance.number} → ${advance.application.invoiceNumber}`, documentDate: advance.application.invoiceDate, lines: of(advance.application.amount), invoiceValue: advance.application.amount });
        }
      }
      return documents;
    };
    const exportSales = new DurableMap<ExportParticulars>('export_sale', () => String(config.companyId));
    const outwardSupplies: OutwardSupplyPort = {
      async documentsFor(companyId, period): Promise<readonly OutwardDocument[]> {
        const supplier = { gstin: config.gstin, stateCode: config.gstin.slice(0, 2) };
        // Issue #181 — the customer each bill was made out to. A return that names one customer on
        // every bill tells the government the wrong buyer claimed the credit.
        const customerOn = (partyId: string) => {
          const view = customerView(config.companyId, partyId);
          return {
            name: view.name,
            // Issue #279 — no GST number is `null`, never `''`: a blank one read as registered and
            // sent every consumer sale to B2B, blocking the whole month.
            gstin: view.gstin,
            stateCode: view.stateCode ?? config.gstin.slice(0, 2),
            unregisteredConfirmed: view.gstin === null,
          };
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
                // Issue #231 — without the kind, freight read as a goods line with no code and the
                // code-wise summary came out short by it.
                kind: line.kind,
                quantity: line.quantity, ratePercentTimes100: line.ratePercentTimes100,
                taxableValue: line.taxableValue, cgst: line.cgst, sgst: line.sgst, utgst: line.utgst,
                igst: line.igst, cess: line.cess, reverseCharge: line.reverseCharge, rateBasis: line.rateBasis,
                treatment: line.treatment,
              })),
              totals: { invoiceValue: invoice.pricing.totals.invoiceValue },
            },
            // Issue #143 — the return's treatment comes from the same row the bill printed.
            ...(exportSales.has(invoice.id) ? { supplyTreatment: EXPORT_SUPPLIES[exportSales.get(invoice.id)!.kind].returnTreatment } : {}),
            // Issue #286 — and its shipping bill, for the exports table of the upload file.
            ...(exportSales.get(invoice.id)?.shippingBill === undefined ? {} : { shippingBill: exportSales.get(invoice.id)!.shippingBill! }),
          },
          customerOn(String(invoice.partyId)),
          supplier,
        ));
        // Issue #232 — a credit note counts in the state of the bill it corrects, read from that
        // bill (which may be in an earlier month). Every note used to be given our own state, so an
        // inter-state note carrying IGST was flagged as a local sale and filed under Karnataka.
        const hsnByItem = Object.fromEntries(catalogueItems(companyId).map((item) => [item.id, item.hsnSac]));
        const notes = await Promise.all((await returnNotes.list(companyId))
          // Issue #293 — a sales debit note goes to GSTR-1 beside the credit notes (Table 9B, type "D").
          .filter((note) => (note.kind === 'SALES_RETURN' || note.kind === 'SALES_DEBIT_NOTE') && taxPeriodOf(note.documentDate) === period)
          .map(async (note) => {
            const original = await salesRepository.findById(companyId, note.originalDocument.id);
            return returnNoteToDocument(note, customerOn(String(note.partyId)), supplier, {
              original: original === null ? null : {
                placeOfSupplyStateCode: original.pricing?.placeOfSupplyStateCode ?? original.placeOfSupplyStateCode,
                // Issue #325 — so a consumer note is listed where its bill was.
                ...(original.pricing === null ? {} : { invoiceValue: original.pricing.totals.invoiceValue }),
              },
              hsnByItem,
            });
          }));
        return [...documents, ...notes, ...await advanceDocumentsFor(companyId, period, supplier, customerOn)];
      },
      // Issue #286 — papers table 13 counts that carry nothing onto the return: receipt and refund
      // vouchers for goods advances (no GST is due on those), and delivery challans.
      async otherNumbersFor(companyId, period) {
        const inPeriod = (date: string) => taxPeriodOf(date as IsoDate) === period;
        const goodsAdvances = (await advanceRepository.list(companyId)).filter((advance) => advance.tax === null);
        const challans = (await challanRepository.list(companyId)).filter((challan) => inPeriod(challan.documentDate));
        return [
          ...goodsAdvances.filter((advance) => inPeriod(advance.date))
            .map((advance) => ({ kind: 'ADVANCE_RECEIPT' as const, number: advance.number, cancelled: false })),
          ...goodsAdvances.filter((advance) => advance.refund !== null && inPeriod(advance.refund.date))
            .map((advance) => ({ kind: 'REFUND_VOUCHER' as const, number: advance.refund!.number, cancelled: false })),
          ...challans.map((challan) => ({
            kind: challan.reason === 'JOB_WORK' ? 'DELIVERY_CHALLAN_JOB_WORK' as const
              : challan.reason === 'SUPPLY_ON_APPROVAL' ? 'DELIVERY_CHALLAN_APPROVAL' as const
                : challan.reason === 'LIQUID_GAS' ? 'DELIVERY_CHALLAN_LIQUID_GAS' as const
                  : 'DELIVERY_CHALLAN_OTHER' as const,
            number: challan.number,
            cancelled: challan.state === 'CANCELLED',
          })),
        ];
      },
      // Issue #233 — a bill issued in this month and then cancelled is not a sale, but its number
      // was used, so the documents-issued table (GSTR-1 table 13) counts it as cancelled.
      async cancelledNumbersFor(companyId, period) {
        return (await salesRepository.list(companyId, { state: 'CANCELLED' }))
          .filter((invoice) => invoice.number !== null && taxPeriodOf(invoice.documentDate) === period)
          .map((invoice) => ({ kind: 'INVOICE' as const, number: invoice.number as string }));
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
      // Issue #249 — the input-tax side of the same ledger, for the purchases books-versus-return line.
      inputBooks: ledgerInputBookTaxPort(shop.store.read()),
      repository: gstPreparations,
      audit: shop.audit,
      clock: appClock,
      // Issue #296 — a composition business files CMP-08 and GSTR-4, not these.
      scheme: { async during(companyId, from, to) { return schemeDuring(companyId, from, to); } },
    });

    // Issue #141. Challans share the store, so a number is allocated in the same transaction that
    // saves the challan; they read the same master data and calculator the invoice does, so a sale
    // challan shows the tax its invoice will charge.
    const challanRepository = pick(() => new InMemoryChallanRepository(), (db) => new PostgresChallanRepository(db));
    participate(challanRepository);
    const challans = new ChallanDesk(config, new ChallanService({
      store: shop.store, calculator, masterData: masters, repository: challanRepository, invoices: salesRepository,
      permissions: permissionPortFromActor, audit: shop.audit, clock: appClock, invoicePrefix: 'INV',
    }));

    // Issue #142. Quotations and proformas share the store only so a number and the document are
    // saved together; they post nothing to it. They are priced by the invoice's own calculator, and a
    // quotation becomes a sale through the invoice's own service, as a draft.
    const presaleRepository = pick(() => new InMemoryPreSaleRepository(), (db) => new PostgresPreSaleRepository(db));
    participate(presaleRepository);
    // Issue #165. Money taken against a proforma is recorded by the same receivables service as any
    // other receipt, and linking the proforma's invoice applies it and sets off its tax.
    const advanceRepository = pick(() => new InMemoryAdvanceRepository(), (db) => new PostgresAdvanceRepository(db));
    participate(advanceRepository);
    const advances = new AdvanceService({
      store: shop.store, ledger: shop.ledger, receivables: payments, proformas: presaleRepository, repository: advanceRepository,
      permissions: permissionPortFromActor, audit: shop.audit, clock: appClock,
    });
    const presale = new PreSaleDesk(config, new PreSaleService({
      store: shop.store, calculator, repository: presaleRepository, invoices: salesRepository, sales,
      permissions: permissionPortFromActor, audit: shop.audit, clock: appClock, takenPrefixes: ['INV', 'DC', 'RV', 'RFV'],
      advances,
    }), advances);

    // Issue #297 — the three packages the audit found finished but unreachable, composed for real.

    // Bank reconciliation (#22): the store #472 built is the one used on PostgreSQL; in memory the
    // same port keeps the demo working. Matching itself never moves money — posting a line the bank
    // shows but the books lack still goes through `payments.recordPayment` like any other entry.
    const reconciliationStore: ReconciliationStore = pick(() => new InMemoryReconciliationStore(), (db) => new PostgresReconciliationStore(db));
    const reconciliation = new BankReconciliationService(undefined, () => appClock.now(), reconciliationStore);

    // Compliance calendar (#32): the company's profile is derived from facts the app already holds —
    // its GSTIN, its books' start, the e-invoice answer and whether it sells goods — never asked again.
    // A quarterly (QRMP) shop needs a Business details answer the app does not ask yet (ponytail, same
    // as gstReturnTasks): monthly, because the GST returns screen prepares one return a month.
    const calendarProfiles: CompanyProfilePort = {
      async profileFor(companyId) {
        const booksStart = (await shop.store.read().settings.get(companyId))?.booksStartDate ?? currentFinancialYear().from;
        return {
          companyId,
          legalName: config.name,
          gstin: config.gstin,
          registrationType: { value: config.gstin === '' ? 'UNREGISTERED' : 'REGULAR', basis: 'DERIVED' },
          gstFilingFrequency: { value: 'MONTHLY', basis: 'DERIVED', basisNote: 'The GST returns screen prepares one return a month.' },
          // The same turnover facts `eInvoiceDecisionFor` reads: e-invoice obliges only a business
          // that has crossed ₹5 crore in any year since 2017-18 (CGST Rule 48(4), applied by
          // Notf. 78/2020-CT as amended by 10/2023-CT for the ₹5-crore floor, effective
          // 2023-11-01). An exemption means it never applies. When the turnover answer is missing
          // the fact itself stays null — the obligation waits for an answer instead of scheduling
          // deadlines a small business does not have.
          eInvoiceApplicable: eInvoiceExemptionOf(companyId) !== 'NONE'
            ? { value: false, basis: 'DERIVED', basisNote: 'Business details says the business is exempt from e-invoice.' }
            : (() => {
              const answers = turnoverAnswersOf(companyId);
              const band = turnoverBandOn(answers, isoDate(appToday()));
              const legacy = band === null ? turnoverAnswerOn(answers, isoDate(appToday())) : null;
              const above = band === '5_TO_10_CRORE' || band === '10_CRORE_AND_ABOVE' || band === 'UP_TO_5_CRORE_EARLIER_ABOVE' || legacy === 'YES'
                ? true : band === 'UP_TO_5_CRORE' || legacy === 'NO' ? false : null;
              return above === null ? null : { value: above, basis: 'DERIVED', basisNote: 'From the turnover answer in Business details.' };
            })(),
          movesGoods: { value: catalogueItems(companyId).some((item) => item.kind === 'goods'), basis: 'DERIVED' },
          stateCode: { value: config.gstin.slice(0, 2), basis: 'DERIVED' },
          calendarFrom: booksStart,
          timeZone: 'Asia/Kolkata',
          saturdayIsWorking: true,
        };
      },
    };
    let app!: DemoApplication;
    // Real readers, not fixtures: the signals on a deadline come from the return workspace (#30),
    // the e-invoice queue (#26) and the purchase comparison (#31) of this same company.
    const returnReadiness: ReturnReadinessReader = { readinessFor: (companyId, periodKey) => app.returnReadiness(companyId, periodKey) };
    const eInvoiceBacklog: EInvoiceBacklogReader = { pendingFor: (companyId, periodKey) => app.eInvoiceBacklog(companyId, periodKey) };
    const unresolvedPurchases: UnresolvedPurchaseReader = { unresolvedFor: (companyId, periodKey) => app.unresolvedPurchases(companyId, periodKey) };
    const calendar = new ComplianceCalendarService({
      definitions: new CatalogueDefinitions(),
      profiles: calendarProfiles,
      occurrences: pick(() => new InMemoryOccurrences(), (db) => new PostgresOccurrences(db)),
      alerts: pick(() => new InMemoryAlerts(), (db) => new PostgresAlerts(db)),
      exceptions: pick(() => new InMemoryComplianceExceptions(), (db) => new PostgresComplianceExceptions(db)),
      audit: shop.audit,
      clock: appClock,
      signals: [returnReadinessSignals(returnReadiness), eInvoiceBacklogSignals(eInvoiceBacklog), purchaseMismatchSignals(unresolvedPurchases)],
    });

    // Rate advisor (#59). Its register here is two registers read together: the rates the business
    // itself declared on items and codes (`declaredRatesOf` — the very register a bill's rate line
    // is chosen from, so what the advisor suggests is what the business actually charges) and #5's
    // tax defaults, where `remember` puts an approved suggestion. A rate declared for another item
    // counts as code-level evidence only — issue #281 says a rate pinned to an item belongs to that
    // item alone, so the suggestion never claims to be that item's own rate. And a suggestion only
    // ever asks: the owner still declares the new item's rate themselves.
    const mastersRegistryPort = mastersRegistry(masterDataService(), mastersContext);
    const declaredRegistry: TaxDefaultRegistryPort = {
      async candidates(companyId, lookup, asOf) {
        const code = lookup.hsnSac?.trim();
        const declared = declaredRatesOf(companyId).list(companyId)
          .filter((rate) =>
            asOf >= rate.effectiveFrom
            && (rate.effectiveTo === null || asOf <= rate.effectiveTo)
            && ((lookup.itemId !== undefined && rate.itemId === lookup.itemId)
              || (code !== undefined && code !== '' && (code.startsWith(rate.code) || rate.code.startsWith(code)))))
          .map((rate) => ({
            entry: {
              id: `declared:${rate.itemId ?? rate.code}:${rate.declaredOn}`,
              companyId,
              ...(lookup.itemId !== undefined && rate.itemId === lookup.itemId ? { itemId: rate.itemId } : {}),
              hsnSac: rate.code,
              gstRateBasisPoints: Number(rate.ratePercentTimes100),
              ...(rate.cess?.percentTimes100 === undefined ? {} : { cessRateBasisPoints: Number(rate.cess.percentTimes100) }),
              ...(rate.cess?.perUnitPaise === undefined ? {} : { cessPerUnitPaise: rate.cess.perUnitPaise }),
              reverseCharge: false,
              source: `${rate.basis} — declared on ${rate.declaredOn}`,
            } satisfies TaxDefault,
            effectiveFrom: rate.effectiveFrom,
          }));
        return [...declared, ...(await mastersRegistryPort.candidates(companyId, lookup, asOf))];
      },
      async item(companyId, itemId, asOf) {
        const found = catalogueItems(companyId).find((entry) => entry.id === itemId);
        if (found !== undefined) return { name: found.name, hsnSac: found.hsnSac ?? null };
        return mastersRegistryPort.item(companyId, itemId, asOf);
      },
    };
    const rateAdvisor = new RateAdvisorService({
      registry: declaredRegistry,
      learning: mastersLearning(masterDataService(), mastersContext),
      audit: shop.audit,
      clock: () => appClock.now(),
    });

    app = new DemoApplication(config, shop, sales, salesRepository, payments, paymentRepository, documents, reportService, assistant, terms, returns, returnNotes, collections, notifications, outbox, bankFeeds, subscriptions, agent, gstReturns, challans, presale, exportSales, { calendar, reconciliation, reconciliationStore, rateAdvisor });
    app.cancelGuard = cancellationGuard;
    // Issue #290 — a challan holds its goods in the godown's stock, and is judged for an e-way bill.
    challans.hooks = app.challanHooks();
    app.returnMonths = gstPreparations;
    // Issue #296 — the composition scheme reads the same bills, notes and ledger as everything else.
    app.composition = new CompositionDesk({
      companyId: config.companyId, gstin: config.gstin, store: shop.store, ledger: shop.ledger, audit: shop.audit,
      invoices: salesRepository, notes: returnNotes,
      goodsItemCount: (companyId) => catalogueItems(companyId).filter((item) => item.kind !== 'service').length,
      purchases: async (companyId, financialYear) => {
        const range = financialYearRange(financialYear);
        let registeredPaise = 0n;
        let unregisteredPaise = 0n;
        for (const bill of await shop.bills.list(companyId)) {
          if (bill.state !== 'POSTED' || bill.invoiceDate < range.from || bill.invoiceDate > range.to) continue;
          const taxable = bill.lines.reduce((sum, line) => sum + BigInt(line.taxableValuePaise), 0n);
          const gstin = billingAddressOf(companyId, bill.supplierPartyId)?.gstin ?? (bill.supplierPartyId === config.supplierId ? config.supplierGstin : undefined);
          if (gstin === undefined || gstin === null || gstin === '') unregisteredPaise += taxable; else registeredPaise += taxable;
        }
        return { registeredPaise, unregisteredPaise };
      },
    });
    if (demo) await app.seed();
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
      eInvoices: {
        retryWaiting: (serviceActor) => this.retryWaitingEInvoices(serviceActor as ActorContext),
      },
    });
  }

  /**
   * Goods the business already held on the day its books began, entered as a count with what they
   * cost (#229). Their value goes into the books against the opening balance, not this year's
   * costs. Used by the demo's own seed; there is no screen for it yet.
   */
  async recordOpeningStock(
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly itemId: string; readonly quantity: Quantity; readonly unitCost: Money },
  ) {
    this.companyOf(actor);
    return this.shop.inventoryService.recordMovement(actor, {
      idempotencyKey: input.idempotencyKey,
      itemId: input.itemId,
      warehouseId: this.shop.warehouseId,
      kind: 'OPENING',
      quantity: input.quantity,
      unitCost: input.unitCost,
      documentDate: isoDate('2026-04-01'),
      source: { kind: 'opening_stock', id: input.idempotencyKey, number: null },
      reason: 'Opening count on the day the books began',
    });
  }

  private async seed(): Promise<void> {
    // Issue #395 — the demo company's address is seeded before it opens, so its walk-in customer is too.
    if (businessDetailsOf(this.config.companyId) !== null) await this.walkIn(this.shop.setupActor);
    // Issue #229 — a sale takes its goods out of stock, so the three old soap bills below need the
    // soap they sold. It is entered as the count on the day the books begin: 4 + 2 + 1 = 7 pieces,
    // at a made-up cost of ₹200 each, and all of it is sold by those bills, so no soap is left.
    await this.recordOpeningStock(this.shop.setupActor, {
      idempotencyKey: 'seed-opening-soap',
      itemId: resolveItem(this.config.companyId, 'Herbal Bath Soap 100g').id,
      quantity: quantityFromString('7', 'PCS'),
      unitCost: money(200_00n),
    });
    await this.clearOpeningStockSuspense();
    // Issue #299 — the bills are recorded oldest first so bill numbers climb with the dates:
    // 000001 is two months past its due date, 000002 is ten days past, 000003 is the newest.
    await this.recordSale(this.shop.setupActor, { party: this.config.customerName, item: 'Herbal Bath Soap 100g', quantity: '1', rate: '250', date: '2026-06-15', terms: '15', reference: 'seed-overdue-2', requestId: 'seed-overdue-2', notes: 'Synthetic bill, two months past its due date' });
    await this.recordSale(this.shop.setupActor, { party: this.config.customerName, item: 'Herbal Bath Soap 100g', quantity: '2', rate: '250', date: '2026-07-20', terms: '30', reference: 'seed-overdue-1', requestId: 'seed-overdue-1', notes: 'Synthetic bill, ten days past its due date' });
    await this.recordSale(this.shop.setupActor, { party: this.config.customerName, item: 'Herbal Bath Soap 100g', quantity: '4', rate: '250', date: '2026-08-29', terms: '30', reference: 'seed-sale', requestId: 'seed-sale', notes: 'Synthetic opening demo sale' });
  }

  /**
   * Issue #299 — the opening stock entry parks its cost in the opening-balance-difference account,
   * which is where an unexplained difference is meant to sit until the owner decides. The demo
   * knows where it came from — the owner put in the soap the business began with — so the balance
   * is moved to Capital the way an accountant clears a suspense balance, and the demo books carry
   * no unexplained difference. Whatever happens to sit in the account is cleared, not a fixed
   * figure, so the journal stays right if the seeded count or cost changes.
   */
  private async clearOpeningStockSuspense(): Promise<void> {
    const actor = this.shop.setupActor;
    const accounts = this.shop.store.read().accounts;
    const [difference, capital] = await Promise.all([
      accounts.findByCode(actor.companyId, '3900'),
      accounts.findByCode(actor.companyId, '3100'),
    ]);
    if (!difference || !capital) return;
    const row = (await trialBalance(this.shop.store.read(), actor.companyId)).rows
      .find((entry) => entry.account.id === difference.id);
    if (!row || row.balance.minor === 0n) return;
    // Clear to the opposite side: a credit balance is debited away, a debit balance credited.
    const { balance: amount, side } = row;
    await this.shop.ledger.postVoucher(actor, {
      idempotencyKey: 'seed-opening-stock-clearance',
      type: 'JOURNAL',
      date: isoDate('2026-04-01'),
      narration: 'The opening stock was the owner\u2019s own goods, so its cost is moved from the opening difference to capital',
      source: { kind: 'opening_stock', id: 'seed-opening-soap', number: null },
      lines: [
        { accountId: difference.id, debit: side === 'CREDIT' ? amount : money(0n), credit: side === 'DEBIT' ? amount : money(0n) },
        { accountId: capital.id, debit: side === 'DEBIT' ? amount : money(0n), credit: side === 'CREDIT' ? amount : money(0n) },
      ],
    });
  }

  /** Issue #280 — every change to where customers pay, oldest first, from the audit trail. */
  private async payeeChanges(companyId: CompanyId): Promise<readonly { readonly at: string; readonly summary: string }[]> {
    const audit = this.shop.audit;
    if (audit instanceof InMemoryAuditPort) {
      return audit.events.filter((event) => event.action === 'payee.changed' && event.companyId === companyId).map((event) => ({ at: event.at, summary: event.summary }));
    }
    const db = (this.shop.persistence as Extract<Persistence, { kind: 'postgres' }>).db;
    const { rows } = await db.tenantTransaction(companyId, (sql) => sql.query(
      `SELECT occurred_at, after_json ->> 'summary' AS summary FROM audit_events
        WHERE company_id = $1 AND action = 'payee.changed' ORDER BY seq DESC LIMIT 20`, [companyId]));
    return rows.reverse().map((row) => ({ at: (row.occurred_at as Date).toISOString(), summary: String(row.summary) }));
  }

  async dashboard(actor: ActorContext) {
    permissionPortFromActor.require(actor, 'dashboard.read', 'view this dashboard');
    const companyId = this.companyOf(actor);
    const sales = await this.salesRepository.list(companyId, { state: 'FINAL' });
    const purchases = await this.shop.bills.list(companyId);
    const payments = await this.paymentRepository.list(companyId);
    const returnNotes = await this.returnNotes.list(companyId);
    // Issue #234 — every figure on Home is as on today (in India), not as on a fixed day.
    const today = appToday();
    // Issue #230 (the supplier tile from #237) — every supplier this business owes, not only the
    // built-in one, so the tile and Reports' "You still owe suppliers" are the same figure.
    const supplierIds = [...new Set([String(this.config.supplierId), ...supplierParties(companyId).map((party) => party.id)])];
    const supplierPositions = await Promise.all(supplierIds.map(async (id) => ({ id, position: await this.payments.position(actor, id as PartyId, today) })));
    const supplierOpen = supplierPositions.flatMap(({ position }) => openBillsOf(position.documents, 'PAYMENT'));
    const suppliersOwed = supplierPositions.filter(({ position }) => openBillsOf(position.documents, 'PAYMENT').length > 0);
    const supplierTile = {
      id: suppliersOwed.length === 1 ? suppliersOwed[0]!.id : null,
      name: suppliersOwed.length === 1 ? this.partyName(companyId, suppliersOwed[0]!.id) : suppliersOwed.length === 0 ? 'Suppliers' : `${suppliersOwed.length} suppliers`,
      outstanding: jsonAmount(sum(supplierOpen.map((d) => d.outstanding)).minor),
      // Issue #261 — paid before the bill, not yet taken off one. Beside what is owed, never subtracted.
      advancesPaid: jsonAmount(sum(supplierPositions.map(({ position }) => position.advancesPaid)).minor),
      documents: supplierOpen.map((position) => ({ id: position.document.documentId, number: position.document.number, dueDate: position.document.dueDate, outstanding: jsonAmount(position.outstanding.minor), status: position.status })),
    };
    // Issue #237 — what every customer owes, worked out exactly as Reports works out its
    // receivables total (same parties, same positions, same financial year, same day), so the two
    // screens can never disagree. Only issued bills count; a cancelled bill is owed by nobody.
    const receivables = await ageingBody(duesFrom(this.documents, this.payments), actor, companyId, currentFinancialYear(), 'RECEIVABLE', today);
    const customerOpen = receivables.rows.flatMap((row) => row.documents.map((document) => ({ ...document, partyName: row.partyName })));
    const stockItems = await this.stockNeedingAttention(actor, companyId);
    const stockTile = stockItems[0] ?? { itemId: '', name: 'No goods yet', quantity: 0, unit: '', reorderLevel: null, needsAttention: false };
    const month = today.slice(0, 7);
    const salesTodayBilled = sales.filter((invoice) => invoice.documentDate === today).reduce((total, invoice) => total + (invoice.pricing?.totals.invoiceValue.minor ?? 0n), 0n);
    const salesTodayReturned = returnNotes.filter((note) => note.kind === 'SALES_RETURN' && note.documentDate === today).reduce((total, note) => total + note.totals.total.minor, 0n)
      // Issue #293 — a debit note for a higher price is more sales, so it counts back in.
      - returnNotes.filter((note) => note.kind === 'SALES_DEBIT_NOTE' && note.documentDate === today).reduce((total, note) => total + note.totals.total.minor, 0n);
    const purchasesMonthBilled = purchases.filter((bill) => bill.state === 'POSTED' && bill.invoiceDate.slice(0, 7) === month).reduce((total, bill) => total + bill.totalPaise, 0n);
    const purchasesMonthReturned = returnNotes.filter((note) => note.kind === 'PURCHASE_RETURN' && note.documentDate.slice(0, 7) === month).reduce((total, note) => total + note.totals.total.minor, 0n);
    const home = await this.home(actor, companyId, today, { sales, payments, receivables, suppliersOwed: sum(supplierOpen.map((d) => d.outstanding)).minor, stockItems, salesToday: salesTodayBilled - salesTodayReturned });
    return {
      today,
      company: { id: companyId, name: this.config.name, location: this.config.location },
      home,
      metrics: {
        // Issue #273 — sales are net of goods returned by customers, and purchases net of goods
        // sent back to suppliers, as in Reports. What was billed and what came back are published
        // beside each so the screen can write the subtraction out.
        salesToday: jsonAmount(salesTodayBilled - salesTodayReturned),
        salesTodayBilled: jsonAmount(salesTodayBilled),
        salesTodayReturned: jsonAmount(salesTodayReturned),
        customersOwe: jsonAmount(receivables.total.amount.minor),
        purchasesMonth: jsonAmount(purchasesMonthBilled - purchasesMonthReturned),
        purchasesMonthBilled: jsonAmount(purchasesMonthBilled),
        purchasesMonthReturned: jsonAmount(purchasesMonthReturned),
        needsAttention: stockItems.filter((item) => item.needsAttention).length + supplierOpen.filter((position) => position.daysOverdue > 0).length,
      },
      // Issue #237 — the goods that need looking at, the least left first, not one fixed item.
      stock: stockTile,
      stockItems,
      supplier: supplierTile,
      customer: {
        id: receivables.rows.length === 1 ? receivables.rows[0]!.partyId : null,
        name: receivables.rows.length === 1 ? receivables.rows[0]!.partyName : receivables.rows.length === 0 ? 'Customers' : `${receivables.rows.length} customers`,
        outstanding: jsonAmount(receivables.total.amount.minor),
        documents: customerOpen.map((document) => ({ id: document.sourceId, number: document.sourceNumber, party: document.partyName, outstanding: jsonAmount(document.amount.minor) })),
      },
      activity: [
        // Issue #237 — each bill under the customer it was made out to, as printed on it.
        ...sales.map((invoice) => ({ id: invoice.id, kind: 'sale', title: `${invoice.number} · ${this.invoicePrints.get(invoice.id)?.document.buyer.name ?? this.partyName(companyId, String(invoice.partyId))}`, amount: jsonAmount(invoice.pricing?.totals.invoiceValue.minor ?? 0n), status: 'Recorded' })),
        ...purchases.map((bill) => ({ id: bill.id, kind: 'purchase', title: `${bill.invoiceNumber} · ${bill.supplierName}`, amount: jsonAmount(bill.totalPaise), status: bill.state === 'POSTED' ? 'Recorded' : bill.state })),
        // Issue #230 — who actually paid, or was paid; not the demo customer for every payment.
        ...payments.map((payment) => ({ id: payment.id, kind: 'payment', direction: payment.direction, title: `${payment.direction === 'RECEIPT' ? 'Received from' : 'Paid to'} ${this.partyName(companyId, payment.partyId)} · ${payment.mode.replace('_', ' ')}`, amount: jsonAmount(payment.amount.minor), status: payment.state === 'RECORDED' ? 'Recorded' : payment.state })),
        ...returnNotes.map((note) => ({ id: note.id, kind: 'return', title: `${note.number} · ${note.originalDocument.number}`, amount: jsonAmount(note.totals.total.minor), status: 'Recorded' })),
        // Issue #280 — a change to where customers pay, so the owner sees it whoever made it.
        ...(await this.payeeChanges(companyId))
          .map((event) => ({ id: `payee:${event.at}`, kind: 'payee', title: event.summary, detail: 'If you did not make this change, put it back now and check who can sign in.', amount: null, status: 'Changed' })),
      ].reverse(),
    };
  }

  /**
   * Issue #310 — the new Home: the money card, the tasks that need the owner (most urgent first),
   * and the latest bills with Paid / due / Late. See home-application.ts. A task's source is read
   * only when this person may read it; its button is sent only when they may use it.
   */
  private async home(actor: ActorContext, companyId: CompanyId, today: IsoDate, read: {
    readonly sales: readonly SalesInvoice[];
    readonly payments: readonly Payment[];
    readonly receivables: Awaited<ReturnType<typeof ageingBody>>;
    readonly suppliersOwed: bigint;
    readonly stockItems: Awaited<ReturnType<DemoApplication['stockNeedingAttention']>>;
    readonly salesToday: bigint;
  }) {
    const may = (permission: string) => actor.permissions.includes(permission);
    const figures = await moneyCardFigures(this.shop.store, companyId, currentFinancialYear(), today);
    const reports = ['financial', 'sales', 'purchase', 'stock', 'dues', 'gst', 'exceptions'].every((kind) => may(`reports.view.${kind}`));
    const opens = (section: string) => (reports ? { view: 'reports', section } : null);

    const tasks: HomeTask[] = [];
    if (may('eway.view')) {
      for (const bill of (await this.ewayBillChoices(actor)).invoices) if (bill.status === 'NEEDED') tasks.push(ewayTask(bill, may('eway.generate')));
    }
    if (may('einvoice.view')) {
      for (const bill of (await this.issuedInvoices(actor)).invoices) {
        const task = eInvoiceTask({ ...bill, number: bill.number ?? '' }, may('einvoice.generate'));
        if (task !== null) tasks.push(task);
      }
    }
    const doneMonths = may('gst_returns.view') ? doneReturnMonths(await this.gstReturns.list(actor)) : new Set<string>();
    if (may('gst_returns.view')) {
      const booksStart = (await this.shop.store.read().settings.get(companyId))?.booksStartDate ?? currentFinancialYear().from;
      tasks.push(...await gstReturnTasks(actor, { id: companyId, name: this.config.name, gstin: this.config.gstin, booksStart }, doneMonths, may('gst_returns.prepare'),
        { onScheme: schemeOn(companyId, appToday()) === 'COMPOSITION', filedQuarters: filedCalendarQuarters(String(companyId)) }));
    }
    // Customers more than 30 days late, while the reminder plan still has something to send them.
    const late = read.receivables.rows.filter((row) => row.oldestDaysOverdue > 30);
    const lateIds = new Set(late.map((row) => String(row.partyId)));
    const stillToRemind = !may('collections.reminders.view')
      || (await this.collections.plan(actor, today)).candidates.some((candidate) => candidate.decision !== 'SKIP' && lateIds.has(String(candidate.partyId)));
    const lateTask = stillToRemind ? lateCustomersTask(late.map((row) => ({ outstanding: row.outstanding.minor })), may('collections.reminders.send')) : null;
    if (lateTask !== null) tasks.push(lateTask);
    const stock = stockTask(read.stockItems.filter((item) => item.needsAttention), may('ledger.post.purchase'));
    if (stock !== null) tasks.push(stock);
    if (turnoverBandFor(companyId, today) === null && eInvoiceExemptionOf(companyId) === 'NONE') tasks.push(turnoverTask(financialYearName(today), may('ledger.setup')));
    // Issue #290 — goods on approval must be billed within six months of leaving.
    if (may('challan.issue')) {
      for (const due of await this.challans.approvalsDue(actor, today)) tasks.push(approvalChallanTask(due, may('sales.finalise')));
    }
    tasks.sort((a, b) => a.rank - b.rank);

    // The latest five bills, newest first, each with what is still owed on it and how it was paid.
    const owed = new Map(read.receivables.rows.flatMap((row) => row.documents.map((document) => [document.sourceId, document.amount.minor] as const)));
    const newestFirst = [...read.sales].sort((a, b) => b.documentDate.localeCompare(a.documentDate) || String(b.number).localeCompare(String(a.number)));
    const recentBills = newestFirst.slice(0, 5).map((invoice) => recentBillRow(
      { id: invoice.id, number: invoice.number, dueDate: invoice.dueDate, total: invoice.pricing?.totals.invoiceValue.minor ?? 0n },
      this.invoicePrints.get(invoice.id)?.document.buyer.name ?? this.partyName(companyId, String(invoice.partyId)),
      owed.get(invoice.id) ?? 0n,
      read.payments.filter((payment) => payment.direction === 'RECEIPT' && payment.allocations.some((allocation) => allocation.documentId === invoice.id)).map((payment) => payment.mode),
      today,
    ));

    return {
      money: {
        salesToday: { amount: jsonAmount(read.salesToday), opens: opens('report-sales') },
        cashInDrawer: { amount: jsonAmount(figures.cashInDrawer), opens: opens('report-books') },
        bankInToday: { amount: jsonAmount(figures.bankInToday), opens: { view: 'activity' } },
        toCollect: { amount: jsonAmount(read.receivables.total.amount.minor), opens: opens('report-dues') },
        toPay: { amount: jsonAmount(read.suppliersOwed), opens: opens('report-dues') },
      },
      tasks,
      // Issue #297 — the deadlines ahead, from the real compliance calendar: return readiness, the
      // IRN backlog and purchase mismatches ride along as its signals. A month already filed hides.
      comingUp: may('compliance.calendar.view') ? comingUpRows(await this.calendar.calendar(actor), doneMonths) : [],
      recentBills,
    };
  }

  /**
   * Issue #237 — the goods on the Home screen's stock tile, the ones that need looking at first.
   *
   * An item needs attention when none is left, or when what is left is at or below the reorder
   * level the business set on it. They come first, the least cover first (for an item with a
   * reorder level, what is left as a share of that level; for one without, none left counts as no
   * cover at all). Everything else follows, the smallest quantity first.
   */
  private async stockNeedingAttention(actor: ActorContext, companyId: CompanyId) {
    const goods = catalogueItems(companyId).filter((item) => item.kind === 'goods' && item.active !== false);
    const rows = await Promise.all(goods.map(async (item) => {
      const balance = await this.shop.inventoryService.balance(actor, { itemId: item.id, warehouseId: this.shop.warehouseId });
      const left = balance.physical.scaled;
      const reorder = item.reorderLevel?.scaled ?? null;
      const needsAttention = left <= 0n || (reorder !== null && left <= reorder);
      // Cover in millionths of the reorder level, so the order is exact and never a float.
      const cover = left <= 0n ? -1n : reorder !== null && reorder > 0n ? (left * 1_000_000n) / reorder : null;
      return {
        itemId: item.id,
        name: item.name,
        quantity: Number(left) / 1_000_000,
        unit: balance.physical.unit,
        reorderLevel: reorder === null ? null : Number(reorder) / 1_000_000,
        needsAttention,
        left,
        cover,
      };
    }));
    rows.sort((a, b) => {
      if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
      if (a.cover !== null && b.cover !== null && a.cover !== b.cover) return a.cover < b.cover ? -1 : 1;
      if ((a.cover === null) !== (b.cover === null)) return a.cover !== null ? -1 : 1;
      return a.left === b.left ? a.name.localeCompare(b.name) : a.left < b.left ? -1 : 1;
    });
    return rows.map(({ left: _left, cover: _cover, ...row }) => row);
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

  // Issue #294 — expenses, journal and contra entries, the owner's money, and the cash and bank books.
  booksHeads(actor: ActorContext) { this.companyOf(actor); return this.booksDesk.heads(); }
  async booksJournalAccounts(actor: ActorContext) { this.companyOf(actor); return this.booksDesk.journalAccounts(); }
  async booksPreview(actor: ActorContext, kind: 'expense' | 'journal' | 'contra' | 'owner', input: Record<string, unknown>) {
    this.companyOf(actor);
    return this.booksDesk.preview(actor, kind, input);
  }
  async booksRecord(actor: ActorContext, kind: 'expense' | 'journal' | 'contra' | 'owner', input: Record<string, unknown>) {
    this.companyOf(actor);
    return this.booksDesk.record(actor, kind, input);
  }
  async booksUndo(actor: ActorContext, input: Record<string, unknown>) { this.companyOf(actor); return this.booksDesk.undo(actor, input); }
  async booksEntries(actor: ActorContext) { this.companyOf(actor); return { entries: await this.booksDesk.entries(actor) }; }
  async booksBook(actor: ActorContext, input: Record<string, unknown>) { this.companyOf(actor); return this.booksDesk.book(actor, input); }

  async reports(actor: ActorContext) {
    const companyId = actor.companyId;
    this.companyOf(actor);
    // Issue #234 — the financial year today falls in (1 April to 31 March), worked out from today in
    // India; days late are counted to today, or to the end of the period if that came first.
    const filter: ReportFilter = currentFinancialYear();
    const today = appToday();
    const pack = await this.reportService.pack(actor, filter);
    const drill = (figure: Figure) =>
      figure.contributors.map((c) => ({ date: c.date, number: c.sourceNumber, description: c.description, amount: jsonAmount(c.amount.minor) }));
    const statementLines = (lines: readonly StatementLine[]) =>
      lines.map((l) => ({ kind: l.kind, label: l.label, amount: jsonAmount(l.amount.amount.minor) }));

    return {
      period: { from: filter.from, to: filter.to, lateCountedTo: today < filter.to ? today : filter.to },
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
        income: { total: jsonAmount(pack.profitAndLoss.body.income.total.amount.minor), rows: pack.profitAndLoss.body.income.rows.map((r) => ({ name: r.name, amount: jsonAmount(r.movement.amount.minor) })), lines: statementLines(pack.profitAndLoss.body.income.lines), drill: drill(pack.profitAndLoss.body.income.total) },
        expenses: { total: jsonAmount(pack.profitAndLoss.body.expenses.total.amount.minor), rows: pack.profitAndLoss.body.expenses.rows.map((r) => ({ name: r.name, amount: jsonAmount(r.movement.amount.minor) })), lines: statementLines(pack.profitAndLoss.body.expenses.lines) },
        // Issue #273 — sales less goods returned by customers, and purchases less goods sent back.
        grossSales: jsonAmount(pack.profitAndLoss.body.grossSales.amount.minor),
        salesReturns: jsonAmount(pack.profitAndLoss.body.salesReturns.amount.minor),
        netSales: jsonAmount(pack.profitAndLoss.body.netSales.amount.minor),
        grossPurchases: jsonAmount(pack.profitAndLoss.body.grossPurchases.amount.minor),
        purchaseReturns: jsonAmount(pack.profitAndLoss.body.purchaseReturns.amount.minor),
        netPurchases: jsonAmount(pack.profitAndLoss.body.netPurchases.amount.minor),
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
        rows: pack.stock.body.rows.map((r) => ({ item: r.itemName, warehouse: r.warehouseName, unit: r.unitCode, closing: r.closing, available: r.available, sellable: r.sellable, value: jsonAmount(r.value.minor) })),
      },
      dues: {
        receivables: { title: pack.receivables.header.title, sentence: pack.receivables.body.sentence, total: jsonAmount(pack.receivables.body.total.amount.minor), rows: pack.receivables.body.rows.map((r) => ({ party: r.partyName, outstanding: jsonAmount(r.outstanding.minor), onAccount: jsonAmount(r.onAccount.minor), oldestDaysOverdue: r.oldestDaysOverdue })) },
        // Issue #261 — what is owed never goes below zero; advances paid are their own figure.
        payables: { sentence: pack.payables.body.sentence, total: jsonAmount(pack.payables.body.total.amount.minor), advancesPaid: jsonAmount(pack.payables.body.advancesPaid.minor), rows: pack.payables.body.rows.map((r) => ({ party: r.partyName, outstanding: jsonAmount(r.outstanding.minor), advancesPaid: jsonAmount(r.advancesPaid.minor), oldestDaysOverdue: r.oldestDaysOverdue })) },
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
      // Issue #295 — the TDS customers deducted, by customer and financial-year quarter, for
      // matching against Form 26AS before the return is filed. A reversed receipt contributes nothing.
      tds: {
        title: 'TDS deducted by customers, by quarter',
        sentence: 'Tax your customers kept back on their payments — money the government owes you, matched with Form 26AS.',
        rows: tdsRows(await this.payments.tdsReceivable(actor), (partyId) => this.partyName(companyId, partyId)),
      },
    };
  }

  /**
   * Issue #228 — the review of a supplier bill.
   *
   * Nothing on the screen chooses the kind of GST: the supplier's GST number says which state they
   * are in, our own says which state the goods arrived in, and the reviewed rule decides. The
   * review shows each line's tax and how the total is made up, so the figure that will be claimed
   * is visible before anything is recorded.
   */
  async previewPurchase(actor: ActorContext, input: Record<string, unknown>) {
    const draft = await this.purchaseInput(actor, input);
    if ('alreadyRecorded' in draft) {
      throw conflict('PURCHASE_ALREADY_RECORDED', `${draft.message} Nothing more needs doing.`);
    }
    const { approved, supplierState, godownState, reverseChargeNotes } = draft;
    const preview = this.shop.posting.preview(actor, approved);
    const intra = preview.tax.intraState;
    const head = intra ? 'CGST + SGST' : 'IGST';
    const lineTaxes = approved.lines.map((line) => taxOn(line.taxableValuePaise, line.gstRateBasisPoints));
    const lines = approved.lines.map((line, index) =>
      `${line.description}: ${formatQuantity(line.quantity)} × ${formatPaise(line.ratePaise)} = ${formatPaise(line.taxableValuePaise)}, ${head} ${line.gstRateBasisPoints / 100}% = ${formatPaise(lineTaxes[index] ?? 0n)}`);
    const claimable = preview.tax.cgstPaise + preview.tax.sgstPaise + preview.tax.igstPaise + preview.tax.cessPaise;
    // Issue #289 — a supplier who may not charge GST: the bill carries none, whatever the states.
    const registration = resolveSupplier(this.companyOf(actor), approved.supplierPartyId).gstRegistrationType;
    const reverseCharge = approved.taxLiability === 'REVERSE_CHARGE';
    // Issue #289, part 3 — under reverse charge the blocked tax is still owed (s.9(3)); only its credit goes.
    const rcmPayable = claimable + (reverseCharge ? preview.tax.ineligibleItcPaise : 0n);
    const blockedNotes = DemoApplication.blockedCreditNotes(approved, preview.tax.intraState);
    const why = reverseCharge
      ? `This bill is under reverse charge: ${approved.supplierName} charges no GST on it, and you pay ${formatPaise(rcmPayable)} of GST to the government yourself (CGST s.9(3)).`
      : registration === 'unregistered'
      ? `The supplier is not registered for GST, so their bill carries no GST (CGST s.32(1)) and none can be claimed back (s.16(2)(a)).`
      : registration === 'composition'
        ? `The supplier is a composition dealer, so their bill carries no GST (CGST s.10(4)) and none can be claimed back (s.17(5)(e)).`
        : intra
      ? `The supplier is in ${STATE_NAMES[supplierState] ?? supplierState} (${supplierState}), the same state as your godown, so the bill carries CGST and SGST.`
      : `The supplier is in ${STATE_NAMES[supplierState] ?? supplierState} (${supplierState}) and your godown is in ${STATE_NAMES[godownState] ?? godownState} (${godownState}), so the bill carries IGST.`;
    const sumLine = lineTaxes.length > 1
      ? [`${head}: ${lineTaxes.map(formatPaise).join(' + ')} = ${formatPaise(claimable)}`]
      : [];
    // Issue #261 — an advance already paid to this supplier is offered against this bill, ticked.
    const advance = await this.supplierAdvanceFor(actor, approved, input);
    return {
      state: 'preview',
      title: both('Ready to record', 'दर्ज करने के लिए तैयार'),
      // Nothing has happened yet, so the review says what recording will do, not what it did.
      message: advance !== null && advance.used > 0n
        ? `Recording bill ${approved.invoiceNumber} from ${approved.supplierName} for ${formatPaise(preview.totalPaise)} will take the ${formatPaise(advance.used)} advance already paid off it, so you will owe them ${formatPaise(preview.totalPaise - advance.used)}, due on ${preview.dueDate}, and ${formatPaise(claimable)} of GST you can claim back.`
        : reverseCharge
          ? `Recording bill ${approved.invoiceNumber} from ${approved.supplierName} will add ${formatPaise(preview.totalPaise)} to what you owe them, due on ${preview.dueDate}, and ${formatPaise(rcmPayable)} of GST under reverse charge that you pay the government in cash${claimable === rcmPayable ? ' and then claim back as credit' : `, of which ${formatPaise(claimable)} comes back as credit`}.`
          : `Recording bill ${approved.invoiceNumber} from ${approved.supplierName} will add ${formatPaise(preview.totalPaise)} to what you owe them, due on ${preview.dueDate}, and ${formatPaise(claimable)} of GST you can claim back.`,
      amount: jsonAmount(preview.totalPaise),
      supplier: approved.supplierName,
      taxType: intra ? 'CGST_SGST' : 'IGST',
      tax: { cgst: jsonAmount(preview.tax.cgstPaise), sgst: jsonAmount(preview.tax.sgstPaise), igst: jsonAmount(preview.tax.igstPaise), total: jsonAmount(claimable) },
      // Issue #261 — with an advance taken off, the bill's total is not what is due; the sum below says what is.
      effects: [why, ...reverseChargeNotes, ...blockedNotes, ...lines, ...sumLine,
        ...previewEffects(preview, this.config.location).map((line) => advance !== null && advance.used > 0n && line.startsWith('Supplier due: ') ? `Bill total: ${formatPaise(preview.totalPaise)}` : line),
        ...preview.warnings, ...(advance === null ? [] : advance.effects)],
      token: approved.id,
      advance: advance === null ? null : {
        available: jsonAmount(advance.available), use: advance.use, used: jsonAmount(advance.used),
        owe: jsonAmount(preview.totalPaise - advance.used), label: advance.label, effects: advance.effects,
      },
    };
  }

  /**
   * Issue #261 — what of this supplier's advances this bill will use, and the sum, step by step.
   * Used unless the person unticked it (`useAdvance: no`). `null` when there is no advance to use.
   */
  private async supplierAdvanceFor(actor: ActorContext, approved: ApprovedPurchase, input: Record<string, unknown>) {
    const position = await this.payments.position(actor, approved.supplierPartyId as PartyId, isoDate(approved.invoiceDate));
    const available = position.advancesPaid.minor;
    if (available <= 0n) return null;
    const use = !(input.useAdvance === false || input.useAdvance === 'no' || input.useAdvance === 'false');
    const total = approved.invoiceTotalPaise;
    const used = use ? (available < total ? available : total) : 0n;
    const name = approved.supplierName;
    const label = `Take the ${formatPaise(available < total ? available : total)} advance already paid to ${name} off this bill`;
    const effects = use
      ? [
        `Advance already paid to ${name}: ${formatPaise(available)}. It is taken off this bill:`,
        `${formatPaise(total)} − ${formatPaise(used)} = ${formatPaise(total - used)} you will owe ${name}.`,
        ...(available > used ? [`${formatPaise(available)} − ${formatPaise(used)} = ${formatPaise(available - used)} stays as an advance for their next bill.`] : []),
        'The GST you can claim is the bill\'s GST only. The advance adds none.',
      ]
      : [`Advance already paid to ${name}: ${formatPaise(available)}. You chose not to take it off this bill, so you will owe them ${formatPaise(total)} and the advance stays for a later bill.`];
    return { available, use, used, effects, label };
  }

  async recordPurchase(actor: ActorContext, input: Record<string, unknown>) {
    permissionPortFromActor.require(actor, 'ledger.post.purchase', 'record a supplier bill');
    const draft = await this.purchaseInput(actor, input);
    const state = async () => this.dashboard(actor);
    if ('alreadyRecorded' in draft) {
      // Pressing Record twice, or typing the same bill in again, records it once.
      const dashboard = await state();
      return { state: 'recorded', deduplicated: true, title: both('Already recorded once', 'पहले से एक बार दर्ज है'), message: both(`${draft.message} Stock and the supplier balance were not doubled.`, `${draft.message} स्टॉक और सप्लायर का बाक़ी दोबारा नहीं बढ़ा।`), bill: DemoApplication.purchaseBillJson(draft.alreadyRecorded), stock: DemoApplication.stockOf(dashboard, draft.alreadyRecorded.lines[0]?.itemId), supplier: dashboard.supplier, purchaseCheck: await this.purchaseCheckFor(actor, draft.alreadyRecorded), reverseCharge: await this.reverseChargeJson(actor, draft.alreadyRecorded) };
    }
    const { approved } = draft;
    // A supplier added a moment ago gets their own account in the books before the bill is posted to it.
    await this.shop.ledger.openPartyAccount(this.shop.setupActor, { partyId: approved.supplierPartyId, name: approved.supplierName, kind: 'SUPPLIER' });
    // Issue #261 — worked out before the bill is posted, so it is the advance the review showed.
    const advance = await this.supplierAdvanceFor(actor, approved, input);
    // Issue #289, part 2b — an advance on a reverse-charge bill is allowed now: the day it was paid is
    // a payment date under CGST s.12(3)(b) / s.13(3)(a), so the bill's GST falls due from then.
    const result = await this.shop.posting.post(actor, approved, `web:${approved.id}`);
    if (draft.reverseChargeEntry !== null) await this.recordReverseCharge(actor, approved, result.bill, draft.reverseChargeEntry);
    const used = advance !== null && advance.used > 0n
      ? await this.payments.useSupplierAdvance(actor, {
        partyId: approved.supplierPartyId as PartyId, documentId: result.bill.id, documentNumber: result.bill.invoiceNumber,
        amount: money(advance.used), date: isoDate(approved.invoiceDate), idempotencyKey: `web-purchase:${result.bill.id}`,
      })
      : [];
    const usedTotal = used.reduce((total, part) => total + part.amount.minor, 0n);
    // Issue #274 — the adjustment record: which advance voucher was adjusted against this bill, and by how much.
    const adjustments = await Promise.all(used.map(async (part) => {
      const payment = await this.payments.payment(actor, part.paymentId);
      const voucher = payment?.voucherId ? await this.shop.ledger.getVoucher(actor, payment.voucherId) : null;
      return { paymentId: part.paymentId, voucherNumber: voucher?.number ?? part.paymentId, paidOn: payment?.date ?? '', amount: part.amount.minor };
    }));
    const dashboard = await state();
    const owe = result.bill.totalPaise - usedTotal;
    return {
      state: 'recorded', deduplicated: result.deduplicated, title: result.deduplicated ? 'Already recorded once' : 'Purchase recorded',
      // Issue #274 — with an advance adjusted, what is owed is the bill less the advance, never the whole bill.
      message: result.deduplicated ? 'The existing bill was returned. Stock and the supplier balance were not doubled.'
        : usedTotal > 0n ? result.bill.summary.replace(`${formatPaise(result.bill.totalPaise)} is now owed to`, `${formatPaise(result.bill.totalPaise)} − ${formatPaise(usedTotal)} = ${formatPaise(owe)} is now owed to`)
          : result.bill.summary,
      ...(usedTotal > 0n ? { effects: [
        ...adjustments.map((a) => `Advance adjusted against bill no. ${result.bill.invoiceNumber}: payment voucher ${a.voucherNumber} dated ${a.paidOn === '' ? '' : formatDate(isoDate(a.paidOn))}, ${formatPaise(a.amount)}.`),
        `Advance taken off this bill: ${formatPaise(result.bill.totalPaise)} − ${formatPaise(usedTotal)} = ${formatPaise(owe)} you owe ${result.bill.supplierName}.`,
        ...(advance !== null && advance.available > usedTotal ? [`${formatPaise(advance.available - usedTotal)} stays as an advance for their next bill.`] : []),
      ] } : {}),
      advanceUsed: jsonAmount(usedTotal), owe: jsonAmount(owe),
      advanceAdjustments: adjustments.map((a) => ({ paymentId: a.paymentId, voucherNumber: a.voucherNumber, paidOn: a.paidOn, amount: jsonAmount(a.amount) })),
      bill: DemoApplication.purchaseBillJson(result.bill), stock: DemoApplication.stockOf(dashboard, approved.lines[0]?.itemId), supplier: dashboard.supplier,
      purchaseCheck: await this.purchaseCheckFor(actor, result.bill),
      reverseCharge: await this.reverseChargeJson(actor, result.bill),
    };
  }

  /**
   * Issue #289, part 2b — puts a posted reverse-charge bill in the register: the date it reached the
   * business, its reverse-charge lines as a self-invoice must print them (Rule 46), and the supplier.
   */
  private async recordReverseCharge(actor: ActorContext, approved: ApprovedPurchase, bill: PurchaseBill, entry: ReverseChargeEntryDraft) {
    const companyId = this.companyOf(actor);
    const lines = bill.lines.filter((line) => entry.lineNumbers.includes(line.lineNumber)).map((line) => {
      const typed = approved.lines.find((candidate) => candidate.lineNumber === line.lineNumber);
      return {
        lineNumber: line.lineNumber, description: line.description, hsnSac: typed?.hsnSac ?? '',
        quantity: formatQuantity(line.quantity), unit: line.quantity.unit,
        taxableValuePaise: line.taxableValuePaise, gstRateBasisPoints: typed?.gstRateBasisPoints ?? 0,
        cgstPaise: line.cgstPaise, sgstPaise: line.sgstPaise, igstPaise: line.igstPaise, cessPaise: line.cessPaise,
      };
    });
    await this.shop.reverseCharge.recordPurchase(actor, {
      billId: bill.id, supplierPartyId: bill.supplierPartyId, supplier: this.registerParty(companyId, bill.supplierPartyId),
      supplierRegistered: entry.supplierRegistered, supplyKind: entry.supplyKind,
      invoiceNumber: bill.invoiceNumber, invoiceDate: isoDate(bill.invoiceDate), receivedOn: entry.receivedOn,
      enteredOn: indiaDateOf(bill.postedAt), interState: !bill.tax.intraState, lines,
    });
  }

  /**
   * Issue #289, part 2b — issue the self-invoice for one purchase from an unregistered supplier
   * (CGST s.31(3)(f), Rule 47A). Once per purchase: pressing again returns the one issued.
   */
  async issueSelfInvoice(actor: ActorContext, input: Record<string, unknown>) {
    const companyId = this.companyOf(actor);
    const billId = String(input.billId ?? '').trim();
    if (billId === '') throw invalid('SELF_INVOICE_BILL_REQUIRED', 'Choose the purchase to issue the self-invoice for.');
    const bill = await this.shop.bills.findById(companyId, billId);
    if (bill === null) throw notFound('PURCHASE_BILL_UNKNOWN', 'That supplier bill was not found.');
    const typed = String(input.date ?? '').trim();
    let issuedOn: IsoDate;
    try {
      issuedOn = typed === '' ? appToday() : isoDate(typed);
    } catch {
      throw invalid('SELF_INVOICE_DATE', 'Enter the self-invoice date as a date.');
    }
    const key = String(input.idempotencyKey ?? '').trim() || `self-invoice:${bill.id}`;
    const { invoice, deduplicated } = await this.shop.reverseCharge.issueSelfInvoice(actor, {
      billId: bill.id, issuedOn, idempotencyKey: key, billReversed: bill.state === 'REVERSED',
      recipient: (() => {
        const seller = sellerPrint(companyId, { name: this.config.name, gstin: this.config.gstin }).seller;
        return { name: seller.name, addressLines: seller.addressLines, gstin: seller.gstin ?? this.config.gstin, stateCode: seller.stateCode, stateName: seller.stateName };
      })(),
    });
    const point = await this.shop.taxPointOf(companyId, bill.id);
    const due = selfInvoiceDue(invoice.receivedOn, appToday(), invoice.issuedOn);
    return {
      state: 'recorded', deduplicated,
      title: deduplicated ? 'Self-invoice already issued' : 'Self-invoice issued',
      message: deduplicated
        ? `Self-invoice ${invoice.number} was already issued for bill ${bill.invoiceNumber} from ${bill.supplierName}. A second one was not made.`
        : `Self-invoice ${invoice.number} dated ${formatDate(invoice.issuedOn)} is issued for bill ${bill.invoiceNumber} from ${bill.supplierName}.`,
      effects: [due.words, ...(point === null ? [] : [point.words])],
      number: invoice.number, issuedOn: invoice.issuedOn, billId: bill.id,
      html: selfInvoiceHtml(invoice, { number: bill.invoiceNumber, date: bill.invoiceDate }),
    };
  }

  /** Issue #289, part 2b — the self-invoice of one purchase, as a printable page. */
  async selfInvoicePrint(actor: ActorContext, input: Record<string, unknown>) {
    const companyId = this.companyOf(actor);
    const billId = String(input.billId ?? '').trim();
    const invoice = await this.shop.reverseCharge.selfInvoiceFor(companyId, billId);
    if (invoice === null) throw notFound('SELF_INVOICE_UNKNOWN', 'No self-invoice has been issued for that purchase yet.');
    const bill = await this.shop.bills.findById(companyId, billId);
    return { state: 'print' as const, number: invoice.number, html: selfInvoiceHtml(invoice, { number: bill?.invoiceNumber ?? '', date: bill?.invoiceDate ?? invoice.receivedOn }) };
  }

  /**
   * Issue #289, part 2b — every purchase from an unregistered supplier on reverse charge, with its
   * self-invoice: issued, or how many of the 30 days are left. The ones needing action come first.
   */
  async selfInvoiceList(actor: ActorContext) {
    const companyId = this.companyOf(actor);
    const live = new Set((await this.shop.bills.list(companyId)).filter((bill) => bill.state === 'POSTED').map((bill) => bill.id));
    const rows = await this.shop.reverseCharge.reminders(companyId, appToday(), (billId) => live.has(billId));
    const order: Record<string, number> = { OVERDUE: 0, LAST_DAY: 1, DUE_SOON: 2, NOT_YET_DUE: 3, ISSUED: 4 };
    const sorted = [...rows].sort((a, b) => (order[a.due.state] ?? 9) - (order[b.due.state] ?? 9));
    return {
      toIssue: sorted.filter((row) => row.due.state !== 'ISSUED').length,
      items: sorted.map((row) => ({
        billId: row.billId, supplier: row.supplierName, bill: row.invoiceNumber, receivedOn: row.receivedOn,
        tax: jsonAmount(row.taxPaise), state: row.due.state, lastDay: row.due.lastDay, daysLeft: row.due.daysLeft,
        words: row.due.words, number: row.selfInvoiceNumber,
      })),
    };
  }

  /** A party as a self-invoice or payment voucher prints it: name, address, GSTIN if any, State. */
  private registerParty(companyId: CompanyId, partyId: string): RegisterParty {
    const printed = this.paymentPartyPrint(companyId, partyId);
    return { name: printed.name, addressLines: printed.addressLines, gstin: printed.gstin ?? null, stateCode: printed.stateCode, stateName: printed.stateName };
  }

  /**
   * Issue #289, part 2b — where a reverse-charge bill stands: when its GST falls due and in which
   * return, and (for an unregistered supplier) its self-invoice. `null` for any other bill.
   */
  private async reverseChargeJson(actor: ActorContext, bill: PurchaseBill) {
    const companyId = this.companyOf(actor);
    const purchase = await this.shop.reverseCharge.purchaseFor(companyId, bill.id);
    if (purchase === null) return null;
    const point = await this.shop.taxPointOf(companyId, bill.id);
    const invoice = await this.shop.reverseCharge.selfInvoiceFor(companyId, bill.id);
    const due = purchase.supplierRegistered ? null : selfInvoiceDue(purchase.receivedOn, appToday(), invoice?.issuedOn ?? null);
    return {
      billId: bill.id,
      receivedOn: purchase.receivedOn,
      timeOfSupply: point === null ? null : { date: point.date, clause: point.clause, settled: point.settled, period: taxPeriodOf(point.date), words: point.words },
      selfInvoice: purchase.supplierRegistered ? null : {
        state: due?.state ?? 'NOT_YET_DUE', lastDay: due?.lastDay ?? null, daysLeft: due?.daysLeft ?? null, words: due?.words ?? '',
        number: invoice?.number ?? null, issuedOn: invoice?.issuedOn ?? null,
      },
    };
  }

  /**
   * Issue #311 — the purchase check (#31, GSTR-2B/IMS) of one supplier bill, on the bill itself: the
   * line the Purchase check screen shows for it in its month, in both languages. Reads only; `null`
   * when the month's comparison cannot be read, so the bill is never held up by it.
   */
  private async purchaseCheckFor(actor: ActorContext, bill: PurchaseBill) {
    try {
      const workspace = await this.shop.itc.workspace(actor, taxPeriodOf(isoDate(bill.invoiceDate)));
      const line = workspace.lines.find((row) => row.book?.sourceId === bill.id)
        ?? workspace.lines.find((row) => row.book?.number === bill.invoiceNumber && row.book.supplierPartyId === bill.supplierPartyId);
      if (line === undefined) return null;
      return {
        status: line.status, outcome: line.outcome, portalDataPresent: workspace.portalDataPresent,
        'en-IN': `${line.statusLabel['en-IN']} — ${line.outcomeLabel['en-IN']}`,
        'hi-IN': `${line.statusLabel['hi-IN']} — ${line.outcomeLabel['hi-IN']}`,
        sentence: say(line.sentence),
      };
    } catch (error) {
      // The bill is never held up by its purchase check; why the month could not be read is reported.
      reportUnexpected('api.purchaseCheck', error);
      return null;
    }
  }

  /** Issue #237 — the stock of the goods just bought, not whichever item Home puts first. */
  private static stockOf(dashboard: Awaited<ReturnType<DemoApplication['dashboard']>>, itemId: string | undefined) {
    return dashboard.stockItems.find((item) => item.itemId === itemId) ?? dashboard.stock;
  }

  /** A posted supplier bill as the screen shows it: who, which number, and the tax under each head. */
  private static purchaseBillJson(bill: PurchaseBill) {
    return {
      id: bill.id, number: bill.invoiceNumber, supplier: bill.supplierName, date: bill.invoiceDate, total: jsonAmount(bill.totalPaise),
      taxable: jsonAmount(bill.tax.taxableValuePaise), cgst: jsonAmount(bill.tax.cgstPaise), sgst: jsonAmount(bill.tax.sgstPaise), igst: jsonAmount(bill.tax.igstPaise),
      lines: bill.lines.map((line) => ({ item: line.description, quantity: formatQuantity(line.quantity), taxable: jsonAmount(line.taxableValuePaise), cgst: jsonAmount(line.cgstPaise), sgst: jsonAmount(line.sgstPaise), igst: jsonAmount(line.igstPaise) })),
    };
  }

  /** Issue #228 — a supplier, with the GST number and address their bills carry, and their account in the books. */
  async addSupplier(actor: ActorContext, input: Record<string, unknown>) {
    const companyId = this.companyOf(actor);
    const created = createSupplier(companyId, input);
    await this.shop.ledger.openPartyAccount(this.shop.setupActor, { partyId: created.supplier.id, name: created.supplier.name, kind: 'SUPPLIER' });
    return created;
  }

  async purchase(actor: ActorContext, id: string) {
    this.companyOf(actor);
    const bill = await this.shop.posting.bill(actor, id);
    if (bill === null) throw notFound('PURCHASE_UNKNOWN', 'That supplier bill was not found.');
    return bill;
  }

  // ------------------------------------------------------- issue #23: chasing what is still owed

  /**
   * Issue #403 — the day a reminder is worked out for is the server's today, never a date the request
   * names: a future "today" would chase bills that are not yet due, in stronger words, and log a day
   * that never happened. Tests move the day with `useFixedAppClock(...)`.
   */
  private static reminderDate(): IsoDate {
    return appToday();
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
      partyId: reminder.partyId,
      party: this.partyName(reminder.companyId, String(reminder.partyId)),
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
    const companyId = this.companyOf(actor);
    const today = DemoApplication.reminderDate();
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
        partyId: view.promise.partyId,
        party: this.partyName(companyId, String(view.promise.partyId)),
        amount: jsonAmount(view.promise.amount.minor),
        promisedOn: view.promise.promisedOn,
        outcome: view.outcome,
        explanation: view.explanation,
      })),
      disputes: (await this.collections.disputes(actor)).map((dispute) => ({
        id: dispute.id, documentId: dispute.documentId, reason: dispute.reason, state: dispute.state,
        partyId: dispute.partyId, party: this.partyName(companyId, String(dispute.partyId)),
      })),
      outbox: this.outbox.messages.slice(0, 10),
    };
  }

  async sendReminder(actor: ActorContext, input: Record<string, unknown>) {
    this.companyOf(actor);
    const reminder = await this.collections.send(actor, {
      documentId: String(input.documentId ?? ''),
      today: DemoApplication.reminderDate(),
    });
    return {
      state: reminder.state === 'SENT' ? 'recorded' : 'recorded',
      title: reminder.state === 'SENT' ? 'Reminder sent' : `Reminder ${reminder.state.toLowerCase()}`,
      message: reminder.state === 'FAILED'
        ? (reminder.failureReason ?? both('The message could not be delivered.', 'संदेश नहीं पहुंच पाया।'))
        : say(reminder.message),
      reminder: this.reminderJson(reminder),
    };
  }

  async sendAllReminders(actor: ActorContext, input: Record<string, unknown>) {
    this.companyOf(actor);
    const sent = await this.collections.sendPlanned(actor, DemoApplication.reminderDate());
    return {
      state: 'recorded',
      title: sent.length === 0 ? both('Nothing needed sending', 'कुछ भेजना ज़रूरी नहीं था') : both(`${sent.length} reminder${sent.length === 1 ? '' : 's'} handled`, `${sent.length} रिमाइंडर संभाले`),
      message: sent.length === 0
        ? both('Every open bill was deliberately left alone today. The reasons are on this screen.', 'हर खुला बिल आज जान-बूझकर छोड़ा गया। वजह इस स्क्रीन पर है।')
        : both(`${sent.filter((r) => r.state === 'SENT').length} sent, ${sent.filter((r) => r.state !== 'SENT').length} not delivered.`, `${sent.filter((r) => r.state === 'SENT').length} भेजे गए, ${sent.filter((r) => r.state !== 'SENT').length} नहीं पहुंचे।`),
      reminders: sent.map((reminder) => this.reminderJson(reminder)),
    };
  }

  async retryReminder(actor: ActorContext, input: Record<string, unknown>) {
    this.companyOf(actor);
    const reminder = await this.collections.retry(actor, String(input.reminderId ?? ''), DemoApplication.reminderDate());
    return { state: 'recorded', title: both(`Reminder ${reminder.state.toLowerCase()}`, `रिमाइंडर ${reminder.state.toLowerCase()}`), message: reminder.failureReason ?? say(reminder.message), reminder: this.reminderJson(reminder) };
  }

  /**
   * Issue #237 — the customer a bill is made out to. A promise or a dispute about a bill is always
   * recorded against the bill's own customer, never against whichever customer the demo started
   * with, and a bill that is not one of this business's issued bills is refused.
   */
  private async billParty(actor: ActorContext, documentId: string): Promise<{ partyId: PartyId; name: string; number: string }> {
    const companyId = this.companyOf(actor);
    const invoice = documentId === '' ? undefined : (await this.salesRepository.list(companyId, { state: 'FINAL' })).find((candidate) => candidate.id === documentId);
    if (invoice === undefined) throw notFound('REMINDER_BILL_NOT_FOUND', 'Choose one of your issued bills. That bill is not among them.');
    return { partyId: invoice.partyId, name: this.partyName(companyId, String(invoice.partyId)), number: invoice.number ?? invoice.id };
  }

  /** Issue #237 — the customer chosen on the screen, from this business's own customer list. */
  private chosenCustomer(actor: ActorContext, input: Record<string, unknown>): { partyId: PartyId; name: string } {
    const companyId = this.companyOf(actor);
    const wanted = String(input.partyId ?? '').trim();
    if (wanted === '') throw invalid('REMINDER_CUSTOMER_REQUIRED', 'Choose the customer this is about.');
    const party = customers(companyId).find((candidate) => candidate.id === wanted);
    if (party === undefined) throw notFound('REMINDER_CUSTOMER_NOT_FOUND', 'That customer is not in your customer list.');
    return { partyId: party.id as unknown as PartyId, name: party.legalName };
  }

  async recordPromiseToPay(actor: ActorContext, input: Record<string, unknown>) {
    const bill = await this.billParty(actor, String(input.documentId ?? ''));
    const promise = await this.collections.recordPromise(actor, {
      partyId: bill.partyId,
      documentId: String(input.documentId ?? ''),
      amount: money(paise(input.amount)),
      promisedOn: isoDate(String(input.promisedOn ?? '')),
      note: input.note === undefined ? null : String(input.note),
    });
    return { state: 'recorded', title: both('Promise recorded', 'वादा दर्ज हुआ'), message: both(`${bill.name} promised ${formatINR(promise.amount)} against ${bill.number} by ${promise.promisedOn}. Reminders for this bill are paused until then.`, `${bill.name} ने ${bill.number} के लिए ${promise.promisedOn} तक ${formatINR(promise.amount)} देने का वादा किया। इस बिल के रिमाइंडर तब तक रुके हैं।`), partyId: bill.partyId, party: bill.name };
  }

  async raiseBillDispute(actor: ActorContext, input: Record<string, unknown>) {
    const documentId = input.documentId === undefined || input.documentId === '' ? null : String(input.documentId);
    // A dispute about one bill belongs to that bill's customer; one about the whole account names the customer.
    const party = documentId === null ? this.chosenCustomer(actor, input) : await this.billParty(actor, documentId);
    await this.collections.raiseDispute(actor, {
      partyId: party.partyId,
      documentId,
      reason: String(input.reason ?? ''),
    });
    return { state: 'recorded', title: both('Dispute recorded', 'विवाद दर्ज हुआ'), message: documentId === null ? both(`${party.name}'s bills will not be chased until the dispute is closed.`, `${party.name} के बिलों के लिए विवाद बंद होने तक पैसा नहीं माँगा जाएगा।`) : both(`${'number' in party ? party.number : 'This bill'} for ${party.name} will not be chased until the dispute is closed.`, `${party.name} का ${'number' in party ? party.number : 'यह बिल'} विवाद बंद होने तक नहीं माँगा जाएगा।`), partyId: party.partyId, party: party.name };
  }

  async resolveBillDispute(actor: ActorContext, input: Record<string, unknown>) {
    this.companyOf(actor);
    await this.collections.resolveDispute(actor, String(input.disputeId ?? ''), String(input.resolution ?? 'Settled with the customer.'));
    return { state: 'recorded', title: both('Dispute closed', 'विवाद बंद हुआ'), message: both('The bill goes back into the reminder ladder at the rung its age has reached.', 'बिल रिमाइंडर की सीढ़ी में अपनी उम्र के हिसाब से वापस चला गया।') };
  }

  async stopReminders(actor: ActorContext, input: Record<string, unknown>) {
    const party = this.chosenCustomer(actor, input);
    await this.collections.optOut(actor, party.partyId, String(input.reason ?? ''));
    return { state: 'recorded', title: both('Reminders stopped', 'रिमाइंडर बंद'), message: both(`${party.name} will not receive automatic reminders.`, `${party.name} को अपने-आप रिमाइंडर नहीं जाएँगे।`), partyId: party.partyId, party: party.name };
  }

  async resumeReminders(actor: ActorContext, input: Record<string, unknown> = {}) {
    const party = this.chosenCustomer(actor, input);
    await this.collections.resumeReminders(actor, party.partyId);
    return { state: 'recorded', title: both('Reminders started again', 'रिमाइंडर फिर शुरू'), message: both(`${party.name} will receive automatic reminders again.`, `${party.name} को फिर से अपने-आप रिमाइंडर जाएँगे।`), partyId: party.partyId, party: party.name };
  }

  /**
   * Issue #181 — the customer list and the item list this business bills from.
   *
   * Adding a customer does two things at once, because a name without a place in the books cannot
   * be billed: the master record is written, and the customer's own account is opened in the
   * ledger. Both or neither.
   */
  catalogue(actor: ActorContext) {
    // Issue #395 — a read only reads. The walk-in customer (#288) is made when the shop's address
    // is saved (`saveBusinessDetails`), so it is on the list from then on.
    return readCatalogue(this.companyOf(actor));
  }

  /**
   * Issue #288 — the company's walk-in customer, with its account in the books, opened by `openedBy`.
   * Issue #395: never from a read.
   */
  private async walkIn(actor: ActorContext, openedBy: ActorContext = this.shop.setupActor) {
    const party = walkInCustomer(this.companyOf(actor));
    await this.shop.ledger.openPartyAccount(openedBy, { partyId: party.id, name: party.legalName, kind: 'CUSTOMER' });
    return party;
  }

  async addCustomer(actor: ActorContext, input: Record<string, unknown>) {
    const companyId = this.companyOf(actor);
    const created = createCustomer(companyId, input);
    await this.shop.ledger.openPartyAccount(this.shop.setupActor, {
      partyId: created.customer.id,
      name: created.customer.name,
      kind: 'CUSTOMER',
    });
    return created;
  }

  addItem(actor: ActorContext, input: Record<string, unknown>) {
    return createItem(this.companyOf(actor), input, String(actor.userId));
  }

  /** Issue #308 — the item's own edit dialog: HSN code, barcode, usual price, other name. */
  editItem(actor: ActorContext, input: Record<string, unknown>) {
    // The price and code a bill starts from: changed by someone who may make bills, never by a viewer.
    permissionPortFromActor.require(actor, SALES_PERMISSIONS.draft, 'change an item');
    return editItem(this.companyOf(actor), input, String(actor.userId));
  }

  /**
   * Issue #308 — what the item picker needs from the bills already issued: how many bills each item
   * went on (to put the most-sold first), the six sold on most bills in the last seven days (the
   * chips), and, for the customer on the bill, the price each item was last charged to them at — the
   * same answer the review's "last time you charged them" sentence gives (#11). Cancelled bills and
   * unissued reviews do not count. Reads only.
   */
  async itemSelling(actor: ActorContext, input: Record<string, unknown>) {
    const companyId = this.companyOf(actor);
    const customerId = String(input.customerId ?? '').trim();
    const today = appToday();
    const weekStart = daysAfter(today, -6);
    const bills = (await this.salesRepository.list(companyId, { state: 'FINAL' }))
      .filter((bill) => bill.documentDate <= today)
      // Newest first; two bills of one day in the order they were numbered.
      .sort((a, b) => b.documentDate.localeCompare(a.documentDate) || String(b.number).localeCompare(String(a.number)));
    const sold: Record<string, number> = {};
    const thisWeek: Record<string, number> = {};
    const lastPrices: Record<string, { price: number; number: string | null; date: string }> = {};
    for (const bill of bills) {
      for (const itemId of new Set(bill.lines.map((line) => line.itemId))) {
        sold[itemId] = (sold[itemId] ?? 0) + 1;
        if (bill.documentDate >= weekStart) thisWeek[itemId] = (thisWeek[itemId] ?? 0) + 1;
      }
      if (customerId === '' || bill.partyId !== customerId) continue;
      for (const line of bill.lines) {
        lastPrices[line.itemId] ??= { price: jsonAmount(line.unitPrice.minor), number: bill.number, date: bill.documentDate };
      }
    }
    const mostSoldThisWeek = Object.entries(thisWeek).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([itemId]) => itemId);
    return { sold, mostSoldThisWeek, lastPrices };
  }

  /** Issue #187 — correct an item's HSN code, e.g. when a bill is held up because it is too short. */
  changeItemCode(actor: ActorContext, input: Record<string, unknown>) {
    return changeItemCode(this.companyOf(actor), input, String(actor.userId));
  }

  /**
   * Issue #182 — the delivery side of the catalogue: the transporters the business uses, and the
   * other addresses a customer takes goods at.
   */
  deliveryChoices(actor: ActorContext, partyId: string) {
    const companyId = this.companyOf(actor);
    return {
      transporters: transporters(companyId).map((carrier) => ({ id: carrier.id, name: carrier.name, transporterId: carrier.transporterId })),
      addresses: partyId === '' ? [] : shippingChoices(companyId, resolveCustomer(companyId, partyId).id),
    };
  }

  addTransporter(actor: ActorContext, input: Record<string, unknown>) {
    return createTransporter(this.companyOf(actor), input);
  }

  addShippingAddress(actor: ActorContext, input: Record<string, unknown>) {
    return addShippingAddress(this.companyOf(actor), input);
  }

  /**
   * Issue #280 — where customers' money goes. Changing the UPI id or the bank account on the bills is
   * the classic invoice-fraud path, so every change is kept in the audit trail and shown on Home's
   * activity, whoever made it.
   */
  async saveUpiId(actor: ActorContext, input: Record<string, unknown>) {
    const companyId = this.companyOf(actor);
    const before = upiIdOf(companyId);
    const saved = saveUpiId(companyId, input);
    await this.recordPayeeChange(actor, 'UPI id', before, saved.upiId);
    return saved;
  }

  async saveBusinessDetails(actor: ActorContext, company: { readonly name: string; readonly gstin: string }, input: Record<string, unknown>) {
    const companyId = this.companyOf(actor);
    const describe = (bank: { readonly bankName: string; readonly ifsc: string; readonly accountNumber: string } | null) =>
      bank === null ? null : `${bank.bankName}, ${bank.ifsc}, account ending ${bank.accountNumber.replace(/\s/g, '').slice(-4)}`;
    const before = describe(readBusinessDetails(companyId, company).bank);
    const saved = saveBusinessDetails(companyId, company, input);
    await this.recordPayeeChange(actor, 'bank account', before, describe(saved.bank));
    // Issue #395 — the walk-in customer (#288) needs the shop's address, so it is made, or moved to
    // the new town and PIN code, here, and its account opened as the person saving. Without
    // `ledger.setup` the account waits for the first counter sale.
    if (actor.permissions.includes('ledger.setup')) await this.walkIn(actor, actor);
    else walkInCustomer(companyId);
    return saved;
  }

  private async recordPayeeChange(actor: ActorContext, what: string, before: string | null, after: string | null) {
    if (before === after) return;
    await this.shop.audit.record({
      companyId: this.companyOf(actor), actorId: actor.userId, at: appClock.now().toISOString(),
      action: 'payee.changed', subjectType: 'company', subjectId: String(actor.companyId),
      summary: `The ${what} customers pay into was ${before === null ? `set to ${after}` : after === null ? `removed (it was ${before})` : `changed from ${before} to ${after}`}`,
      details: { what, before: before ?? '', after: after ?? '' },
    });
  }

  /** Issue #224 — a customer's saved address, for the correction form. */
  customerAddress(actor: ActorContext, customerId: string) {
    const companyId = this.companyOf(actor);
    const found = customerBillingAddress(companyId, customerId);
    // Issue #235 — the credit limit is corrected on the same form.
    return { ...found, creditLimit: customerView(companyId, found.customerId).creditLimit };
  }

  /**
   * Issue #224 — corrects a customer's saved address: its lines, town or PIN code. Issue #235 — and
   * their credit limit, when the form sends one (an empty box removes it).
   */
  correctCustomerAddress(actor: ActorContext, input: Record<string, unknown>) {
    const companyId = this.companyOf(actor);
    // The limit is checked first, so a mistyped limit does not leave the address half-saved.
    if ('creditLimit' in input) creditLimitPaiseOf(input.creditLimit);
    const corrected = correctCustomerAddress(companyId, input);
    if (!('creditLimit' in input)) return corrected;
    const customer = setCustomerCreditLimit(companyId, String(input.customerId ?? input.customer ?? ''), input.creditLimit);
    const limit = customer.creditLimitPaise ?? null;
    return {
      ...corrected,
      title: both('Customer corrected', 'ग्राहक ठीक किया गया'),
      message: say({ 'en-IN': `${corrected.message} ${limit === null
        ? `${customer.legalName} has no credit limit, so bills to them are not checked against one.`
        : `${customer.legalName}'s credit limit is ${formatPaise(limit)}. Every bill to them is checked against it.`}`,
        'hi-IN': `${corrected.message} ${limit === null
        ? `${customer.legalName} की कोई उधार सीमा नहीं है, इसलिए उनके बिल सीमा से जाँचे नहीं जाते।`
        : `${customer.legalName} की उधार सीमा ${formatPaise(limit)} है। हर बिल उसी से जाँचा जाता है।`}` }),
    };
  }

  /**
   * Issue #288 — "walk-in" names the company's walk-in customer, for callers that have not read the
   * list. Shared by the review and the live total (#306), so both bill the same customer.
   */
  private async saleCustomerOf(actor: ActorContext, given: Record<string, unknown>) {
    const companyId = this.companyOf(actor);
    const asked = String(given.customerId ?? given.customer ?? given.party ?? '').trim();
    const walkIn = asked.toLowerCase() === 'walk-in' || customers(companyId).some((party) => party.id === asked && isWalkIn(party))
      ? await this.walkIn(actor)
      : null;
    const input = walkIn === null ? given : { ...given, customerId: walkIn.id };
    if (walkIn !== null && !['', 'same'].includes(String(input.shipTo ?? '').trim().toLowerCase())) {
      throw invalid('WALK_IN_DELIVERY', 'A walk-in customer takes the goods at the counter. To send them somewhere else, add the customer with their name and address, and choose them instead.');
    }
    return { walkIn, input };
  }

  /** Issue #288 — CGST Rule 46(e): from ₹50,000 of taxable value a walk-in cannot be billed. */
  private static walkInTooLarge(taxable: bigint) {
    return invalid('WALK_IN_NAME_REQUIRED', `This bill's taxable value is ${formatPaise(taxable)}. From ${formatPaise(WALK_IN_LIMIT)} the law asks for the buyer's name, address and state on the bill (CGST Rule 46(e)). Add the customer with their name and address, and choose them instead of Walk-in.`);
  }

  async previewSale(actor: ActorContext, given: Record<string, unknown>) {
    const { walkIn, input } = await this.saleCustomerOf(actor, given);
    const exportSale = this.exportParticulars(input);
    const zeroRated = exportSale === null || !EXPORT_SUPPLIES[exportSale.kind].zeroRated
      ? {}
      : { zeroRated: EXPORT_SUPPLIES[exportSale.kind].taxPaid ? 'WITH_TAX' as const : 'WITHOUT_TAX' as const };
    // Issue #233 — one key per review, sent by the screen with the review and again with Record, so
    // pressing Record twice issues one bill. The screen never uses the customer's own reference as
    // the key: two real sales can carry the same order number, and the second must not come back as
    // the first. Issue #392 — a review without a key is refused rather than given an invented one.
    // Issue #256 — this review replaces the one the same sale form showed before it. That earlier
    // review was never issued, so it is forgotten rather than left behind as "a bill waiting".
    const replaced = String(input.replaces ?? '').trim();
    if (replaced !== '' && replaced !== String(input.requestId ?? '')) {
      await this.discardReview(actor, `web-sale:${replaced}`, 'a later review of the same sale replaced it');
    }
    // The bill is read before its key, so a form that cannot be read is answered as that.
    const saleInput = { ...this.saleInput(input), ...zeroRated };
    const draft = await this.sales.createDraft(actor, { idempotencyKey: `web-sale:${requestKeyOf(input, 'SALE_REQUEST_ID_REQUIRED', 'bill')}`, input: saleInput });
    try {
      if (exportSale !== null) this.exportSales.set(draft.id, exportSale);
      // Issue #266 — the date the bill will carry, said plainly when it is not today.
      const dateNotice = await this.saleDateNotice(actor, draft.documentDate);
      // Issue #288 — CGST Rule 46(e): from ₹50,000 of taxable value an unregistered buyer's name,
      // address and state must be on the bill, so a walk-in cannot be billed that much.
      const taxable = draft.pricing?.totals.taxableValue.minor ?? 0n;
      if (walkIn !== null && taxable >= WALK_IN_LIMIT) throw DemoApplication.walkInTooLarge(taxable);
      const checked = await this.checkSale(actor, draft);
      // Issue #182 — the delivery answers, checked once and kept against this draft, so the bill is
      // frozen with exactly what the screen showed rather than with a second reading of the form.
      const customer = resolveCustomer(this.config.companyId, String(input.customerId ?? input.customer ?? input.party ?? ''));
      const delivery = deliveryDetails(this.config.companyId, customer, input);
      this.deliveries.set(draft.id, delivery);
      // Issue #288 — money taken at the counter is recorded with the bill, so the review says so
      // instead of "the customer balance will increase".
      const paidNow = this.paidNowOn(input, draft, customer.legalName);
      // Issue #296 — a composition business issues a Bill of Supply: said first, so nobody expects GST on it.
      const billOfSupply = draft.pricing?.supplierRegistration === 'COMPOSITION';
      const effects = paidNow === null ? checked.effects : checked.effects.map((effect) => (effect === say(BALANCE_WILL_INCREASE) ? say(paidNow.sentence) : effect));
      return {
        ...checked,
        billKind: billOfSupply ? 'BILL_OF_SUPPLY' as const : 'TAX_INVOICE' as const,
        effects: billOfSupply
          ? [both('This will be a Bill of Supply, not a tax invoice. Your business is on the composition scheme, so no GST is added and the bill says "composition taxable person, not eligible to collect tax on supplies".', 'यह टैक्स इनवॉइस नहीं, Bill of Supply होगा। आपका बिज़नेस कम्पोज़िशन स्कीम में है, इसलिए GST नहीं जुड़ता और बिल पर "composition taxable person, not eligible to collect tax on supplies" लिखा रहता है।'), ...effects]
          : effects,
        paidNow: paidNow === null ? null : { mode: paidNow.mode, amount: jsonAmount(paidNow.amount), due: jsonAmount(paidNow.due) },
        dateNotice,
        placeOfSupply: draft.supplyKind === 'SERVICES'
          ? DemoApplication.servicePlaceOfSupplyReason(draft.pricing?.placeOfSupplyStateCode ?? null, customer, walkIn !== null)
          : walkIn === null
            ? delivery.placeOfSupplyReason
            : both(`Place of supply: ${STATE_NAMES[delivery.placeOfSupplyStateCode] ?? delivery.placeOfSupplyStateCode} (${delivery.placeOfSupplyStateCode}) — the goods are handed over at your counter.`, `सप्लाई का स्थान: ${STATE_NAMES[delivery.placeOfSupplyStateCode] ?? delivery.placeOfSupplyStateCode} (${delivery.placeOfSupplyStateCode}) — माल आपके काउंटर पर दिया जाता है।`),
        // Issue #143 — said on the review, so nobody issues an export thinking it is a local sale.
        exportSupply: exportSale === null ? null : {
          kind: exportSale.kind,
          endorsement: EXPORT_SUPPLIES[exportSale.kind].endorsement,
        },
        // Whether this consignment may not leave without an e-way bill. It never blocks the bill:
        // an e-way bill is raised against an issued invoice number, so the bill comes first.
        ewayBill: await this.ewayReminder(actor, draft, delivery),
        // Issue #239 — whether this bill needs a government e-invoice number, decided here from
        // what the app already knows and said in one line. Never a reason to hold the bill back.
        eInvoice: ((decision) => ({ ...decision, message: say(decision.message) }))(this.eInvoiceDecisionFor(draft)),
      };
    } catch (error) {
      // Issue #256 — a review the app refused (600 KGS asked, 50 KGS in the godown) saved nothing
      // from the person's point of view, so nothing of it is kept: no draft for Reports to call
      // "a bill waiting". It never had a number, so the number series is untouched.
      // The refusal is what the person needs to read, so a failure to tidy up never replaces it.
      await this.discardReview(actor, draft.idempotencyKey, 'the app refused the review').catch((tidy: unknown) => reportError('api.discardReview', tidy));
      throw error;
    }
  }

  /**
   * Issue #306 — the bill's GST and total while it is being typed, from the same input a review
   * takes. **Nothing is stored**: no draft, no audit entry, no number, no stock held. The figures come
   * from `SalesService.estimate`, which runs the very calculator and stock check a review runs, so
   * `total` here is always the `amount` the review and the issued bill carry.
   *
   * Anything that would stop the bill — a customer not chosen yet, a rate missing, goods short, a
   * date the bill cannot carry — comes back in `refusals` as data, never as an error. Only a person
   * who may not start a bill at all is refused outright (403), before anything is read.
   */
  async estimateSale(actor: ActorContext, given: Record<string, unknown>) {
    this.companyOf(actor);
    permissionPortFromActor.require(actor, SALES_PERMISSIONS.draft, 'start a bill');
    const refused = (refusals: readonly Refusal[]) => ({ state: 'estimate' as const, ready: false, total: null, totals: null, lines: [], placeOfSupply: null, ewayBill: null, eInvoice: null, dateNotice: null, refusals });
    try {
      const { walkIn, input } = await this.saleCustomerOf(actor, given);
      const exportSale = this.exportParticulars(input);
      const zeroRated = exportSale === null || !EXPORT_SUPPLIES[exportSale.kind].zeroRated
        ? {}
        : { zeroRated: EXPORT_SUPPLIES[exportSale.kind].taxPaid ? 'WITH_TAX' as const : 'WITHOUT_TAX' as const };
      const bill = await this.sales.estimate(actor, { ...this.saleInput(input), ...zeroRated });
      const dateNotice = await this.saleDateNotice(actor, bill.documentDate);
      const refusals: Refusal[] = bill.problems.map((problem) => ({
        code: problem.code,
        ...(problem.lineId === undefined ? {} : { lineId: problem.lineId, itemId: bill.lines.find((line) => line.lineId === problem.lineId)?.itemId }),
        'en-IN': problem.message['en-IN'],
        'hi-IN': problem.message['hi-IN'],
      }));
      const pricing = bill.pricing;
      if (pricing === null) return { ...refused(refusals), dateNotice };
      if (walkIn !== null && pricing.totals.taxableValue.minor >= WALK_IN_LIMIT) {
        const error = DemoApplication.walkInTooLarge(pricing.totals.taxableValue.minor);
        refusals.push({ code: error.code, 'en-IN': error.message, 'hi-IN': `इस बिल का टैक्सेबल वैल्यू ${formatPaise(pricing.totals.taxableValue.minor)} है। ${formatPaise(WALK_IN_LIMIT)} से ऊपर क़ानून (CGST Rule 46(e)) बिल पर ख़रीदार का नाम, पता और राज्य माँगता है। ग्राहक को नाम और पते के साथ जोड़िए, और Walk-in की जगह उन्हें चुनिए।` });
      }
      const customer = resolveCustomer(this.config.companyId, String(input.customerId ?? input.customer ?? input.party ?? ''));
      const delivery = deliveryDetails(this.config.companyId, customer, input);
      const state = currentStates().find((row) => row.code === pricing.placeOfSupplyStateCode)?.name ?? pricing.placeOfSupplyStateCode;
      const taxes = pricing.split === 'IGST' ? 'IGST' : pricing.split === 'CGST_UTGST' ? 'CGST + UTGST' : 'CGST + SGST';
      const eway = this.ewayDecisionOf(bill, delivery);
      const eInvoice = this.eInvoiceDecisionFor({ ...bill, exportKind: exportSale?.kind });
      const amounts = (from: { taxableValue: Money; cgst: Money; sgst: Money; utgst: Money; igst: Money; cess: Money; totalTax: Money }) => ({
        taxableValue: jsonAmount(from.taxableValue.minor), cgst: jsonAmount(from.cgst.minor), sgst: jsonAmount(from.sgst.minor),
        utgst: jsonAmount(from.utgst.minor), igst: jsonAmount(from.igst.minor), cess: jsonAmount(from.cess.minor), totalTax: jsonAmount(from.totalTax.minor),
      });
      return {
        state: 'estimate' as const,
        // True when nothing stops the bill: pressing Review would show exactly these figures.
        ready: refusals.length === 0,
        total: jsonAmount(pricing.totals.invoiceValue.minor),
        totals: { ...amounts(pricing.totals), roundOff: jsonAmount(pricing.totals.roundOff.minor), total: jsonAmount(pricing.totals.invoiceValue.minor) },
        lines: pricing.lines.map((line) => ({
          lineId: line.lineId, itemId: line.itemId, itemName: line.itemName, kind: line.kind, chargeKind: line.chargeKind,
          ratePercent: line.ratePercentTimes100 === null ? null : Number(line.ratePercentTimes100) / 100,
          ...amounts(line), lineTotal: jsonAmount(line.lineTotal.minor),
        })),
        placeOfSupply: {
          stateCode: pricing.placeOfSupplyStateCode, split: pricing.split,
          'en-IN': `${state} sale · ${taxes}`,
          'hi-IN': `${state} की बिक्री · ${taxes}`,
          reason: bill.supplyKind === 'SERVICES'
            ? DemoApplication.servicePlaceOfSupplyReason(pricing.placeOfSupplyStateCode, customer, walkIn !== null)
            : walkIn === null
            ? delivery.placeOfSupplyReason
            : both(`Place of supply: ${STATE_NAMES[delivery.placeOfSupplyStateCode] ?? delivery.placeOfSupplyStateCode} (${delivery.placeOfSupplyStateCode}) — the goods are handed over at your counter.`, `सप्लाई का स्थान: ${STATE_NAMES[delivery.placeOfSupplyStateCode] ?? delivery.placeOfSupplyStateCode} (${delivery.placeOfSupplyStateCode}) — माल आपके काउंटर पर दिया जाता है।`),
        },
        ewayBill: eway === null ? null : eway.outcome === 'REQUIRED'
          ? { needed: true, 'en-IN': 'Needs an e-way bill before the goods leave', 'hi-IN': 'माल निकलने से पहले ई-वे बिल चाहिए', reason: eway.reason }
          : { needed: false, 'en-IN': 'No e-way bill needed', 'hi-IN': 'ई-वे बिल की ज़रूरत नहीं', reason: eway.reason },
        eInvoice: {
          needed: eInvoice.needed, askTurnover: eInvoice.askTurnover, message: say(eInvoice.message),
          ...(eInvoice.needed === 'YES'
            ? { 'en-IN': 'Needs a government e-invoice number, sent by itself when you issue the bill', 'hi-IN': 'सरकारी ई-इनवॉइस नंबर चाहिए, बिल जारी करते ही अपने आप भेजा जाएगा' }
            : eInvoice.needed === 'NO'
              ? { 'en-IN': 'No e-invoice needed', 'hi-IN': 'ई-इनवॉइस की ज़रूरत नहीं' }
              : { 'en-IN': 'E-invoice not decided yet: answer the turnover question in Business details', 'hi-IN': 'ई-इनवॉइस अभी तय नहीं: बिज़नेस डिटेल्स में टर्नओवर का सवाल भरिए' }),
        },
        dateNotice,
        refusals,
      };
    } catch (error) {
      if (!(error instanceof DomainError) || error.kind === 'FORBIDDEN') throw error;
      return refused([{ code: error.code, 'en-IN': error.message, 'hi-IN': error.details['hi-IN'] ?? error.message }]);
    }
  }

  /**
   * Issue #266 — what the date on a new bill means, checked on every review and again at Record.
   *
   *   - **After today: refused.** A tax invoice carries the date it is issued. A bill issued today
   *     cannot say tomorrow, and a date in the next financial year would also take a number from
   *     next year's series.
   *   - **In a month whose GST return has gone to the government (downloaded for filing, being
   *     filed, or filed): refused.** That return went without this bill, so the bill would be missing
   *     from it. A correction to a filed month is a credit or debit note, never a new bill dated back.
   *   - **In a month whose return is approved but not yet sent: allowed, and said.** The GST returns
   *     screen already reports the change (#30), and the return is reopened and approved again.
   *   - **Before today: allowed, and said.** A bill can be made the day after the goods left, and the
   *     demo books hold older bills, so an earlier date is not refused; the review says it in one line.
   *   - **Before a bill already issued: allowed, and said.** The numbers stay in one unbroken run;
   *     the review says this bill will have a later number than a bill with a later date.
   */
  private async saleDateNotice(actor: ActorContext, date: IsoDate): Promise<string | null> {
    const today = appToday();
    if (date > today) {
      throw invalid('SALE_DATE_AFTER_TODAY', `A bill cannot be dated after today. This one says ${formatClaimDate(date)}, and today is ${formatClaimDate(today)}. Date it today, or the day the goods left if that was earlier.`);
    }
    const companyId = this.companyOf(actor);
    const period = taxPeriodOf(date);
    const month = formatTaxPeriod(period);
    let approvedMonth = false;
    for (const returnType of ['GSTR1', 'GSTR3B'] as const) {
      const prepared = await this.returnMonths.find(companyId, period, returnType);
      if (prepared === null || !LOCKED_RETURN_STATES.has(prepared.state)) continue;
      const sent = SENT_RETURN_STATES[prepared.state];
      if (sent !== undefined) {
        throw notAllowed('SALE_DATE_MONTH_CLOSED', `This bill says ${formatClaimDate(date)}, but the GST return for ${month} has already been ${sent}, so a new bill cannot be dated in that month. Date it today, ${formatClaimDate(today)}.`);
      }
      approvedMonth = true;
    }
    if (date === today) return null;
    const lines = [both(`This bill will be dated ${formatClaimDate(date)}, which is before today, ${formatClaimDate(today)}.`, `यह बिल ${formatClaimDate(date)} की तारीख़ का बनेगा, जो आज ${formatClaimDate(today)} से पहले की है।`)];
    if (approvedMonth) {
      lines.push(both(`The GST return for ${month} is already approved without it, so that return will have to be reopened and approved again.`, `${month} का GST रिटर्न इसके बिना पहले से मंज़ूर है, इसलिए वह रिटर्न फिर से खोलकर दोबारा मंज़ूर करना होगा।`));
    }
    const later = (await this.salesRepository.list(companyId))
      .filter((bill) => bill.number !== null && financialYearOf(bill.documentDate) === financialYearOf(date) && bill.documentDate > date)
      .sort((a, b) => b.documentDate.localeCompare(a.documentDate))[0];
    if (later !== undefined) {
      lines.push(both(`Bill ${later.number} is already issued with the date ${formatClaimDate(later.documentDate)}, so this bill will get a later number with an earlier date.`, `बिल ${later.number} ${formatClaimDate(later.documentDate)} की तारीख़ से पहले से बना है, इसलिए इस बिल को पहली तारीख़ के साथ बाद का नंबर मिलेगा।`));
    }
    return lines.join(' ');
  }

  /**
   * Issue #256 — forgets a sale review that was never issued, found by its review key. Only the
   * person who made the review can have it forgotten, only while it is still unissued, and a bill
   * held for approval is never touched: that one was held on purpose.
   */
  private async discardReview(actor: ActorContext, key: string, reason: string): Promise<void> {
    const review = await this.salesRepository.findByIdempotencyKey(this.companyOf(actor), key);
    if (review === null || review.createdBy !== actor.userId) return;
    if ((review.state !== 'DRAFT' && review.state !== 'NEEDS_INFO') || review.number !== null) return;
    await this.sales.discardDraft(actor, review.id, reason);
    this.exportSales.delete(review.id);
    this.deliveries.delete(review.id);
  }

  /**
   * Issue #182 — does this load need an e-way bill before the lorry leaves?
   *
   * The answer comes from the same applicability rules the e-way bill screen decides with, over the
   * consignment's value including tax and the two states, so the reminder and the decision cannot
   * disagree.
   */
  private async ewayReminder(_actor: ActorContext, draft: SalesInvoice, delivery: DeliveryDetails | null) {
    const decision = this.ewayDecisionOf(draft, delivery);
    if (decision === null || decision.outcome !== 'REQUIRED') return null;
    return {
      outcome: decision.outcome,
      message: both('This consignment needs an e-way bill before the vehicle leaves.', 'गाड़ी चलने से पहले इस कंसाइनमेंट का ई-वे बिल ज़रूरी है।'),
      reason: decision.reason,
      ruleId: decision.ruleId,
    };
  }

  /** Issue #290 — what the challan desk needs: the godown's stock and the e-way bill rules. */
  challanHooks(): ChallanHooks {
    const goodsLines = (challan: ChallanFacts) => challan.lines
      .filter((line) => itemView(this.config.companyId, line.itemId).kind === 'goods')
      .map((line) => ({ lineId: line.lineId, itemId: line.itemId, warehouseId: line.warehouseId ?? this.shop.warehouseId, quantity: line.quantity }));
    const inventory = this.shop.inventoryService;
    return {
      check: async (actor, challan) => {
        const result = await inventory.reserve(actor, { documentId: challan.id ?? 'challan-check', documentDate: challan.documentDate, lines: goodsLines(challan), hold: false });
        if (result.ok) return null;
        return result.shortfalls
          .map((short) => `You have ${short.available} ${short.unit} of ${short.itemName} in ${short.warehouseName}, and this challan sends ${short.required} ${short.unit}. Goods have to be in the godown to leave on a challan.`)
          .join(' ');
      },
      hold: async (actor, challan) => {
        const lines = goodsLines(challan);
        if (lines.length === 0) return;
        // Out until billed or cancelled: no timer puts goods that have left back on sale.
        await inventory.reserve(actor, { documentId: challan.id, documentDate: challan.documentDate, lines, holdUntil: '9999-12-31T00:00:00.000Z' });
      },
      release: async (actor, challanId) => { await inventory.release(actor, challanId); },
      eway: (challan) => {
        try {
          const decision = decideEwayApplicability({
            movementId: challan.id ?? 'challan-check',
            reason: challanReason(challan.reason).movementReason,
            consignor: dispatchFrom(this.config.companyId, { name: this.config.name, gstin: this.config.gstin }),
            billTo: this.movementParty(String(challan.partyId)),
            documents: [consignmentFromChallan({ ...challan, id: challan.id ?? 'challan-check', number: challan.number ?? 'DC (not yet numbered)' })],
            transportMode: 'ROAD',
            vehicleType: 'REGULAR',
            conveyance: 'HIRED_VEHICLE',
          }, { on: challan.documentDate });
          return decision.outcome === 'REQUIRED' || decision.outcome === 'NOT_REQUIRED'
            ? { outcome: decision.outcome, reason: decision.reason, ruleId: decision.ruleId }
            : null;
        } catch (error) {
          // The challan is still issued; the e-way bill screen decides again. A fault here is ours.
          reportUnexpected('api.challanEwayDecision', error);
          return null;
        }
      },
    };
  }

  /**
   * Issue #290 — bills the goods on a challan: the challan's hold is let go, the bill is made for
   * exactly its goods (which takes them out of stock once), and the bill is linked to the challan.
   * If the bill cannot be made, the goods are held again and nothing else changes.
   */
  async billChallan(actor: ActorContext, input: Record<string, unknown>) {
    const challan = await this.challans.get(actor, String(input.challan ?? ''));
    if (challan.state !== 'ISSUED') {
      throw invalid('CHALLAN_NOT_OPEN', `${challan.number} is ${challan.state === 'CANCELLED' ? 'cancelled' : 'already billed'}, so there is nothing to bill.`);
    }
    if (!challanReason(challan.reason).invoiceFollows) {
      throw invalid('CHALLAN_NOT_A_SUPPLY', `${challan.number} moved goods that are not being sold (${challanReason(challan.reason).label}), so no bill follows it.`);
    }
    await this.challans.hooks.release(actor, challan.id);
    let recorded;
    try {
      recorded = await this.recordSale(actor, {
        customerId: String(challan.partyId),
        lines: challan.lines.map((line) => ({ itemId: line.itemId, quantity: (Number(line.quantity.scaled) / 1_000_000).toString(), rate: (Number(line.unitPrice.minor) / 100).toString() })),
        date: String(input.date ?? '') || appToday(),
        terms: String(input.terms ?? '30'),
        reference: String(input.reference ?? '') || `challan-bill:${challan.id}`,
        approvalReason: String(input.approvalReason ?? ''),
        // One bill per challan: the challan itself is what a retry repeats.
        requestId: String(input.requestId ?? '') || `challan-bill:${challan.id}`,
      }, false);
      // Issue #301 — a challan is billed or refused, never held: the goods are already with them.
      if (!('invoice' in recorded)) throw new Error('A challan bill was held for approval.');
    } catch (error) {
      await this.challans.hooks.hold(actor, challan);
      throw error;
    }
    const linked = await this.challans.linkInvoice(actor, { challan: challan.id, invoice: recorded.invoice.id });
    return { ...recorded, message: `${recorded.message} ${linked.message}`, challan: linked.challan, effects: linked.effects };
  }

  /** The e-way bill decision itself, or `null` when the rules cannot answer. Issue #306 shows both answers. */
  private ewayDecisionOf(draft: SalesInvoice, delivery: DeliveryDetails | null) {
    const pricing = draft.pricing;
    if (pricing === null) return null;
    // Issue #287 — CGST Rule 138(1): an e-way bill is for the movement of goods. A service moves
    // none, so its bill is never checked or reminded for one.
    if (draft.supplyKind === 'SERVICES') return null;
    try {
      const consignor = dispatchFrom(this.config.companyId, { name: this.config.name, gstin: this.config.gstin });
      const billTo = this.movementParty(draft.partyId);
      const decision = decideEwayApplicability({
        movementId: draft.id,
        reason: 'SUPPLY',
        consignor,
        billTo,
        // Where the goods actually finish, which is what the limit is judged on.
        ...(delivery === null || delivery.deliverTo === null ? {} : { shipTo: delivery.deliverTo }),
        documents: [{
          documentId: draft.id,
          documentType: pricing.supplierRegistration === 'COMPOSITION' ? 'BILL_OF_SUPPLY' : 'TAX_INVOICE',
          documentNumber: draft.number ?? draft.id,
          documentDate: draft.documentDate,
          lines: consignmentLinesOf(pricing.lines),
        }],
        transportMode: 'ROAD',
        vehicleType: 'REGULAR',
        conveyance: 'HIRED_VEHICLE',
      }, { on: draft.documentDate });
      return decision.outcome === 'REQUIRED' || decision.outcome === 'NOT_REQUIRED' ? decision : null;
    } catch (error) {
      // The reminder is a courtesy. If the rules cannot answer, the e-way bill screen still can,
      // and a bill is never held back over it. Why they could not answer is still worth knowing.
      reportUnexpected('api.saleEwayReminder', error);
      return null;
    }
  }

  /**
   * The checks shown before a bill is issued: its tax, what was last agreed with this customer, and
   * their credit. Issue #142 — a draft made from a quotation is checked here too, so a converted
   * quotation meets exactly the checks a typed sale does.
   */
  /** Issue #293 — a line's rate per unit after its discount, rounded to the paisa. */
  private static priceAfterDiscount(line: SalesInvoice['lines'][number], priced: { readonly grossAmount: { readonly minor: bigint }; readonly discountAmount: { readonly minor: bigint } } | undefined) {
    if (line.discount === undefined || priced === undefined || line.quantity.scaled <= 0n) return line.unitPrice;
    const net = priced.grossAmount.minor - priced.discountAmount.minor;
    return money((net * 1_000_000n + line.quantity.scaled / 2n) / line.quantity.scaled);
  }

  /** Issue #11 / #301 — the trade-terms verdict on a draft, with an approval's reason when one is given. */
  private termsQuote(actor: ActorContext, draft: SalesInvoice, override?: { readonly reason: string }): Promise<TradeTermsQuote> {
    const pricing = draft.pricing;
    if (pricing === null) throw invalid('SALES_NOT_PRICED', 'This bill has not been worked out yet.');
    return this.terms.quote(actor, {
      // The customer and the goods this bill is actually for, so "last time you charged them" is
      // about them and about these goods, not about a demo party's soap.
      partyId: draft.partyId,
      documentDate: draft.documentDate,
      documentId: draft.id,
      // Issue #235 — the whole bill, GST, freight and other charges included: what they will owe.
      billValue: pricing.totals.invoiceValue,
      lines: draft.lines.map((line) => ({
        lineId: line.lineId,
        itemId: line.itemId,
        itemName: pricing.lines.find((priced) => priced.lineId === line.lineId)?.itemName ?? itemView(this.config.companyId, line.itemId).name,
        unit: line.quantity.unit,
        quantity: String(Number(line.quantity.scaled) / 1_000_000),
        // Issue #293 — what each unit is really sold for after its discount, so #11's discount limit
        // and approval apply to a typed discount exactly as to a lowered rate.
        unitPrice: DemoApplication.priceAfterDiscount(line, pricing.lines.find((priced) => priced.lineId === line.lineId)),
      })),
      ...(override === undefined ? {} : { override }),
    });
  }

  /**
   * Issue #301 — whether this person may approve what the sale review asked approval for: approving a
   * bill (`sales.approve`), plus the credit or discount permission for what is being allowed.
   */
  private static approvalFor(actor: ActorContext, quote: TradeTermsQuote) {
    if (quote.outcome === 'ALLOW') return { required: false, canApprove: true, who: '' };
    const credit = quote.credit.outcome !== 'ALLOW' && quote.reasons.includes(quote.credit.sentence);
    const discount = quote.lines.some((line) => line.discount?.outcome === 'NEEDS_APPROVAL');
    const needed: string[] = [SALES_PERMISSIONS.approve];
    if (credit) needed.push(TRADE_TERMS_PERMISSIONS.overrideCreditLimit);
    if (discount) needed.push(TRADE_TERMS_PERMISSIONS.approveDiscount);
    const who = credit
      ? 'someone allowed to approve bills past a customer’s credit limit'
      : 'the owner, or someone allowed to approve discounts';
    return { required: true, canApprove: needed.every((permission) => actor.permissions.includes(permission)), who };
  }

  /**
   * Issue #301 — a sale whose review needs approval is never issued without one. The person issuing it
   * either approves it, giving a reason that is kept with their name in the audit trail, or, when they
   * cannot, the bill is held as waiting for approval (`hold`), or refused when there is nowhere to hold it.
   * Returns the held result, or `null` when the bill may be issued.
   *
   * A held bill is not a tax invoice: CGST Act 2017 s.31(1) (in force 1 July 2017) wants the invoice
   * issued before or at the removal of the goods, so they should not leave until it is approved.
   */
  private async approvalGate(actor: ActorContext, token: string, approval: { readonly reason: string; readonly hold: boolean }) {
    const draft = await this.salesRepository.findById(this.companyOf(actor), token);
    // A bill already issued or cancelled is for `finalise` to answer, as a repeat or a refusal.
    if (draft === null || draft.pricing === null || draft.state === 'FINAL' || draft.state === 'CANCELLED') return null;
    const quote = await this.termsQuote(actor, draft);
    const gate = DemoApplication.approvalFor(actor, quote);
    if (!gate.required) return null;
    const why = quote.reasons.map((reason) => say(reason)).join(' ');
    const reason = approval.reason.trim();
    if (reason !== '' && gate.canApprove) {
      // Writes the approval, who gave it and why, to the audit trail; refuses an empty reason.
      await this.termsQuote(actor, draft, { reason });
      return null;
    }
    if (reason !== '') {
      throw forbidden('SALE_APPROVAL_NOT_ALLOWED', `You cannot approve this bill. It needs ${gate.who}. Nothing was issued.`, { details: { approver: gate.who } });
    }
    if (gate.canApprove) {
      throw notAllowed('SALE_APPROVAL_REQUIRED', `${why} Nothing was issued. Say why you are allowing it, and it is issued with your name on the approval.`, { details: { approver: gate.who, canApprove: 'true' } });
    }
    if (!approval.hold) {
      throw notAllowed('SALE_APPROVAL_REQUIRED', `${why} Nothing was issued. Ask ${gate.who} to make this bill.`, { details: { approver: gate.who, canApprove: 'false' } });
    }
    const held = draft.state === 'PENDING_APPROVAL' ? draft : await this.sales.submitForApproval(actor, token);
    if (held.state === 'NEEDS_INFO') {
      throw notAllowed('SALES_NEEDS_INFO', 'This bill needs more information before it can be sent for approval.');
    }
    return {
      state: 'waiting',
      title: both('Waiting for approval', 'मंज़ूरी का इंतज़ार'),
      message: both(`${why} The bill was not issued. It is waiting for approval from ${gate.who}.`, `${why} बिल नहीं बना। ${gate.who} की मंज़ूरी का इंतज़ार है।`),
      amount: jsonAmount(held.pricing?.totals.invoiceValue.minor ?? 0n),
      token: held.id,
      approver: gate.who,
    };
  }

  /** Issue #301 — bills held for approval, with why, for someone who may approve them. */
  async salesWaitingForApproval(actor: ActorContext) {
    const held = await this.salesRepository.list(this.companyOf(actor), { state: 'PENDING_APPROVAL' });
    const bills = await Promise.all(held.map(async (bill) => {
      const quote = bill.pricing === null ? null : await this.termsQuote(actor, bill);
      return {
        token: bill.id,
        date: bill.documentDate,
        customer: this.partyName(this.companyOf(actor), String(bill.partyId)),
        amount: jsonAmount(bill.pricing?.totals.invoiceValue.minor ?? 0n),
        why: quote === null ? [] : quote.reasons,
        madeByYou: bill.createdBy === actor.userId,
        canApprove: quote !== null && DemoApplication.approvalFor(actor, quote).canApprove && bill.createdBy !== actor.userId,
      };
    }));
    return { bills };
  }

  /** Issue #301 — someone allowed to approves a held bill, with their reason, and it is issued. */
  async approveSale(actor: ActorContext, input: Record<string, unknown>) {
    const usageDate = appToday();
    requireIssuable(this.config.companyId);
    await this.subscriptions.require(actor, 'sales.issue_invoice', usageDate);
    const token = String(input.token ?? '');
    const bill = await this.salesRepository.findById(this.companyOf(actor), token);
    if (bill === null) throw notFound('API_INVOICE_NOT_FOUND', 'We could not find that bill.');
    if (bill.state !== 'PENDING_APPROVAL') throw notAllowed('SALE_NOT_WAITING', 'This bill is not waiting for approval.');
    if (String(input.reason ?? '').trim() === '') {
      throw invalid('SALE_APPROVAL_REASON_REQUIRED', 'Please say why this is being allowed, so anyone looking at the bill later understands.');
    }
    // Checked before the approval is written down, so a refused approval leaves no trace of one.
    if (bill.createdBy === actor.userId) {
      throw forbidden('SALES_SELF_APPROVAL', 'The person who made a bill cannot approve it. Ask someone else to look at it.');
    }
    return this.issueCheckedSale(actor, token, usageDate, null, '', { reason: String(input.reason), hold: false });
  }

  private async checkSale(actor: ActorContext, draft: SalesInvoice) {
    if (draft.pricing === null) throw new Error(draft.problems.map((problem) => say(problem.message)).join(' '));
    // Issue #229 — no selling more than is in the godown. Checked here, at the review, for every
    // way a bill is made (typed, or from a quotation), and nothing is taken out until Record.
    const stocked = await this.sales.checkStock(actor, draft.id);
    const short = stocked.problems.filter((problem) => problem.code === 'STOCK_NOT_ENOUGH');
    if (short.length > 0) {
      // Issue #262 — the refusal also carries the Hindi sentence and, for each short line, the goods
      // and the godown, so the screen can open the purchase bill for exactly those goods. The sale
      // itself stays stopped: there is no override and stock never goes below nothing.
      // Issue #290 — goods out on a challan are not available; say where they are.
      const out = (await Promise.all([...new Set(draft.lines.map((line) => line.itemId))].map((itemId) => this.challans.outOnChallans(actor, itemId)))).flat();
      const onChallans = out.length === 0 ? '' : ` ${out.map((entry) => `${entry.quantity} ${entry.unit} ${out.length === 1 ? 'is' : 'are'} out on ${entry.number}`).join(', ')}, not counted as available. To bill goods already sent, open the challan and press Make the bill.`;
      throw notAllowed('SALES_STOCK_NOT_ENOUGH', short.map((problem) => say(problem.message)).join(' ') + onChallans, {
        messageId: 'stock.not_enough',
        details: {
          'hi-IN': short.map((problem) => problem.message['hi-IN']).join(' '),
          shortStock: JSON.stringify(short.flatMap((problem) => (problem.stock === undefined ? [] : [problem.stock]))),
        },
      });
    }

    // Issue #11: what was last agreed, what the discount is, and whether this customer should be
    // given more credit. The draft is excluded from its own pending value.
    const quote = await this.termsQuote(actor, draft);

    const effects = [both('A numbered invoice will be issued.', 'नंबर वाला बिल बनेगा।'), say(BALANCE_WILL_INCREASE)];
    for (const reason of quote.reasons) effects.push(say(reason));
    for (const line of quote.lines) {
      if (line.price.source !== 'NONE') effects.push(say(line.price.sentence));
    }

    return {
      state: 'preview',
      title: quote.outcome === 'BLOCK' ? both('This sale is on hold', 'यह बिक्री रोकी हुई है') : both('Sale checked', 'बिक्री जाँची गई'),
      message: say(draft.pricing.explanation),
      amount: jsonAmount(draft.pricing.totals.invoiceValue.minor),
      token: draft.id,
      effects,
      // Issue #205 — the review repeats the calculator's own charge lines and tax. The browser
      // formats these figures; it never works the tax out for itself.
      chargeLines: draft.pricing.lines.filter((line) => line.kind === 'CHARGE').map((line) => ({
        kind: line.chargeKind,
        taxableValue: jsonAmount(line.taxableValue.minor),
        gst: jsonAmount(line.totalTax.minor),
      })),
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
      // Issue #301 — what Record will do: issue it, ask this person to approve it, or hold it.
      approval: DemoApplication.approvalFor(actor, quote),
    };
  }

  /**
   * Issue #288 — what a "paid now" sale will receive, checked against the bill it comes with. More
   * than the bill is refused: change is given back in the shop, not kept in the books.
   */
  private paidNowOn(input: Record<string, unknown>, draft: SalesInvoice, customer: string) {
    const paid = paidNowOf(input);
    if (paid === null) return null;
    const total = draft.pricing?.totals.invoiceValue.minor ?? 0n;
    const amount = paid.amount ?? total;
    if (amount > total) {
      throw invalid('SALE_PAID_MORE_THAN_BILL', `The bill is ${formatPaise(total)}, but ${formatPaise(amount)} is entered as paid. Enter what the customer paid for this bill, up to ${formatPaise(total)}; any change is given back.`);
    }
    const due = total - amount;
    return {
      ...paid, amount, due,
      sentence: due === 0n
        ? { 'en-IN': `Paid now by ${paid.words['en-IN']}: ${formatPaise(amount)}. Nothing is left to pay on this bill.`,
            'hi-IN': `${paid.words['hi-IN']} से अभी दिया: ${formatPaise(amount)}। इस बिल पर कुछ बाक़ी नहीं रहा।` }
        : { 'en-IN': `Paid now by ${paid.words['en-IN']}: ${formatPaise(amount)}. ${formatPaise(total)} − ${formatPaise(amount)} = ${formatPaise(due)} is added to what ${customer} owes.`,
            'hi-IN': `${paid.words['hi-IN']} से अभी दिया: ${formatPaise(amount)}। ${formatPaise(total)} − ${formatPaise(amount)} = ${formatPaise(due)} ${customer} के बाक़ी में जुड़ेगा।` },
    };
  }

  async recordSale(actor: ActorContext, input: Record<string, unknown>, hold = true) {
    // Issue #42: the plan is checked before the bill is issued, and counted only after it was.
    // In that order, because a bill that failed to post is not a bill, and charging somebody's
    // allowance for the product's own failure would be the wrong way round.
    const usageDate = appToday();
    // Issue #180 — checked before anything is drafted or numbered, so a business without an address
    // is refused without burning an invoice number on the refusal.
    requireIssuable(this.config.companyId);
    await this.subscriptions.require(actor, 'sales.issue_invoice', usageDate);
    // Issue #288 — money taken at the counter needs the right to record money received, checked
    // before the bill, so nobody is left with a bill whose receipt was refused.
    const paid = paidNowOf(input);
    if (paid !== null) permissionPortFromActor.require(actor, 'payments.record', 'record money received');
    const preview = await this.previewSale(actor, input);
    // Issue #284 — refused here first, so the review this request made is not left behind as a draft.
    await this.refuseIfTooLateForPortal(actor, preview.token, true);
    return this.issueCheckedSale(actor, preview.token, usageDate, paid, String(input.distanceKm ?? '').trim(), { reason: String(input.approvalReason ?? ''), hold });
  }

  /** Issues a bill that has been checked, and counts it against the plan once it exists. */
  /**
   * Issue #210 part 3 — send the bill for its e-invoice number without the customer waiting.
   *
   * Three rules decide the shape of this:
   *
   *   - **Issuing a bill never waits on the government.** The send is started and not awaited, so a
   *     slow or dead portal delays nobody. A bill that could not be reported is a task, not a
   *     failure: it is a valid GST bill, it is in the books, and the number catches up.
   *   - **A bill that does not have to be registered is never sent.** The applicability rules decide,
   *     on the same facts and the same notifications the printed bill is judged by.
   *   - **Sending twice produces no second IRN.** The service is keyed on the document, and the
   *     portal's own duplicate answer is treated as success.
   */
  private startAutomaticEInvoice(actor: ActorContext, invoiceId: string): void {
    const persistence = this.shop.persistence;
    if (persistence.kind === 'postgres') {
      // Issue #345 — written in the bill's own transaction: if the bill rolls back, so does this,
      // and nothing is ever sent for a bill that does not exist. The worker sends it after commit.
      // The action waits for this write before it commits (`durable.ts`).
      persist(actor.companyId, () => persistence.db.requireUnitOfWork(actor.companyId).enqueue({
        topic: EINVOICE_TOPIC,
        dedupeKey: invoiceId,
        payload: { documentId: invoiceId, actorId: String(actor.userId), branchId: actor.branchId === null ? null : String(actor.branchId) },
      }));
      return;
    }
    void (async () => {
      const document = await this.eInvoiceDocumentFor(actor, invoiceId);
      const applicability = this.applicabilityFor(document);
      // Decided here rather than inside the service, because the service refuses a bill that does
      // not need one — and for a bill issued to a shopkeeper who never asked, that refusal is the
      // right answer, not an error worth showing them.
      if (decideApplicability(applicability).outcome !== 'APPLICABLE') return;
      await this.shop.eInvoice.register(actor, { document, applicability });
    })().catch((error: unknown) => {
      // Nothing here may reach the bill. The record itself carries the failure and the retry; a
      // fault of our own (not the portal being down) is reported as well.
      reportUnexpected('api.einvoiceAutoSend', error);
    });
  }

  /**
   * Issue #345 — the worker's side of the automatic e-invoice. The record is marked PENDING in one
   * unit of work, the portal is called holding nothing, and the answer is saved in the unit of work
   * that marks the outbox message sent. A crash anywhere repeats the same question with the same
   * idempotency key, and the portal answers a repeat with the IRN it already gave.
   */
  outboxHandlers(): Readonly<Record<string, OutboxHandler>> {
    const persistence = this.shop.persistence;
    if (persistence.kind === 'memory') return {};
    return {
      [EINVOICE_TOPIC]: async (message) => {
        const payload = message.payload as { documentId: string; actorId: string; branchId: string | null };
        const actor: ActorContext = {
          companyId: this.config.companyId,
          branchId: payload.branchId === null ? null : asId<'Branch'>(payload.branchId),
          userId: asId<'User'>(payload.actorId),
          permissions: ['einvoice.generate', 'einvoice.view'],
        };
        const prepared = await persistence.db.unitOfWork(this.config.companyId, async () => {
          const document = await this.eInvoiceDocumentFor(actor, payload.documentId);
          const applicability = this.applicabilityFor(document);
          if (decideApplicability(applicability).outcome !== 'APPLICABLE') return null;
          try {
            return await this.shop.eInvoice.prepareRegistration(actor, { document, applicability });
          } catch (error) {
            // A bill the rules say not to send (or cannot yet decide) is an answer, not a failure to
            // retry: it waits on the E-invoice screen, exactly as before.
            if (error instanceof DomainError) return null;
            throw error;
          }
        });
        if (prepared === null || prepared.kind === 'DONE') return;
        const outcome = await this.shop.eInvoice.callPortal(prepared);
        return async () => { await this.shop.eInvoice.completeRegistration(actor, prepared, outcome); };
      },
    };
  }

  /**
   * Issue #210 part 3 — the bills whose e-invoice number has not come back yet, and one more try.
   *
   * Only a failure the portal said was worth retrying is retried. A bill the government refused
   * needs correcting, and sending it again unchanged would get the same answer.
   */
  async retryWaitingEInvoices(actor: ActorContext): Promise<number> {
    const waiting = (await this.shop.eInvoice.list(actor))
      .filter((record) => record.status === 'FAILED' && record.failure?.retryable === true);
    let sent = 0;
    for (const record of waiting) {
      try {
        const document = await this.eInvoiceDocumentFor(actor, record.documentId);
        await this.shop.eInvoice.register(actor, { document, applicability: this.applicabilityFor(document) });
        sent += 1;
      } catch (error) {
        // Still down, or the bill has changed. It stays on the list and is tried again next time.
        reportUnexpected('api.einvoiceRetry', error);
      }
    }
    return sent;
  }

  /**
   * Issue #284 — a bill that must carry an e-invoice number, dated past the portal's 30-day limit,
   * can never get one, so it would never be a valid tax invoice. It is refused before a number is
   * used, with the same sentence the review shows and the way through: date it today.
   */
  private async refuseIfTooLateForPortal(actor: ActorContext, token: string, discard: boolean): Promise<void> {
    const draft = await this.salesRepository.findById(this.companyOf(actor), token);
    if (draft === null) return;
    const decision = this.eInvoiceDecisionFor(draft);
    if (decision.needed !== 'YES' || decision.lateForPortal !== true) return;
    if (discard) await this.discardReview(actor, draft.idempotencyKey, 'too old for the e-invoice portal').catch((tidy: unknown) => reportError('api.discardReview', tidy));
    // Written for a bill that does not exist yet: nothing to cancel, so the sentence says so.
    const deadline = reportingDeadline(draft.documentDate, this.turnoverFactsOn(draft.documentDate).lastYearTurnover ?? {}, appToday());
    const lastDay = deadline.kind === 'LIMIT' ? ` The last day the government accepts it was ${formatClaimDate(isoDate(String(deadline.lastDay)))}.` : '';
    throw notAllowed(
      'SALE_EINVOICE_TOO_LATE',
      `This bill needs a government e-invoice number, but it is dated ${formatClaimDate(draft.documentDate)}, more than 30 days ago, so the government's portal would refuse it.${lastDay} Without that number it is not a valid tax invoice and your customer cannot claim GST credit on it. Nothing was issued and no bill number was used. Date it today, ${formatClaimDate(appToday())}, and it is sent the moment you make the bill.`,
      { details: { today: appToday() } },
    );
  }

  private async issueCheckedSale(actor: ActorContext, token: string, usageDate: IsoDate, paidNow: PaidNow | null = null, ewayDistanceKm = '', approval = { reason: '', hold: true }) {
    requireIssuable(this.config.companyId);
    await this.refuseIfTooLateForPortal(actor, token, false);
    const held = await this.approvalGate(actor, token, approval);
    if (held !== null) return held;
    const finalise = () => this.sales.finalise(actor, { idempotencyKey: `web-sale-final:${token}`, invoiceId: token });
    // Issue #288 — "Paid now": the bill and its receipt in one unit of work. Both vouchers post, or
    // neither does and no bill number is used. Keyed on the bill, so a second press records neither again.
    const { final, receipt } = paidNow === null
      ? { final: await finalise(), receipt: null }
      : await this.shop.store.transaction(this.companyOf(actor), async () => {
        const issued = await finalise();
        return { final: issued, receipt: await this.receiveAtCounter(actor, issued.invoice, paidNow) };
      });
    this.freezeBillPrint(final.invoice, this.deliveries.get(token) ?? null, this.exportSales.get(token) ?? null);
    await this.subscriptions.recordUsage(actor, {
      meter: 'invoices',
      // The invoice's own id, so a retried request counts the same bill once.
      idempotencyKey: `invoice:${final.invoice.id}`,
      note: 'a bill was issued',
      on: usageDate,
    });
    // Issue #210 part 3 — started, never awaited. The bill is issued whatever the portal does.
    if (!final.deduplicated) this.startAutomaticEInvoice(actor, final.invoice.id);
    // Issue #239 — the same decision the review showed, from the same facts: the buyer (registered,
    // consumer or export), the bill's date, and the turnover band and exemption in Business details.
    // It builds no payload, so it cannot fail in a way that touches the bill.
    const decision = this.eInvoiceDecisionFor(final.invoice);
    const ewayBill = await this.ewayReminder(actor, final.invoice, this.deliveries.get(token) ?? null);
    const ewayRaised = ewayBill === null ? null : await this.raiseEwayByItself(actor, final.invoice.id, ewayDistanceKm);
    return {
      state: 'recorded', deduplicated: final.deduplicated,
      title: final.deduplicated ? both('Sale already recorded once', 'बिक्री पहले से एक बार दर्ज है') : both('Sale recorded', 'बिक्री दर्ज हुई'),
      message: receipt === null
        ? both(`${final.invoice.number} was issued.`, `${final.invoice.number} बन गया।`)
        : both(`${final.invoice.number} was issued. ${formatPaise(receipt.amount.minor)} received by ${paidNow?.words['en-IN'] ?? receipt.mode.toLowerCase()}.`, `${final.invoice.number} बन गया। ${paidNow?.words['hi-IN'] ?? receipt.mode.toLowerCase()} से ${formatPaise(receipt.amount.minor)} मिला।`),
      // Said on the screen the moment the bill is issued, so nobody has to go looking for it.
      eInvoice: decision.needed === 'NO'
        ? { expected: false, needed: 'NO' as const, message: null, askTurnover: false }
        : decision.needed === 'UNKNOWN'
          ? { expected: false, needed: 'UNKNOWN' as const, message: say(decision.message), askTurnover: decision.askTurnover }
          : decision.lateForPortal === true
            ? { expected: true, needed: 'YES' as const, message: say(decision.message), askTurnover: false }
            : { expected: true, needed: 'YES' as const, askTurnover: false, message: both('This bill has to carry a government e-invoice number. It is being sent now — the bill is already issued, and the number appears on the E-invoice screen when it comes back.', 'इस बिल पर सरकारी ई-इनवॉइस नंबर होना ज़रूरी है। उसे अब भेजा जा रहा है — बिल तो बन चुका है, और नंबर ई-इनवॉइस स्क्रीन पर आने पर दिखेगा।') },
      invoice: { id: final.invoice.id, number: final.invoice.number, amount: jsonAmount(final.invoice.pricing?.totals.invoiceValue.minor ?? 0n) },
      // Issue #240 — whether these goods need an e-way bill, so the screen can offer it in one press.
      ewayBill,
      // Issue #311 — and, when the bill names the vehicle, the e-way bill itself, raised by itself.
      ewayRaised,
      // Issue #307 — what the done screen hands the customer: who they are, what was paid, and what
      // is still due, with the UPI link for that amount only.
      ...(await this.saleFinish(actor, final.invoice, receipt)),
    };
  }

  /**
   * Issue #311 — the e-way bill of a bill that needs one, raised the moment the bill is made when the
   * bill names the vehicle, through the same two steps the E-way bill screen takes (#240): the form
   * filled from the bill, then the portal. The bill is already issued, so nothing here can undo it.
   *
   *   - No vehicle on the bill: nothing is raised (`null`); the bill stays "needs one" on the e-way
   *     bill list and Home, until the vehicle is known.
   *   - Raised before (Make bill pressed twice): the same e-way bill, never a second one.
   *   - The portal refused or was down: the record says so, the bill stays "needs one", and the
   *     E-way bill screen retries it. Never silent: the reason comes back with the bill.
   *
   * ponytail: awaited inline, so a slow portal slows Make bill; start it in the background and let
   * the done screen poll /api/eway/for-bill if the real portal proves slow.
   */
  private async raiseEwayByItself(actor: ActorContext, invoiceId: string, distanceKm: string) {
    try {
      const found = await this.ewayBillForBill(actor, { invoice: invoiceId });
      if (found.raised !== null) return found.raised;
      if (found.check.outcome !== 'REQUIRED' || found.form.vehicle === '') return null;
      return await this.generateEwayBill(actor, { ...found.form, ...(distanceKm === '' ? {} : { distanceKm }) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The e-way bill could not be raised.';
      return { state: 'eway' as const, status: 'NOT_RAISED' as const, ewayBillNumber: null, validUntilLabel: null, message, failure: { message, retryable: true } };
    }
  }

  /** Issue #288 — the money taken at the counter, received against the bill it came with. */
  private receiveAtCounter(actor: ActorContext, invoice: SalesInvoice, paid: PaidNow) {
    const amount = paid.amount ?? invoice.pricing?.totals.invoiceValue.minor ?? 0n;
    const number = invoice.number ?? '';
    return this.payments.recordPayment(actor, {
      idempotencyKey: `web-sale-paid:${invoice.id}`,
      direction: 'RECEIPT',
      partyId: invoice.partyId as PartyId,
      mode: paid.mode,
      amount: money(amount),
      date: invoice.documentDate,
      reference: number,
      bankAccountCode: paid.bankAccountCode,
      allocations: [{ documentId: invoice.id, documentNumber: number, amount: money(amount) }],
      narration: `Received by ${paid.words} at the counter against bill ${number}`,
    });
  }

  /**
   * Issue #307 — the facts the done screen needs after a sale. The browser builds the message; the
   * amount still due and the UPI link for it come from the books here, never worked out on the screen.
   */
  private async saleFinish(actor: ActorContext, invoice: SalesInvoice, receipt: Payment | null) {
    const companyId = this.companyOf(actor);
    const view = customerView(companyId, invoice.partyId);
    const position = await this.payments.position(actor, invoice.partyId as PartyId, invoice.documentDate);
    const due = position.documents.find((d) => d.document.documentId === invoice.id)?.outstanding.minor
      ?? invoice.pricing?.totals.invoiceValue.minor ?? 0n;
    // Issue #390 — the payee frozen on this bill when it was issued, never the id saved since.
    const upiId = this.invoicePrints.get(invoice.id)?.document.upiId ?? null;
    const payee = sellerPrint(companyId, { name: this.config.name, gstin: this.config.gstin }).seller.name;
    const voucher = receipt?.voucherId == null ? null : await this.shop.ledger.getVoucher(actor, receipt.voucherId);
    return {
      customer: { id: view.id, name: view.name, phone: view.phone, walkIn: view.walkIn },
      paid: receipt === null ? null : { paymentId: receipt.id, voucherNumber: voucher?.number ?? null, mode: receipt.mode, amount: jsonAmount(receipt.amount.minor) },
      due: jsonAmount(due),
      shop: payee,
      upiLink: upiId === null || due <= 0n ? null : upiPaymentLink(upiId, payee, money(due), invoice.number ?? ''),
    };
  }


  // ------------------------------------------------ issue #233: cancelling a wrong bill

  /**
   * Money already received against this bill. Cancelling the bill does not un-receive it: the
   * customer paid, the bank has it, and the receipt stays in the books. It is taken off the
   * cancelled bill and left on account for that customer — money held for them, to be refunded or
   * set against their next bill. An advance for goods carries no GST of its own, so nothing on the
   * return changes because of it.
   */
  private async receiptsAgainst(companyId: CompanyId, invoice: SalesInvoice): Promise<Payment[]> {
    return (await this.paymentRepository.listForParty(companyId, invoice.partyId))
      .filter((payment) => payment.state === 'RECORDED' && payment.allocations.some((allocation) => allocation.documentId === invoice.id));
  }

  /** Today in India, where the business keeps its books, not in UTC (which is still yesterday until 05:30). */
  private static indiaDate(at: Date | string = appClock.now()): IsoDate {
    return indiaDateOf(at);
  }

  private static cancelToday(): IsoDate {
    return DemoApplication.indiaDate();
  }

  /** What cancelling this bill will do, or why it cannot be cancelled. Writes nothing. */
  async previewCancelSale(actor: ActorContext, input: Record<string, unknown>) {
    const companyId = this.companyOf(actor);
    const invoiceId = String(input.invoice ?? '');
    // The reason is asked for on the review; a placeholder lets the checks run before it is typed.
    const reason = String(input.reason ?? '').trim() || 'reason to follow';
    const invoice = await this.sales.checkCancel(actor, {
      invoiceId, reason, today: DemoApplication.cancelToday(), ignoreClearable: ['EINVOICE', 'EWAY_BILL'],
    });
    if (invoice.state === 'CANCELLED') {
      return { state: 'preview' as const, title: both(`${invoice.number} is already cancelled`, `${invoice.number} पहले से रद्द है`), message: both('Nothing more will change.', 'अब कुछ और नहीं बदलेगा।'), token: invoice.id, amount: 0, effects: [], clearFirst: [] };
    }
    const clearFirst = (await this.cancelGuard.blockers(actor, invoice)).filter((blocker) => blocker.clearable !== null);
    const customer = customerView(companyId, String(invoice.partyId)).name;
    const value = invoice.pricing?.totals.invoiceValue.minor ?? 0n;
    const received = sum((await this.receiptsAgainst(companyId, invoice)).map((payment) =>
      sum(payment.allocations.filter((allocation) => allocation.documentId === invoice.id).map((allocation) => allocation.amount))));
    const goods = invoice.supplyKind === 'GOODS'
      ? invoice.lines.filter((line) => catalogueItems(companyId).find((item) => item.id === line.itemId)?.kind !== 'service')
      : [];
    const effects = [
      ...clearFirst.map((blocker) => blocker.message),
      `The number ${invoice.number} stays used and the bill stays on record, marked CANCELLED. No new bill will ever get this number.`,
      `${customer} will owe ${formatPaise(value)} less.`,
      ...goods.map((line) => `${showQuantity(line.quantity)} of ${invoice.pricing?.lines.find((priced) => priced.lineId === line.lineId)?.itemName ?? line.itemId} go back into stock.`),
      `The GST return for ${formatTaxPeriod(taxPeriodOf(invoice.documentDate))} will count ${invoice.number} as a cancelled bill, not as a sale.`,
      ...(received.minor > 0n
        ? [`${formatPaise(received.minor)} already received against this bill stays in your books as money held for ${customer} (on account). Refund it or use it on their next bill.`]
        : []),
    ];
    return {
      state: 'preview' as const,
      title: both(`Cancel ${invoice.number}?`, `${invoice.number} रद्द करें?`),
      message: both(`${invoice.number} for ${formatPaise(value)} will be cancelled.`, `${invoice.number} ${formatPaise(value)} का रद्द हो जाएगा।`),
      token: invoice.id,
      amount: jsonAmount(value),
      effects,
      clearFirst: clearFirst.map((blocker) => ({ kind: blocker.clearable, message: blocker.message })),
    };
  }

  /**
   * Cancels an issued bill. Refused, with the credit-note route, once its month is approved or
   * filed, once a credit note exists against it, or once its e-invoice or e-way bill can no longer
   * be cancelled with the government. With `cancelGovernmentDocuments`, a live e-way bill and e-invoice
   * are cancelled with the government first (the e-way bill before the e-invoice it came from).
   */
  async cancelSale(actor: ActorContext, input: Record<string, unknown>) {
    const companyId = this.companyOf(actor);
    const invoiceId = String(input.invoice ?? '');
    const reason = String(input.reason ?? '').trim();
    const today = DemoApplication.cancelToday();
    const clearFirst = input.cancelGovernmentDocuments === true || input.cancelGovernmentDocuments === 'yes';
    const checked = await this.sales.checkCancel(actor, {
      invoiceId, reason, today, ...(clearFirst ? { ignoreClearable: ['EINVOICE', 'EWAY_BILL'] as const } : {}),
    });
    if (checked.state === 'CANCELLED') return this.cancelledJson(checked, 0n, true);

    if (clearFirst) {
      for (const blocker of await this.cancelGuard.blockers(actor, checked)) {
        if (blocker.clearable === 'EWAY_BILL') await this.shop.ewayBill.cancel(actor, checked.id, { reasonCode: 'OTHERS', reason });
      }
      for (const blocker of await this.cancelGuard.blockers(actor, checked)) {
        if (blocker.clearable === 'EINVOICE') await this.shop.eInvoice.cancel(actor, checked.id, { reasonCode: 'OTHER', reason });
      }
    }

    // The bill, its entry, its goods and any money received against it change in one save.
    let movedOnAccount = 0n;
    const cancelled = await this.shop.store.transaction(companyId, async () => {
      const receipts = await this.receiptsAgainst(companyId, checked);
      const done = await this.sales.cancel(actor, { idempotencyKey: `web-sale-cancel:${checked.id}`, invoiceId: checked.id, reason, today });
      for (const payment of receipts) {
        movedOnAccount += sum(payment.allocations.filter((allocation) => allocation.documentId === checked.id).map((allocation) => allocation.amount)).minor;
        await this.payments.allocate(actor, payment.id, payment.allocations.filter((allocation) => allocation.documentId !== checked.id), payment.version);
      }
      return done;
    });
    return this.cancelledJson(cancelled, movedOnAccount, false);
  }

  private cancelledJson(invoice: SalesInvoice, onAccount: bigint, deduplicated: boolean) {
    const customer = customerView(this.config.companyId, String(invoice.partyId)).name;
    return {
      state: 'recorded' as const,
      deduplicated,
      title: deduplicated ? 'Bill already cancelled' : 'Bill cancelled',
      message: both(`${invoice.number} is cancelled. The number stays used, the bill stays on record marked CANCELLED, ${customer}'s balance and the stock are back as they were, and the GST return counts it as cancelled.`, `${invoice.number} रद्द हो गया। नंबर वहीं का वहीं है, बिल रिकॉर्ड में CANCELLED मार्क के साथ है, ${customer} का बाक़ी और स्टॉक जैसे थे वैसे हो गए, और GST रिटर्न इसे रद्द गिनता है।`),
      onAccount: onAccount === 0n ? null : {
        amount: jsonAmount(onAccount),
        message: both(`${formatPaise(onAccount)} received against ${invoice.number} is now held on account for ${customer}.`, `${invoice.number} के लिए मिला ${formatPaise(onAccount)} अब ${customer} के ख़ाते में रखा है।`),
      },
      invoice: { id: invoice.id, number: invoice.number, state: invoice.state, reason: invoice.cancelReason },
    };
  }

  /**
   * Issue #142 — turns an accepted quotation into a sale without retyping it.
   *
   * Step one: the quoted lines become a draft bill, shown with the same checks as a typed sale.
   * Nothing is issued yet; the person sees the bill and presses issue, which is step two.
   */
  async convertQuotation(actor: ActorContext, input: Record<string, unknown>) {
    this.companyOf(actor);
    const converted = await this.presale.convert(actor, input);
    const checked = await this.checkSale(actor, converted.invoice);
    return {
      ...checked,
      title: both(`Bill ready from ${converted.quotation.number}`, `${converted.quotation.number} से बिल तैयार`),
      effects: [...converted.notes, ...checked.effects],
      quotation: this.presale.describe(converted.quotation),
    };
  }

  /** Step two: the bill made from the quotation is issued like any other sale. */
  async issueConvertedSale(actor: ActorContext, input: Record<string, unknown>) {
    const companyId = this.companyOf(actor);
    const usageDate = appToday();
    await this.subscriptions.require(actor, 'sales.issue_invoice', usageDate);
    const token = String(input.token ?? '');
    if ((await this.salesRepository.findById(companyId, token)) === null) throw notFound('API_INVOICE_NOT_FOUND', 'We could not find that bill.');
    return this.issueCheckedSale(actor, token, usageDate, null, '', { reason: String(input.approvalReason ?? ''), hold: true });
  }

  /**
   * Issues #132 and #133 — the bill as it was handed over, frozen the moment it is issued.
   *
   * A template id would not do: a design can be edited, and then every old bill silently changes
   * shape. The whole page is copied here instead — the design in the business's own colour, the
   * parties and the priced lines as they were that day — so a bill reprinted in three years is the
   * page the customer was given, whatever has changed since.
   */
  private freezeBillPrint(invoice: SalesInvoice, delivery: DeliveryDetails | null = null, exportSupply: ExportParticulars | null = null): void {
    if (this.invoicePrints.has(invoice.id)) return;
    const template = templateById('india-standard');
    if (template === undefined) throw notFound('API_TEMPLATE', 'The India-standard design is missing.');
    const branding = brandingOf(invoice.companyId);
    // A finalised bill is always priced, and pricing decides the place of supply.
    const place = invoice.pricing?.placeOfSupplyStateCode ?? invoice.placeOfSupplyStateCode ?? this.config.gstin.slice(0, 2);
    // Issue #180 — the seller block, and the bank, declaration, terms and signature beside it, come
    // from the business's own saved particulars. Frozen here with everything else, so changing the
    // address tomorrow never alters a bill issued today.
    const us = sellerPrint(this.config.companyId, { name: this.config.name, gstin: this.config.gstin });
    // Issue #390 — the UPI id customers pay into is frozen with the bill, like the bank details.
    // A reprint must never re-point an issued bill's pay-by-scan square at a different payee:
    // CGST Rule 56(8) (in force since 1 July 2017) forbids overwriting an entry in a document once
    // made, and the invoice issued under Section 31 / Rule 46 is the document the customer holds.
    // A new payee reaches a customer only on a new bill or payment request.
    const upiId = upiIdOf(invoice.companyId);
    this.invoicePrints.set(invoice.id, {
      document: { ...toInvoiceDocument(invoice, {
        // Issue #296 — a composition dealer issues a bill of supply (CGST Rule 49) headed by the
        // words Rule 5 requires, with no tax on it (s.10(4)).
        title: invoice.pricing?.supplierRegistration === 'COMPOSITION' ? 'BILL_OF_SUPPLY' : 'TAX_INVOICE',
        ...(invoice.pricing?.supplierRegistration === 'COMPOSITION' ? { compositionLegend: COMPOSITION_LEGEND } : {}),
        seller: us.seller,
        bank: us.bank,
        declaration: us.declaration,
        terms: us.terms,
        signatureDataUri: us.signatureDataUri,
        // Issue #181 — the customer this bill was actually made out to, with the address saved on
        // their own record. Frozen here with everything else, so moving them tomorrow never alters
        // a bill issued today.
        buyer: customerPrint(this.config.companyId, invoice.partyId),
        placeOfSupplyStateName: place === '96' ? OUTSIDE_INDIA : STATE_NAMES[place] ?? place,
        // Issue #143 — the export or SEZ title, endorsement, shipping bill and currency.
        exportSupply,
        // Issue #182 — where the goods went, who carried them, and what the bill refers back to.
        // The consignee block prints in full on every bill (#134); it repeats the buyer when the
        // goods went to the buyer's own billing address, and carries the delivery address when
        // they did not, which is what Rule 46(o) asks for.
        ...(delivery?.shipTo == null ? {} : { shipTo: delivery.shipTo }),
        ...(delivery?.transport == null ? {} : { transport: delivery.transport }),
        ...(delivery?.references == null ? {} : { references: delivery.references }),
        ...(delivery?.poReference == null ? {} : { poReference: delivery.poReference }),
        logoDataUri: branding.logoDataUri,
        tradeMark: branding.tradeMark,
      }), upiId },
      snapshot: brandedSnapshot(template, 'en-IN', String(invoice.documentDate), branding),
    });
  }

  /**
   * Issue #132 — the finished bill: on screen, on the printer, and as a PDF for #133.
   *
   * One path serves all three, so the page a shopkeeper checks is the page that prints and the page
   * that is sent. The stored document is the bill as it was issued; the two facts that can only
   * arrive later are layered on here — the government's IRN and its own signed square once the bill
   * is registered, and the pay-by-scan UPI square for whatever is still due.
   */
  async invoicePrint(
    actor: ActorContext,
    invoiceId: string,
    options: {
      readonly pdf?: boolean;
      readonly format?: unknown;
      readonly locale?: unknown;
      /** Issue #183 — every marked copy in one document, for the business's own printer. */
      readonly allCopies?: boolean;
    } = {},
  ) {
    const companyId = this.companyOf(actor);
    const invoice = await this.salesRepository.findById(companyId, invoiceId);
    // Issue #233 — a cancelled bill still reprints, with CANCELLED across it.
    if (invoice === null || (invoice.state !== 'FINAL' && invoice.state !== 'CANCELLED')) throw notFound('API_INVOICE_NOT_FOUND', 'No issued bill was found.');
    const facts = this.invoicePrints.get(invoiceId);
    if (facts === undefined) throw notFound('API_INVOICE_PRINT_FACTS', 'The issued bill has no stored print snapshot.');
    const locale: Locale = options.locale === 'hi-IN' ? 'hi-IN' : 'en-IN';
    // Issue #307 — the 2-inch (58mm) till roll too, for the counter printer.
    const format: PageFormat = options.format === 'THERMAL_80MM' || options.format === 'THERMAL_58MM' ? options.format : options.format === 'MOBILE' ? 'MOBILE' : 'A4';
    const eInvoiceRecords = (await this.shop.eInvoice.list(actor)).filter((record) => record.documentId === invoice.id);
    // Issue #288 — money received against this bill (paid at the counter, or later) is printed as
    // paid, and only what is left is asked for by the UPI square. A cancelled bill has none.
    const paidOnBill = invoice.state !== 'FINAL' ? 0n : sum((await this.receiptsAgainst(companyId, invoice))
      .flatMap((payment) => payment.allocations.filter((allocation) => allocation.documentId === invoice.id).map((allocation) => allocation.amount))).minor;
    const acknowledgement = eInvoiceRecords.find((record) => record.status === 'REGISTERED')?.acknowledgement ?? null;
    // Issue #189 — only a bill that is meant to be registered keeps a space for the government's
    // QR. It is meant to be once the business has started registering it, or when the business
    // told us its turnover went over ₹5 crore (the e-invoice threshold — last year, or any year from
    // 2017-18 on, #236) and the customer is a registered business. Every other bill prints no
    // e-invoice block at all.
    // Issue #239 — the same decision the sale review and the E-invoice screen show, so an exempt
    // business or an export is judged here exactly as there.
    const eInvoiceExpected =
      eInvoiceRecords.length > 0 || this.eInvoiceDecisionFor(invoice).needed === 'YES';
    // Issue #390 — the UPI square pays the id frozen on the bill at issue (it rides in on
    // `facts.document`). A bill frozen before #390 carries none and prints no square, rather than
    // the id saved today: its original payee is not known, and guessing could send money elsewhere.
    // Issue #182 — the e-way bill number is raised against the issued invoice, so it only exists
    // after the bill is frozen. It is layered on here exactly as the government's IRN is: the
    // stored document is untouched, and every later reprint carries the number.
    const ewayBillNumber = printableEwayNumber(await this.shop.ewayBill.list(actor), invoice.id);
    const transport = facts.document.transport;
    const document: InvoiceDocument = {
      ...facts.document,
      ...(paidOnBill === 0n ? {} : {
        totals: { ...facts.document.totals, amountPaid: money(paidOnBill), outstanding: money(facts.document.totals.invoiceValue.minor - paidOnBill) },
      }),
      eInvoiceExpected,
      cancelled: invoice.state === 'CANCELLED'
        ? { on: invoice.cancelledAt === null ? invoice.documentDate : DemoApplication.indiaDate(invoice.cancelledAt), reason: invoice.cancelReason ?? '' }
        : null,
      upiId: facts.document.upiId ?? null,
      ...(ewayBillNumber === null || transport?.eWayBillNumber != null
        ? {}
        : { transport: { ...(transport ?? {}), eWayBillNumber: ewayBillNumber } }),
      eInvoice: acknowledgement === null ? facts.document.eInvoice : {
        irn: acknowledgement.irn,
        // Drawn from the government's own signed string, never from anything we made up.
        qrSvg: qrSvg(acknowledgement.signedQrCode, `IRN ${acknowledgement.irn}`),
        ackNumber: acknowledgement.ackNumber,
        ackDate: acknowledgement.ackDate,
      },
    };
    // Issue #183 — CGST Rule 48 prepares a goods invoice in triplicate and a services invoice in
    // duplicate, each copy marked. The app printed one unmarked page. The customer is always given
    // the Original; the whole set is for the business's own printer.
    const copies = copiesFor(document);
    const allCopies = options.allCopies === true && format === 'A4';
    const rendered = { format, locale, copy: 'ORIGINAL' as const };
    return {
      state: 'print' as const,
      number: invoice.number ?? '',
      // Issue #233 — the screen offers "Cancel this bill" only on a bill that stands.
      cancelled: invoice.state === 'CANCELLED',
      format,
      copies: copies.length,
      copyMarkings: copies.map((copy) => copyMarking(document, copy, locale)).filter((marking): marking is string => marking !== null),
      // The bill prints without the customer's address until somebody types one, and the screen
      // says so rather than inventing a line of it.
      hasBuyerAddress: facts.document.buyer.addressLines.length > 0,
      ...(options.pdf === true
        ? {
          pdf: allCopies
            ? await invoicePdfCopies(document, facts.snapshot, { format, locale })
            : await invoicePdf(document, facts.snapshot, rendered),
        }
        : {
          html: allCopies
            ? renderInvoiceCopies(document, facts.snapshot, { format, locale })
            : renderInvoice(document, facts.snapshot, rendered),
        }),
    };
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
      // Issue #403 — the server's today, never one the request names.
      today: appToday(),
    });
    // Planning looks at nothing; the preview is where the request meets the books, so both run
    // together for the screen. Neither of them writes anything.
    return this.agentPlanJson(await this.agent.preview(actor, plan.id));
  }

  async agentApprove(actor: ActorContext, input: Record<string, unknown>) {
    this.companyOf(actor);
    const plan = await this.agent.approve(actor, String(input.planId ?? ''), String(input.fingerprint ?? ''));
    return { state: 'recorded', title: both('Approved', 'मंज़ूर'), message: both('The assistant will do exactly what you saw.', 'असिस्टेंट वैसे ही करेगा जैसे आपने देखा।'), plan: this.agentPlanJson(plan) };
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
      message: say(report.summary),
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
      audit: await this.agentTrail(actor.companyId),
    };
  }

  /** Issue #404 — the assistant's last twenty lines, read from the company's own audit trail. */
  private async agentTrail(companyId: CompanyId): Promise<readonly { readonly action: string; readonly at: string; readonly detail: unknown }[]> {
    const audit = this.shop.audit;
    if (audit instanceof InMemoryAuditPort) {
      return audit.events.filter((event) => event.companyId === companyId && event.action.startsWith('agent.'))
        .slice(-20).map((event) => ({ action: event.action, at: event.at, detail: event.details }));
    }
    const db = (this.shop.persistence as Extract<Persistence, { kind: 'postgres' }>).db;
    const { rows } = await db.tenantTransaction(companyId, (sql) => sql.query(
      `SELECT action, occurred_at, COALESCE(after_json -> 'details', after_json, '{}'::jsonb) AS detail FROM audit_events
        WHERE company_id = $1 AND action LIKE 'agent.%' ORDER BY seq DESC LIMIT 20`, [companyId]));
    return rows.reverse().map((row) => ({ action: String(row.action), at: (row.occurred_at as Date).toISOString(), detail: row.detail }));
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

  /** Issue #350 — this business's plan, which sets how much heavy work it may ask for a minute. */
  planId(actor: ActorContext): Promise<string> { return this.subscriptions.planOf(this.companyOf(actor)); }

  async subscriptionAccount(actor: ActorContext, input: Record<string, unknown> = {}) {
    this.companyOf(actor);
    const today = appToday();
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
    const today = appToday();
    const planId = String(input.planId ?? '');
    const existing = await this.subscriptions.account(actor, today);
    const subscription = existing.subscription.id.startsWith('implied:')
      ? await this.subscriptions.start(actor, { planId, on: today })
      : await this.subscriptions.changePlan(actor, { planId, on: today, reason: String(input.reason ?? 'Changed from the account screen') });
    return {
      state: 'recorded',
      title: both('Plan changed', 'प्लान बदला'),
      message: both(`This business is now on the ${subscription.planId} plan. Nothing that was already recorded has changed.`, `यह बिज़नेस अब ${subscription.planId} प्लान पर है। जो पहले दर्ज हुआ वह वैसे का वैसा है।`),
    };
  }

  async issueSubscriptionInvoice(actor: ActorContext, input: Record<string, unknown>) {
    this.companyOf(actor);
    const today = appToday();
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

  // ------------------------------------------------------ issue #230: money received and money paid
  //
  // Money in comes from a customer the person picked, and money out goes to a supplier the person
  // picked. There is no default: a payment with nobody chosen is refused, because the old default
  // posted every customer's money to the demo customer. The bills offered, and the only bills the
  // money may be put against, are the chosen party's own open bills.

  /** The open bills of one customer (money received) or one supplier (money paid), with what is still due on each. */
  async paymentOpenBills(actor: ActorContext, input: Record<string, unknown>) {
    const companyId = this.companyOf(actor);
    const { direction, party } = this.paymentParty(companyId, input);
    const date = isoDate(String(input.date || appToday()));
    const position = await this.payments.position(actor, party.id as PartyId, date);
    const open = openBillsOf(position.documents, direction);
    return {
      direction,
      party,
      owed: jsonAmount(sum(open.map((d) => d.outstanding)).minor),
      onAccount: direction === 'RECEIPT' ? jsonAmount(position.onAccount.minor) : 0,
      // Issue #261 — advances already paid to this supplier and not yet taken off a bill.
      advancesPaid: direction === 'PAYMENT' ? jsonAmount(position.advancesPaid.minor) : 0,
      advanceChoice: direction === 'PAYMENT' ? { label: say(advanceChoiceLabel(party.name)), help: say(advanceChoiceHelp(party.name, open.length)) } : null,
      bills: open.map((d) => ({
        id: d.document.documentId,
        number: d.document.number,
        date: d.document.date,
        dueDate: d.document.dueDate,
        total: jsonAmount(d.document.value.minor),
        paid: jsonAmount(d.allocated.minor),
        outstanding: jsonAmount(d.outstanding.minor),
      })),
      // Issue #295 — what the screen may offer on money received: the owner's write-off limit in
      // rupees, the TDS sections to pick from, and the quarter this date falls in.
      ...(direction === 'RECEIPT' ? {
        writeOffLimit: Number(writeOffLimitOf(companyId)) / 100,
        tdsSections: [...TDS_SECTIONS],
        tdsQuarter: tdsQuarterOf(date),
      } : {}),
    };
  }

  async previewPayment(actor: ActorContext, input: Record<string, unknown>) {
    const plan = await this.paymentPlan(actor, input);
    const { direction, party, amount, how, applied, leftOver, owedBefore } = plan;
    // Issue #295 — TDS, discount, write-off and credit notes close a bill without money: the
    // review counts them too, or it would promise a debt that is not really left.
    const adjustments = plan.settlements.reduce((total, settlement) => total + settlement.amount.minor, 0n)
      + plan.creditNotes.reduce((total, note) => total + note.noteTotal, 0n);
    const owedAfter = owedBefore - (amount - leftOver) - adjustments;
    if (plan.advance > 0n) return this.previewSupplierAdvance(actor, plan, owedAfter);
    const whose = direction === 'RECEIPT' ? `${party.name} का बाक़ी` : `${party.name} का आपका बाक़ी`;
    return {
      state: 'preview',
      title: both(direction === 'RECEIPT' ? 'Money received — check it' : 'Money paid — check it', direction === 'RECEIPT' ? 'पैसा मिला — जाँच लीजिए' : 'पैसा दिया — जाँच लीजिए'),
      message: both(`${formatPaise(amount)} will reduce ${direction === 'RECEIPT' ? `what ${party.name} owes` : `what you owe ${party.name}`}.`, `${formatPaise(amount)} ${whose} घटाएगा।`),
      amount: jsonAmount(amount),
      party,
      direction,
      token: plan.key,
      effects: [
        both(`${direction === 'RECEIPT' ? 'Received from' : 'Paid to'} ${party.name} by ${how.words['en-IN']}.`,
          `${party.name} ${direction === 'RECEIPT' ? 'से' : 'को'} ${how.words['hi-IN']} से ${direction === 'RECEIPT' ? 'मिला' : 'दिया'}।`),
        ...applied.map(({ position, amount: put }) =>
          both(`${position.document.number}: ${formatPaise(position.outstanding.minor)} − ${formatPaise(put)} = ${formatPaise(position.outstanding.minor - put)} still due on this bill`,
            `${position.document.number}: ${formatPaise(position.outstanding.minor)} − ${formatPaise(put)} = ${formatPaise(position.outstanding.minor - put)} इस बिल पर अभी बाक़ी`)),
        // Issue #295 — what each adjustment does, in words a shopkeeper can check.
        ...plan.settlements.map((settlement) => settlement.kind === 'TDS_DEDUCTED'
          ? both(`${settlement.documentNumber}: ${formatPaise(settlement.amount.minor)} of tax deducted under s.${settlement.tdsSection} (${settlement.tdsQuarter}) — kept as TDS to come back from the government, not as money ${party.name} still owes.`,
              `${settlement.documentNumber}: s.${settlement.tdsSection} (${settlement.tdsQuarter}) के तहत ${formatPaise(settlement.amount.minor)} का टैक्स कटा — यह सरकार से वापस मिलने वाला TDS है, ${party.name} का बाक़ी नहीं.`)
          : settlement.kind === 'DISCOUNT_ALLOWED'
            ? both(`${settlement.documentNumber}: ${formatPaise(settlement.amount.minor)} discount allowed — counted as an expense, no GST change.`,
                `${settlement.documentNumber}: ${formatPaise(settlement.amount.minor)} का डिस्काउंट दिया — खर्चे में गिना गया, GST में कोई बदलाव नहीं.`)
            : both(`${settlement.documentNumber}: ${formatPaise(settlement.amount.minor)} written off — counted as money you could not collect.`,
                `${settlement.documentNumber}: ${formatPaise(settlement.amount.minor)} बाक़ी माफ़ किया — ऐसा पैसा गिना गया जो वसूल नहीं हुआ.`)),
        ...plan.creditNotes.map((note) =>
          both(`${note.position.document.number}: a GST credit note for ${formatPaise(note.noteTotal)} will be issued for the discount of ${formatPaise(note.declared)}.`,
            `${note.position.document.number}: ${formatPaise(note.declared)} की छूट के लिए ${formatPaise(note.noteTotal)} का GST क्रेडिट नोट बनेगा.`)),
        ...(leftOver > 0n
          ? [applied.length === 0
            ? both(`${formatPaise(leftOver)} is not put against any bill yet, so it stays on account for ${party.name}.`,
                `${formatPaise(leftOver)} अभी किसी बिल पर नहीं लगा, इसलिए ${party.name} के ख़ाते में रहेगा।`)
            : both(`${formatPaise(amount)} − ${formatPaise(amount - leftOver)} = ${formatPaise(leftOver)} is more than the bills chosen, so it stays on account for ${party.name}.`,
                `${formatPaise(amount)} − ${formatPaise(amount - leftOver)} = ${formatPaise(leftOver)} चुने हुए बिल से ज़्यादा है, इसलिए ${party.name} के ख़ाते में रहेगा।`)]
          : []),
        both(`${direction === 'RECEIPT' ? `${party.name} owes` : `You owe ${party.name}`} ${formatPaise(owedBefore)} on open bills now, and ${formatPaise(owedAfter < 0n ? 0n : owedAfter)} after this.`,
          `${direction === 'RECEIPT' ? `${party.name} का` : `${party.name} को आपका`} ${formatPaise(owedBefore)} खुले बिल पर अभी है, और इसके बाद ${formatPaise(owedAfter < 0n ? 0n : owedAfter)}।`),
      ],
    };
  }

  /**
   * Issue #261 — the review of money paid to a supplier before their bill. It says plainly that this
   * is an advance, that nothing is owed because of it, and that it comes off their next bill.
   */
  private async previewSupplierAdvance(actor: ActorContext, plan: Awaited<ReturnType<DemoApplication['paymentPlan']>>, owedAfter: bigint) {
    const { party, amount, how, applied, advance } = plan;
    const position = await this.payments.position(actor, party.id as PartyId, plan.date);
    const heldBefore = position.advancesPaid.minor;
    const against = amount - advance;
    return {
      state: 'preview',
      title: both('Advance to a supplier — check it', 'सप्लायर को अडवांस — जाँच लीजिए'),
      message: owedAfter <= 0n
        ? both(`Advance paid to ${party.name}: ${formatPaise(advance)}. You owe them nothing yet; when their bill is entered, ${formatPaise(advance)} will be taken off it.`,
          `${party.name} को अडवांस दिया: ${formatPaise(advance)}। अभी आपका कोई बाक़ी नहीं है; जब उनका बिल आएगा, उसमें से ${formatPaise(advance)} घटा दिया जाएगा।`)
        : both(`Advance paid to ${party.name}: ${formatPaise(advance)}. It is not taken off the ${formatPaise(owedAfter)} you already owe them on open bills; when their next bill is entered, ${formatPaise(advance)} will be taken off it.`,
          `${party.name} को अडवांस दिया: ${formatPaise(advance)}। यह खुले बिलों के ${formatPaise(owedAfter)} बाक़ी से नहीं घटा; जब उनका अगला बिल आएगा, उसमें से ${formatPaise(advance)} घटा दिया जाएगा।`),
      amount: jsonAmount(amount),
      advance: jsonAmount(advance),
      party,
      direction: plan.direction,
      token: plan.key,
      effects: [
        both(`Paid to ${party.name} by ${how.words['en-IN']}.`, `${party.name} को ${how.words['hi-IN']} से दिया।`),
        ...applied.map(({ position: bill, amount: put }) =>
          both(`${bill.document.number}: ${formatPaise(bill.outstanding.minor)} − ${formatPaise(put)} = ${formatPaise(bill.outstanding.minor - put)} still due on this bill`,
            `${bill.document.number}: ${formatPaise(bill.outstanding.minor)} − ${formatPaise(put)} = ${formatPaise(bill.outstanding.minor - put)} इस बिल पर अभी बाक़ी`)),
        ...(applied.length > 0 ? [both(`${formatPaise(amount)} − ${formatPaise(against)} = ${formatPaise(advance)} is kept as an advance.`, `${formatPaise(amount)} − ${formatPaise(against)} = ${formatPaise(advance)} अडवांस के रूप में रखा गया।`)] : []),
        ...(heldBefore > 0n ? [both(`Advances already with ${party.name}: ${formatPaise(heldBefore)} + ${formatPaise(advance)} = ${formatPaise(heldBefore + advance)}.`, `${party.name} के पास पहले से अडवांस: ${formatPaise(heldBefore)} + ${formatPaise(advance)} = ${formatPaise(heldBefore + advance)}।`)] : []),
        // Issue #274 — what the voucher will say it is against, before anything is saved.
        both(`Against: ${advanceAgainstWords(plan.particulars)}.`, `बदले में: ${advanceAgainstWords(plan.particulars)}।`),
        ...(plan.particulars?.supplierReceiptVoucher ? [both(`Supplier's receipt voucher: No. ${plan.particulars.supplierReceiptVoucher.number} dated ${formatDate(plan.particulars.supplierReceiptVoucher.date)}.`, `सप्लायर की रसीद वाउचर: नं. ${plan.particulars.supplierReceiptVoucher.number} दिनांक ${formatDate(plan.particulars.supplierReceiptVoucher.date)}।`)] : []),
        `Narration: ${plan.narration ?? ''}`,
        both(`In your books it is kept under "Advances paid to suppliers", not as money you owe.`, `आपकी बही में यह "Advances paid to suppliers" में रखा गया है, आपका बाक़ी नहीं।`),
        both('No GST is entered for this advance, and no GST credit is claimed on it. The credit comes with their bill.', 'इस अडवांस पर कोई GST दर्ज नहीं, और न ही GST क्रेडिट लिया गया। क्रेडिट उनके बिल के साथ आएगा।'),
      ],
    };
  }

  async recordPayment(actor: ActorContext, input: Record<string, unknown>) {
    const companyId = this.companyOf(actor);
    permissionPortFromActor.require(actor, 'payments.record', 'record money received or paid');
    // Pressed twice: the first press already settled the bill, so the second is answered from the
    // payment it made rather than being checked again as if it were new money.
    const earlier = await this.paymentRepository.findByIdempotencyKey(companyId, paymentKeyOf(input));
    if (earlier !== null) {
      const { direction, party } = this.paymentParty(companyId, input);
      if (earlier.partyId !== party.id || earlier.amount.minor !== paise(input.amount) || earlier.direction !== direction) {
        throw conflict('PAYMENT_KEY_REUSED', 'This entry was already used for a different payment. Nothing new was recorded; start a fresh entry.');
      }
      return this.paymentRecordedJson(actor, earlier, party, true);
    }
    const plan = await this.paymentPlan(actor, input);
    const { direction, party, amount, date, how, applied } = plan;
    // A party added a moment ago gets their own account in the books before money is posted to it.
    await this.shop.ledger.openPartyAccount(this.shop.setupActor, { partyId: party.id as PartyId, name: party.name, kind: direction === 'RECEIPT' ? 'CUSTOMER' : 'SUPPLIER' });
    const payment = await this.payments.recordPayment(actor, {
      idempotencyKey: plan.key,
      direction,
      partyId: party.id as PartyId,
      mode: how.mode,
      amount: money(amount),
      date,
      reference: plan.reference,
      bankAccountCode: how.bankAccountCode,
      ...(how.cheque === undefined ? {} : { cheque: how.cheque }),
      ...(applied.length === 0 ? {} : { allocations: applied.map(({ position, amount: put }) => ({ documentId: position.document.documentId, documentNumber: position.document.number, amount: money(put) })) }),
      ...(plan.settlements.length === 0 ? {} : { settlements: plan.settlements }),
      writeOffLimit: money(writeOffLimitOf(companyId)),
      ...(plan.advance > 0n ? { advanceToSupplier: true } : {}),
      ...(plan.particulars === undefined ? {} : { advanceParticulars: plan.particulars }),
      ...(plan.narration === undefined ? {} : { narration: plan.narration }),
    });
    // The same request twice is one payment. The same key for a different payment is a mistake,
    // not a retry — checked before any credit note is issued, so a refused retry leaves nothing behind.
    if (payment.partyId !== party.id || payment.amount.minor !== amount || payment.direction !== direction) {
      throw conflict('PAYMENT_KEY_REUSED', 'This entry was already used for a different payment. Nothing new was recorded; start a fresh entry.');
    }
    // Issue #295 — a discount chosen as a GST credit note is a real note (CGST Act s.34 with
    // s.15(3)(b)), issued per line. Each note's own idempotency key makes a retried record find
    // the note rather than make it twice, and lets the receipt show only this payment's notes.
    const issuedNotes: { bill: string; number: string; total: bigint }[] = [];
    for (const request of plan.creditNotes) {
      for (const line of request.lines) {
        const { note } = await this.returns.postPriceCorrection(actor, {
          idempotencyKey: `${plan.key}:credit-note:${line.lineId}`,
          originalInvoiceId: request.position.document.documentId,
          originalLineId: line.lineId,
          documentDate: plan.date,
          reason: `Discount allowed while receiving payment${plan.reference === null ? '' : ` ${plan.reference}`} on ${request.position.document.number}`,
          cause: 'DISCOUNT_AFTER_SALE',
          amountOff: money(line.amountOff),
          discountEvidence: request.evidence,
        });
        issuedNotes.push({ bill: request.position.document.number, number: note.number, total: note.totals.total.minor });
      }
    }
    return this.paymentRecordedJson(actor, payment, party, false, issuedNotes);
  }

  private async paymentRecordedJson(actor: ActorContext, payment: Payment, party: { id: string; name: string }, deduplicated: boolean, issuedNotes: readonly { bill: string; number: string; total: bigint }[] = []) {
    const direction = payment.direction;
    const earlier = deduplicated ? payment : null;
    const position = await this.payments.position(actor, party.id as PartyId, payment.date);
    const owed = sum(openBillsOf(position.documents, direction).map((d) => d.outstanding));
    const voucher = payment.voucherId === null ? null : await this.shop.ledger.getVoucher(actor, payment.voucherId);
    const advance = payment.advanceToSupplier === true ? payment.amount.minor - sum(payment.allocations.map((a) => a.amount)).minor : 0n;
    return {
      state: 'recorded',
      deduplicated,
      title: earlier !== null ? both('Already recorded once', 'पहले से एक बार दर्ज है') : direction === 'RECEIPT' ? both('Money received recorded', 'मिला हुआ पैसा दर्ज हुआ') : payment.advanceToSupplier === true ? both('Advance paid recorded', 'दिया हुआ अडवांस दर्ज हुआ') : both('Money paid recorded', 'दिया हुआ पैसा दर्ज हुआ'),
      message: earlier !== null
        ? both(`${formatPaise(payment.amount.minor)} ${direction === 'RECEIPT' ? 'from' : 'to'} ${party.name} was already recorded. It was not recorded twice.`,
          `${party.name} ${direction === 'RECEIPT' ? 'से' : 'को'} ${formatPaise(payment.amount.minor)} पहले से दर्ज है। दो बार दर्ज नहीं हुआ।`)
        : both(`${formatPaise(payment.amount.minor)} ${direction === 'RECEIPT' ? 'received from' : 'paid to'} ${party.name} is in your books${voucher === null ? '' : ` as ${voucher.number}`}.`,
          `${party.name} ${direction === 'RECEIPT' ? 'से मिला' : 'को दिया'} ${formatPaise(payment.amount.minor)} आपकी बही में दर्ज है${voucher === null ? '' : `, वाउचर ${voucher.number} के रूप में`}।`),
      effects: [
        direction === 'RECEIPT' ? both(`${party.name} now owes ${formatPaise(owed.minor)} on open bills.`, `${party.name} का ${formatPaise(owed.minor)} खुले बिल पर बाक़ी है।`) : both(`You now owe ${party.name} ${formatPaise(owed.minor)}.`, `अब ${party.name} को आपका ${formatPaise(owed.minor)} बाक़ी है।`),
        ...(direction === 'PAYMENT' && position.advancesPaid.minor > 0n
          ? [both(`Advance with ${party.name}, to be taken off their next bill: ${formatPaise(position.advancesPaid.minor)}.`, `${party.name} के पास अडवांस, जो उनके अगले बिल से घटेगा: ${formatPaise(position.advancesPaid.minor)}।`)]
          : []),
      ],
      advance: jsonAmount(advance),
      advancesPaid: direction === 'PAYMENT' ? jsonAmount(position.advancesPaid.minor) : 0,
      paymentId: payment.id,
      voucherNumber: voucher?.number ?? null,
      direction,
      party,
      mode: payment.mode,
      amount: jsonAmount(payment.amount.minor),
      outstanding: jsonAmount(owed.minor),
      onAccount: direction === 'RECEIPT' ? jsonAmount(position.onAccount.minor) : 0,
      settled: payment.allocations.map((allocation) => ({ number: allocation.documentNumber, amount: jsonAmount(allocation.amount.minor) })),
      // Issue #295 — the non-cash ways the bills were settled, and any credit notes issued.
      adjustments: (payment.settlements ?? []).map((settlement) => ({
        number: settlement.documentNumber, kind: settlement.kind, amount: jsonAmount(settlement.amount.minor),
        section: settlement.tdsSection ?? null, quarter: settlement.tdsQuarter ?? null, certificate: settlement.tdsCertificate ?? null,
      })),
      creditNotes: issuedNotes.map((note) => ({ bill: note.bill, number: note.number, total: jsonAmount(note.total) })),
      // Kept for callers written before #230; it is the chosen party's figure now, never the demo customer's.
      customerOutstanding: jsonAmount(owed.minor),
    };
  }

  /** The receipt (money in) or payment voucher (money out) for one recorded payment, as a printable page. */
  async paymentVoucher(actor: ActorContext, input: Record<string, unknown>) {
    const companyId = this.companyOf(actor);
    const payment = await this.paymentRepository.findById(companyId, String(input.paymentId ?? ''));
    if (payment === null) throw notFound('PAYMENT_NOT_FOUND', 'That payment is not in this business.');
    const voucher = payment.voucherId === null ? null : await this.shop.ledger.getVoucher(actor, payment.voucherId);
    const documents = await this.documents.openDocuments(companyId, payment.partyId);
    const seller = sellerPrint(companyId, { name: this.config.name, gstin: this.config.gstin }).seller;
    const html = paymentVoucherHtml({
      payment,
      number: voucher?.number ?? payment.id,
      seller,
      party: this.paymentPartyPrint(companyId, payment.partyId),
      bills: payment.allocations.map((allocation) => {
        const bill = documents.find((d) => d.documentId === allocation.documentId);
        return { number: allocation.documentNumber, date: bill?.date ?? null, total: bill?.value.minor ?? null, settled: allocation.amount.minor, adjusted: allocation.adjustedFromAdvance === true };
      }),
      // Issue #295 — TDS, discount or write-off the receipt settled bills by.
      adjustments: (payment.settlements ?? []).map((settlement) => ({
        bill: settlement.documentNumber,
        kind: settlement.kind,
        amount: settlement.amount.minor,
        section: settlement.tdsSection ?? null,
        quarter: settlement.tdsQuarter ?? null,
        certificate: settlement.tdsCertificate ?? null,
      })),
      // …and the s.34 credit notes THIS receipt's discount issued — matched by the key they were
      // posted under, so a note from another receipt or an earlier correction is never claimed here.
      creditNotes: (await Promise.all(
        [...new Set([...payment.allocations.map((a) => a.documentId), ...(payment.settlements ?? []).map((s) => s.documentId)])]
          .map(async (documentId) => {
            const bill = payment.allocations.find((a) => a.documentId === documentId)?.documentNumber
              ?? (payment.settlements ?? []).find((s) => s.documentId === documentId)?.documentNumber ?? documentId;
            return (await this.returnNotes.listForOriginal(companyId, documentId))
              .filter((note) => note.priceCorrection === true && note.idempotencyKey.startsWith(`${payment.idempotencyKey}:credit-note:`))
              .map((note) => ({ bill, number: note.number }));
          }),
      )).flat(),
      // Issue #289, part 2b — s.31(3)(g): paying a reverse-charge bill, this voucher is the payment voucher.
      reverseCharge: payment.direction !== 'PAYMENT' ? [] : (await Promise.all(payment.allocations.map(async (allocation) => {
        const purchase = await this.shop.reverseCharge.purchaseFor(companyId, allocation.documentId);
        return purchase === null ? null : {
          bill: purchase.invoiceNumber, interState: purchase.interState, lines: purchase.lines,
          placeOfSupply: `${seller.stateName} (${seller.stateCode})`,
        };
      }))).filter((entry) => entry !== null),
    });
    return { state: 'print' as const, number: voucher?.number ?? payment.id, html };
  }

  private paymentParty(companyId: CompanyId, input: Record<string, unknown>): { direction: 'RECEIPT' | 'PAYMENT'; party: { id: string; name: string } } {
    const raw = String(input.direction ?? 'RECEIPT').trim().toUpperCase();
    if (raw !== 'RECEIPT' && raw !== 'PAYMENT') throw invalid('PAYMENT_DIRECTION_INVALID', 'Say whether this is money received or money paid.');
    const direction = raw;
    const wanted = String(input.partyId ?? input.party ?? '').trim();
    if (direction === 'RECEIPT') {
      if (wanted === '') throw invalid('PAYMENT_CUSTOMER_REQUIRED', 'Choose the customer who paid you. The money is not put against anybody until you do.');
      const found = resolveCustomer(companyId, wanted);
      if (!customers(companyId).some((party) => party.id === found.id)) {
        throw invalid('CUSTOMER_NOT_FOUND', `"${wanted}" is not in your customer list. Choose the customer who paid you.`);
      }
      return { direction, party: { id: found.id, name: found.legalName } };
    }
    if (wanted === '') throw invalid('PAYMENT_SUPPLIER_REQUIRED', 'Choose the supplier you paid. The money is not put against anybody until you do.');
    const found = resolveSupplier(companyId, wanted);
    return { direction, party: { id: found.id, name: found.legalName } };
  }

  /** Everything a payment will do, worked out once so the review and the record cannot disagree. */
  private async paymentPlan(actor: ActorContext, input: Record<string, unknown>) {
    const companyId = this.companyOf(actor);
    permissionPortFromActor.require(actor, 'payments.record', 'record money received or paid');
    const { direction, party } = this.paymentParty(companyId, input);
    const amount = paise(input.amount);
    const date = isoDate(String(input.date ?? ''));
    const how = paymentHow(direction, input);
    const reference = String(input.reference ?? '').trim() || null;
    const key = paymentKeyOf(input);
    const position = await this.payments.position(actor, party.id as PartyId, date);
    const open = openBillsOf(position.documents, direction);
    const theirs = position.documents.filter((d) => d.document.side === (direction === 'RECEIPT' ? 'RECEIVABLE' : 'PAYABLE'));
    // Issue #295 — the adjustments on the bills: TDS deducted, discount allowed, write-off. A bill
    // an adjustment is on is a chosen bill even when its box was left unticked.
    const settlementPlan = paymentSettlementsOf(input, direction, open, date);
    const creditNotes = await Promise.all(settlementPlan.creditNotes.map(async (request) => ({
      ...request,
      ...(await this.creditNoteLinesOf(companyId, request)),
    })));
    // Issue #295 — a GST credit note needs the returns permission. The review refuses here, not
    // after the clerk pressed Record.
    if (creditNotes.length > 0) {
      permissionPortFromActor.require(actor, 'returns.create', 'issue a GST credit note for the discount');
    }
    const adjustmentOn = (documentId: string): bigint =>
      settlementPlan.settlements.filter((s) => s.documentId === documentId).reduce((total, s) => total + s.amount.minor, 0n)
        + creditNotes.filter((note) => note.position.document.documentId === documentId).reduce((total, note) => total + note.noteTotal, 0n);
    const chosenIds = [...new Set([...billIdsOf(input), ...settlementPlan.settlements.map((s) => s.documentId), ...creditNotes.map((note) => note.position.document.documentId)])];
    const chosen = chosenIds.map((id) => {
      const found = open.find((d) => d.document.documentId === id);
      if (found !== undefined) return found;
      const settled = theirs.find((d) => d.document.documentId === id);
      if (settled !== undefined) throw invalid('PAYMENT_BILL_ALREADY_PAID', `${settled.document.number} is already fully paid, so nothing more can be put against it.`);
      throw invalid('PAYMENT_BILL_NOT_THEIRS', `That bill is not one of the open bills of ${party.name}, so this money cannot be put against it.`);
    }).sort((a, b) => a.document.date.localeCompare(b.document.date) || a.document.number.localeCompare(b.document.number));
    // Oldest chosen bill first, each up to what is still due on it after its adjustments. Nothing
    // goes on a bill nobody chose.
    let remaining = amount;
    const applied: { position: DocumentPosition; amount: bigint }[] = [];
    for (const position of chosen) {
      if (remaining <= 0n) break;
      const due = position.outstanding.minor - adjustmentOn(position.document.documentId);
      const put = remaining < due ? remaining : due;
      if (put > 0n) {
        applied.push({ position, amount: put });
        remaining -= put;
      }
    }
    // Issue #295 — the same refusal the service makes, made here so the review says it too.
    validateSettlements(
      applied.map(({ position, amount: put }) => ({ documentId: position.document.documentId, documentNumber: position.document.number, amount: money(put) })),
      settlementPlan.settlements,
      theirs,
      money(writeOffLimitOf(companyId)),
    );
    // Issue #261 — paying a supplier before their bill is allowed, but only as an advance the person
    // chose with its own click. Without that click, money no bill takes is refused, as before.
    const advanceChosen = direction === 'PAYMENT' && chosenAsAdvance(input);
    const tickEn = `tick “${advanceChoiceLabel(party.name)['en-IN']}”`;
    const tickHi = `“${advanceChoiceLabel(party.name)['hi-IN']}” पर टिक कीजिए`;
    if (direction === 'PAYMENT' && remaining > 0n && !advanceChosen) {
      const covered = amount - remaining;
      throw invalid('PAYMENT_MORE_THAN_BILLS', chosen.length === 0
        ? open.length === 0
          ? `You have no bill from ${party.name} yet. To pay them before their bill, ${tickEn}. Nothing was recorded.`
          : `Choose the bill${open.length === 1 ? '' : 's'} of ${party.name} this pays. To pay them before a bill instead, ${tickEn}.`
        : `The bills chosen come to ${formatPaise(covered)}, but ${formatPaise(amount)} is being paid. ${formatPaise(amount)} − ${formatPaise(covered)} = ${formatPaise(remaining)} would not settle any bill. Choose more bills, pay ${formatPaise(covered)}, or ${tickEn} to keep ${formatPaise(remaining)} as an advance.`, { details: { 'hi-IN': chosen.length === 0
        ? open.length === 0
          ? `${party.name} का अभी कोई बिल नहीं है। उनका बिल आने से पहले पैसा देने के लिए, ${tickHi}। कुछ दर्ज नहीं हुआ।`
          : `${party.name} का वह बिल चुनिए जिसके लिए यह पैसा है। बिल से पहले पैसा देने के लिए, ${tickHi}।`
        : `चुने हुए बिल ${formatPaise(covered)} के हैं, पर ${formatPaise(amount)} दिया जा रहा है। ${formatPaise(amount)} − ${formatPaise(covered)} = ${formatPaise(remaining)} किसी बिल पर नहीं लगेगा। और बिल चुनिए, ${formatPaise(covered)} दीजिए, या ${tickHi} ताकि ${formatPaise(remaining)} अडवांस रहे।` } });
    }
    // Issue #274 — what the advance is paid against, and its narration, only when there is an advance.
    const particulars = direction === 'PAYMENT' && remaining > 0n ? advanceParticularsOf(input, date) : undefined;
    const narration = particulars === undefined ? undefined : advanceNarration({
      party: party.name, particulars, how: how.words['en-IN'], reference, bills: applied.map(({ position }) => position.document.number),
    });
    return {
      direction, party, amount, date, how, reference, applied, leftOver: remaining, particulars, narration,
      advance: direction === 'PAYMENT' ? remaining : 0n,
      settlements: settlementPlan.settlements,
      creditNotes,
      owedBefore: sum(open.map((d) => d.outstanding)).minor,
      key,
    };
  }

  /**
   * Issue #295 — one credit note per line of the bill the discount is on (price corrections are
   * per original line, CGST s.34). The declared discount is shared across the bill's taxable
   * lines in proportion to their value; the note's own total is what it will actually credit,
   * within a paise or two of the declared figure.
   */
  private async creditNoteLinesOf(companyId: CompanyId, request: { position: DocumentPosition; declared: bigint }): Promise<{ lines: { lineId: string; amountOff: bigint }[]; noteTotal: bigint }> {
    const bill = await this.salesRepository.findById(companyId, request.position.document.documentId);
    if (bill === null || bill.state !== 'FINAL' || bill.pricing === null) {
      throw invalid('DISCOUNT_CREDIT_NOTE_UNAVAILABLE', `A GST credit note cannot be made on ${request.position.document.number}. Book the discount as an expense instead.`);
    }
    const halfUp = (numerator: bigint, denominator: bigint): bigint => denominator <= 0n ? 0n : (numerator + denominator / 2n) / denominator;
    const eligible = bill.pricing.lines.filter((line) => !isChargeLine(line) && line.taxableValue.minor > 0n && line.cess.minor === 0n);
    if (eligible.length === 0) {
      throw invalid('DISCOUNT_CREDIT_NOTE_UNAVAILABLE', `A GST credit note cannot be made on ${request.position.document.number}: nothing on it can be re-priced. Book the discount as an expense instead.`);
    }
    const grossOf = (line: (typeof eligible)[number]): bigint =>
      line.taxableValue.minor + line.cgst.minor + line.sgst.minor + line.utgst.minor + line.igst.minor + line.cess.minor;
    const totalGross = eligible.reduce((total, line) => total + grossOf(line), 0n);
    let given = 0n;
    const lines: { lineId: string; amountOff: bigint; expectedTax: bigint }[] = [];
    for (const [index, line] of eligible.entries()) {
      const credit = index === eligible.length - 1 ? request.declared - given : halfUp(request.declared * grossOf(line), totalGross);
      given += credit;
      const amountOff = halfUp(credit * line.taxableValue.minor, grossOf(line));
      if (amountOff <= 0n) continue;
      const expectedTax = [line.cgst, line.sgst, line.utgst, line.igst, line.cess]
        .reduce((total, head) => total + halfUp(head.minor * amountOff, line.taxableValue.minor), 0n);
      lines.push({ lineId: line.lineId, amountOff, expectedTax });
    }
    if (lines.length === 0) {
      throw invalid('DISCOUNT_CREDIT_NOTE_UNAVAILABLE', `A GST credit note cannot be made on ${request.position.document.number}. Book the discount as an expense instead.`);
    }
    return { lines, noteTotal: lines.reduce((total, line) => total + line.amountOff + line.expectedTax, 0n) };
  }

  private paymentPartyPrint(companyId: CompanyId, partyId: string): RenderableParty {
    if (customers(companyId).some((party) => party.id === partyId)) return customerPrint(companyId, partyId);
    const supplier = supplierParties(companyId).find((party) => party.id === partyId);
    const address = billingAddressOf(companyId, partyId);
    const stateCode = address?.stateCode ?? '';
    return {
      name: supplier?.legalName ?? (partyId === String(this.config.supplierId) ? this.config.supplierName : partyId),
      addressLines: address === null ? [] : [address.line1, ...(address.line2 === undefined || address.line2 === '' ? [] : [address.line2]), `${address.city} ${address.pincode}`],
      gstin: address?.gstin ?? null,
      stateCode,
      stateName: STATE_NAMES[stateCode] ?? stateCode,
    };
  }

  private partyName(companyId: CompanyId, partyId: string): string {
    return customers(companyId).find((party) => party.id === partyId)?.legalName
      ?? supplierParties(companyId).find((party) => party.id === partyId)?.legalName
      ?? (partyId === String(this.config.supplierId) ? this.config.supplierName : partyId === String(this.config.customerId) ? this.config.customerName : partyId);
  }

  // Issue #24 — explicit provider permission and incremental imports. Imported lines remain drafts
  // for the bank reconciliation engine; these endpoints never post ledger entries or move money.
  async bankFeedWorkspace(actor: ActorContext) {
    const context = this.bankContext(actor);
    const payments = await this.paymentRepository.list(actor.companyId);
    const transactionIds = (await Promise.all((await this.bankFeeds.connections(context)).map((connection) => this.bankFeeds.transactions(context, connection.id)))).flat().map((transaction) => transaction.id);
    const matched = await this.reconciliationStore.matchedLines(String(actor.companyId), transactionIds, payments.map((payment) => payment.id));
    const matchedBank = new Set(matched.bankTransactionIds);
    return {
      providers: [{ id: 'sandbox-aa', name: 'Sandbox authorised bank feed' }],
      connections: await Promise.all((await this.bankFeeds.connections(context)).map(async (connection) => ({
        ...this.bankConnectionJson(connection),
        accounts: (await this.bankFeeds.accounts(context, connection.id)).map((account) => ({ ...account, balancePaise: account.balancePaise?.toString() ?? null })),
        transactions: (await this.bankFeeds.transactions(context, connection.id)).map((transaction) => ({ ...transaction, debitPaise: transaction.debitPaise.toString(), creditPaise: transaction.creditPaise.toString(), matched: matchedBank.has(transaction.id) })),
      }))),
      // Issue #297 — which imported lines a match not undone already covers, for the Reconcile tab.
      // Payment ids are book data: a caller who may only read the bank balance gets the bank side,
      // not the ids of the business's receipts and payments.
      reconciliation: { matchedTransactionIds: matched.bankTransactionIds, matchedPaymentIds: actor.permissions.includes('bank.reconcile') ? matched.paymentIds : [] },
    };
  }

  async startBankFeedConsent(actor: ActorContext, input: Record<string, unknown>) {
    const { connection, state } = await this.bankFeeds.startConsent(this.bankContext(actor), { provider: String(input.provider ?? ''), ...(input.redirectUri ? { redirectUri: String(input.redirectUri) } : {}) });
    // Issue #402: `consentState` comes back once, to the person who started the request; the bank returns it.
    return { state: 'draft', connection: this.bankConnectionJson(connection), consentState: state };
  }

  async completeBankFeedConsent(actor: ActorContext, input: Record<string, unknown>) {
    const connection = await this.bankFeeds.completeConsent(this.bankContext(actor), String(input.connectionId ?? ''), String(input.authorizationCode ?? ''), String(input.consentState ?? ''));
    return { state: 'success', connection: this.bankConnectionJson(connection) };
  }

  async syncBankFeed(actor: ActorContext, input: Record<string, unknown>) {
    const connectionId = String(input.connectionId ?? '');
    const result = await this.bankFeeds.sync(this.bankContext(actor), connectionId, String(input.idempotencyKey ?? `web-bank-sync:${connectionId}:${appToday()}`));
    return { state: 'success', imported: result.imported, duplicates: result.duplicates, connection: this.bankConnectionJson(result.connection) };
  }

  async disconnectBankFeed(actor: ActorContext, input: Record<string, unknown>) {
    const connectionId = String(input.connectionId ?? '');
    const connection = await this.bankFeeds.disconnect(this.bankContext(actor), connectionId, String(input.idempotencyKey ?? `web-bank-disconnect:${connectionId}`));
    return { state: 'success', connection: this.bankConnectionJson(connection), message: both('Bank access was disconnected. Previously imported transactions remain available for your records.', 'बैंक का ऐक्सेस बंद हो गया। पहले से लाई गई ट्रांज़ेक्शन आपके रिकॉर्ड में हैं।') };
  }

  private bankContext(actor: ActorContext): BankFeedContext { this.companyOf(actor); return { companyId: String(actor.companyId), actorId: String(actor.userId), permissions: new Set(actor.permissions) }; }
  private bankConnectionJson(connection: BankFeedConnection) { return { ...connection }; }

  // ------------------------------------------------------------------ issue #22 [E22]: bank reconciliation
  //
  // Wired in for #297. The check matches imported bank lines against recorded bank receipts and
  // payments; it writes only its own match records — a bank line becomes money in the books only
  // through `payments.recordPayment`, with the party and the account chosen by a person.

  private reconciliationContext(actor: ActorContext) { this.companyOf(actor); return { companyId: String(actor.companyId), actorId: String(actor.userId), permissions: new Set(actor.permissions) }; }

  /** Every imported bank line, across every connection, oldest first. */
  private async bankFeedTransactions(actor: ActorContext) {
    const context = this.bankContext(actor);
    const lines = [] as Awaited<ReturnType<BankFeedService['transactions']>>[number][];
    for (const connection of await this.bankFeeds.connections(context)) lines.push(...await this.bankFeeds.transactions(context, connection.id));
    return lines.sort((a, b) => a.bookedOn.localeCompare(b.bookedOn));
  }

  private matchJson(match: ReconciliationMatch) {
    return {
      id: match.id, candidateId: match.candidateId, bankTransactionIds: match.bankTransactionIds, paymentIds: match.paymentIds,
      confidence: match.confidence, amountDifferencePaise: match.amountDifferencePaise.toString(), reasons: match.reasons,
      status: match.status, remainingBankPaise: match.remainingBankPaise.toString(), remainingBookPaise: match.remainingBookPaise.toString(),
      confirmedBy: match.confirmedBy, confirmedAt: match.confirmedAt,
    };
  }

  private runJson(run: ReconciliationRun) {
    return {
      candidates: run.candidates.map((candidate) => ({ ...candidate, amountDifferencePaise: candidate.amountDifferencePaise.toString() })),
      matches: run.matches.map((match) => this.matchJson(match)),
      exceptions: run.exceptions,
      suggestedPayments: run.suggestedPayments.map((suggestion) => ({ ...suggestion, amountPaise: suggestion.amountPaise.toString() })),
    };
  }

  async runBankReconciliation(actor: ActorContext) {
    const bankLines = (await this.bankFeedTransactions(actor)).map((transaction) => fromBankTransaction(transaction));
    const bookPayments = (await this.paymentRepository.list(actor.companyId))
      .map((payment) => fromPayment(payment)).filter((payment): payment is BookPayment => payment !== null);
    return this.runJson(await this.reconciliation.reconcile(this.reconciliationContext(actor), bankLines, bookPayments));
  }

  async confirmReconciliation(actor: ActorContext, input: Record<string, unknown>) {
    const candidateId = String(input.candidateId ?? '').trim();
    if (candidateId === '') throw invalid('RECONCILIATION_CANDIDATE_REQUIRED', 'Say which suggested match you are confirming.');
    return this.matchJson(await this.reconciliation.confirm(this.reconciliationContext(actor), candidateId));
  }

  async unmatchReconciliation(actor: ActorContext, input: Record<string, unknown>) {
    const matchId = String(input.matchId ?? '').trim();
    const reason = String(input.reason ?? '').trim();
    if (matchId === '') throw invalid('RECONCILIATION_MATCH_REQUIRED', 'Say which match to undo.');
    if (reason === '') throw invalid('RECONCILIATION_REASON_REQUIRED', 'Undoing a match needs a reason — it goes on the record.');
    return this.matchJson(await this.reconciliation.unmatch(this.reconciliationContext(actor), matchId, reason));
  }

  /**
   * A bank line with nothing in the books becomes a receipt or a payment the usual way — through
   * the receivables service, with the person naming the customer or supplier. The next run matches
   * it to the bank line on its own.
   */
  async recordBankSuggestion(actor: ActorContext, input: Record<string, unknown>) {
    const companyId = this.companyOf(actor);
    const transactionId = String(input.transactionId ?? '').trim();
    const line = (await this.bankFeedTransactions(actor)).find((transaction) => transaction.id === transactionId);
    if (line === undefined) throw notFound('BANK_LINE_NOT_FOUND', 'That bank line is not in this business\'s imported transactions.');
    const direction = line.creditPaise > 0n ? 'RECEIPT' : 'PAYMENT';
    const { party } = this.paymentParty(companyId, { direction, partyId: input.partyId });
    await this.shop.ledger.openPartyAccount(this.shop.setupActor, { partyId: party.id as PartyId, name: party.name, kind: direction === 'RECEIPT' ? 'CUSTOMER' : 'SUPPLIER' });
    const payment = await this.payments.recordPayment(actor, {
      // One press or a retried request records this bank line once.
      idempotencyKey: `bank-reconcile:${transactionId}`,
      direction,
      partyId: party.id as PartyId,
      mode: 'BANK_TRANSFER',
      amount: money(line.creditPaise > 0n ? line.creditPaise : line.debitPaise),
      date: isoDate(line.bookedOn),
      reference: line.reference ?? null,
      bankAccountCode: CURRENT_ACCOUNT,
      narration: `Recorded from the bank feed: ${line.description}`,
      // The supplier bill this debit settles, when the person named one; anything left over — or a
      // payment they said is on account — stays an advance, the same as the money-paid form.
      ...(billIdsOf(input).length > 0 ? { bills: billIdsOf(input) } : {}),
      ...(direction === 'PAYMENT' ? { advanceToSupplier: true } : {}),
    });
    return { state: 'success', paymentId: payment.id };
  }

  // ------------------------------------------------------------------ issue #32 [E32]: the compliance calendar

  /** The calendar as the deadlines screen and Home's "Coming up" read it. */
  async complianceCalendar(actor: ActorContext) {
    const view = await this.calendar.calendar(actor);
    return {
      today: view.today, from: view.from, to: view.to, exceptions: view.exceptions,
      entries: view.entries.map((entry) => ({
        occurrence: entry.occurrence, daysRemaining: entry.daysRemaining, state: entry.state,
        signals: entry.signals.map((signal) => ({ ...signal, ...(signal.amount === undefined ? {} : { amount: jsonAmount(signal.amount.minor) }) })),
        nextAction: entry.nextAction, reviewNote: entry.reviewNote,
      })),
    };
  }

  /** Mark a deadline done with what proves it — an ARN or challan, or a typed confirmation. */
  async completeObligation(actor: ActorContext, input: Record<string, unknown>) {
    const key = String(input.key ?? '').trim();
    if (key === '') throw invalid('OBLIGATION_REQUIRED', 'Say which deadline was done.');
    const reference = String(input.reference ?? '').trim();
    const note = String(input.note ?? '').trim();
    const filedOn = input.filedOn === undefined || String(input.filedOn).trim() === '' ? appToday() : isoDate(String(input.filedOn).trim());
    const evidence = reference !== ''
      ? { kind: 'PORTAL_RECEIPT' as const, reference, filedOn, note: note === '' ? `Shown on the portal as ${reference}.` : note }
      : { kind: 'TYPED_CONFIRMATION' as const, reference: '', filedOn, note };
    const record = await this.calendar.complete(actor, {
      key,
      evidence,
      idempotencyKey: String(input.idempotencyKey ?? '') || `calendar-complete:${key}:${actor.userId}`,
    });
    return { state: 'success', occurrence: record };
  }

  // The three readers the calendar's signals get their truth from. They run as the app's own actor:
  // what they read is company data already checked for permission on the way in.

  async returnReadiness(companyId: CompanyId, periodKey: string) {
    const preparations = (await this.gstReturns.list(this.shop.setupActor as ActorContext)).filter((preparation) => preparation.period === periodKey);
    if (preparations.length === 0) return { prepared: false, taxPayable: money(0n), blockingIssues: 0 };
    const gstr3b = preparations.find((preparation) => preparation.returnType === 'GSTR3B');
    const blockingIssues = preparations.reduce((count, preparation) =>
      count + preparation.findings.filter((finding) => finding.severity === 'BLOCKING').length, 0);
    // Tax payable = outward tax − claimable credit + reverse-charge liability, floored at zero.
    let taxPayable = 0n;
    if (gstr3b !== undefined) {
      const outward = totalTaxOf(sumReturnAmounts(gstr3b.snapshot.documents.flatMap((document) => document.lines.map((line) => line.amounts))));
      const credit = totalTaxOf(sumReturnAmounts([gstr3b.snapshot.inward.allOtherItc, gstr3b.snapshot.inward.reverseChargeItc, gstr3b.snapshot.inward.importItc])).minor - totalTaxOf(gstr3b.snapshot.inward.reversedItc).minor;
      taxPayable = outward.minor - credit + totalTaxOf(gstr3b.snapshot.inward.reverseChargeLiability).minor;
      if (taxPayable < 0n) taxPayable = 0n;
    }
    return { prepared: true, taxPayable: money(taxPayable), blockingIssues };
  }

  async eInvoiceBacklog(companyId: CompanyId, periodKey: string) {
    const bills = (await this.issuedInvoices(this.shop.setupActor as ActorContext)).invoices;
    const pending = bills.filter((bill) =>
      bill.date.startsWith(periodKey) && bill.needed === 'YES' && (bill.eInvoiceStatus === 'NOT_SENT' || bill.eInvoiceStatus === 'FAILED'));
    return {
      count: pending.length,
      records: pending.map((bill) => ({ kind: 'sales_invoice', id: bill.id, label: `Invoice ${bill.number ?? bill.id} dated ${bill.date}` })),
    };
  }

  async unresolvedPurchases(companyId: CompanyId, periodKey: string) {
    const workspace = await this.shop.itc.workspace(this.shop.setupActor as ActorContext, taxPeriod(periodKey));
    // Nothing imported for the month is not "unresolved" — it is nothing to compare yet.
    if (!workspace.portalDataPresent) return null;
    const unresolved = workspace.lines.filter((line) => line.decision === null && line.status !== 'EXACT');
    return {
      count: unresolved.length,
      amount: totalItcTaxOf(sumItcAmounts(unresolved.map((line) => line.claimable))),
      records: unresolved.map((line) => ({ kind: 'purchase_invoice', id: line.key, label: line.book?.number ?? line.portal?.number ?? line.key })),
    };
  }

  // ------------------------------------------------------------------ issue #59 [E59]: the rate advisor

  /**
   * A rate suggestion for the item form. It reads the tax-default register (#5) and never writes —
   * accepting it is the ordinary item-save path, so the business's declared rate is never overridden.
   */
  async rateHint(actor: ActorContext, input: Record<string, unknown>) {
    this.companyOf(actor);
    const hsnSac = String(input.hsnSac ?? '').trim();
    const itemId = String(input.itemId ?? '').trim();
    if (hsnSac === '' && itemId === '') throw invalid('RATE_HINT_NEEDS_A_CLUE', 'Give an item or an HSN/SAC code to suggest a rate for.');
    const advice = await this.rateAdvisor.suggest(String(actor.companyId), {
      index: 0,
      description: String(input.description ?? ''),
      ...(itemId === '' ? {} : { itemId }),
      ...(hsnSac === '' ? {} : { hsnSac }),
    }, appToday());
    const rate = advice.kind === 'SUGGESTED' ? advice.suggestion.rate : null;
    return {
      kind: advice.kind,
      ...(rate === null ? {} : {
        // The register and the item form both keep rates in basis points (5% = 500), so the
        // suggestion travels in the same unit — the form only divides for its percent text field.
        ratePercentTimes100: Number(rate.gstRateBasisPoints),
        basis: rate.basis,
        reverseCharge: rate.reverseCharge,
        citation: rate.citation,
        cessPerUnitPaise: rate.cessPerUnitPaise?.toString() ?? null,
      }),
      ...(advice.kind === 'SUGGESTED'
        ? { reason: advice.suggestion.reason, question: advice.suggestion.question, restingOn: advice.suggestion.restingOn ?? null }
        : { reason: advice.reason, question: advice.question, whatWouldHelp: advice.whatWouldHelp }),
    };
  }

  // ------------------------------------------------------------------ issue #30: GST returns
  //
  // One screen for a month. The two returns, the questions that stop it, whether it agrees with the
  // books, and the file to upload. The workspace object the service returns is already shaped for a
  // person, so this is a rename into JSON rather than a second set of decisions.

  private gstPeriodOf(input: Record<string, unknown>): TaxPeriod {
    const raw = String(input.period ?? '').trim();
    if (raw === '') {
      // Default to the month before today, which is the one a business is actually filing.
      // Issue #234 — worked out from today in India, not in UTC.
      return taxPeriod(previousMonthOfToday());
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
      statusLabel: say(workspace.stateLabel),
      summary: say(workspace.sentence),
      // Whether a snapshot has actually been taken and stored. Looking at what a month *would* say
      // is free and needs nothing stored, so this is not the same as `mayApprove`: a month nobody
      // has prepared has nothing to approve, and the screen must not offer to.
      prepared: workspace.preparation !== null,
      mayApprove: workspace.mayApprove,
      whyNotApprovable: workspace.whyNotApprovable.map((reason) => say(reason)),
      counts: workspace.counts,
      approvedAt: workspace.preparation?.approval?.approvedAt ?? null,
      exportedAt: workspace.preparation?.exportedAt ?? null,
      // Every table, with its rows and — on every row — the bills behind it.
      sections: workspace.gstr1.sections.map((section) => ({
        id: section.id,
        name: say(section.name),
        sentence: say(section.sentence),
        taxableValue: jsonAmount(section.totals.taxableValue.minor),
        tax: jsonAmount(totalTaxOf(section.totals).minor),
        rows: section.rows.map((row) => ({
          label: row.documentNumber ?? row.placeOfSupplyStateCode ?? '—',
          // Issue #232 — the state each row is reported under, so a note filed under the wrong state
          // can be seen on the screen and not only in the government file.
          placeOfSupply: row.placeOfSupplyStateCode === null ? null
            : `${STATE_NAMES[row.placeOfSupplyStateCode] ?? row.placeOfSupplyStateCode} (${row.placeOfSupplyStateCode})`,
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
      // Issue #231 — the code-wise summary (GSTR-1 table 12), so what it reports under each goods
      // code can be read back and compared with the printed bills.
      hsn: workspace.gstr1.hsn.map((row) => ({
        // Issue #286 — which tab of table 12 the row belongs to.
        supplyTo: row.supplyTo,
        hsn: row.hsnOrSac,
        description: row.description,
        unit: row.unit,
        quantity: row.quantity,
        rate: row.ratePercentTimes100 === null ? null : Number(row.ratePercentTimes100) / 100,
        taxableValue: jsonAmount(row.amounts.taxableValue.minor),
        cgst: jsonAmount(row.amounts.cgst.minor),
        sgst: jsonAmount(row.amounts.sgst.minor),
        igst: jsonAmount(row.amounts.igst.minor),
        cess: jsonAmount(row.amounts.cess.minor),
        bills: row.sources.map((source) => source.number),
      })),
      // Issue #233 — the documents-issued table (GSTR-1 table 13): every number used in the month,
      // and how many of them were cancelled rather than counted as sales.
      documentsIssued: workspace.gstr1.documents.map((row) => ({
        kind: row.kind, from: row.from, to: row.to, total: row.total, cancelled: row.cancelled, issued: row.issued,
      })),
      reasons: workspace.reasons.map((reason) => ({ sourceId: reason.sourceId, section: reason.section, reason: say(reason.reason) })),
      gstr3b: {
        summary: say(workspace.gstr3b.sentence),
        caution: say(workspace.gstr3b.caution),
        outward: workspace.gstr3b.outward.map((box) => ({
          boxId: box.boxId, label: say(box.label),
          taxableValue: jsonAmount(box.amounts.taxableValue.minor),
          tax: jsonAmount(totalTaxOf(box.amounts).minor),
        })),
        // Issue #289, part 3 — Table 4 box by box, so 4(A) and the s.17(5) credit taken out in 4(B)(1) can be seen.
        credit: workspace.gstr3b.credit.map((box) => ({
          boxId: box.boxId, label: say(box.label),
          cgst: jsonAmount(box.amounts.cgst.minor), sgst: jsonAmount(box.amounts.sgst.minor),
          igst: jsonAmount(box.amounts.igst.minor), cess: jsonAmount(box.amounts.cess.minor),
          tax: jsonAmount(totalTaxOf(box.amounts).minor),
        })),
        heads: workspace.gstr3b.heads.map((head) => ({
          head: head.head,
          liability: jsonAmount(head.liability.minor),
          credit: jsonAmount(head.credit.minor),
          difference: jsonAmount(head.difference.minor),
          reverseChargeCash: jsonAmount(head.reverseChargeCash.minor),
          cashToPay: jsonAmount(head.cashToPay.minor),
          creditLeft: jsonAmount(head.creditLeft.minor),
        })),
      },
      reconciliation: {
        agrees: workspace.reconciliation.agrees,
        sentence: say(workspace.reconciliation.sentence),
        heads: workspace.reconciliation.heads.map((head) => ({
          head: head.head,
          onTheReturn: jsonAmount(head.onTheReturn.minor),
          inTheBooks: jsonAmount(head.inTheBooks.minor),
          agrees: head.agrees,
        })),
      },
      // Issue #249 — the credit side: what the return claims against the input GST in the books.
      purchaseReconciliation: workspace.purchaseReconciliation === null ? null : {
        agrees: workspace.purchaseReconciliation.agrees,
        sentence: say(workspace.purchaseReconciliation.sentence),
        onTheReturn: jsonAmount(workspace.purchaseReconciliation.onTheReturn.minor),
        inTheBooks: jsonAmount(workspace.purchaseReconciliation.inTheBooks.minor),
        heads: workspace.purchaseReconciliation.heads.map((head) => ({
          head: head.head,
          onTheReturn: jsonAmount(head.onTheReturn.minor),
          inTheBooks: jsonAmount(head.inTheBooks.minor),
          explained: jsonAmount(head.explained.minor),
          agrees: head.agrees,
        })),
      },
      // The bills that are in the books but cannot go on the return until somebody answers.
      exceptions: workspace.exceptions.map((exception) => ({
        number: exception.document.number,
        party: exception.document.partyName,
        amount: jsonAmount(exception.document.invoiceValue.minor),
        questions: exception.findings.map((finding) => ({ message: say(finding.message), whatToDo: say(finding.whatToDo) })),
      })),
      findings: workspace.findings.map((finding) => ({
        code: finding.code, severity: finding.severity,
        message: say(finding.message), whatToDo: say(finding.whatToDo),
        document: finding.source?.number ?? null,
      })),
      drift: workspace.drift === null ? null : {
        message: say(workspace.drift.message),
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
      statusLabel: say(line.statusLabel),
      outcome: line.outcome,
      outcomeLabel: say(line.outcomeLabel),
      // Issue #192 — section 16(4)'s last date, beside the bill from the day it arrives rather than
      // on the day it is too late to do anything about it.
      lastClaimDate: line.lastClaimDate,
      lastClaimDateLabel: line.lastClaimDate === null ? null : formatClaimDate(line.lastClaimDate),
      sentence: say(line.sentence),
      matchNote: say(line.matchNote),
      claimable: jsonAmount(totalItcTaxOf(line.claimable).minor),
      heldBack: jsonAmount(totalItcTaxOf(line.heldBack).minor),
      // The whole of "match decisions show evidence": every field, both sides, and the verdict.
      evidence: line.evidence.map((row) => ({
        field: row.field,
        label: say(row.label),
        ours: row.ours,
        theirs: row.theirs,
        verdict: row.verdict,
        difference: row.difference === null ? null : jsonAmount(row.difference.minor),
      })),
      findings: line.findings.map((finding) => ({
        code: finding.code, severity: finding.severity,
        message: say(finding.message), whatToDo: say(finding.whatToDo),
      })),
      decision: line.decision === null ? null : {
        kind: line.decision.kind,
        reason: line.decision.reason,
        decidedAt: line.decision.decidedAt,
        stale: line.decisionStale,
      },
      portalSource: line.portal?.source ?? null,
      // Issue #249 — goods sent back: the bill the return corrects and our own note's number.
      againstBill: line.book?.original?.number ?? null,
      ourReference: line.book?.ourReference ?? null,
      awaitingSupplierNote: line.book?.awaitingSupplierNote === true,
    };
  }

  private itcWorkspaceJson(workspace: ItcWorkspace) {
    return {
      state: 'itc' as const,
      period: workspace.period,
      periodLabel: workspace.periodLabel,
      summary: say(workspace.sentence),
      portalDataPresent: workspace.portalDataPresent,
      lastImport: workspace.lastImport === null ? null : {
        source: workspace.lastImport.source,
        fileName: workspace.lastImport.fileName,
        importedAt: workspace.lastImport.importedAt,
        sentence: say(workspace.lastImport.sentence),
        rejected: workspace.lastImport.rejected.map((row) => row.reason),
      },
      counts: workspace.counts,
      outcomeCounts: workspace.outcomeCounts,
      claimable: jsonAmount(totalItcTaxOf(workspace.claimable).minor),
      heldBack: jsonAmount(totalItcTaxOf(workspace.heldBack).minor),
      // Its own figure, never folded into held back: this part comes back on no month.
      timeBarred: jsonAmount(totalItcTaxOf(workspace.timeBarred).minor),
      atRisk: jsonAmount(totalItcTaxOf(workspace.atRisk).minor),
      lines: workspace.lines.map((line) => this.itcLineJson(line)),
      findings: workspace.findings
        .filter((finding) => finding.lineKey === null)
        .map((finding) => ({ code: finding.code, severity: finding.severity, message: say(finding.message), whatToDo: say(finding.whatToDo) })),
      returnLinkage: {
        allOtherItc: jsonAmount(totalItcTaxOf(workspace.returnLinkage.allOtherItc).minor),
        reverseChargeItc: jsonAmount(totalItcTaxOf(workspace.returnLinkage.reverseChargeItc).minor),
        importItc: jsonAmount(totalItcTaxOf(workspace.returnLinkage.importItc).minor),
        reversedItc: jsonAmount(totalItcTaxOf(workspace.returnLinkage.reversedItc).minor),
        caution: say(workspace.returnLinkage.caution),
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
      imported: say(batch.sentence),
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
      imported: say(batch.sentence),
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
      idempotencyKey: `web-itc:${period}:${requestKeyOf(input, 'ITC_REQUEST_ID_REQUIRED', 'answer')}`,
    });
    return this.itcWorkspaceJson(workspace);
  }

  async gstReturnWorkspace(actor: ActorContext, input: Record<string, unknown>) {
    return this.gstWorkspaceJson(await this.gstReturns.workspace(actor, this.gstInput(input)));
  }

  async prepareGstReturn(actor: ActorContext, input: Record<string, unknown>) {
    const request = this.gstInput(input);
    const workspace = await this.gstReturns.prepare(actor, {
      ...request,
      idempotencyKey: `web-gstr:${request.period}:${String(input.reference ?? request.period)}`,
    });
    await this.shop.itc.claimPeriod(actor, request.period);
    return this.gstWorkspaceJson(workspace);
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
      title: both(`${returnType === 'GSTR1' ? 'GSTR-1' : 'GSTR-3B'} file ready`, `${returnType === 'GSTR1' ? 'GSTR-1' : 'GSTR-3B'} फ़ाइल तैयार`),
      message: say(file.sentence),
      fileName: file.fileName,
      payload: file.payload,
    };
  }

  async returnDocuments(actor: ActorContext) {
    const companyId = this.companyOf(actor);
    permissionPortFromActor.require(actor, 'returns.create', 'view bills eligible for return');
    const returned = async (id: string, kind: 'SALES_RETURN' | 'PURCHASE_RETURN', lineId: string) =>
      (await this.returnNotes.listForOriginal(companyId, id)).filter((note) => isGoodsReturn(note, kind))
        .flatMap((note) => note.lines).filter((line) => line.originalLineId === lineId)
        .reduce((total, line) => total + line.quantity.scaled, 0n);
    const sales = await this.salesRepository.list(companyId, { state: 'FINAL' });
    const purchases = (await this.shop.bills.list(companyId)).filter((bill) => bill.state === 'POSTED');
    return {
      documents: [
        ...(await Promise.all(sales.map(async (invoice) => ({
          kind: 'SALES_RETURN', id: invoice.id, number: invoice.number, party: this.invoicePrints.get(invoice.id)?.document.buyer.name ?? this.config.customerName,
          date: invoice.documentDate,
          // Issue #233 — what a credit note for the whole bill would still credit, charges included.
          // Issue #293 — a debit note for a higher price adds to it.
          leftToCredit: jsonAmount((invoice.pricing?.totals.invoiceValue.minor ?? 0n) + (await this.returnNotes.listForOriginal(companyId, invoice.id))
            .filter((note) => note.kind !== 'PURCHASE_RETURN')
            .reduce((total, note) => total + (note.kind === 'SALES_DEBIT_NOTE' ? 1n : -1n) * note.totals.total.minor, 0n)),
          lines: await Promise.all(invoice.lines.map(async (line) => ({
            id: line.lineId, item: invoice.pricing?.lines.find((priced) => priced.lineId === line.lineId)?.itemName ?? line.note ?? line.itemId,
            // Issue #293 — the rate the bill charged, so a price correction can start from it.
            rate: jsonAmount(line.unitPrice.minor),
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
    if (String(input.mode ?? '') === PRICE_CORRECTION) return this.previewPriceCorrection(actor, input);
    const command = this.returnInput(input);
    const preview = command.kind === 'SALES_RETURN'
      ? await this.returns.previewSales(actor, command.command)
      : await this.returns.previewPurchase(actor, command.command);
    // Issue #293 — services and charges never go into or out of a godown, so the sentence says so.
    const stockMoves = preview.lines.some((line) => line.supplyKind === 'GOODS' && !isChargeLine(line));
    return {
      state: 'preview', title: command.kind === 'SALES_RETURN' ? both('Customer return checked', 'ग्राहक वापसी जाँची गई') : both('Supplier return checked', 'सप्लायर वापसी जाँची गई'),
      message: say(preview.summary), amount: jsonAmount(preview.totals.total.minor), token: command.command.idempotencyKey,
      stockMoves,
      effects: [
        command.kind === 'SALES_RETURN' ? both('A credit note will reduce what the customer owes.', 'एक क्रेडिट नोट ग्राहक का बाक़ी घटा देगा।') : both('A debit note will reduce what you owe the supplier.', 'एक डेबिट नोट सप्लायर का आपका बाक़ी घटा देगा।'),
        !stockMoves ? both('Nothing goes into or out of stock: this is for services, not goods.', 'स्टॉक में कुछ नहीं आता-जाता: यह सेवाओं के लिए है, माल के लिए नहीं।')
          : command.kind === 'SALES_RETURN' ? both('Accepted goods will go back into stock.', 'स्वीकृत माल स्टॉक में वापस जाएगा।') : both('Returned goods will leave stock.', 'वापसी का माल स्टॉक से चला जाएगा।'),
        preview.complianceStatus === 'PENDING_ADJUSTMENT' ? both('This bill has a government e-invoice number, so this note must be reported to the government too.', 'इस बिल का सरकारी ई-इनवॉइस नंबर है, इसलिए यह नोट भी सरकार को रिपोर्ट होना ज़रूरी है।') : both('Nothing about this note has to be reported to the government separately.', 'इस नोट के बारे में सरकार को अलग से कुछ रिपोर्ट नहीं करना।'),
        ...preview.warnings.map(say),
      ],
      // Issue #186 — e.g. the 30 November deadline is close. Kept apart so every language shows it.
      warnings: preview.warnings.map(say),
    };
  }

  /**
   * Issue #298 — what the recorded note did, said in the session's language. `note.summary` is the
   * frozen English record kept for the printed note; this pair is only the screen's sentence, and
   * its en-IN side is the stored sentence verbatim so the two can never disagree.
   */
  private noteSummaryWords(note: ReturnNote): Bilingual {
    const total = formatINR(note.totals.total);
    const against = note.originalDocument.number;
    if (note.priceCorrection === true && note.kind === 'SALES_DEBIT_NOTE')
      return { 'en-IN': note.summary, 'hi-IN': `${note.number} ने ज़्यादा दाम के लिए ${against} पर ${total} और माँगा।` };
    if (note.priceCorrection === true)
      return { 'en-IN': note.summary, 'hi-IN': `${note.number} ने कम दाम के लिए ${against} पर ${total} का क्रेडिट दिया। माल वापस नहीं आया।` };
    if (note.kind === 'PURCHASE_RETURN') {
      const party = supplierParties(this.config.companyId).find((candidate) => candidate.id === note.partyId)?.legalName ?? note.partyId;
      return { 'en-IN': note.summary, 'hi-IN': `${note.number} ने ${against} के लिए ${party} का ${total} बाक़ी कम किया।` };
    }
    return { 'en-IN': note.summary, 'hi-IN': `${note.number} ने ${against} के लिए ${total} का क्रेडिट दिया।` };
  }

  async recordReturn(actor: ActorContext, input: Record<string, unknown>) {
    // Issue #293 — a price correction is recorded through the same door, with nothing coming back.
    const price = String(input.mode ?? '') === PRICE_CORRECTION;
    const command = price ? null : this.returnInput(input);
    const result = command === null
      ? await this.returns.postPriceCorrection(actor, this.priceCorrectionInput(input))
      : command.kind === 'SALES_RETURN'
        ? await this.returns.postSales(actor, command.command)
        : await this.returns.postPurchase(actor, command.command);
    await this.freezeNotePrint(result.note);
    // Issue #284 — a credit note to a registered buyer is reported like a bill: sent by itself,
    // never awaited, and only when the rules say this note needs an e-invoice number. Issue #293 —
    // so is a debit note to a customer (CGST Rule 48(4), inserted by Notification 68/2019-Central Tax
    // of 13 December 2019; the businesses it covers named by Notification 13/2020-Central Tax of 21 March 2020).
    const eInvoice = result.note.kind !== 'PURCHASE_RETURN' ? await this.noteEInvoiceDecision(actor, result.note) : null;
    if (eInvoice?.needed === 'YES' && eInvoice.lateForPortal !== true && !result.deduplicated) this.startAutomaticEInvoice(actor, result.note.id);
    const noteWords = result.note.kind === 'SALES_DEBIT_NOTE'
      ? { 'en-IN': 'This debit note', 'hi-IN': 'इस डेबिट नोट' }
      : { 'en-IN': 'This credit note', 'hi-IN': 'इस क्रेडिट नोट' };
    const noteSummary = this.noteSummaryWords(result.note);
    return {
      state: 'recorded', deduplicated: result.deduplicated,
      title: price
        ? (result.deduplicated ? both('Price correction already recorded once', 'दाम सुधार पहले से एक बार दर्ज है') : both('Price correction recorded', 'दाम सुधार दर्ज हुआ'))
        : (result.deduplicated ? both('Return already recorded once', 'वापसी पहले से एक बार दर्ज है') : both('Return recorded', 'वापसी दर्ज हुई')),
      message: eInvoice?.needed === 'YES'
        ? `${say(noteSummary)} ${eInvoice.lateForPortal === true ? say({ 'en-IN': eInvoice.message['en-IN'].replace('This bill', noteWords['en-IN']), 'hi-IN': eInvoice.message['hi-IN'].replace('इस बिल', noteWords['hi-IN']) }) : both(`${noteWords['en-IN']} has to carry a government e-invoice number. It is being sent now, and the number appears on the E-invoice screen when it comes back.`, `${noteWords['hi-IN']} पर सरकारी ई-इनवॉइस नंबर होना ज़रूरी है। उसे अब भेजा जा रहा है, और नंबर ई-इनवॉइस स्क्रीन पर आने पर दिखेगा।`)}`
        : say(noteSummary),
      note: { id: result.note.id, number: result.note.number, kind: result.note.kind, amount: jsonAmount(result.note.totals.total.minor), priceCorrection: result.note.priceCorrection === true },
    };
  }

  /** Issue #293 — the check before a price correction: what note it makes, for how much, saving nothing. */
  private async previewPriceCorrection(actor: ActorContext, input: Record<string, unknown>) {
    const command = this.priceCorrectionInput(input);
    const preview = await this.returns.previewPriceCorrection(actor, command);
    const credit = preview.kind === 'SALES_RETURN';
    return {
      state: 'preview', title: credit ? both('Lower price checked', 'कम दाम जाँचा गया') : both('Higher price checked', 'ज़्यादा दाम जाँचा गया'),
      message: say(preview.summary), amount: jsonAmount(preview.totals.total.minor), token: command.idempotencyKey,
      noteKind: preview.kind, stockMoves: false,
      effects: [
        credit ? both('A credit note will reduce what the customer owes.', 'एक क्रेडिट नोट ग्राहक का बाक़ी घटा देगा।') : both('A debit note will add to what the customer owes.', 'एक डेबिट नोट ग्राहक के बाक़ी में जुड़ेगा।'),
        both('Nothing goes into or out of stock: only the price changes.', 'स्टॉक में कुछ नहीं आता-जाता: सिर्फ़ दाम बदलता है।'),
        preview.complianceStatus === 'PENDING_ADJUSTMENT' ? both('This bill has a government e-invoice number, so this note must be reported to the government too.', 'इस बिल का सरकारी ई-इनवॉइस नंबर है, इसलिए यह नोट भी सरकार को रिपोर्ट होना ज़रूरी है।') : both('Nothing about this note has to be reported to the government separately.', 'इस नोट के बारे में सरकार को अलग से कुछ रिपोर्ट नहीं करना।'),
        ...preview.warnings.map(say),
      ],
      warnings: preview.warnings.map(say),
    };
  }

  /**
   * Issue #293 — a price correction as typed on the Returns screen: the bill, the line, and either the
   * new rate per unit (`newRate`) or the amount off (`amountOff`), both before GST.
   */
  private priceCorrectionInput(input: Record<string, unknown>) {
    if (String(input.kind ?? 'SALES_RETURN') === 'PURCHASE_RETURN') {
      throw invalid('PRICE_CORRECTION_SALES_ONLY', "A supplier's change of price comes on the supplier's own credit or debit note. Enter it from their paper.");
    }
    const documentId = String(input.documentId ?? '').trim();
    const lineId = String(input.lineId ?? '').trim();
    if (documentId === '' || lineId === '' || lineId === WHOLE_BILL) throw invalid('RETURN_DOCUMENT_REQUIRED', 'Choose the bill and the item whose price changes.');
    const newUnitPrice = optionalMoney(input.newRate);
    const amountOff = optionalMoney(input.amountOff);
    const cause = String(input.cause ?? '');
    return {
      cause: cause === 'DISCOUNT_AFTER_SALE' ? 'DISCOUNT_AFTER_SALE' as const : cause === 'INVOICE_ERROR' ? 'INVOICE_ERROR' as const : '' as 'INVOICE_ERROR',
      idempotencyKey: `web-price:${String(input.reference || `${documentId}:${lineId}:${input.date}`)}`,
      originalInvoiceId: documentId, originalLineId: lineId,
      documentDate: isoDate(String(input.date)), reason: String(input.reason ?? ''),
      ...(newUnitPrice === undefined ? {} : { newUnitPrice }),
      ...(amountOff === undefined ? {} : { amountOff }),
    };
  }

  /** Issue #284 — whether a sales credit note needs an e-invoice number, decided like its bill's. */
  private async noteEInvoiceDecision(actor: ActorContext, note: ReturnNote) {
    const bill = await this.salesRepository.findById(this.companyOf(actor), note.originalDocument.id);
    if (bill === null) return null;
    return this.eInvoiceDecisionFor({
      id: bill.id, partyId: bill.partyId, customerType: bill.customerType,
      documentDate: note.documentDate, documentType: note.kind === 'SALES_DEBIT_NOTE' ? 'DEBIT_NOTE' : 'CREDIT_NOTE',
    });
  }

  /**
   * Issue #186 — the printed note, frozen when it is recorded, exactly as a bill is.
   *
   * The customer's name, address and GSTIN and the place of supply come from the original bill as it
   * was printed, so the credit note names the buyer the bill named. The business's own particulars
   * are the ones saved on the day the note is issued (#180).
   */
  private async freezeNotePrint(note: ReturnNote): Promise<void> {
    if (this.notePrints.has(note.id)) return;
    const template = templateById('india-standard');
    if (template === undefined) throw notFound('API_TEMPLATE', 'The India-standard design is missing.');
    const branding = brandingOf(note.companyId);
    const us = sellerPrint(this.config.companyId, { name: this.config.name, gstin: this.config.gstin });
    const bill = note.kind !== 'PURCHASE_RETURN' ? this.invoicePrints.get(note.originalDocument.id) : undefined;
    const original = bill !== undefined
      ? noteOriginalFromInvoice(bill.document)
      : await this.noteOriginalFromPurchase(note);
    this.notePrints.set(note.id, {
      document: toCreditNoteDocument(note, original, { seller: us.seller, logoDataUri: branding.logoDataUri, signatureDataUri: us.signatureDataUri }),
      snapshot: brandedSnapshot(template, 'en-IN', String(note.documentDate), branding),
    });
  }

  /**
   * The other party when there is no frozen bill to copy it from: a supplier, or an old bill.
   *
   * Issue #291 — Rule 53(1A) asks a debit note for the supplier's name, address and GSTIN. Since
   * #228 the supplier is a master-data record with its billing address and GSTIN, so they are read
   * from there. The place of supply is the original purchase bill's: the goods were delivered to our
   * own registered state, wherever the supplier sits.
   */
  private async noteOriginalFromPurchase(note: ReturnNote): Promise<{ counterparty: RenderableParty; placeOfSupplyStateCode: string | null; placeOfSupplyStateName: string | null }> {
    try {
      return { counterparty: customerPrint(this.config.companyId, String(note.partyId)), placeOfSupplyStateCode: null, placeOfSupplyStateName: null };
    } catch {
      // Not a customer: the note was against a purchase, so the counterparty is the supplier, read below.
      const bill = note.kind === 'PURCHASE_RETURN' ? await this.shop.bills.findById(note.companyId, note.originalDocument.id) : null;
      const supplierId = String(bill?.supplierPartyId ?? note.partyId);
      const address = billingAddressOf(this.config.companyId, supplierId);
      const ours = this.config.gstin.slice(0, 2);
      const supplierState = address?.stateCode ?? (bill?.tax.intraState === true ? ours : '');
      const counterparty: RenderableParty = {
        name: bill?.supplierName ?? suppliers(this.config.companyId).find((party) => party.id === supplierId)?.legalName ?? supplierId,
        addressLines: address === null ? [] : [address.line1, ...(address.line2 === undefined ? [] : [address.line2]), `${address.city} ${address.pincode}`.trim()].filter((line) => line !== ''),
        gstin: address?.gstin ?? null,
        stateCode: supplierState,
        stateName: supplierState === '' ? '' : STATE_NAMES[supplierState] ?? supplierState,
      };
      return bill === null
        ? { counterparty, placeOfSupplyStateCode: null, placeOfSupplyStateName: null }
        : { counterparty, placeOfSupplyStateCode: ours, placeOfSupplyStateName: STATE_NAMES[ours] ?? ours };
    }
  }

  /** Issue #186 — every note this business has issued, newest first, for the Returns screen's list. */
  async listReturnNotes(actor: ActorContext) {
    permissionPortFromActor.require(actor, 'returns.create', 'view return notes');
    const notes = await this.returnNotes.list(this.companyOf(actor));
    return {
      notes: notes
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((note) => ({
          id: note.id, number: note.number, kind: note.kind, date: note.documentDate,
          against: note.originalDocument.number, amount: jsonAmount(note.totals.total.minor),
          printable: this.notePrints.has(note.id),
          // Issue #249 — the supplier's own credit note, once known, for goods sent back to them.
          supplierCreditNote: note.supplierCreditNote ?? null,
          // Issue #293 — a note that changed only the price.
          priceCorrection: note.priceCorrection === true,
        })),
    };
  }

  /**
   * Issue #249 — the supplier's credit-note number and date on a return of goods to them, added when
   * their note arrives. The purchase check then looks for it in the government's record.
   */
  async recordSupplierCreditNote(actor: ActorContext, input: Record<string, unknown>) {
    const noteId = String(input.noteId ?? '').trim();
    if (noteId === '') throw invalid('RETURN_NOTE_REQUIRED', 'Choose the return the credit note is for.');
    const note = await this.returns.recordSupplierCreditNote(actor, {
      noteId,
      number: String(input.supplierNoteNumber ?? ''),
      date: isoDate(String(input.supplierNoteDate ?? '')),
    });
    return {
      state: 'recorded', title: both("Supplier's credit note added", 'सप्लायर का क्रेडिट नोट जोड़ा'),
      message: both(`${note.number} now carries ${note.supplierCreditNote?.number ?? ''} dated ${note.supplierCreditNote?.date ?? ''}. The purchase check will look for it in the government's record.`, `${note.number} पर अब ${note.supplierCreditNote?.number ?? ''} दिनांक ${note.supplierCreditNote?.date ?? ''} है। पर्चेज़ चेक इसे सरकार के रिकॉर्ड में ढूँढेगा।`),
      note: { id: note.id, number: note.number, supplierCreditNote: note.supplierCreditNote ?? null },
    };
  }

  /** Issue #186 — the printed credit or debit note: on screen, on the printer, and as a PDF. */
  async notePrint(actor: ActorContext, noteId: string, options: { readonly pdf?: boolean; readonly format?: unknown; readonly locale?: unknown } = {}) {
    const note = await this.returnNotes.findById(this.companyOf(actor), noteId);
    if (note === null) throw notFound('API_NOTE_NOT_FOUND', 'No credit or debit note was found.');
    const frozen = this.notePrints.get(note.id);
    if (frozen === undefined) throw notFound('API_NOTE_PRINT_FACTS', 'This note was recorded before notes could be printed, so it has no stored page.');
    // Issue #284 — the government's IRN and signed QR, once registered, printed as on a bill.
    // The note prints without the IRN block rather than not at all; why the record was unreadable is reported.
    // Issue #343 — a refusal is not "unreadable": it is passed on, never printed around (#348 found the note printed anyway).
    const record = await this.shop.eInvoice.forDocument(actor, note.id).catch((error: unknown) => {
      if ((error as { kind?: string; code?: string }).kind === 'FORBIDDEN' || (error as { code?: string }).code === 'FORBIDDEN') throw error;
      reportUnexpected('api.notePrintIrn', error);
      return null;
    });
    const acknowledgement = record?.status === 'REGISTERED' ? record.acknowledgement ?? null : null;
    const facts = acknowledgement === null ? frozen : {
      ...frozen,
      document: {
        ...frozen.document,
        eInvoice: {
          irn: acknowledgement.irn,
          ackNumber: acknowledgement.ackNumber,
          ackDate: acknowledgement.ackDate,
          qrSvg: qrSvg(acknowledgement.signedQrCode, `IRN ${acknowledgement.irn}`),
        },
      },
    };
    const locale: Locale = options.locale === 'hi-IN' ? 'hi-IN' : 'en-IN';
    const format: PageFormat = options.format === 'THERMAL_80MM' ? 'THERMAL_80MM' : options.format === 'MOBILE' ? 'MOBILE' : 'A4';
    return {
      state: 'print' as const,
      number: note.number,
      kind: note.kind,
      format,
      ...(options.pdf === true
        ? { pdf: await creditNotePdf(facts.document, facts.snapshot, { format, locale }) }
        : { html: renderCreditNote(facts.document, facts.snapshot, { format, locale }) }),
    };
  }

  // ------------------------------------------------- issue #18: order, delivery, three-way match

  /** The catalogue the purchase screens share, so an item means the same thing on all of them. */
  private static readonly CATALOGUE: Record<string, { description: string; hsnSac: string; unit: string; kind: 'GOODS' | 'SERVICES'; batchId?: string }> = {
    TMT12: { description: 'TMT Steel Bar 12mm', hsnSac: '72142090', unit: 'KGS', kind: 'GOODS' },
    SOAP: { description: 'Herbal Bath Soap 100g', hsnSac: '34011190', unit: 'BOX', kind: 'GOODS' },
    FRT: { description: 'Inward freight', hsnSac: '996511', unit: 'NOS', kind: 'SERVICES' },
  };

  /**
   * Issue #366 — the item an order, a delivery or a bill check names. On a developer's machine the
   * three built-in short ids still work; everywhere else, and for any other id or name, it is one of
   * the business's own items (master data), so the stock it moves points at a real record and the
   * delivery survives a restart. An item that is not on the list is refused with the plain sentence
   * every other screen gives.
   */
  private catalogueItem(companyId: CompanyId | string, id: unknown) {
    const key = String(id ?? '').trim();
    const builtIn = DemoApplication.CATALOGUE[key === '' ? 'SOAP' : key];
    if (this.shop.persistence.kind === 'memory' && builtIn !== undefined) return { id: key === '' ? 'SOAP' : key, ...builtIn };
    const item = resolveItem(companyId, key);
    return {
      id: item.id, description: item.name, hsnSac: item.hsnSac, unit: item.baseUnit,
      kind: item.kind === 'goods' ? 'GOODS' as const : 'SERVICES' as const, batchId: undefined as string | undefined,
    };
  }

  /**
   * Issue #366 — who an order or a delivery is from: a supplier on the business's own list. The demo
   * supplier stands in only in memory and only when none was named, because on PostgreSQL a delivery
   * must point at a real supplier record.
   */
  private orderSupplier(companyId: CompanyId | string, input: Record<string, unknown>): { readonly id: string; readonly name: string } {
    const named = String(input.supplierId ?? '').trim();
    if (named === '' && this.shop.persistence.kind === 'memory') {
      return { id: this.config.supplierId, name: String(input.party || this.config.supplierName) };
    }
    const supplier = resolveSupplier(companyId, named || String(input.party ?? ''));
    return { id: supplier.id, name: supplier.legalName };
  }

  /** Reads a typed quantity into micro-units without letting a float near it. */
  private typedQuantity(value: unknown, unit: string) {
    const text = String(value ?? '').trim();
    if (!/^\d+(?:\.\d{1,6})?$/.test(text)) throw invalid('API_QUANTITY_INVALID', 'Enter a quantity, for example 100.');
    return quantity(text, unit);
  }

  /** How much of an item is actually on the shelf, which is the figure #18 has to get right. */
  private async stockOf(actor: ActorContext, itemId: string) {
    const item = this.catalogueItem(this.companyOf(actor), itemId);
    const balance = await this.shop.inventoryService.balance(actor, {
      itemId: item.id, warehouseId: this.shop.warehouseId, batchId: item.batchId ?? null,
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
    const item = this.catalogueItem(this.companyOf(actor), input.item);
    const supplier = this.orderSupplier(this.companyOf(actor), input);
    const created = await this.shop.matching.createOrder(actor, {
      orderNumber: number,
      supplierPartyId: supplier.id,
      supplierName: supplier.name,
      orderDate: String(input.date ?? ''),
      lines: [{
        lineNumber: 1, itemId: item.id, description: item.description, hsnSac: item.hsnSac,
        quantity: this.typedQuantity(input.quantity, item.unit), ratePaise: paise(input.rate),
        gstRateBasisPoints: Number(input.gst ?? 1800), supplyKind: item.kind,
        ...(item.kind === 'GOODS' ? { warehouseId: this.shop.warehouseId } : {}),
      }],
    });
    const order = created.state === 'DRAFT' ? await this.shop.matching.placeOrder(actor, created.id) : created;
    return {
      state: 'recorded', title: both('Order placed', 'ऑर्डर दिया गया'), message: order.summary,
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
    const item = this.catalogueItem(this.companyOf(actor), input.item);
    const orderNumber = String(input.orderNumber ?? '').trim();
    const order = orderNumber === '' ? null : await this.orderNumbered(actor, orderNumber);
    // A delivery against an order is from the order's own supplier.
    const supplier = order === null ? this.orderSupplier(this.companyOf(actor), input) : { id: order.supplierPartyId, name: order.supplierName };

    const received = this.typedQuantity(input.received, item.unit);
    const accepted = this.typedQuantity(input.accepted, item.unit);
    const rate = order?.lines[0]?.ratePaise ?? paise(input.rate);
    const shortfall = received.scaled - accepted.scaled;

    const details = {
      receiptNumber: number,
      supplierPartyId: supplier.id,
      supplierName: supplier.name,
      receiptDate: String(input.date ?? ''),
      ...(input.deliveryNote ? { deliveryNote: String(input.deliveryNote) } : {}),
      lines: [{
        lineNumber: 1, itemId: item.id, description: item.description, warehouseId: this.shop.warehouseId,
        ...(item.batchId ? { batchId: item.batchId } : {}),
        receivedQuantity: received, acceptedQuantity: accepted, ratePaise: rate,
        ...(shortfall > 0n
          ? {
              rejectionReason: (String(input.rejectionReason || 'DAMAGED') as 'DAMAGED'),
              rejectionNote: String(input.rejectionNote || 'Turned away at the gate'),
              evidence: { checkedBy: actor.userId, checkedAt: appClock.now().toISOString(), note: String(input.rejectionNote || 'Checked at the gate') },
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
    const item = this.catalogueItem(this.companyOf(actor), input.item);
    const invoiceNumber = String(input.reference ?? '').trim();
    if (!invoiceNumber) throw invalid('API_REFERENCE_REQUIRED', 'Enter the supplier bill number.');
    const orderNumber = String(input.orderNumber ?? '').trim();
    const order = orderNumber === '' ? null : await this.orderNumbered(actor, orderNumber);
    const supplier = order === null ? this.orderSupplier(this.companyOf(actor), input) : { id: order.supplierPartyId, name: order.supplierName };

    // With no order, every confirmed delivery from this supplier is what the bill is checked on.
    const receipts = order === null
      ? (await this.shop.matching.receiptsForParty(actor, supplier.id)).filter((receipt) => receipt.state === 'CONFIRMED')
      : [];

    const match = await this.shop.matching.matchForInvoice(actor, {
      purchaseId: `web-purchase:${invoiceNumber}`,
      invoiceNumber,
      supplierPartyId: supplier.id,
      lines: [{
        lineNumber: 1, itemId: item.id, description: item.description,
        quantity: this.typedQuantity(input.quantity, item.unit), ratePaise: paise(input.rate),
        gstRateBasisPoints: Number(input.gst ?? 1800),
      }],
    }, {
      ...(order === null ? { receiptIds: receipts.map((receipt) => receipt.id) } : { orderId: order.id }),
      on: String(input.date ?? appToday()),
    });

    const cleared = await this.shop.matching.isClearedToPost(actor, match);
    return { ...DemoApplication.matchJson(match, cleared), stock: await this.stockOf(actor, item.id) };
  }

  /** A person accepting the differences, with the reason kept beside them. */
  async approvePurchaseMatch(actor: ActorContext, input: Record<string, unknown>) {
    const reason = String(input.reason ?? '').trim();
    const rebuilt = await this.matchPurchaseBill(actor, input);
    if (rebuilt.outcome !== 'HOLD_FOR_APPROVAL') {
      return { ...rebuilt, title: both('Nothing to approve', 'मंज़ूर करने को कुछ नहीं'), message: both('This bill is not on hold, so there is nothing to accept.', 'यह बिल होल्ड पर नहीं है, इसलिए मंज़ूर करने को कुछ नहीं।') };
    }
    const match = rebuilt.raw;
    await this.shop.matching.approveMatch(actor, match, reason);
    const cleared = await this.shop.matching.isClearedToPost(actor, match);
    return {
      ...DemoApplication.matchJson(match, cleared),
      title: both('Differences accepted', 'फ़र्क़ मंज़ूर किया'),
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
    if (invoice === null) {
      // Issue #284 — a credit note is reported to the government exactly as a bill is.
      const note = await this.returnNotes.findById(companyId, invoiceId);
      if (note !== null && note.kind !== 'PURCHASE_RETURN') return this.noteEInvoiceDocument(actor, note);
      throw notFound('API_INVOICE_NOT_FOUND', 'We could not find that bill.');
    }
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
    // Issue #181 — the buyer this bill names, read from their own record.
    const buyerView = customerView(this.config.companyId, invoice.partyId);
    const exportSale = this.exportSales.get(invoice.id);
    const buyer: PartyDetails = {
      // "URP" — unregistered person — is what the portal expects when a buyer has no GST number.
      gstin: buyerView.gstin ?? 'URP',
      legalName: buyerView.name,
      address1: buyerView.line1 ?? '',
      ...(buyerView.line2 === null ? {} : { address2: buyerView.line2 }),
      location: buyerView.city ?? '',
      pincode: buyerView.pincode ?? '',
      stateCode: buyerView.stateCode ?? '',
    };

    // Issue #231 — freight and other charges are part of the value of the goods they travel with,
    // so they go inside those goods' items rather than as an item with no goods code.
    const lines: EInvoiceLine[] = foldChargesIntoGoods(pricing.lines).map((item, index) => ({
      lineNumber: index + 1,
      description: item.line.itemName,
      isService: invoice.supplyKind === 'SERVICES',
      hsnOrSac: item.line.hsnOrSac ?? '',
      quantity: (Number(item.line.quantity.scaled) / 1_000_000).toString(),
      unit: item.line.quantity.unit,
      unitPricePaise: item.line.unitPrice.minor,
      // The item's gross carries its share of the freight too, so gross less discount is still the
      // assessable value, which is how the government checks an item.
      grossAmountPaise: item.line.grossAmount.minor + item.chargeValue.minor,
      discountPaise: item.line.discountAmount.minor,
      taxableValuePaise: item.taxableValue.minor,
      gstRatePercentTimes100: item.line.ratePercentTimes100 ?? 0n,
      cgstPaise: item.cgst.minor,
      // One column for state and union-territory tax, as on the government's schema.
      sgstPaise: item.sgst.minor + item.utgst.minor,
      igstPaise: item.igst.minor,
      cessPaise: item.cess.minor,
      lineTotalPaise: item.lineTotal.minor,
    }));

    return {
      documentId: invoice.id,
      documentType: 'INVOICE',
      documentNumber: invoice.number,
      documentDate: invoice.documentDate,
      // Issue #143 — an export or SEZ sale reports the kind its bill printed, with the same particulars.
      recipientKind: exportSale?.kind ?? (invoice.customerType === 'B2B' ? 'B2B' : 'B2C'),
      ...(exportSale?.countryCode === undefined ? {} : { countryCode: exportSale.countryCode }),
      ...(exportSale?.currency === undefined ? {} : { currency: exportSale.currency }),
      ...(exportSale?.shippingBill === undefined ? {} : { shippingBill: exportSale.shippingBill }),
      supplier: seller,
      recipient: buyer,
      placeOfSupplyStateCode: pricing.placeOfSupplyStateCode,
      reverseCharge: false,
      lines,
      totalTaxableValuePaise: pricing.totals.taxableValue.minor,
      totalCgstPaise: pricing.totals.cgst.minor,
      totalSgstPaise: pricing.totals.sgst.minor + pricing.totals.utgst.minor,
      totalIgstPaise: pricing.totals.igst.minor,
      totalCessPaise: pricing.totals.cess.minor,
      roundOffPaise: pricing.totals.roundOff.minor,
      invoiceValuePaise: pricing.totals.invoiceValue.minor,
    };
  }

  /**
   * Issue #284 — a credit note for goods a registered buyer returned, as the government's CRN.
   *
   * The seller, the buyer, the place of supply and the buyer kind are the original bill's, because
   * the note adjusts that bill; the lines and amounts are the note's own. Freight and other charges
   * the note gives back go inside the first goods line, as they do on a bill (#231), because the
   * portal takes no item without a goods code.
   */
  private async noteEInvoiceDocument(actor: ActorContext, note: ReturnNote): Promise<EInvoiceDocument> {
    const bill = await this.eInvoiceDocumentFor(actor, note.originalDocument.id);
    const goods = note.lines.filter((line) => !isChargeLine(line));
    const charges = note.lines.filter((line) => isChargeLine(line));
    const extra = (pick: (line: ReturnNote['lines'][number]) => bigint) => charges.reduce((total, line) => total + pick(line), 0n);
    const lines: EInvoiceLine[] = goods.map((line, index) => {
      const first = index === 0;
      const taxable = line.amounts.taxableValue.minor + (first ? extra((charge) => charge.amounts.taxableValue.minor) : 0n);
      const cgst = line.amounts.cgst.minor + (first ? extra((charge) => charge.amounts.cgst.minor) : 0n);
      const sgst = line.amounts.sgst.minor + line.amounts.utgst.minor + (first ? extra((charge) => charge.amounts.sgst.minor + charge.amounts.utgst.minor) : 0n);
      const igst = line.amounts.igst.minor + (first ? extra((charge) => charge.amounts.igst.minor) : 0n);
      const cess = line.amounts.cess.minor + (first ? extra((charge) => charge.amounts.cess.minor) : 0n);
      return {
        lineNumber: index + 1,
        description: line.description,
        isService: line.supplyKind === 'SERVICES',
        hsnOrSac: line.hsnOrSac ?? '',
        quantity: (Number(line.quantity.scaled) / 1_000_000).toString(),
        unit: line.quantity.unit,
        unitPricePaise: line.unitPrice?.minor ?? 0n,
        grossAmountPaise: taxable,
        discountPaise: 0n,
        taxableValuePaise: taxable,
        gstRatePercentTimes100: line.ratePercentTimes100 ?? 0n,
        cgstPaise: cgst,
        sgstPaise: sgst,
        igstPaise: igst,
        cessPaise: cess,
        lineTotalPaise: taxable + cgst + sgst + igst + cess,
      };
    });
    const totals = note.totals;
    const taxes = totals.taxableValue.minor + totals.cgst.minor + totals.sgst.minor + totals.utgst.minor + totals.igst.minor + totals.cess.minor;
    return {
      ...bill,
      documentId: note.id,
      documentType: note.kind === 'SALES_DEBIT_NOTE' ? 'DEBIT_NOTE' : 'CREDIT_NOTE',
      documentNumber: note.number,
      documentDate: note.documentDate,
      lines,
      totalTaxableValuePaise: totals.taxableValue.minor,
      totalCgstPaise: totals.cgst.minor,
      totalSgstPaise: totals.sgst.minor + totals.utgst.minor,
      totalIgstPaise: totals.igst.minor,
      totalCessPaise: totals.cess.minor,
      roundOffPaise: totals.total.minor - taxes,
      invoiceValuePaise: totals.total.minor,
      precedingDocuments: [{ number: note.originalDocument.number, date: note.originalDocument.date }],
    };
  }

  /**
   * The turnover facts this product actually holds: the band the business picked in Business
   * details for the bill's financial year. Never a figure typed on the E-invoice screen (#236) —
   * one saved answer, read everywhere, so the screens cannot disagree.
   *
   * Two different facts come out of it:
   *
   *  - whether turnover *exceeded* ₹5 crore in any year from 2017-18 on, which decides whether the
   *    bill needs an e-invoice at all (Notification 13/2020 as amended by 10/2023); and
   *  - last year's turnover as bounds, which decides whether the portal's 30-day limit applies
   *    (₹10 crore and above, GSTN advisory of 5 November 2024).
   *
   * "Not sure", an unanswered year, and an old yes/no that does not settle a fact all leave that
   * fact out, and the rules then ask rather than guess.
   */
  private turnoverFactsOn(on: string): { readonly declaredTurnoverBand?: { thresholdPaise: bigint; above: boolean }; readonly lastYearTurnover?: { atLeastPaise?: bigint; belowPaise?: bigint } } {
    const answers = turnoverAnswersOf(this.config.companyId);
    const band = turnoverBandOn(answers, isoDate(on));
    const legacy = band === null ? turnoverAnswerOn(answers, isoDate(on)) : null;
    const FIVE = 5_00_00_000_00n;
    const TEN = 10_00_00_000_00n;
    // "Up to ₹5 crore" is at most ₹5 crore, so below one paisa more.
    const upToFive = { belowPaise: FIVE + 1n };
    const overFive = { atLeastPaise: FIVE + 1n };
    const everAbove = band === '5_TO_10_CRORE' || band === '10_CRORE_AND_ABOVE' || band === 'UP_TO_5_CRORE_EARLIER_ABOVE' || legacy === 'YES'
      ? true
      : band === 'UP_TO_5_CRORE' ? false : undefined;
    const lastYear = band === 'UP_TO_5_CRORE' || band === 'UP_TO_5_CRORE_EARLIER_ABOVE' || legacy === 'NO'
      ? upToFive
      : band === '5_TO_10_CRORE' ? { ...overFive, belowPaise: TEN }
        : band === '10_CRORE_AND_ABOVE' ? { atLeastPaise: TEN }
          : legacy === 'YES' ? overFive : undefined;
    return {
      ...(everAbove === undefined ? {} : { declaredTurnoverBand: { thresholdPaise: FIVE, above: everAbove } }),
      ...(lastYear === undefined ? {} : { lastYearTurnover: lastYear }),
    };
  }

  /**
   * Issue #239 — the facts the rules decide on, all of them already held by the app: the bill's own
   * date and buyer, the turnover band and the exemption from Business details. Nothing is taken
   * from what somebody types on the E-invoice screen, so that screen and the sale review cannot
   * give two different answers for one bill.
   */
  private applicabilityFor(document: EInvoiceDocument) {
    return this.applicabilityOf({
      documentType: document.documentType,
      documentDate: document.documentDate,
      recipientKind: document.recipientKind,
      recipientGstin: document.recipient.gstin,
    });
  }

  private applicabilityOf(bill: { readonly documentType?: EInvoiceDocument['documentType'] | undefined; readonly documentDate: string; readonly recipientKind: EInvoiceDocument['recipientKind']; readonly recipientGstin: string | null; readonly billOfSupply?: boolean }) {
    const exemption = eInvoiceExemptionOf(this.config.companyId);
    return {
      documentType: bill.documentType ?? 'INVOICE' as const,
      documentDate: bill.documentDate,
      recipientKind: bill.recipientKind,
      // Issue #296 — a composition dealer's bill of supply carries no tax and is never reported.
      ...(bill.billOfSupply === true ? { isBillOfSupply: true } : {}),
      ...(bill.recipientGstin === null || bill.recipientGstin === '' || bill.recipientGstin === 'URP' ? {} : { recipientGstin: bill.recipientGstin }),
      supplier: {
        gstin: this.config.gstin,
        ...this.turnoverFactsOn(bill.documentDate),
        ...(exemption === 'NONE' ? {} : { exemptCategories: [exemption] }),
      },
    };
  }

  /**
   * Issue #239 — whether this bill needs a government e-invoice number, said in one line.
   *
   * Decided by the same rules that decide whether the bill is sent, from what the app already
   * knows: who the buyer is (a registered business, a consumer, an export), the bill's date, and
   * the turnover band and exemption saved in Business details. When the turnover is not known the
   * answer is "we don't know yet" with a pointer to Business details — never a guess either way.
   * It never stops a bill being issued (#210 part 3).
   */
  private eInvoiceDecisionFor(bill: { readonly id: string; readonly partyId: string; readonly customerType: 'B2B' | 'B2C'; readonly documentDate: string; readonly exportKind?: ExportParticulars['kind'] | undefined; readonly documentType?: EInvoiceDocument['documentType']; readonly pricing?: { readonly supplierRegistration?: string } | null }): {
    readonly needed: 'YES' | 'NO' | 'UNKNOWN';
    readonly message: { readonly 'en-IN': string; readonly 'hi-IN': string };
    readonly askTurnover: boolean;
    readonly ruleId: string;
    /** Needed, but dated too long ago for the portal to take it (#236). */
    readonly lateForPortal?: boolean;
  } {
    let gstin: string | null = null;
    // A party that is no longer a customer (merged, or a supplier's note) has no GSTIN to read here.
    try { gstin = customerView(this.config.companyId, bill.partyId).gstin; } catch (error) { reportUnexpected('api.einvoiceRecipient', error); gstin = null; }
    const recipientKind = bill.exportKind ?? this.exportSales.get(bill.id)?.kind ?? (bill.customerType === 'B2B' ? 'B2B' as const : 'B2C' as const);
    const decision = decideApplicability(this.applicabilityOf({ documentType: bill.documentType, documentDate: bill.documentDate, recipientKind, recipientGstin: gstin, billOfSupply: bill.pricing?.supplierRegistration === 'COMPOSITION' }));
    const NOT_NEEDED = 'This bill does not need an e-invoice number';
    const NOT_NEEDED_HI = 'इस बिल को ई-इनवॉइस नंबर की ज़रूरत नहीं';
    if (decision.outcome === 'APPLICABLE') {
      const deadline = reportingDeadline(bill.documentDate, this.turnoverFactsOn(bill.documentDate).lastYearTurnover ?? {}, appToday());
      // Issue #236 — a bill dated too long ago for the portal is not described as being sent.
      const late = deadline.kind === 'LIMIT' && deadline.closed;
      const message = late
        ? { 'en-IN': `This bill needs a government e-invoice number, but it cannot be sent. ${deadline.message}`,
            'hi-IN': `इस बिल को सरकारी ई-इनवॉइस नंबर चाहिए, पर उसे नहीं भेजा जा सकता। ${deadline.message}` }
        : { 'en-IN': 'This bill needs a government e-invoice number. It is sent by itself when you issue it.',
            'hi-IN': 'इस बिल को सरकारी ई-इनवॉइस नंबर चाहिए। जारी करते ही अपने आप भेजा जाता है।' };
      return { needed: 'YES', message, askTurnover: false, ruleId: decision.ruleId, lateForPortal: late };
    }
    if (decision.outcome === 'NOT_APPLICABLE') {
      const exemption = eInvoiceExemptionOf(this.config.companyId);
      const message = decision.ruleId === 'EINV.RECIPIENT.B2C'
        ? { 'en-IN': `${NOT_NEEDED}: the customer has no GST number.`,
            'hi-IN': `${NOT_NEEDED_HI}: ग्राहक के पास GST नंबर नहीं है।` }
        : decision.ruleId.startsWith('EINV.EXEMPT.') && exemption !== 'NONE'
          ? { 'en-IN': `${NOT_NEEDED}: Business details says your business is ${EINVOICE_EXEMPTION_WORDS[exemption]}, and the e-invoice rules leave those out whatever the turnover.`,
              'hi-IN': `${NOT_NEEDED_HI}: बिज़नेस डिटेल्स कहता है आपका कारोबार ${EINVOICE_EXEMPTION_WORDS[exemption]} है, और ई-इनवॉइस के नियम उन्हें हर टर्नओवर पर छोड़ते हैं।` }
          : decision.ruleId.startsWith('EINV.THRESHOLD.')
            ? { 'en-IN': `${NOT_NEEDED}: Business details says your turnover has never been over ₹5 crore in any year since 2017-18.`,
                'hi-IN': `${NOT_NEEDED_HI}: बिज़नेस डिटेल्स कहता है आपका टर्नओवर 2017-18 के बाद कभी ₹5 करोड़ से ऊपर नहीं गया।` }
            : { 'en-IN': `${NOT_NEEDED}. ${decision.reason}`, 'hi-IN': `${NOT_NEEDED_HI}. ${decision.reason}` };
      return { needed: 'NO', message, askTurnover: false, ruleId: decision.ruleId };
    }
    if (decision.ruleId === 'EINV.TURNOVER.UNKNOWN') {
      return {
        needed: 'UNKNOWN', askTurnover: true, ruleId: decision.ruleId,
        message: { 'en-IN': "We don't know yet whether you need e-invoices: Business details does not say whether your turnover has been over ₹5 crore. Answer once in Business details. This bill can still be issued now.",
                   'hi-IN': 'अभी पता नहीं कि आपको ई-इनवॉइस चाहिए या नहीं: बिज़नेस डिटेल्स में नहीं लिखा कि टर्नओवर ₹5 करोड़ से ऊपर गया है या नहीं। बिज़नेस डिटेल्स में एक बार जवाब दीजिए। यह बिल अभी भी जारी हो सकता है।' },
      };
    }
    return { needed: 'UNKNOWN', askTurnover: false, ruleId: decision.ruleId, message: { 'en-IN': decision.reason, 'hi-IN': decision.reason } };
  }

  /**
   * The invoices this company has issued: the pickers on other screens, and the E-invoice screen's
   * list (#239) — each bill, whether it needs an e-invoice number and why, and where it stands with
   * the government in plain words. Nothing here asks the person anything.
   */
  async issuedInvoices(actor: ActorContext) {
    const companyId = this.companyOf(actor);
    const invoices = await this.salesRepository.list(companyId, { state: 'FINAL' });
    const records = await this.shop.eInvoice.list(actor);
    const now = appClock.now().toISOString();
    return {
      invoices: invoices.map((invoice) => {
        const record = records.find((candidate) => candidate.documentId === invoice.id);
        const decision = this.eInvoiceDecisionFor(invoice);
        let customer: string | null = null;
        try { customer = customerView(this.config.companyId, invoice.partyId).name; } catch (error) { reportUnexpected('api.listCustomerName', error); customer = null; }
        const status = record?.status ?? 'NOT_SENT';
        return {
          id: invoice.id,
          number: invoice.number,
          date: invoice.documentDate,
          customer,
          amount: jsonAmount(invoice.pricing?.totals.invoiceValue.minor ?? 0n),
          // The bill's own state and the government's are shown separately, never merged.
          eInvoiceStatus: status,
          // Issue #239 — decided by the app, never asked.
          needed: decision.needed,
          // The bill is already issued, so "sent by itself when you issue it" is not said here;
          // the status line says where it stands.
          decision: decision.needed === 'YES' && decision.lateForPortal !== true
            ? both('This bill needs a government e-invoice number.', 'इस बिल को सरकारी ई-इनवॉइस नंबर चाहिए।')
            : say(decision.message),
          askTurnover: decision.askTurnover,
          statusText: DemoApplication.eInvoiceStatusText(status, record?.failure ?? null, decision.needed),
          canRetry: status === 'FAILED' && record?.failure?.retryable === true && decision.needed === 'YES',
          canCancel: status === 'REGISTERED' && (record?.cancellableUntil === undefined || record.cancellableUntil > now),
        };
      }).concat(await this.creditNoteEInvoiceRows(actor, invoices, records, now)),
    };
  }

  /**
   * Issue #284 — the credit notes for goods customers returned, on the same list as the bills they
   * adjust, because a note to a registered buyer needs its own e-invoice number. Only notes that
   * need one are listed: a note to a consumer has nothing to send, and listing it would only add noise.
   */
  private async creditNoteEInvoiceRows(
    actor: ActorContext,
    invoices: readonly { readonly id: string; readonly partyId: string; readonly customerType: 'B2B' | 'B2C' }[],
    records: readonly EInvoiceRecord[],
    now: string,
  ) {
    const notes = (await this.returnNotes.list(this.companyOf(actor))).filter((note) => note.kind !== 'PURCHASE_RETURN');
    return notes.flatMap((note) => {
      const bill = invoices.find((invoice) => invoice.id === note.originalDocument.id);
      if (bill === undefined) return [];
      const debit = note.kind === 'SALES_DEBIT_NOTE';
      const decision = this.eInvoiceDecisionFor({ id: bill.id, partyId: bill.partyId, customerType: bill.customerType, documentDate: note.documentDate, documentType: debit ? 'DEBIT_NOTE' : 'CREDIT_NOTE' });
      if (decision.needed !== 'YES') return [];
      const record = records.find((candidate) => candidate.documentId === note.id);
      let customer: string | null = null;
      try { customer = customerView(this.config.companyId, bill.partyId).name; } catch (error) { reportUnexpected('api.listCustomerName', error); customer = null; }
      const status = record?.status ?? 'NOT_SENT';
      return [{
        id: note.id,
        number: note.number,
        date: note.documentDate,
        customer,
        amount: jsonAmount(note.totals.total.minor),
        kind: debit ? 'DEBIT_NOTE' as const : 'CREDIT_NOTE' as const,
        against: note.originalDocument.number,
        eInvoiceStatus: status,
        needed: decision.needed,
        decision: decision.lateForPortal === true
          ? say(decision.message).replace('This bill', debit ? 'This debit note' : 'This credit note')
          : both(`This ${debit ? 'debit' : 'credit'} note against ${note.originalDocument.number} needs a government e-invoice number.`,
                 `${note.originalDocument.number} के लिए इस ${debit ? 'डेबिट' : 'क्रेडिट'} नोट को सरकारी ई-इनवॉइस नंबर चाहिए।`),
        askTurnover: false,
        statusText: DemoApplication.eInvoiceStatusText(status, record?.failure ?? null, decision.needed),
        canRetry: status === 'FAILED' && record?.failure?.retryable === true,
        canCancel: status === 'REGISTERED' && (record?.cancellableUntil === undefined || record.cancellableUntil > now),
      }];
    });
  }

  /** Issue #239 — where a bill stands with the government, in one plain line. */
  private static eInvoiceStatusText(status: string, failure: { readonly message: string; readonly retryable: boolean } | null, needed: 'YES' | 'NO' | 'UNKNOWN'): string {
    switch (status) {
      case 'REGISTERED': return 'Sent. The government gave it an e-invoice number.';
      case 'PENDING': return 'Waiting for the government to answer.';
      case 'CANCELLED': return 'Cancelled with the government.';
      case 'FAILED': return failure === null
        ? 'Refused by the government.'
        : `Refused by the government: ${failure.message}${failure.retryable ? ' Worth trying again.' : ''}`;
      default: return needed === 'YES' ? 'Not sent yet.' : needed === 'NO' ? 'Nothing to send.' : 'Not sent: waiting for your turnover answer in Business details.';
    }
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
      // Issue #283 — the deadline in Indian time, not a UTC stamp the owner has to convert.
      cancellableUntilLabel: record.cancellableUntil === undefined ? null : describeExpiry(record.cancellableUntil),
      reportableUntil: record.reportableUntil ?? null,
      reportableUntilLabel: record.reportableUntil === undefined ? null : readableDate(record.reportableUntil),
      failure: record.failure ?? null,
      raw: record,
    };
  }

  /** Whether this bill needs an IRN, and what would be sent. Writes nothing, sends nothing. */
  async previewEInvoice(actor: ActorContext, input: Record<string, unknown>) {
    const document = await this.eInvoiceDocumentFor(actor, String(input.invoice ?? ''));
    const existing = (await this.shop.eInvoice.list(actor)).find((record) => record.documentId === document.documentId) ?? null;
    const preview = await this.shop.eInvoice.preview(actor, {
      document, applicability: this.applicabilityFor(document),
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
      // Issue #236 — "must be reported by" only for a business the limit applies to; otherwise one
      // plain sentence saying there is no deadline, or that we need its turnover to tell.
      reportableUntilLabel: preview.reportableUntil === undefined ? null : readableDate(preview.reportableUntil),
      deadline: preview.deadline === undefined ? null : { kind: preview.deadline.kind, message: preview.deadline.message },
      problems: preview.problems.map((problem) => ({ field: problem.field, message: problem.message })),
      documentNumber: document.documentNumber,
      // Issue #239 — what the government already holds for this bill, so a bill already sent is
      // shown as sent (with Cancel), not as "Ready to send" (left over from #236).
      record: existing === null ? null : DemoApplication.eInvoiceJson(existing),
    };
  }

  /** Sends the bill to the government, once. */
  async registerEInvoice(actor: ActorContext, input: Record<string, unknown>) {
    const document = await this.eInvoiceDocumentFor(actor, String(input.invoice ?? ''));
    const record = await this.shop.eInvoice.register(actor, {
      document, applicability: this.applicabilityFor(document),
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
      document, applicability: this.applicabilityFor(document),
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
    // Issue #141 — a delivery challan travels in place of an invoice (CGST Rule 55(3)). It brings
    // its own reason for moving, so the form's reason is not asked for a second time.
    const challan = await this.challans.forMovement(actor, invoiceId);
    if (challan !== null) return this.movementOf(challan.document, challan.reason, input, challan.partyId);

    const invoice = await this.salesRepository.findById(companyId, invoiceId);
    if (invoice === null) throw notFound('API_INVOICE_NOT_FOUND', 'We could not find that bill.');
    if (invoice.state !== 'FINAL' || invoice.number === null) {
      throw invalid('API_INVOICE_NOT_FINAL', 'This bill has not been issued yet, so there is nothing to move against it.');
    }
    const pricing = invoice.pricing;
    if (pricing === null) throw invalid('API_INVOICE_NOT_PRICED', 'This bill has no tax worked out on it yet.');
    // Issue #287 — CGST Rule 138(1): e-way bills are for goods that move.
    if (invoice.supplyKind === 'SERVICES') {
      throw invalid('EWAY_NOT_FOR_SERVICES', 'This bill is for a service. An e-way bill is only for goods that move (CGST Rule 138), so this bill never needs one.');
    }

    const lines = consignmentLinesOf(pricing.lines);
    const document: ConsignmentDocument = {
      documentId: invoice.id,
      documentType: pricing.supplierRegistration === 'COMPOSITION' ? 'BILL_OF_SUPPLY' : 'TAX_INVOICE',
      documentNumber: invoice.number,
      documentDate: invoice.documentDate,
      lines,
    };
    // Issue #224 — where the bill itself says the goods went, when it says somewhere other than the
    // buyer's billing address. The e-way bill carries that address rather than asking for it again.
    const delivery = this.deliveries.get(invoice.id);
    const recorded = delivery?.deliverTo ?? null;
    // Issue #240 — what the sale already said about the journey: the vehicle and the transporter.
    // A form that sends its own vehicle box wins, even empty (Part A now, the lorry later); a caller
    // that sends nothing gets the bill's.
    const fromBill = {
      vehicle: delivery?.transport?.vehicleNumber ?? null,
      carrier: delivery?.carrier ?? null,
    };
    return this.movementOf(document, String(input.reason ?? 'SUPPLY') as MovementReason, input, String(invoice.partyId), recorded, fromBill);
  }

  /** One movement of goods: the document on the lorry, why it is moving, and what the form said. */
  /** One customer, as an e-way bill names a party: their own record, never a stand-in. */
  private movementParty(partyId: string): MovementParty {
    const view = customerView(this.config.companyId, partyId);
    // Issue #224 — an address saved with a PIN from another state never goes onto an e-way bill.
    if (view.stateCode !== null && view.pincode !== null) requireAddressInState({ stateCode: view.stateCode, pincode: view.pincode }, `${view.name}'s`);
    return {
      legalName: view.name,
      gstin: view.gstin ?? 'URP',
      address1: view.line1 ?? '',
      ...(view.line2 === null ? {} : { address2: view.line2 }),
      place: view.city ?? '',
      pincode: view.pincode ?? '',
      stateCode: view.stateCode ?? '',
    };
  }

  private movementOf(
    document: ConsignmentDocument, reason: MovementReason, input: Record<string, unknown>, partyId: string,
    recorded: MovementParty | null = null,
    fromBill: { readonly vehicle: string | null; readonly carrier: DeliveryDetails['carrier'] } = { vehicle: null, carrier: null },
  ): Movement {
    // Issue #180 — where the goods actually leave from, taken from the business's own address. An
    // e-way bill that disagrees with the invoice about the dispatch place is exactly the
    // discrepancy an officer stops a lorry over.
    const consignor: MovementParty = dispatchFrom(this.config.companyId, { name: this.config.name, gstin: this.config.gstin });
    // Issue #181 — the customer this document was actually made out to, with their own saved
    // address. An e-way bill naming a different buyer is a discrepancy against its own invoice.
    const billTo: MovementParty = this.movementParty(partyId);

    const shipTo = DemoApplication.deliveryPlace(billTo, recorded, input);

    const distance = String(input.distanceKm ?? '').trim();
    if (distance !== '' && !/^\d{1,4}$/.test(distance)) {
      throw invalid('EWAY_DISTANCE', `"${distance}" is not a distance. Type whole kilometres, for example 840, or leave it empty and the portal works it out from the PIN codes.`);
    }
    const vehicleNumber = (input.vehicle === undefined ? fromBill.vehicle ?? '' : String(input.vehicle)).trim();
    const carrier = fromBill.carrier;
    const withinSameCity = String(input.withinSameCity ?? '').trim();
    const vehicle: VehicleAssignment | undefined = vehicleNumber === '' ? undefined : {
      registrationNumber: vehicleNumber,
      vehicleType: input.oversized === 'yes' ? 'ODC' : 'REGULAR',
      fromPlace: consignor.place,
      fromStateCode: consignor.stateCode,
    };

    return {
      movementId: document.documentId,
      reason,
      consignor,
      billTo,
      ...(shipTo === undefined ? {} : { shipTo }),
      documents: [document],
      transportMode: 'ROAD',
      vehicleType: input.oversized === 'yes' ? 'ODC' : 'REGULAR',
      conveyance: 'OWN_VEHICLE',
      // Issue #240 — blank is sent as 0: the portal works the road distance out from the two PIN
      // codes itself. A typed distance is checked against the portal's own before it is sent.
      ...(distance === '' ? {} : { approximateDistanceKm: Number(distance) }),
      ...(carrier === null ? {} : {
        transporter: {
          name: carrier.name,
          transporterId: carrier.transporterId,
          ...(carrier.documentNumber === undefined ? {} : { documentNumber: carrier.documentNumber }),
          ...(carrier.documentDate === undefined ? {} : { documentDate: carrier.documentDate as IsoDate }),
        },
      }),
      ...(withinSameCity === '' ? {} : { withinSameCity: withinSameCity === 'yes' }),
      ...(vehicle === undefined ? {} : { vehicle }),
    };
  }

  /**
   * Issue #224 — where the goods really go, as the e-way bill names it. Undefined when they go to the
   * buyer's own billing address, so the rules read that address and the portal is told "Regular".
   *
   * Nothing here is copied from the buyer. The delivery place used to be the buyer's own record with
   * the town and state swapped in, so a Hyderabad delivery went out under the buyer's Delhi PIN code
   * and an address line nobody had typed. The PIN is what the portal works the route out from and
   * what an officer checks against the lorry.
   *
   * 1. The bill already says where the goods went: that address, in full. A dispatch form naming a
   *    different state is refused, because one bill cannot describe two journeys.
   * 2. The bill does not, and the form names a delivery state: the form must also give the address
   *    line, the town and a PIN code that belongs to that state.
   */
  private static deliveryPlace(billTo: MovementParty, recorded: MovementParty | null, input: Record<string, unknown>): MovementParty | undefined {
    const typed = (key: string) => String(input[key] ?? '').trim();
    const shipToState = typed('shipToState');

    if (recorded !== null) {
      // Issue #240 — the screen fills the bill's own address in; typed back unchanged, it is the bill's.
      const typedAddress = typed('shipToAddress');
      const typedPin = typed('shipToPincode');
      if ((typedAddress !== '' && typedAddress !== recorded.address1) || (typedPin !== '' && typedPin !== recorded.pincode)) {
        throw invalid('EWAY_SHIP_TO_DIFFERS_FROM_BILL', `The bill says these goods go to ${recorded.address1}, ${recorded.place} ${recorded.pincode}, but the form says ${typedAddress || recorded.address1}, ${typedPin || recorded.pincode}. One bill cannot describe two journeys. Use the bill's address, or correct the bill.`);
      }
      if (shipToState !== '' && shipToState !== recorded.stateCode) {
        const recordedState = STATE_NAMES[recorded.stateCode] ?? recorded.stateCode;
        const typedState = STATE_NAMES[shipToState] ?? shipToState;
        throw invalid('EWAY_SHIP_TO_DIFFERS_FROM_BILL', `The bill says these goods go to ${recorded.place}, ${recordedState}, but the form says ${typedState}. One bill cannot describe two journeys. Leave the delivery state on "Wherever the buyer is" to use the bill's address, or correct the bill.`);
      }
      return recorded;
    }
    if (shipToState === '' || (shipToState === billTo.stateCode && typed('shipToAddress') === '' && typed('shipToPincode') === '')) return undefined;
    // Issue #240 — the buyer's own address, as the screen fills it in from the bill: not a ship-to.
    if (shipToState === billTo.stateCode && typed('shipToAddress') === billTo.address1 && typed('shipToPincode') === billTo.pincode
      && (typed('shipToPlace') === '' || typed('shipToPlace') === billTo.place)) return undefined;

    const address1 = typed('shipToAddress');
    if (address1 === '') throw invalid('EWAY_SHIP_TO_ADDRESS', 'Type the delivery address — the building, street or area the goods are going to.');
    const place = typed('shipToPlace');
    if (place === '') throw invalid('EWAY_SHIP_TO_PLACE', 'Type the town or city the goods are going to.');
    const pincode = typed('shipToPincode');
    const pinCheck = validatePincodeForState(pincode, shipToState, 'shipToPincode');
    if (!pinCheck.ok) {
      throw invalid('EWAY_SHIP_TO_PINCODE', pincode === '' ? 'Type the PIN code of the delivery address. The portal works the route out from it.' : pinCheck.problems[0]?.message ?? 'That PIN code is not right for the delivery address.');
    }
    // The goods go to another place of the same buyer, so the name and GST number stay theirs.
    return { legalName: billTo.legalName, gstin: billTo.gstin, address1, place, pincode, stateCode: shipToState };
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
        ? (preview.ready
          ? (preview.vehicleReady ? 'Ready to raise' : 'Ready, but no vehicle yet')
          : preview.distance?.refusalKind === 'TOO_FAR' ? 'The distance is more than the portal accepts'
            : preview.distance?.refusalKind === 'NEEDED' ? 'Type the distance' : 'Something is missing')
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
      validitySum: preview.validitySum ?? null,
      consignmentValue: jsonAmount(preview.consignmentValuePaise),
      problems: preview.problems.map((problem) => ({ field: problem.field, message: problem.message })),
      documentNumber: movement.documents[0]?.documentNumber ?? '',
      // Issue #240 — how the distance is settled, and everything the e-way bill will carry.
      distance: preview.distance ?? null,
      filled: DemoApplication.ewayFilled(movement),
    };
  }

  /**
   * Issue #240 — everything the e-way bill will carry, as the screen shows it for confirming:
   * both parties with GST numbers, addresses, PIN codes and states, the bill, its lines, the vehicle
   * and the transporter. All of it comes from the bill; none of it is typed.
   */
  private static ewayFilled(movement: Movement) {
    const party = (who: MovementParty) => ({
      name: who.legalName,
      gstin: who.gstin,
      address: [who.address1, who.address2].filter((line) => line !== undefined && line !== '').join(', '),
      place: who.place,
      pincode: who.pincode,
      stateCode: who.stateCode,
      state: STATE_NAMES[who.stateCode] ?? who.stateCode,
    });
    const document = movement.documents[0];
    const lines = document?.lines ?? [];
    const sum = (pick: (line: (typeof lines)[number]) => bigint) => lines.reduce((total, line) => total + pick(line), 0n);
    return {
      from: party(movement.dispatchFrom ?? movement.consignor),
      billTo: party(movement.billTo),
      to: party(movement.shipTo ?? movement.billTo),
      document: document === undefined ? null : { number: document.documentNumber, date: document.documentDate, type: document.documentType },
      lines: lines.map((line) => ({
        description: line.description, hsn: line.hsnCode, quantity: line.quantity, unit: line.unit,
        value: jsonAmount(line.taxableValuePaise),
        tax: jsonAmount(line.cgstPaise + line.sgstPaise + line.igstPaise + line.cessPaise),
      })),
      taxable: jsonAmount(sum((line) => line.taxableValuePaise)),
      cgst: jsonAmount(sum((line) => line.cgstPaise)),
      sgst: jsonAmount(sum((line) => line.sgstPaise)),
      igst: jsonAmount(sum((line) => line.igstPaise)),
      transportMode: movement.transportMode === 'ROAD' ? 'Road' : movement.transportMode,
      vehicle: movement.vehicle?.registrationNumber ?? null,
      transporter: movement.transporter === undefined ? null : {
        name: movement.transporter.name,
        transporterId: movement.transporter.transporterId,
        documentNumber: movement.transporter.documentNumber ?? null,
        documentDate: movement.transporter.documentDate ?? null,
      },
    };
  }

  /**
   * Issue #240 — a bill, ready for its e-way bill: the form filled from the bill, the check already
   * run, and what (if anything) has been raised for it. Nothing is written.
   */
  async ewayBillForBill(actor: ActorContext, input: Record<string, unknown>) {
    const invoiceId = String(input.invoice ?? '');
    // Only the bill: the vehicle and transporter are the bill's own.
    const movement = await this.movementFor(actor, invoiceId, { reason: 'SUPPLY' });
    const check = await this.previewEwayBill(actor, { invoice: invoiceId, reason: 'SUPPLY' });
    const record = await this.shop.ewayBill.forMovement(actor, movement.movementId);
    const to = movement.shipTo ?? movement.billTo;
    const raised = record !== null && record.acknowledgement !== undefined && !['CANCELLED', 'REJECTED', 'FAILED'].includes(record.status);
    return {
      invoice: invoiceId,
      check,
      raised: raised ? DemoApplication.ewayJson(record, this.shop.clock.now()) : null,
      // The form, as the screen fills it. The distance box stays empty: the portal works it out.
      form: {
        invoice: invoiceId,
        reason: 'SUPPLY',
        shipToState: to.stateCode,
        shipToAddress: to.address1,
        shipToPlace: to.place,
        shipToPincode: to.pincode,
        distanceKm: '',
        vehicle: movement.vehicle?.registrationNumber ?? '',
      },
    };
  }

  /**
   * Issue #240 — the bills to choose from on the e-way bill screen: each with its customer and
   * total, and whether it needs an e-way bill. Those that need one and have none come first.
   */
  async ewayBillChoices(actor: ActorContext) {
    const companyId = this.companyOf(actor);
    const invoices = await this.salesRepository.list(companyId, { state: 'FINAL' });
    const records = await this.shop.ewayBill.list(actor);
    const rows = [];
    for (const invoice of invoices) {
      // Issue #287 — a service bill moves no goods, so it is not one to choose an e-way bill for.
      if (invoice.number === null || invoice.supplyKind === 'SERVICES') continue;
      let customer: string | null = null;
      try { customer = customerView(this.config.companyId, invoice.partyId).name; } catch (error) { reportUnexpected('api.listCustomerName', error); customer = null; }
      let outcome: string = 'CANNOT_DECIDE';
      try {
        const movement = await this.movementFor(actor, invoice.id, { reason: 'SUPPLY' });
        outcome = decideEwayApplicability(movement).outcome;
      } catch (error) { reportUnexpected('api.ewayChoiceOutcome', error); /* the check itself says what is wrong once the bill is chosen */ }
      const record = records.find((candidate) => candidate.movementId === invoice.id && candidate.acknowledgement !== undefined
        && !['CANCELLED', 'REJECTED', 'FAILED'].includes(candidate.status));
      const status = record !== undefined ? 'RAISED' : outcome === 'REQUIRED' ? 'NEEDED' : outcome === 'NOT_REQUIRED' ? 'NOT_NEEDED' : 'ASK';
      // Issue #311 — a try that got no number (at Make bill, or here): why, whether sending it again
      // can help, and the distance it sent, so Home can offer the same request again.
      const failed = status === 'NEEDED' ? records.findLast((candidate) => candidate.movementId === invoice.id && candidate.status === 'FAILED') : undefined;
      rows.push({
        id: invoice.id,
        number: invoice.number,
        date: invoice.documentDate,
        customer,
        amount: jsonAmount(invoice.pricing?.totals.invoiceValue.minor ?? 0n),
        status,
        label: status === 'RAISED' ? `e-way bill ${record?.acknowledgement?.ewayBillNumber ?? ''}`
          : status === 'NEEDED' ? 'needs one'
            : status === 'NOT_NEEDED' ? 'not needed' : 'check it',
        failure: failed?.failure === undefined ? null
          : { message: failed.failure.message, retryable: failed.failure.retryable, distanceKm: failed.distanceKm ?? 0 },
      });
    }
    const order: Record<string, number> = { NEEDED: 0, ASK: 1, RAISED: 2, NOT_NEEDED: 3 };
    rows.sort((left, right) => (order[left.status] ?? 9) - (order[right.status] ?? 9) || (left.date < right.date ? 1 : left.date > right.date ? -1 : 0));
    return { invoices: rows };
  }

  /** Raises the e-way bill with the portal, once. */
  async generateEwayBill(actor: ActorContext, input: Record<string, unknown>) {
    const movement = await this.movementFor(actor, String(input.invoice ?? ''), input);
    const record = await this.shop.ewayBill.generate(actor, movement);
    // What was sent to the portal, kept so every later printing of this number says the same thing.
    this.ewayMovements.set(movement.movementId, movement);
    // Issue #141 — the number the portal gave goes straight onto the challan, so it prints there.
    const number = record.acknowledgement?.ewayBillNumber;
    if (movement.documents[0]?.documentType === 'DELIVERY_CHALLAN' && number !== undefined) {
      await this.challans.recordPortalEwayBill(actor, movement.movementId, number, movement.vehicle?.registrationNumber ?? null);
    }
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

  /**
   * Issue #191 — the page the driver is handed at a checkpoint.
   *
   * Rule 138A(1) accepts the number carried electronically, so nothing is blocked for want of this
   * page. It is printed because officers expect the portal's own sheet, and it is refused before the
   * portal has given a number: a page with no number on it is not an e-way bill.
   */
  async ewayPrint(actor: ActorContext, input: Record<string, unknown>, options: { readonly pdf?: boolean } = {}) {
    const movementId = String(input.invoice ?? '');
    // The movement the portal was given wins over anything on the form now. Only a bill raised
    // before this was kept falls back to rebuilding it, and then the page is at least consistent
    // with the invoice rather than with a half-filled screen.
    const movement = this.ewayMovements.get(movementId) ?? (await this.movementFor(actor, movementId, input));
    const record = await this.shop.ewayBill.forMovement(actor, movement.movementId);
    if (record === null) throw notFound('API_EWAY_NOT_RAISED', 'No e-way bill has been raised for this movement yet.');
    const banner = ewayPrintBanner(record);
    if (banner?.kind === 'REFUSED') throw invalid('API_EWAY_NO_NUMBER', banner.message);
    const snapshot = this.invoicePrints.get(String(input.invoice ?? ''))?.snapshot
      ?? captureSnapshot(templateById('india-standard') as TemplateDefinition, 'en-IN', appToday());
    const rendered = { snapshot, format: 'A4' as const, locale: 'en-IN' as const };
    return {
      state: 'print' as const,
      ewayBillNumber: record.acknowledgement?.ewayBillNumber ?? '',
      status: record.status,
      // The screen says which of these the page carries, so the person pressing Print knows before
      // the paper comes out that it is a cancelled or an unvehicled one.
      notice: banner === null ? null : banner.message,
      ...(options.pdf === true
        ? { pdf: await ewayBillPdf(record, movement, rendered) }
        : { html: renderEwayBill(record, movement, rendered) }),
    };
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
        title: both(`${base.vehicle} is on the registering authority's record`, `${base.vehicle} रजिस्टरिंग अथॉरिटी के रिकॉर्ड में है`),
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
        title: both(`The authority holds no vehicle with the number ${base.vehicle}`, `अथॉरिटी के पास ${base.vehicle} नंबर की कोई गाड़ी नहीं है`),
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
      title: both('This vehicle has not been checked', 'यह गाड़ी अभी जाँची नहीं गई'),
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
    // Issue #343 — the bill must be this business's own: another company's bill id is "not found", never checked against.
    if ((await this.salesRepository.findById(this.companyOf(actor), movementId)) === null) throw notFound('API_INVOICE_NOT_FOUND', 'We could not find that bill.');
    const weight = String(input.weightKg ?? '').trim();
    const distance = String(input.distanceKm ?? '').trim();

    const transport: TransportDetails = {
      mode: 'ROAD',
      vehicleNumber: String(input.vehicle ?? '').trim(),
      movementDate: appToday(),
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
      return { ...rebuilt, title: both('Nothing to accept', 'मान्यता देने को कुछ नहीं'), message: both('There is nothing on this supplier that needs accepting.', 'इस सप्लायर के बारे में कुछ मान्यता देने की ज़रूरत नहीं।') };
    }
    await this.shop.risk.acknowledge(actor, rebuilt.raw, reason);
    const cleared = await this.shop.risk.isClearedToProceed(actor, rebuilt.raw);
    return { ...DemoApplication.riskJson(rebuilt.raw, cleared), title: both('Accepted', 'मान्यता दी गई'), message: cleared.reason };
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
   * Issue #228 — a supplier bill as the purchasing module (#16, #17) needs it, from what was typed.
   *
   * The supplier is a record from the supplier list, never a typed name. Every line names an item
   * from the item list with its own quantity, price and GST rate. The kind of GST — IGST, or CGST
   * and SGST — is not asked: the real validation (#16) puts the supplier's state, read from their
   * GST number, and our godown's state to the reviewed rule, and runs the real duplicate check.
   * Anything it does not clear is refused with its own words; nothing is marked "checked" here.
   */
  private async purchaseInput(actor: ActorContext, input: Record<string, unknown>): Promise<
    | { readonly approved: ApprovedPurchase; readonly supplierState: string; readonly godownState: string; readonly reverseChargeNotes: readonly string[]; readonly reverseChargeEntry: ReverseChargeEntryDraft | null }
    | { readonly alreadyRecorded: PurchaseBill; readonly message: string }
  > {
    const companyId = this.companyOf(actor);
    const supplier = resolveSupplier(companyId, String(input.supplierId ?? input.supplier ?? input.party ?? ''));
    const supplierAddress = billingAddressOf(companyId, supplier.id);
    const supplierGstin = supplierAddress?.gstin;
    // Issue #289 — only a supplier the law lets trade unregistered (s.22, s.23) may have no GSTIN.
    const unregistered = supplier.gstRegistrationType === 'unregistered';
    if (supplierGstin === undefined && !unregistered) {
      throw invalid('SUPPLIER_GSTIN_MISSING', `${supplier.legalName} has no GST number saved. It decides which GST is on their bill and whether you can claim it, so add it to their record first.`);
    }
    const reference = String(input.reference ?? '').trim();
    if (!reference) throw invalid('API_REFERENCE_REQUIRED', 'Enter the supplier bill number.');
    const date = isoDate(String(input.date ?? ''));
    const noGst = unregistered || supplier.gstRegistrationType === 'composition';
    const typedLines = this.purchaseLines(companyId, input, noGst ? supplier : null);
    const reverseCharge = this.reverseChargeOf(companyId, supplier, supplierGstin !== undefined, typedLines, input, date);
    // What the supplier's bill shows: a reverse-charge or exempt line carries no GST from them.
    const lines = typedLines.map((line, index) => reverseCharge.lines[index]?.kind === 'NONE' ? line : { ...line, gstRateBasisPoints: 0 });
    // Issue #289, part 2b — the facts a reverse-charge bill's time of supply turns on (CGST s.12(3),
    // s.13(3)), checked before anything is posted so the register never refuses a posted bill.
    const reverseChargeEntry = reverseCharge.any
      ? this.reverseChargeEntryOf(supplier, supplierGstin !== undefined, typedLines, reverseCharge.lines, input, date)
      : null;
    const typedTotal = String(input.amount ?? '').trim() === '' ? null : paise(input.amount);
    const linesTotal = lines.reduce((total, line) => total + line.taxableValuePaise + taxOn(line.taxableValuePaise, line.gstRateBasisPoints), 0n);
    const total = typedTotal ?? linesTotal;
    const godownState = gstinStateCode(this.config.gstin);
    const supplierState = supplierGstin === undefined ? supplierAddress?.stateCode ?? '' : gstinStateCode(supplierGstin);

    // The same supplier's bill number twice in one financial year is the same bill: a supplier
    // numbers each bill once a year. Typed again exactly, it is a retry and is recorded once; with
    // anything different, it is refused rather than posted a second time.
    const posted = (await this.shop.bills.list(companyId)).filter((bill) => bill.state === 'POSTED');
    const gstinOf = (partyId: string) => billingAddressOf(companyId, partyId)?.gstin ?? (partyId === this.config.supplierId ? this.config.supplierGstin : undefined);
    const year = financialYearOf(date);
    // With no GSTIN to compare, the same supplier record is the same seller.
    const sameNumber = posted.find((bill) =>
      (supplierGstin === undefined ? bill.supplierPartyId === supplier.id : normaliseIdentifier(gstinOf(bill.supplierPartyId) ?? '') === normaliseIdentifier(supplierGstin))
      && normaliseInvoiceNumber(bill.invoiceNumber) === normaliseInvoiceNumber(reference)
      && financialYearOf(bill.invoiceDate) === year);
    if (sameNumber !== undefined) {
      const identical = sameNumber.invoiceDate === date && sameNumber.totalPaise === total
        && sameNumber.lines.length === lines.length
        && sameNumber.lines.every((line, index) => line.itemId === lines[index]?.itemId
          && line.quantity.scaled === lines[index]?.quantity.scaled && line.taxableValuePaise === lines[index]?.taxableValuePaise);
      const message = `Bill ${sameNumber.invoiceNumber} from ${sameNumber.supplierName}, dated ${sameNumber.invoiceDate} for ${formatPaise(sameNumber.totalPaise)}, is already in your books.`;
      if (identical) return { alreadyRecorded: sameNumber, message };
      throw conflict('PURCHASE_DUPLICATE', `${message} A supplier gives each bill its own number for the year, so this is the same bill and it has not been recorded twice. If the supplier changed the bill, they send a credit or debit note against it.`);
    }

    // The draft #16 checks: every figure typed, with the evidence of having been typed.
    const typed = <T,>(value: T) => ({ value, confidence: 1, evidence: { page: 0, text: String(value) } });
    const draftId = `web:${supplier.id}:${normaliseInvoiceNumber(reference)}:${year}`;
    const verdict = validatePurchase({
      draft: {
        id: draftId,
        companyId,
        documentId: `web-document:${draftId}`,
        source: 'manual',
        ...(supplierGstin === undefined ? {} : { supplierGstin: typed(supplierGstin) }),
        supplierName: typed(supplier.legalName),
        buyerGstin: typed(this.config.gstin),
        invoiceNumber: typed(reference),
        invoiceDate: typed(String(date)),
        ...(typedTotal === null ? {} : { invoiceTotalPaise: typed(typedTotal) }),
        lines: lines.map((line) => ({
          description: typed(line.description),
          hsnSac: typed(line.hsnSac),
          quantity: typed(plainQuantity(line.quantity.scaled)),
          unit: typed(line.quantity.unit),
          ratePaise: typed(line.ratePaise),
          taxableValuePaise: typed(line.taxableValuePaise),
          gstRateBasisPoints: typed(line.gstRateBasisPoints),
        })),
        fieldsNeedingReview: [],
        arithmeticProblems: [],
        createdAt: appClock.now().toISOString(),
      },
      supplier,
      ...(billingAddressOf(companyId, supplier.id) === null ? {} : { supplierAddress: billingAddressOf(companyId, supplier.id)! }),
      buyerStateCode: godownState,
      existing: posted.map((bill) => ({
        id: bill.purchaseId,
        companyId: bill.companyId,
        supplierGstin: gstinOf(bill.supplierPartyId) ?? '',
        invoiceNumber: bill.invoiceNumber,
        invoiceDate: bill.invoiceDate,
        invoiceTotalPaise: bill.totalPaise,
        enteredOn: indiaDateOf(bill.postedAt),
        contentFingerprint: `posted:${bill.id}`,
      })),
      taxSplit: DemoApplication.purchaseTaxSplit,
      today: appToday(),
    });
    if (verdict.status !== 'POSTABLE') {
      const shown = verdict.findings.filter((finding) => finding.severity !== 'MINOR');
      throw invalid('PURCHASE_NEEDS_CHECKING', shown.length === 0 ? verdict.summary : shown.map((finding) => finding.message).join(' '), { details: { status: verdict.status } });
    }
    // Issue #289, part 3 — a line with no GST at all (unregistered seller, exempt freight) has no
    // credit to block. Checked on the final rates, after reverse charge has set the law's rate.
    // Issue #296 — CGST Act s.10(4): a composition dealer is not entitled to any input tax credit,
    // so on a bill dated while the business is on the scheme every line's GST goes into cost, the
    // same way credit blocked by s.17(5) does. The liability under reverse charge is unaffected.
    const onComposition = schemeOn(companyId, date) === 'COMPOSITION';
    const finalLines = lines.map((line, index) => {
      const decided = reverseCharge.lines[index];
      const priced = decided?.kind === 'REVERSE_CHARGE' ? { ...line, gstRateBasisPoints: decided.rateBasisPoints } : line;
      return onComposition && priced.gstRateBasisPoints > 0 && priced.itcEligibility === 'ELIGIBLE'
        ? { ...priced, itcEligibility: 'INELIGIBLE' as const, blockedCreditClause: COMPOSITION_NO_CREDIT_CLAUSE }
        : priced;
    });
    const untaxedBlocked = finalLines.find((line) => line.itcEligibility === 'INELIGIBLE' && line.gstRateBasisPoints === 0);
    if (untaxedBlocked !== undefined) {
      throw invalid('PURCHASE_BLOCKED_NO_GST', `Line ${untaxedBlocked.lineNumber} (${untaxedBlocked.description}) carries no GST, so there is no credit to mark as not available. Leave it as "GST can be claimed".`);
    }
    return {
      approved: {
        id: `web-purchase:${draftId}`,
        companyId,
        sourceDocumentId: `web-document:${draftId}`,
        verdict,
        supplierPartyId: supplier.id,
        supplierName: supplier.legalName,
        invoiceNumber: reference,
        invoiceDate: date,
        // Issue #289 — on a reverse-charge line the GST is the law's rate for the supply, owed by us.
        lines: finalLines,
        invoiceTotalPaise: total,
        taxLiability: reverseCharge.any ? 'REVERSE_CHARGE' : 'SUPPLIER',
        creditDays: 30,
        approvedBy: actor.userId,
        approvedAt: appClock.now().toISOString(),
      },
      supplierState,
      godownState,
      reverseChargeNotes: reverseChargeEntry === null ? reverseCharge.notes : [...reverseCharge.notes, ...reverseChargeEntry.notes],
      reverseChargeEntry,
    };
  }

  /**
   * Issue #289, part 2b — when the goods or service reached the business (typed as `receivedOn`,
   * else the bill's date), which reverse-charge lines the self-invoice covers, and what the review
   * says about the date the tax falls due and the self-invoice's 30 days.
   */
  private reverseChargeEntryOf(
    supplier: Party, registered: boolean, lines: readonly ApprovedPurchaseLine[],
    decided: readonly { readonly kind: string }[], input: Record<string, unknown>, date: IsoDate,
  ): ReverseChargeEntryDraft {
    const typed = String(input.receivedOn ?? '').trim();
    let receivedOn: IsoDate;
    try {
      receivedOn = typed === '' ? date : isoDate(typed);
    } catch {
      throw invalid('PURCHASE_RECEIVED_ON', 'Enter the date the goods or the service reached you, as a date.');
    }
    const lineNumbers = lines.filter((_, index) => decided[index]?.kind === 'REVERSE_CHARGE').map((line) => line.lineNumber);
    const supplyKind = checkReverseChargeEntry({
      receivedOn, today: appToday(),
      supplyKinds: lines.filter((line) => lineNumbers.includes(line.lineNumber)).map((line) => line.supplyKind),
    });
    // The time of supply as it stands on the day of recording: nothing has been paid yet.
    const point = rcmTimeOfSupply({
      supplyKind, supplierDocumentDate: date, supplierIssuesInvoice: registered, receivedOn, paidOn: null, selfInvoiceOn: null, enteredInBooksOn: appToday(),
    });
    const notes = [
      supplyKind === 'SERVICES' && !registered
        ? `The GST on this falls due on the date of your self-invoice, or the day you pay ${supplier.legalName} if that is earlier (CGST s.13(3)(a) and (c)). It goes on the GST return for that month.`
        : `${point.words} It goes on the GST return for ${formatTaxPeriod(taxPeriodOf(point.date))}, and moves earlier if you pay ${supplier.legalName} before then.`,
      ...(registered ? [] : [`${supplier.legalName} has no GST number, so you issue the invoice for this purchase yourself — a self-invoice (CGST s.31(3)(f)). ${selfInvoiceDue(receivedOn, appToday(), null).words} The app makes it for you once the bill is recorded.`]),
    ];
    return { receivedOn, supplyKind, lineNumbers, supplierRegistered: registered, notes };
  }

  /** The reviewed GST rules, which answer IGST against CGST and SGST from the two states (#228). */
  private static readonly purchaseTaxSplit = rulesEngineTaxSplit({ registry: shippedRegistry() });

  /**
   * Issue #228 — the lines of a supplier bill, each an item from the item list with its own
   * quantity, price and GST rate. One line is the old single-item shape; many come as `lines`.
   */
  /**
   * Issue #289, part 2 — which lines of this bill are under reverse charge (the buyer pays their GST,
   * CGST s.9(3)), from the notified lists in `reverse-charge-notified.ts` and the person's answers to
   * what the lists turn on and the code cannot tell. Law checked 10–11 Oct 2026; sources on issue #289.
   *
   *  - A question not yet answered stops the bill, with the question, so it is asked once and kept.
   *  - A supplier may not charge GST on a reverse-charge supply (its invoice says the tax is payable
   *    on reverse charge — Rule 46(p)), nor on an exempt one, so GST typed on such a line is refused.
   *  - The rate is the law's for the supply (5% for GTA freight), else the item's from the rate schedule.
   *  - The tax is posted as owed by us, paid in cash (s.49(4), Circular 172/04/2022-GST), with the
   *    same amount as credit (GSTR-3B 3.1(d) and 4(A)(3)).
   */
  private reverseChargeOf(companyId: CompanyId, supplier: Party, registered: boolean, lines: readonly ApprovedPurchaseLine[], input: Record<string, unknown>, date: IsoDate) {
    const answers = DemoApplication.reverseChargeAnswers(input);
    const decided = lines.map((line) => reverseChargeDecisionFor({
      hsnSac: line.hsnSac, on: date,
      supplier: { registered, agriculturist: supplier.unregisteredBasis === 'AGRICULTURIST' },
      recipientIsComposition: false,
      answers,
    }));
    const asks = new Map<string, { id: string; question: string; why: string; lines: string[] }>();
    decided.forEach((decision, index) => {
      if (decision.kind !== 'ASK') return;
      const line = lines[index] as ApprovedPurchaseLine;
      const held = asks.get(decision.ask.id) ?? { id: decision.ask.id, question: decision.ask.question, why: decision.ask.why, lines: [] };
      held.lines.push(`${line.description} (HSN/SAC ${line.hsnSac})`);
      asks.set(decision.ask.id, held);
    });
    if (asks.size > 0) {
      const questions = [...asks.values()];
      throw invalid('PURCHASE_REVERSE_CHARGE_QUESTION', [
        `Whether you, the buyer, pay the GST on ${questions.flatMap((ask) => ask.lines).join(', ')} turns on something only you can tell. Answer ${questions.length === 1 ? 'the question' : 'the questions'} on the form, then review it again. Nothing was recorded.`,
        ...questions.map((ask) => `${ask.question} ${ask.why}`),
      ].join(' '), { details: { questions: JSON.stringify(questions) } });
    }
    const typed = (line: ApprovedPurchaseLine) => line.gstRateBasisPoints;
    const result = decided.map((decision, index): { kind: 'NONE' } | { kind: 'EXEMPT'; because: string } | { kind: 'REVERSE_CHARGE'; rateBasisPoints: number; entry: Extract<ReverseChargeDecision, { kind: 'REVERSE_CHARGE' }>['entry'] } => {
      const line = lines[index] as ApprovedPurchaseLine;
      const label = `Line ${index + 1} (${line.description})`;
      if (decision.kind === 'NONE' || decision.kind === 'ASK') return { kind: 'NONE' };
      if (registered && DemoApplication.typedGstOn(input, index) && typed(line) > 0) {
        throw invalid('PURCHASE_REVERSE_CHARGE_GST_CHARGED', decision.kind === 'EXEMPT'
          ? `${label}: this is exempt (${decision.because}), so no GST is due on it and ${supplier.legalName} may not charge any. Leave GST at 0. If their bill shows GST, ask them about it before paying it.`
          : `${label} is under reverse charge — ${citeReverseChargeEntry(decision.entry)} (${decision.entry.description}). You pay its GST to the government yourself, so ${supplier.legalName}'s bill must not charge it and should say the tax is payable on reverse charge (CGST Rule 46(p)). Leave GST at 0. If their bill does charge GST, ask them to correct it before paying.`);
      }
      if (decision.kind === 'EXEMPT') return { kind: 'EXEMPT', because: decision.because };
      const declared = itemView(companyId, line.itemId).ratePercent;
      const rateBasisPoints = decision.entry.rate?.basisPoints ?? (declared === null ? null : Math.round(declared * 100));
      if (rateBasisPoints === null || rateBasisPoints <= 0) {
        throw invalid('PURCHASE_REVERSE_CHARGE_RATE', `${label} is under reverse charge — ${citeReverseChargeEntry(decision.entry)} — so you pay its GST, at the rate the law sets for it. ${line.description} has no GST rate saved. Add its rate on the Items screen first, then record the bill.`);
      }
      return { kind: 'REVERSE_CHARGE', rateBasisPoints, entry: decision.entry };
    });
    const any = result.some((line) => line.kind === 'REVERSE_CHARGE');
    // One bill posts under one liability. A registered supplier's ordinary GST and reverse-charge
    // tax on the same bill would be posted as one or the other, so such a bill is not taken here.
    if (any && result.some((line, index) => line.kind === 'NONE' && (lines[index]?.gstRateBasisPoints ?? 0) > 0 && registered && supplier.gstRegistrationType !== 'composition')) {
      throw notAllowed('PURCHASE_REVERSE_CHARGE_MIXED', `This bill from ${supplier.legalName} has lines under reverse charge (you pay the GST) and lines on which they charge GST. Recording both on one bill is not in the app yet, so nothing was recorded. Enter the reverse-charge lines as one bill and the others as another, with the same bill number and a suffix such as -A and -B, so each GST goes to the right place.`);
    }
    const notes = result.flatMap((line, index) => {
      const label = `${lines[index]?.description ?? ''} (HSN/SAC ${lines[index]?.hsnSac ?? ''})`;
      if (line.kind === 'EXEMPT') return [`${label}: no GST is due — ${line.because}.`];
      if (line.kind !== 'REVERSE_CHARGE') return [];
      return [`${label} is under reverse charge — ${citeReverseChargeEntry(line.entry)} (${line.entry.description}), in force from ${formatDate(isoDate(line.entry.effectiveFrom))}. You, the buyer, pay its GST at ${line.rateBasisPoints / 100}%${line.entry.rate === undefined ? '' : ` (${line.entry.rate.source})`}.`];
    });
    if (any) {
      notes.push('You pay this GST to the government in cash with your GSTR-3B (Table 3.1(d)); credit cannot be used to pay it (CGST s.49(4), Circular 172/04/2022-GST). The same amount comes back as credit in that return (Table 4(A)(3)).');
    }
    return { lines: result, any, notes };
  }

  /**
   * Issue #289, part 3 — one sentence per line whose credit CGST s.17(5) blocks: the clause, the
   * tax, and where it went instead.
   */
  private static blockedCreditNotes(approved: ApprovedPurchase, intraState: boolean): string[] {
    return approved.lines.filter((line) => line.itcEligibility === 'INELIGIBLE').map((line) => {
      const tax = taxOn(line.taxableValuePaise, line.gstRateBasisPoints);
      const reason = BLOCKED_CREDIT_REASONS.find((candidate) => candidate.clause === line.blockedCreditClause);
      const owed = approved.taxLiability === 'REVERSE_CHARGE' ? ' You still pay this GST to the government under reverse charge; only the credit is lost.' : '';
      if (line.blockedCreditClause === COMPOSITION_NO_CREDIT_CLAUSE) {
        return `${line.description}: credit not available — your business is on the composition scheme, which does not allow claiming GST back (CGST s.10(4)). Its ${formatPaise(taxOn(line.taxableValuePaise, line.gstRateBasisPoints))} of ${intraState ? 'CGST + SGST' : 'IGST'} is added to what it cost you.${owed}`;
      }
      return `${line.description}: credit not available — ${reason?.label.toLowerCase() ?? 'blocked'} (CGST s.${line.blockedCreditClause ?? '17(5)'}). Its ${formatPaise(tax)} of ${intraState ? 'CGST + SGST' : 'IGST'} is added to what it cost you, not to the GST you claim back.${owed}`;
    });
  }

  /** Issue #289 — answers to the reverse-charge questions, from `rcm_<id>` form fields or an object. */
  private static reverseChargeAnswers(input: Record<string, unknown>): Record<string, boolean> {
    const answers: Record<string, boolean> = {};
    const yesNo = (value: unknown): boolean | undefined => {
      const said = String(value ?? '').trim().toLowerCase();
      return said === 'yes' || said === 'true' ? true : said === 'no' || said === 'false' ? false : undefined;
    };
    const raw = input.reverseChargeAnswers;
    const given: unknown = typeof raw === 'string' && raw.trim() !== '' ? JSON.parse(raw) : raw;
    if (given !== null && typeof given === 'object') {
      for (const [id, value] of Object.entries(given as Record<string, unknown>)) {
        const answer = yesNo(value);
        if (answer !== undefined) answers[id] = answer;
      }
    }
    for (const [key, value] of Object.entries(input)) {
      if (!key.startsWith('rcm_')) continue;
      const answer = yesNo(value);
      if (answer !== undefined) answers[key.slice(4)] = answer;
    }
    return answers;
  }

  /** Whether a GST rate was typed on this line of the bill (rather than taken from the item). */
  private static typedGstOn(input: Record<string, unknown>, index: number): boolean {
    const raw = input.lines;
    const parsed: unknown = typeof raw === 'string' && raw.trim() !== '' ? JSON.parse(raw) : raw;
    const rows: Record<string, unknown>[] = Array.isArray(parsed) && parsed.length > 0 ? parsed as Record<string, unknown>[] : [{ gst: input.gst }];
    const row = rows[index] ?? {};
    return String(row.gst ?? row.gstRate ?? '').trim() !== '';
  }

  private purchaseLines(companyId: CompanyId, input: Record<string, unknown>, noGstSupplier: Party | null = null): ApprovedPurchaseLine[] {
    const raw = input.lines;
    const parsed: unknown = typeof raw === 'string' && raw.trim() !== '' ? JSON.parse(raw) : raw;
    const rows: Record<string, unknown>[] = Array.isArray(parsed) && parsed.length > 0
      ? parsed as Record<string, unknown>[]
      : [{ item: input.itemId ?? input.item, quantity: input.quantity, unit: input.unit, rate: input.rate, gst: input.gst }];
    return rows.map((row, index) => {
      const item = resolveItem(companyId, String(row.itemId ?? row.item ?? ''));
      const label = `Line ${index + 1} (${item.name})`;
      const unit = String(row.unit ?? '').trim().toUpperCase() || item.baseUnit;
      const typedQuantity = String(row.quantity ?? '').replace(/,/g, '').trim();
      if (!/^\d+(\.\d{1,6})?$/.test(typedQuantity) || /^0+(\.0+)?$/.test(typedQuantity)) {
        throw invalid('PURCHASE_QUANTITY', `${label}: type how many came, more than zero.`);
      }
      const qty = quantity(typedQuantity, unit);
      const rate = paise(row.rate);
      const typedGst = String(row.gst ?? row.gstRate ?? '').trim();
      const declared = itemView(companyId, item.id);
      // Issue #289 — a seller who is not registered may not charge GST (CGST s.32(1)); nor may a
      // composition dealer (s.10(4)). Their bill carries none, so nothing is assumed from the item.
      if (noGstSupplier !== null && typedGst !== '' && Number(typedGst) !== 0) {
        throw invalid('PURCHASE_GST_NOT_ALLOWED', noGstSupplier.gstRegistrationType === 'composition'
          ? `${label}: ${noGstSupplier.legalName} is a composition dealer. A composition dealer may not collect GST (CGST s.10(4)) and issues a bill of supply, so there is no GST on this bill and none can be claimed (s.17(5)(e)). Leave GST at 0. If their bill shows GST, ask them about it before paying it.`
          : `${label}: ${noGstSupplier.legalName} is not registered for GST. A seller who is not registered may not collect GST (CGST s.32(1)), and no credit can be claimed on their bill (s.16(2)(a)). Leave GST at 0. If their bill shows GST, ask them for their GST number, or about why it is there, before paying it.`);
      }
      const gstBasisPoints = noGstSupplier !== null ? 0 : typedGst === ''
        ? declared.ratePercent === null ? 0 : Math.round(declared.ratePercent * 100)
        : Number(typedGst);
      if (!Number.isInteger(gstBasisPoints) || gstBasisPoints < 0 || gstBasisPoints > 10_000) {
        throw invalid('PURCHASE_GST_RATE', `${label}: choose the GST rate printed on the supplier's bill.`);
      }
      const goods = item.kind === 'goods';
      // Issue #289, part 3 — credit blocked by CGST s.17(5): the person names the clause; the app
      // never decides it. A bill with no GST has nothing to block.
      const blocked = blockedCreditReasonFor(row.blocked ?? row.creditBlocked);
      if (blocked === undefined) {
        throw invalid('PURCHASE_BLOCKED_REASON', `${label}: choose why the GST on it cannot be claimed from the list, or leave it as "GST can be claimed".`);
      }
      return {
        ...(blocked === null ? {} : { blockedCreditClause: blocked.clause }),
        lineNumber: index + 1,
        itemId: item.id,
        description: item.name,
        hsnSac: item.hsnSac,
        supplyKind: goods ? 'GOODS' as const : 'SERVICES' as const,
        ...(goods ? { warehouseId: this.shop.warehouseId } : {}),
        quantity: qty,
        ratePaise: rate,
        taxableValuePaise: lineTaxableValue(qty.scaled, rate),
        gstRateBasisPoints: gstBasisPoints,
        itcEligibility: blocked === null ? 'ELIGIBLE' as const : 'INELIGIBLE' as const,
      };
    });
  }

  /**
   * Issue #181 — the lines somebody actually typed, as records rather than as words.
   *
   * A sale carries one line or many. Each line names an item from the business's own item list, in
   * that item's own unit, and the customer is the customer that was chosen. Nothing here falls back
   * to a demo party or a demo product: a name that matches no record is refused, because a bill
   * that names goods the business does not keep is not a bill of this sale.
   */
  private saleLines(input: Record<string, unknown>) {
    const raw = input.lines;
    const parsed: unknown = typeof raw === 'string' && raw.trim() !== '' ? JSON.parse(raw) : raw;
    const rows: Record<string, unknown>[] = Array.isArray(parsed) && parsed.length > 0
      ? parsed as Record<string, unknown>[]
      : [{ item: input.itemId ?? input.item, quantity: input.quantity, unit: input.unit, rate: input.rate, discount: input.discount, discountPercent: input.discountPercent }];
    return withBillDiscount(rows.map((row, index) => {
      const item = resolveItem(this.config.companyId, String(row.itemId ?? row.item ?? ''));
      const unit = String(row.unit ?? '').trim().toUpperCase() || item.baseUnit;
      const quantity = quantityFromString(String(row.quantity ?? ''), unit);
      const unitPrice = money(paise(row.rate));
      // Issue #293 — the line's own discount, taken off before GST.
      const discount = lineDiscountOf(row, mulDiv(unitPrice, quantity.scaled, 1_000_000n).minor);
      return {
        lineId: `line-${index + 1}`,
        itemId: item.id,
        warehouseId: this.shop.warehouseId,
        quantity,
        unitPrice,
        priceBasis: 'EXCLUSIVE' as const,
        ...(discount === undefined ? {} : { discount }),
      };
    }), input.billDiscount);
  }

  /**
   * Issue #143 — the export or SEZ particulars of a sale, or `null` for an ordinary one.
   *
   * Which kind of supply it is comes from the customer's own record (#5): an SEZ unit, a deemed-export
   * buyer, or a buyer abroad. Only for a buyer abroad does the sale itself say whether it goes under
   * LUT, because that is the seller's choice each time. Everything is checked before anything is
   * drafted, and every problem is said at once.
   */
  private exportParticulars(input: Record<string, unknown>): ExportParticulars | null {
    const customer = resolveCustomer(this.config.companyId, String(input.customerId ?? input.customer ?? input.party ?? ''));
    const text = (value: unknown): string => String(value ?? '').trim();
    const kind = exportSupplyKindFor(customer.gstRegistrationType, text(input.underLut) !== 'no');
    if (kind === null) return null;
    const currency = text(input.exportCurrency).toUpperCase();
    const bill = { number: text(input.shippingBillNumber), date: text(input.shippingBillDate), portCode: text(input.portCode).toUpperCase() };
    const particulars: ExportParticulars = {
      kind,
      ...(text(input.exportCountry) === '' ? {} : { countryCode: text(input.exportCountry).toUpperCase() }),
      ...(currency === '' || currency === 'INR' ? {} : { currency, exchangeRate: text(input.exchangeRate) }),
      ...(bill.number === '' && bill.date === '' && bill.portCode === '' ? {} : { shippingBill: bill }),
    };
    const problems = checkExportParticulars(particulars);
    if (problems.length > 0) throw invalid('EXPORT_PARTICULARS', problems.map((problem) => problem.message).join(' '));
    return particulars;
  }

  /**
   * Issue #287 — goods or services, from the items on the bill. A bill carries one kind (its
   * copies, e-way bill, income account and GSTR-1 rows all follow it), and goods and services count
   * in a state by different rules (IGST Act s. 10 against s. 12), so a bill mixing the two is
   * refused until each line can carry its own.
   */
  private saleSupplyKind(lines: readonly { readonly itemId: string }[], input: Record<string, unknown>): 'GOODS' | 'SERVICES' {
    const kinds = new Set(lines.map((line) => itemView(this.config.companyId, line.itemId).kind));
    if (kinds.size > 1) {
      throw invalid('SALE_MIXES_GOODS_AND_SERVICES', 'This bill has goods and a service on it. Make one bill for the goods and another for the service: GST decides where goods and services count by different rules, and one bill cannot carry both yet.');
    }
    if (!kinds.has('service')) return 'GOODS';
    if (!['', 'same'].includes(String(input.shipTo ?? '').trim().toLowerCase())) {
      throw invalid('SERVICE_NO_SHIP_TO', 'A service is not sent anywhere, so a service bill has no delivery address. Choose "Same as billing address".');
    }
    // CGST Rule 138(1): an e-way bill is only for goods that move, so a service bill also takes none
    // of the delivery box's movement answers — they would otherwise print on it as though goods went.
    const transport = ['transporterId', 'vehicleNumber', 'lrNumber', 'lrDate', 'destination', 'distanceKm', 'ewayBillNumber']
      .filter((field) => String(input[field] ?? '').trim() !== '');
    if (transport.length > 0) {
      throw invalid('SERVICE_NO_TRANSPORT', 'A service is not sent in a vehicle, so a service bill takes no transporter, vehicle, transport receipt, destination, journey distance or e-way bill number. Leave the transport boxes empty — if goods are going too, they need their own bill.');
    }
    return 'SERVICES';
  }

  /** Issue #287 — IGST Act s. 12(2): why a service counts in this state, said as plainly as goods are. */
  private static servicePlaceOfSupplyReason(stateCode: string | null, customer: { readonly legalName: string; readonly gstRegistrationType: string }, walkIn: boolean): string {
    const code = stateCode ?? '';
    const where = `Place of supply: ${STATE_NAMES[code] ?? code} (${code})`;
    const whereHi = `सप्लाई का स्थान: ${STATE_NAMES[code] ?? code} (${code})`;
    if (walkIn) return both(`${where} — the service is supplied at your counter, so it counts in your own state.`, `${whereHi} — सेवा आपके काउंटर पर दी गई, इसलिए यह आपके अपने राज्य में गिनी जाती है।`);
    return customer.gstRegistrationType === 'unregistered'
      ? both(`${where} — the service is supplied to ${customer.legalName}, at the address saved for them.`, `${whereHi} — सेवा ${customer.legalName} को दी गई, उनका सेव किया पता वहीं है।`)
      : both(`${where} — the service is supplied to ${customer.legalName}, who is registered for GST there.`, `${whereHi} — सेवा ${customer.legalName} को दी गई, जो वहाँ GST के लिए रजिस्टर्ड हैं।`);
  }

  private saleInput(input: Record<string, unknown>) {
    const date = isoDate(String(input.date));
    const terms = Number(input.terms ?? 0);
    const freight = optionalMoney(input.freight);
    const otherCharges = optionalMoney(input.otherCharges);
    const customer = resolveCustomer(this.config.companyId, String(input.customerId ?? input.customer ?? input.party ?? ''));
    // The place of supply is where the customer is, never where we are. Billing our own state to
    // an out-of-state customer charges CGST and SGST where the law asks for IGST, and the buyer
    // cannot claim either of them back.
    const address = billingAddressOf(this.config.companyId, customer.id);
    if (address === null) {
      throw invalid('CUSTOMER_ADDRESS_MISSING', `${customer.legalName} has no address saved. A bill must carry the customer's address, so add it before billing them.`);
    }
    // Issue #182 — where the goods go decides which state this sale counts in, and the two cases
    // differ in law: a customer's own godown moves the supply to that state, while goods handed to
    // a third party on the customer's instructions stay where the customer is.
    const lines = this.saleLines(input);
    const supplyKind = this.saleSupplyKind(lines, input);
    const delivery = deliveryDetails(this.config.companyId, customer, input);
    return {
      partyId: customer.id as PartyId,
      customerType: customer.gstRegistrationType === 'unregistered' ? 'B2C' as const : 'B2B' as const,
      supplyKind,
      documentDate: date,
      dueDate: isoDate(daysAfter(date, Number.isFinite(terms) ? terms : 0)),
      // Issue #287 — where goods are delivered is IGST Act s. 10. A service is not delivered
      // anywhere: s. 12(2) decides it in the calculator, from the customer (or from us, when an
      // unregistered customer has no address on record).
      ...(supplyKind === 'SERVICES' ? {} : {
        deliveryStateCode: delivery.placeOfSupplyStateCode,
        placeOfSupplyStateCode: delivery.placeOfSupplyStateCode,
      }),
      lines,
      ...(freight === undefined ? {} : { freight }),
      ...(otherCharges === undefined ? {} : { otherCharges }),
      narration: String(input.notes || '') || null,
    };
  }

  private returnInput(input: Record<string, unknown>) {
    const kind = String(input.kind) === 'PURCHASE_RETURN' ? 'PURCHASE_RETURN' as const : 'SALES_RETURN' as const;
    const documentId = String(input.documentId ?? '').trim();
    const lineId = String(input.lineId ?? '').trim();
    if (documentId === '' || lineId === '') throw invalid('RETURN_DOCUMENT_REQUIRED', 'Choose the original bill and item being returned.');
    // Issue #233 — "Whole bill": every item still on it and every charge, freight included.
    if (lineId === WHOLE_BILL && kind === 'SALES_RETURN') {
      return {
        kind,
        command: {
          idempotencyKey: `web-return:${kind}:${requestKeyOf(input, 'RETURN_REQUEST_ID_REQUIRED', 'return')}`,
          documentDate: isoDate(String(input.date)), reason: String(input.reason ?? ''),
          originalInvoiceId: documentId, lines: [], wholeBill: true,
          wholeBillDisposition: String(input.disposition ?? 'ACCEPTED') as 'ACCEPTED' | 'DAMAGED' | 'SCRAPPED' | 'REPLACEMENT',
          ...(String(input.disposition) === 'DAMAGED' ? { wholeBillWarehouseId: this.shop.damagedWarehouseId } : {}),
        },
      };
    }
    const quantity = quantityFromString(String(input.quantity ?? ''), String(input.unit ?? 'PCS'));
    const disposition = String(input.disposition ?? 'ACCEPTED') as 'ACCEPTED' | 'DAMAGED' | 'SCRAPPED' | 'REPLACEMENT';
    const shared = {
      idempotencyKey: `web-return:${kind}:${requestKeyOf(input, 'RETURN_REQUEST_ID_REQUIRED', 'return')}`,
      documentDate: isoDate(String(input.date)), reason: String(input.reason ?? ''),
      // Issue #292 — goods a customer sends back damaged go to the damaged / not-for-sale location,
      // never into the godown they can be sold from. Goods sent back to a supplier leave the main godown.
      lines: [{
        originalLineId: lineId, quantity, disposition,
        warehouseId: kind === 'SALES_RETURN' && disposition === 'DAMAGED' ? this.shop.damagedWarehouseId : this.shop.warehouseId,
      }],
    };
    // Issue #249 — the supplier's credit note, when it is already in hand. Both or neither.
    const supplierNoteNumber = String(input.supplierNoteNumber ?? '').trim();
    const supplierNoteDate = String(input.supplierNoteDate ?? '').trim();
    // The date field starts filled with today, so an empty number means "not received yet".
    if (supplierNoteNumber !== '' && supplierNoteDate === '') {
      throw invalid('RETURN_SUPPLIER_NOTE_INCOMPLETE', "Type the date printed on the supplier's credit note too, or leave the number empty and add both when it arrives.");
    }
    return kind === 'SALES_RETURN'
      ? { kind, command: { ...shared, originalInvoiceId: documentId } }
      : {
        kind,
        command: {
          ...shared, originalBillId: documentId,
          ...(supplierNoteNumber === '' ? {} : { supplierCreditNote: { number: supplierNoteNumber, date: isoDate(supplierNoteDate) } }),
        },
      };
  }

  private companyOf(actor: ActorContext): CompanyId {
    if (actor.companyId !== this.config.companyId) throw invalid('API_TENANT_MISMATCH', 'This company is not available in your session.');
    return actor.companyId;
  }
}

/** Issue #239 — the exempt kinds of business, as the sale review names them. */
const EINVOICE_EXEMPTION_WORDS: Readonly<Record<Exclude<ReturnType<typeof eInvoiceExemptionOf>, 'NONE'>, string>> = {
  BANKING_OR_NBFC: 'a bank or a finance company (NBFC)',
  INSURANCE: 'an insurance company',
  GOODS_TRANSPORT_AGENCY: 'a goods transport agency',
  PASSENGER_TRANSPORT: 'a passenger transport business',
  CINEMA_ADMISSION: 'a cinema',
  SEZ_UNIT: 'a unit in a Special Economic Zone',
  GOVERNMENT_DEPARTMENT: 'a government department or local authority',
};
