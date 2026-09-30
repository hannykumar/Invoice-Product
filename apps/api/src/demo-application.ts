/**
 * Issues #72 and #80 — one authenticated company composed from the real domain services.
 *
 * Persistence is in-memory for the local app, but company and actor always come from the session.
 */
import { conflict, DomainError, financialYearOf as financialYearName, formatDate, formatINR, invalid, notAllowed, indiaDateOf, isoDate, money, notFound, quantityFromString, sum, type CompanyId, type PartyId } from '@invoice/kernel';
import { appClock, appToday, currentFinancialYear, previousMonthOfToday } from './app-clock.ts';
import { permissionPortFromActor, type ActorContext } from '@invoice/ledger';
import { GstCalculator, RateTable, foldChargesIntoGoods, type ComputedTaxLine } from '@invoice/gst-calc';
import { RulesEngine, shippedRegistry } from '@invoice/rules-engine';
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
  billingAddressOf,
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
import { businessDetailsOf, currentStates, dispatchFrom, eInvoiceExemptionOf, readBusinessDetails, requireIssuable, saveBusinessDetails, sellerPrint, turnoverAnswersOf, turnoverBandFor } from './business-details-application.ts';
import { eInvoiceTask, ewayTask, doneReturnMonths, gstReturnTasks, lateCustomersTask, moneyCardFigures, recentBillRow, stockTask, turnoverTask, type HomeTask } from './home-application.ts';
import { turnoverAnswerOn, turnoverBandOn } from '../../../packages/masters/src/hsn-digits.ts';
import { validatePincodeForState } from '../../../packages/masters/src/validation.ts';
import { STATE_NAMES } from '@invoice/transport';
import { ChallanDesk } from './challan-application.ts';
import { PreSaleDesk } from './presale-application.ts';
import { AdvanceService, InMemoryAdvanceRepository, InMemoryPaymentRepository, ReceivablesService, type DocumentLedgerPort, type DocumentPosition, type OpenDocument, type Payment, type PaymentMode, type AdvanceParticulars, type DocumentReference } from '@invoice/receivables';
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
import type { ApprovedPurchase, ApprovedPurchaseLine, PurchaseBill, PurchasePostingPreview } from '../../../packages/purchasing/src/posting-types.ts';
import { validatePurchase } from '../../../packages/purchasing/src/validate.ts';
import { rulesEngineTaxSplit } from '../../../packages/purchasing/src/rules-adapter.ts';
import { normaliseInvoiceNumber } from '../../../packages/purchasing/src/duplicates.ts';
import { formatPaise } from '../../../packages/purchasing/src/money.ts';
import { gstinStateCode, normaliseIdentifier } from '../../../packages/masters/src/validation.ts';
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
  InMemoryReturnNoteRepository, ReturnService, purchaseReturnSource, returnInventoryAdapter, salesReturnSource, type ReturnNote,
} from '../../../packages/returns/src/index.ts';
import { BankFeedService, SyntheticBankFeedProvider, type BankFeedConnection, type BankFeedContext } from '../../../packages/bank-feeds/src/index.ts';
import { itcInwardTaxPort } from '../../../packages/itc/src/adapters.ts';
import type { ItcWorkspace, ReconciliationLine } from '../../../packages/itc/src/types.ts';
import { ITC_PERMISSIONS, totalTaxOf as totalItcTaxOf } from '../../../packages/itc/src/types.ts';
import { formatClaimDate } from '../../../packages/itc/src/deadline.ts';
import {
  GstReturnService, InMemoryReturnPreparations, ledgerBookTaxPort, ledgerInputBookTaxPort, ledgerInwardTaxPort,
  formatTaxPeriod, returnNoteToDocument, salesInvoiceToDocument, taxPeriod, taxPeriodOf, totalTaxOf,
  type OutwardDocument, type OutwardSupplyPort, type ReturnWorkspace, type TaxPeriod,
} from '@invoice/gst-returns';
import { standardRecurringJobs, type RecurringJobDefinition } from '../../../ops/operations/src/index.ts';

/** Issue #233 — a GST return in one of these states has been approved (and perhaps filed); its month's bills are fixed. */
/** Issue #233 — the Returns screen's choice that credits a whole sales bill, charges included. */
const WHOLE_BILL = '__whole__';
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
const advanceChoiceLabel = (supplier: string): string => `Record this as an advance to ${supplier}`;

const advanceChoiceHelp = (supplier: string, openBills: number): string => openBills === 0
  ? `You have no bill from ${supplier} yet. This money will be kept as an advance and taken off their next bill.`
  : `Whatever is not put against a bill ticked above will be kept as an advance and taken off ${supplier}'s next bill.`;

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

// Money by UPI or bank transfer goes into, or comes out of, the business's current account.
const CURRENT_ACCOUNT = '1121';

/**
 * How the money moved, exactly as it was chosen. Nothing defaults to cash: a payment recorded as
 * cash that came by bank puts money in the drawer that is really in the bank.
 */
const paymentHow = (direction: 'RECEIPT' | 'PAYMENT', input: Record<string, unknown>): {
  mode: PaymentMode; bankAccountCode: string | null; words: string;
  cheque?: { number: string; chequeDate: IsoDate };
} => {
  const chosen = String(input.method ?? input.mode ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (chosen === '') throw invalid('PAYMENT_MODE_REQUIRED', 'Choose how the money was paid: UPI, cash, bank transfer or cheque.');
  if (chosen === 'CASH') return { mode: 'CASH', bankAccountCode: null, words: 'cash' };
  if (chosen === 'UPI') return { mode: 'UPI', bankAccountCode: CURRENT_ACCOUNT, words: 'UPI' };
  if (chosen === 'BANK_TRANSFER') return { mode: 'BANK_TRANSFER', bankAccountCode: CURRENT_ACCOUNT, words: 'bank transfer' };
  if (chosen === 'CHEQUE') {
    const number = String(input.chequeNumber ?? '').trim();
    const dated = String(input.chequeDate ?? '').trim();
    if (number === '' || dated === '') throw invalid('PAYMENT_CHEQUE_DETAILS_REQUIRED', 'Enter the cheque number and the date written on the cheque.');
    const chequeDate = isoDate(dated);
    // A cheque received waits in "cheques in hand" until it clears; a cheque given is drawn on our bank.
    return { mode: 'CHEQUE', bankAccountCode: direction === 'PAYMENT' ? CURRENT_ACCOUNT : null, words: `cheque No. ${number} dated ${chequeDate}`, cheque: { number, chequeDate } };
  }
  throw invalid('PAYMENT_MODE_INVALID', 'Choose how the money was paid: UPI, cash, bank transfer or cheque.');
};

const BALANCE_WILL_INCREASE = 'The customer balance will increase.';

/** Issue #288 — CGST Rule 46(e): from this taxable value an unregistered buyer must be named on the bill. */
const WALK_IN_LIMIT = 50_000_00n;

/**
 * Issue #288 — "Paid now": how the customer paid at the counter, and how much, when the bill is
 * recorded together with its receipt. `null` when the sale does not say (money to come later).
 * Nothing defaults to cash; an amount left out is the whole bill.
 */
const PAID_NOW: Readonly<Record<string, { mode: PaymentMode; bankAccountCode: string | null; words: string }>> = {
  CASH: { mode: 'CASH', bankAccountCode: null, words: 'cash' },
  UPI: { mode: 'UPI', bankAccountCode: CURRENT_ACCOUNT, words: 'UPI' },
  CARD: { mode: 'CARD', bankAccountCode: CURRENT_ACCOUNT, words: 'card' },
};
type PaidNow = (typeof PAID_NOW)[string] & { readonly amount: bigint | null };
const paidNowOf = (input: Record<string, unknown>): PaidNow | null => {
  const chosen = String(input.paidBy ?? '').trim().toUpperCase();
  if (chosen === '') return null;
  const how = PAID_NOW[chosen];
  if (how === undefined) throw invalid('SALE_PAID_BY_INVALID', 'Say how the customer paid at the counter: cash, UPI or card.');
  return { ...how, amount: String(input.paidAmount ?? '').trim() === '' ? null : paise(input.paidAmount) };
};

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
 * against. It is our own accounts voucher; it is not the reverse-charge payment voucher of CGST
 * Rule 52, and the heading does not say it is.
 */
const paymentVoucherHtml = (input: {
  readonly payment: Payment;
  readonly number: string;
  readonly seller: RenderableParty;
  readonly party: RenderableParty;
  readonly bills: readonly { number: string; date: string | null; total: bigint | null; settled: bigint; adjusted: boolean }[];
}): string => {
  const { payment, number, seller, party } = input;
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
${adjustedTable}
${!advance && onAccount > 0n ? `<p>On account, not yet put against a bill: ${formatPaise(onAccount)}</p>` : ''}
${narration}
<p style="margin-top:48px;text-align:right">For ${escapeHtml(seller.name)}<br><br>Authorised signatory</p></body></html>`;
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
      ? `GST: ${formatPaise(claimable)} payable by you under reverse charge`
      : `GST you can claim back: ${formatPaise(claimable)} (${tax.intraState ? 'CGST + SGST' : 'IGST'})`,
  );
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
  private readonly salesRepository: InMemorySalesRepository;
  private readonly invoicePrints = new Map<string, { document: InvoiceDocument; snapshot: TemplateSnapshot }>();
  /** Issue #186 — each credit or debit note's printed page, frozen the moment it is recorded. */
  private readonly notePrints = new Map<string, { document: CreditNoteDocument; snapshot: TemplateSnapshot }>();
  /**
   * The movement each e-way bill was actually raised on, kept against its document.
   *
   * The driver's page must say what the portal was told, not what happens to be on the dispatch
   * form when somebody presses Print. Rebuilding it from the form means a reprint — and every PDF,
   * which never has a form behind it — quietly loses the ship-to address and the transaction type,
   * so the page in the driver's hand disagrees with the government's record for that number.
   */
  private readonly ewayMovements = new Map<string, Movement>();
  /**
   * Issue #182 — the delivery and reference answers, kept against the draft they were checked with
   * until the bill is issued and they are frozen onto it.
   */
  private readonly deliveries = new Map<string, DeliveryDetails>();
  /** Issue #233 — what stops a bill being cancelled; the same guard the sales service asks. */
  private cancelGuard: CancellationGuardPort = { async blockers() { return []; } };
  /**
   * Issue #266 — the GST returns as prepared on the GST returns screen, so a new bill is never
   * dated into a month whose return is already approved or filed.
   */
  private returnMonths: InMemoryReturnPreparations = new InMemoryReturnPreparations();
  /**
   * Issue #143 — the export or SEZ particulars of a sale, kept against the draft and then the bill
   * (they share an id). The printed bill, the e-invoice and GSTR-1 all read this one entry.
   */
  private readonly exportSales: Map<string, ExportParticulars>;
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
  /** Issue #141 — delivery challans, for goods that move before the bill exists. */
  readonly challans: ChallanDesk;
  /** Issue #142 — quotations and proforma invoices, the papers sent before a sale. */
  readonly presale: PreSaleDesk;

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
    challans: ChallanDesk,
    presale: PreSaleDesk,
    exportSales: Map<string, ExportParticulars>,
  ) {
    this.config = config;
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
    // Issue #249 — the shop holds the notes, so the purchase comparison reads the same ones.
    const returnNotes = shop.returnNotes;
    shop.store.join(salesRepository).join(paymentRepository);
    // Issue #181 — the customers and items this company actually keeps, in `packages/masters`.
    // The screens add to the same records, so a customer added at the counter is a customer the
    // bill can be made out to a moment later.
    seedCatalogue(config.companyId, config.catalogue);
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
    const godown = salesInventoryAdapter(shop.inventoryService, { defaultWarehouseId: 'wh-main' });
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
    const gstPreparations = new InMemoryReturnPreparations();
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
            message: `${number} cannot be cancelled: it is in the GST return for ${month}, which is ${prepared.state === 'FILED' ? 'filed' : 'approved'}. Make a credit note for the whole bill instead (Returns, choose "Whole bill"). The bill and the note both stay on record.`,
            clearable: null,
          });
          break;
        }
        // A credit note already points at this bill. Cancelling the bill would leave that note
        // reducing tax on a sale that was never reported.
        const notes = (await returnNotes.listForOriginal(invoice.companyId, invoice.id)).filter((note) => note.kind === 'SALES_RETURN');
        if (notes.length > 0) {
          found.push({
            code: 'SALES_CANCEL_HAS_CREDIT_NOTE',
            message: `${number} cannot be cancelled: credit note ${notes.map((note) => note.number).join(', ')} has already been made against it. Make a credit note for the rest of the bill instead (Returns, choose "Whole bill").`,
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
            message: `${number} has been sent for its e-invoice number and the government has not answered yet. Wait for the answer on the E-invoice screen, then cancel.`,
            clearable: null,
          });
        } else if (eInvoice?.status === 'REGISTERED') {
          const open = eInvoice.cancellableUntil === undefined || eInvoice.cancellableUntil > now;
          found.push(open
            ? {
              code: 'SALES_CANCEL_EINVOICE_ACTIVE',
              message: `${number} has a government e-invoice number (IRN). The e-invoice has to be cancelled with the government first, and that is allowed only within 24 hours of registering it. Cancel the e-invoice, then this bill.`,
              clearable: 'EINVOICE',
            }
            : {
              code: 'SALES_CANCEL_EINVOICE_WINDOW_CLOSED',
              message: `${number} has a government e-invoice number, and the 24 hours in which the government allows it to be cancelled have passed. Make a credit note for the whole bill instead (Returns, choose "Whole bill").`,
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
              message: `${number} has e-way bill ${eway.acknowledgement.ewayBillNumber}. It has to be cancelled on the portal first, which is allowed only within 24 hours of raising it. Cancel the e-way bill, then this bill.`,
              clearable: 'EWAY_BILL',
            }
            : {
              code: 'SALES_CANCEL_EWAY_WINDOW_CLOSED',
              message: `${number} has e-way bill ${eway.acknowledgement.ewayBillNumber}, and it can no longer be cancelled on the portal, so the government holds these goods as moved. Make a credit note for the whole bill instead (Returns, choose "Whole bill").`,
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
        const saleDocuments: OpenDocument[] = invoices.map((invoice) => ({ documentId: invoice.id, kind: 'SALES_INVOICE', number: invoice.number ?? invoice.id, partyId, date: invoice.documentDate, dueDate: invoice.dueDate, value: money((invoice.pricing?.totals.invoiceValue.minor ?? 0n) - returnedValue(invoice.id, 'SALES_RETURN')), side: 'RECEIVABLE' }));
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
      stockMasterData: demoStockMasterData(),
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
        warehouse: (_companyId, warehouseId) => warehouseId === 'wh-main' ? config.location : undefined,
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
      sales: salesReturnSource(salesRepository, async (companyId, documentId) =>
        (await shop.eInvoices.findByDocumentId(companyId, documentId))?.status === 'REGISTERED'),
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
      repository: new InMemoryReminderRepository(),
      permissions: permissionPortFromActor,
      audit: shop.audit,
      // Issue #234 — the app's one real clock, so a reminder is judged on the day it is sent.
      // Quiet hours are a real rule evaluated against this clock; the package tests drive a night
      // and a morning through it.
      clock: appClock,
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
      clock: appClock,
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
    const exportSales = new Map<string, ExportParticulars>();
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
          },
          customerOn(String(invoice.partyId)),
          supplier,
        ));
        // Issue #232 — a credit note counts in the state of the bill it corrects, read from that
        // bill (which may be in an earlier month). Every note used to be given our own state, so an
        // inter-state note carrying IGST was flagged as a local sale and filed under Karnataka.
        const hsnByItem = Object.fromEntries(catalogueItems(companyId).map((item) => [item.id, item.hsnSac]));
        const notes = await Promise.all((await returnNotes.list(companyId))
          .filter((note) => note.kind === 'SALES_RETURN' && taxPeriodOf(note.documentDate) === period)
          .map(async (note) => {
            const original = await salesRepository.findById(companyId, note.originalDocument.id);
            return returnNoteToDocument(note, customerOn(String(note.partyId)), supplier, {
              original: original === null ? null : {
                placeOfSupplyStateCode: original.pricing?.placeOfSupplyStateCode ?? original.placeOfSupplyStateCode,
              },
              hsnByItem,
            });
          }));
        return [...documents, ...notes];
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
    });

    // Issue #141. Challans share the store, so a number is allocated in the same transaction that
    // saves the challan; they read the same master data and calculator the invoice does, so a sale
    // challan shows the tax its invoice will charge.
    const challanRepository = new InMemoryChallanRepository();
    shop.store.join(challanRepository);
    const challans = new ChallanDesk(config, new ChallanService({
      store: shop.store, calculator, masterData: masters, repository: challanRepository, invoices: salesRepository,
      permissions: permissionPortFromActor, audit: shop.audit, clock: appClock, invoicePrefix: 'INV',
    }));

    // Issue #142. Quotations and proformas share the store only so a number and the document are
    // saved together; they post nothing to it. They are priced by the invoice's own calculator, and a
    // quotation becomes a sale through the invoice's own service, as a draft.
    const presaleRepository = new InMemoryPreSaleRepository();
    shop.store.join(presaleRepository);
    // Issue #165. Money taken against a proforma is recorded by the same receivables service as any
    // other receipt, and linking the proforma's invoice applies it and sets off its tax.
    const advanceRepository = new InMemoryAdvanceRepository();
    shop.store.join(advanceRepository);
    const advances = new AdvanceService({
      store: shop.store, ledger: shop.ledger, receivables: payments, proformas: presaleRepository, repository: advanceRepository,
      permissions: permissionPortFromActor, audit: shop.audit, clock: appClock,
    });
    const presale = new PreSaleDesk(config, new PreSaleService({
      store: shop.store, calculator, repository: presaleRepository, invoices: salesRepository, sales,
      permissions: permissionPortFromActor, audit: shop.audit, clock: appClock, takenPrefixes: ['INV', 'DC', 'RV', 'RFV'],
      advances,
    }), advances);

    const app = new DemoApplication(config, shop, sales, salesRepository, payments, paymentRepository, documents, reportService, assistant, terms, returns, returnNotes, collections, notifications, outbox, bankFeeds, subscriptions, agent, agentAudit, gstReturns, challans, presale, exportSales);
    app.cancelGuard = cancellationGuard;
    app.returnMonths = gstPreparations;
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
      warehouseId: 'wh-main',
      kind: 'OPENING',
      quantity: input.quantity,
      unitCost: input.unitCost,
      documentDate: isoDate('2026-04-01'),
      source: { kind: 'opening_stock', id: input.idempotencyKey, number: null },
      reason: 'Opening count on the day the books began',
    });
  }

  private async seed(): Promise<void> {
    // Issue #229 — a sale takes its goods out of stock, so the three old soap bills below need the
    // soap they sold. It is entered as the count on the day the books begin: 4 + 2 + 1 = 7 pieces,
    // at a made-up cost of ₹200 each, and all of it is sold by those bills, so no soap is left.
    await this.recordOpeningStock(this.shop.setupActor, {
      idempotencyKey: 'seed-opening-soap',
      itemId: resolveItem(this.config.companyId, 'Herbal Bath Soap 100g').id,
      quantity: quantityFromString('7', 'PCS'),
      unitCost: money(200_00n),
    });
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
    const salesTodayReturned = returnNotes.filter((note) => note.kind === 'SALES_RETURN' && note.documentDate === today).reduce((total, note) => total + note.totals.total.minor, 0n);
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
        ...this.shop.audit.events.filter((event) => event.action === 'payee.changed' && event.companyId === companyId)
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
    if (may('gst_returns.view')) {
      const booksStart = (await this.shop.store.read().settings.get(companyId))?.booksStartDate ?? currentFinancialYear().from;
      tasks.push(...await gstReturnTasks(actor, { id: companyId, name: this.config.name, gstin: this.config.gstin, booksStart }, doneReturnMonths(await this.gstReturns.list(actor)), may('gst_returns.prepare')));
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
      const balance = await this.shop.inventoryService.balance(actor, { itemId: item.id, warehouseId: 'wh-main' });
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

  async reports(actor: ActorContext) {
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
        rows: pack.stock.body.rows.map((r) => ({ item: r.itemName, warehouse: r.warehouseName, unit: r.unitCode, closing: r.closing, available: r.available, value: jsonAmount(r.value.minor) })),
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
    const { approved, supplierState, godownState } = draft;
    const preview = this.shop.posting.preview(actor, approved);
    const intra = preview.tax.intraState;
    const head = intra ? 'CGST + SGST' : 'IGST';
    const lineTaxes = approved.lines.map((line) => taxOn(line.taxableValuePaise, line.gstRateBasisPoints));
    const lines = approved.lines.map((line, index) =>
      `${line.description}: ${formatQuantity(line.quantity)} × ${formatPaise(line.ratePaise)} = ${formatPaise(line.taxableValuePaise)}, ${head} ${line.gstRateBasisPoints / 100}% = ${formatPaise(lineTaxes[index] ?? 0n)}`);
    const claimable = preview.tax.cgstPaise + preview.tax.sgstPaise + preview.tax.igstPaise + preview.tax.cessPaise;
    const why = intra
      ? `The supplier is in ${STATE_NAMES[supplierState] ?? supplierState} (${supplierState}), the same state as your godown, so the bill carries CGST and SGST.`
      : `The supplier is in ${STATE_NAMES[supplierState] ?? supplierState} (${supplierState}) and your godown is in ${STATE_NAMES[godownState] ?? godownState} (${godownState}), so the bill carries IGST.`;
    const sumLine = lineTaxes.length > 1
      ? [`${head}: ${lineTaxes.map(formatPaise).join(' + ')} = ${formatPaise(claimable)}`]
      : [];
    // Issue #261 — an advance already paid to this supplier is offered against this bill, ticked.
    const advance = await this.supplierAdvanceFor(actor, approved, input);
    return {
      state: 'preview',
      title: 'Ready to record',
      // Nothing has happened yet, so the review says what recording will do, not what it did.
      message: advance !== null && advance.used > 0n
        ? `Recording bill ${approved.invoiceNumber} from ${approved.supplierName} for ${formatPaise(preview.totalPaise)} will take the ${formatPaise(advance.used)} advance already paid off it, so you will owe them ${formatPaise(preview.totalPaise - advance.used)}, due on ${preview.dueDate}, and ${formatPaise(claimable)} of GST you can claim back.`
        : `Recording bill ${approved.invoiceNumber} from ${approved.supplierName} will add ${formatPaise(preview.totalPaise)} to what you owe them, due on ${preview.dueDate}, and ${formatPaise(claimable)} of GST you can claim back.`,
      amount: jsonAmount(preview.totalPaise),
      supplier: approved.supplierName,
      taxType: intra ? 'CGST_SGST' : 'IGST',
      tax: { cgst: jsonAmount(preview.tax.cgstPaise), sgst: jsonAmount(preview.tax.sgstPaise), igst: jsonAmount(preview.tax.igstPaise), total: jsonAmount(claimable) },
      // Issue #261 — with an advance taken off, the bill's total is not what is due; the sum below says what is.
      effects: [why, ...lines, ...sumLine,
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
      return { state: 'recorded', deduplicated: true, title: 'Already recorded once', message: `${draft.message} Stock and the supplier balance were not doubled.`, bill: DemoApplication.purchaseBillJson(draft.alreadyRecorded), stock: DemoApplication.stockOf(dashboard, draft.alreadyRecorded.lines[0]?.itemId), supplier: dashboard.supplier, purchaseCheck: await this.purchaseCheckFor(actor, draft.alreadyRecorded) };
    }
    const { approved } = draft;
    // A supplier added a moment ago gets their own account in the books before the bill is posted to it.
    await this.shop.ledger.openPartyAccount(this.shop.setupActor, { partyId: approved.supplierPartyId, name: approved.supplierName, kind: 'SUPPLIER' });
    // Issue #261 — worked out before the bill is posted, so it is the advance the review showed.
    const advance = await this.supplierAdvanceFor(actor, approved, input);
    if (advance !== null && advance.used > 0n && approved.taxLiability === 'REVERSE_CHARGE') {
      // Tax on a reverse-charge service falls due when it is paid, so an advance would have moved
      // that date. This screen does not handle reverse charge, so it says so rather than mis-tax it.
      throw notAllowed('PURCHASE_ADVANCE_REVERSE_CHARGE', 'This bill is under reverse charge, and an advance paid on it changes when its GST was due. That is not handled here yet, so nothing was recorded.');
    }
    const result = await this.shop.posting.post(actor, approved, `web:${approved.id}`);
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
        sentence: line.sentence['en-IN'],
      };
    } catch {
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

  private reminderDate(input: Record<string, unknown>): IsoDate {
    return input.today === undefined || input.today === '' ? appToday() : isoDate(String(input.today));
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
    return { state: 'recorded', title: 'Promise recorded', message: `${bill.name} promised ${formatINR(promise.amount)} against ${bill.number} by ${promise.promisedOn}. Reminders for this bill are paused until then.`, partyId: bill.partyId, party: bill.name };
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
    return { state: 'recorded', title: 'Dispute recorded', message: documentId === null ? `${party.name}'s bills will not be chased until the dispute is closed.` : `${'number' in party ? party.number : 'This bill'} for ${party.name} will not be chased until the dispute is closed.`, partyId: party.partyId, party: party.name };
  }

  async resolveBillDispute(actor: ActorContext, input: Record<string, unknown>) {
    this.companyOf(actor);
    await this.collections.resolveDispute(actor, String(input.disputeId ?? ''), String(input.resolution ?? 'Settled with the customer.'));
    return { state: 'recorded', title: 'Dispute closed', message: 'The bill goes back into the reminder ladder at the rung its age has reached.' };
  }

  async stopReminders(actor: ActorContext, input: Record<string, unknown>) {
    const party = this.chosenCustomer(actor, input);
    await this.collections.optOut(actor, party.partyId, String(input.reason ?? ''));
    return { state: 'recorded', title: 'Reminders stopped', message: `${party.name} will not receive automatic reminders.`, partyId: party.partyId, party: party.name };
  }

  async resumeReminders(actor: ActorContext, input: Record<string, unknown> = {}) {
    const party = this.chosenCustomer(actor, input);
    await this.collections.resumeReminders(actor, party.partyId);
    return { state: 'recorded', title: 'Reminders started again', message: `${party.name} will receive automatic reminders again.`, partyId: party.partyId, party: party.name };
  }

  /**
   * Issue #181 — the customer list and the item list this business bills from.
   *
   * Adding a customer does two things at once, because a name without a place in the books cannot
   * be billed: the master record is written, and the customer's own account is opened in the
   * ledger. Both or neither.
   */
  async catalogue(actor: ActorContext) {
    const companyId = this.companyOf(actor);
    // Issue #288 — the walk-in customer is on the list from the start, once there is a shop address
    // to bill a counter sale at. Without one, no bill can be issued at all, and the list says nothing.
    if (businessDetailsOf(companyId) !== null) await this.walkIn(actor);
    return readCatalogue(companyId);
  }

  /** Issue #288 — the company's walk-in customer, with its account in the books. */
  private async walkIn(actor: ActorContext) {
    const party = walkInCustomer(this.companyOf(actor));
    await this.shop.ledger.openPartyAccount(this.shop.setupActor, { partyId: party.id, name: party.legalName, kind: 'CUSTOMER' });
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
      title: 'Customer corrected',
      message: `${corrected.message} ${limit === null
        ? `${customer.legalName} has no credit limit, so bills to them are not checked against one.`
        : `${customer.legalName}'s credit limit is ${formatPaise(limit)}. Every bill to them is checked against it.`}`,
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
    // the first. (Callers without a review key still fall back to it, as before.)
    // Issue #256 — this review replaces the one the same sale form showed before it. That earlier
    // review was never issued, so it is forgotten rather than left behind as "a bill waiting".
    const replaced = String(input.replaces ?? '').trim();
    if (replaced !== '' && replaced !== String(input.requestId ?? '')) {
      await this.discardReview(actor, `web-sale:${replaced}`, 'a later review of the same sale replaced it');
    }
    const draft = await this.sales.createDraft(actor, { idempotencyKey: `web-sale:${String(input.requestId || input.reference || crypto.randomUUID())}`, input: { ...this.saleInput(input), ...zeroRated } });
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
      return {
        ...checked,
        effects: paidNow === null ? checked.effects : checked.effects.map((effect) => (effect === BALANCE_WILL_INCREASE ? paidNow.sentence : effect)),
        paidNow: paidNow === null ? null : { mode: paidNow.mode, amount: jsonAmount(paidNow.amount), due: jsonAmount(paidNow.due) },
        dateNotice,
        placeOfSupply: walkIn === null
          ? delivery.placeOfSupplyReason
          : `Place of supply: ${STATE_NAMES[delivery.placeOfSupplyStateCode] ?? delivery.placeOfSupplyStateCode} (${delivery.placeOfSupplyStateCode}) — the goods are handed over at your counter.`,
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
        eInvoice: this.eInvoiceDecisionFor(draft),
      };
    } catch (error) {
      // Issue #256 — a review the app refused (600 KGS asked, 50 KGS in the godown) saved nothing
      // from the person's point of view, so nothing of it is kept: no draft for Reports to call
      // "a bill waiting". It never had a number, so the number series is untouched.
      // The refusal is what the person needs to read, so a failure to tidy up never replaces it.
      await this.discardReview(actor, draft.idempotencyKey, 'the app refused the review').catch(() => undefined);
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
        refusals.push({ code: error.code, 'en-IN': error.message, 'hi-IN': `Is bill ka taxable value ${formatPaise(pricing.totals.taxableValue.minor)} hai. ${formatPaise(WALK_IN_LIMIT)} se upar kanoon (CGST Rule 46(e)) bill par kharidaar ka naam, pata aur rajya maangta hai. Customer ko naam aur pate ke saath joden, aur Walk-in ki jagah unhe chunen.` });
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
          'hi-IN': `${state} ki bikri · ${taxes}`,
          reason: walkIn === null
            ? delivery.placeOfSupplyReason
            : `Place of supply: ${STATE_NAMES[delivery.placeOfSupplyStateCode] ?? delivery.placeOfSupplyStateCode} (${delivery.placeOfSupplyStateCode}) — the goods are handed over at your counter.`,
        },
        ewayBill: eway === null ? null : eway.outcome === 'REQUIRED'
          ? { needed: true, 'en-IN': 'Needs an e-way bill before the goods leave', 'hi-IN': 'Maal nikalne se pehle e-way bill chahiye', reason: eway.reason }
          : { needed: false, 'en-IN': 'No e-way bill needed', 'hi-IN': 'E-way bill ki zaroorat nahin', reason: eway.reason },
        eInvoice: {
          needed: eInvoice.needed, askTurnover: eInvoice.askTurnover, message: eInvoice.message,
          ...(eInvoice.needed === 'YES'
            ? { 'en-IN': 'Needs a government e-invoice number, sent by itself when you issue the bill', 'hi-IN': 'Sarkari e-invoice number chahiye, bill jaari karte hi apne aap bheja jayega' }
            : eInvoice.needed === 'NO'
              ? { 'en-IN': 'No e-invoice needed', 'hi-IN': 'E-invoice ki zaroorat nahin' }
              : { 'en-IN': 'E-invoice not decided yet: answer the turnover question in Business details', 'hi-IN': 'E-invoice abhi tay nahin: Business details mein turnover ka sawaal bharein' }),
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
    const lines = [`This bill will be dated ${formatClaimDate(date)}, which is before today, ${formatClaimDate(today)}.`];
    if (approvedMonth) {
      lines.push(`The GST return for ${month} is already approved without it, so that return will have to be reopened and approved again.`);
    }
    const later = (await this.salesRepository.list(companyId))
      .filter((bill) => bill.number !== null && financialYearOf(bill.documentDate) === financialYearOf(date) && bill.documentDate > date)
      .sort((a, b) => b.documentDate.localeCompare(a.documentDate))[0];
    if (later !== undefined) {
      lines.push(`Bill ${later.number} is already issued with the date ${formatClaimDate(later.documentDate)}, so this bill will get a later number with an earlier date.`);
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
      message: 'This consignment needs an e-way bill before the vehicle leaves.',
      reason: decision.reason,
      ruleId: decision.ruleId,
    };
  }

  /** The e-way bill decision itself, or `null` when the rules cannot answer. Issue #306 shows both answers. */
  private ewayDecisionOf(draft: SalesInvoice, delivery: DeliveryDetails | null) {
    const pricing = draft.pricing;
    if (pricing === null) return null;
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
          documentType: 'TAX_INVOICE',
          documentNumber: draft.number ?? draft.id,
          documentDate: draft.documentDate,
          lines: consignmentLinesOf(pricing.lines),
        }],
        transportMode: 'ROAD',
        vehicleType: 'REGULAR',
        conveyance: 'HIRED_VEHICLE',
      }, { on: draft.documentDate });
      return decision.outcome === 'REQUIRED' || decision.outcome === 'NOT_REQUIRED' ? decision : null;
    } catch {
      // The reminder is a courtesy. If the rules cannot answer, the e-way bill screen still can,
      // and a bill is never held back over it.
      return null;
    }
  }

  /**
   * The checks shown before a bill is issued: its tax, what was last agreed with this customer, and
   * their credit. Issue #142 — a draft made from a quotation is checked here too, so a converted
   * quotation meets exactly the checks a typed sale does.
   */
  private async checkSale(actor: ActorContext, draft: SalesInvoice) {
    if (draft.pricing === null) throw new Error(draft.problems.map((problem) => problem.message['en-IN']).join(' '));
    // Issue #229 — no selling more than is in the godown. Checked here, at the review, for every
    // way a bill is made (typed, or from a quotation), and nothing is taken out until Record.
    const stocked = await this.sales.checkStock(actor, draft.id);
    const short = stocked.problems.filter((problem) => problem.code === 'STOCK_NOT_ENOUGH');
    if (short.length > 0) {
      // Issue #262 — the refusal also carries the Hindi sentence and, for each short line, the goods
      // and the godown, so the screen can open the purchase bill for exactly those goods. The sale
      // itself stays stopped: there is no override and stock never goes below nothing.
      throw notAllowed('SALES_STOCK_NOT_ENOUGH', short.map((problem) => problem.message['en-IN']).join(' '), {
        messageId: 'stock.not_enough',
        details: {
          'hi-IN': short.map((problem) => problem.message['hi-IN']).join(' '),
          shortStock: JSON.stringify(short.flatMap((problem) => (problem.stock === undefined ? [] : [problem.stock]))),
        },
      });
    }

    // Issue #11: what was last agreed, what the discount is, and whether this customer should be
    // given more credit. The draft is excluded from its own pending value.
    const quote = await this.terms.quote(actor, {
      // The customer and the goods this bill is actually for, so "last time you charged them" is
      // about them and about these goods, not about a demo party's soap.
      partyId: draft.partyId,
      documentDate: draft.documentDate,
      documentId: draft.id,
      // Issue #235 — the whole bill, GST, freight and other charges included: what they will owe.
      billValue: draft.pricing.totals.invoiceValue,
      lines: draft.lines.map((line) => ({
        lineId: line.lineId,
        itemId: line.itemId,
        itemName: draft.pricing?.lines.find((priced) => priced.lineId === line.lineId)?.itemName ?? itemView(this.config.companyId, line.itemId).name,
        unit: line.quantity.unit,
        quantity: String(Number(line.quantity.scaled) / 1_000_000),
        unitPrice: line.unitPrice,
      })),
    });

    const effects = ['A numbered invoice will be issued.', BALANCE_WILL_INCREASE];
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
        ? `Paid now by ${paid.words}: ${formatPaise(amount)}. Nothing is left to pay on this bill.`
        : `Paid now by ${paid.words}: ${formatPaise(amount)}. ${formatPaise(total)} − ${formatPaise(amount)} = ${formatPaise(due)} is added to what ${customer} owes.`,
    };
  }

  async recordSale(actor: ActorContext, input: Record<string, unknown>) {
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
    return this.issueCheckedSale(actor, preview.token, usageDate, paid, String(input.distanceKm ?? '').trim());
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
    void (async () => {
      const document = await this.eInvoiceDocumentFor(actor, invoiceId);
      const applicability = this.applicabilityFor(document);
      // Decided here rather than inside the service, because the service refuses a bill that does
      // not need one — and for a bill issued to a shopkeeper who never asked, that refusal is the
      // right answer, not an error worth showing them.
      if (decideApplicability(applicability).outcome !== 'APPLICABLE') return;
      await this.shop.eInvoice.register(actor, { document, applicability });
    })().catch((error: unknown) => {
      // Nothing here may reach the bill. The record itself carries the failure and the retry.
      console.error('The e-invoice for a bill could not be sent; it stays on the E-invoice screen.', error instanceof Error ? error.message : error);
    });
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
      } catch {
        // Still down, or the bill has changed. It stays on the list and is tried again next time.
      }
    }
    return sent;
  }

  private async issueCheckedSale(actor: ActorContext, token: string, usageDate: IsoDate, paidNow: PaidNow | null = null, ewayDistanceKm = '') {
    requireIssuable(this.config.companyId);
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
      title: final.deduplicated ? 'Sale already recorded once' : 'Sale recorded',
      message: receipt === null
        ? `${final.invoice.number} was issued.`
        : `${final.invoice.number} was issued. ${formatPaise(receipt.amount.minor)} received by ${paidNow?.words ?? receipt.mode.toLowerCase()}.`,
      // Said on the screen the moment the bill is issued, so nobody has to go looking for it.
      eInvoice: decision.needed === 'NO'
        ? { expected: false, needed: 'NO' as const, message: null, askTurnover: false }
        : decision.needed === 'UNKNOWN'
          ? { expected: false, needed: 'UNKNOWN' as const, message: decision.message, askTurnover: decision.askTurnover }
          : decision.lateForPortal === true
            ? { expected: true, needed: 'YES' as const, message: decision.message, askTurnover: false }
            : { expected: true, needed: 'YES' as const, askTurnover: false, message: 'This bill has to carry a government e-invoice number. It is being sent now — the bill is already issued, and the number appears on the E-invoice screen when it comes back.' },
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
    const upiId = upiIdOf(companyId);
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
      return { state: 'preview' as const, title: `${invoice.number} is already cancelled`, message: 'Nothing more will change.', token: invoice.id, amount: 0, effects: [], clearFirst: [] };
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
      title: `Cancel ${invoice.number}?`,
      message: `${invoice.number} for ${formatPaise(value)} will be cancelled.`,
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
      message: `${invoice.number} is cancelled. The number stays used, the bill stays on record marked CANCELLED, ${customer}'s balance and the stock are back as they were, and the GST return counts it as cancelled.`,
      onAccount: onAccount === 0n ? null : {
        amount: jsonAmount(onAccount),
        message: `${formatPaise(onAccount)} received against ${invoice.number} is now held on account for ${customer}.`,
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
      title: `Bill ready from ${converted.quotation.number}`,
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
    return this.issueCheckedSale(actor, token, usageDate);
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
    this.invoicePrints.set(invoice.id, {
      document: toInvoiceDocument(invoice, {
        title: 'TAX_INVOICE',
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
      }),
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
    const upiId = upiIdOf(companyId);
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
      ...(upiId === null ? {} : { upiId }),
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
      today: input.today === undefined || input.today === '' ? appToday() : isoDate(String(input.today)),
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
      title: 'Plan changed',
      message: `This business is now on the ${subscription.planId} plan. Nothing that was already recorded has changed.`,
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
      advanceChoice: direction === 'PAYMENT' ? { label: advanceChoiceLabel(party.name), help: advanceChoiceHelp(party.name, open.length) } : null,
      bills: open.map((d) => ({
        id: d.document.documentId,
        number: d.document.number,
        date: d.document.date,
        dueDate: d.document.dueDate,
        total: jsonAmount(d.document.value.minor),
        paid: jsonAmount(d.allocated.minor),
        outstanding: jsonAmount(d.outstanding.minor),
      })),
    };
  }

  async previewPayment(actor: ActorContext, input: Record<string, unknown>) {
    const plan = await this.paymentPlan(actor, input);
    const { direction, party, amount, how, applied, leftOver, owedBefore } = plan;
    const owedAfter = owedBefore - (amount - leftOver);
    if (plan.advance > 0n) return this.previewSupplierAdvance(actor, plan, owedAfter);
    const whose = direction === 'RECEIPT' ? `what ${party.name} owes` : `what you owe ${party.name}`;
    return {
      state: 'preview',
      title: direction === 'RECEIPT' ? 'Money received — check it' : 'Money paid — check it',
      message: `${formatPaise(amount)} will reduce ${whose}.`,
      amount: jsonAmount(amount),
      party,
      direction,
      token: plan.key,
      effects: [
        `${direction === 'RECEIPT' ? 'Received from' : 'Paid to'} ${party.name} by ${how.words}.`,
        ...applied.map(({ position, amount: put }) =>
          `${position.document.number}: ${formatPaise(position.outstanding.minor)} − ${formatPaise(put)} = ${formatPaise(position.outstanding.minor - put)} still due on this bill`),
        ...(leftOver > 0n
          ? [applied.length === 0
            ? `${formatPaise(leftOver)} is not put against any bill yet, so it stays on account for ${party.name}.`
            : `${formatPaise(amount)} − ${formatPaise(amount - leftOver)} = ${formatPaise(leftOver)} is more than the bills chosen, so it stays on account for ${party.name}.`]
          : []),
        `${direction === 'RECEIPT' ? `${party.name} owes` : `You owe ${party.name}`} ${formatPaise(owedBefore)} on open bills now, and ${formatPaise(owedAfter < 0n ? 0n : owedAfter)} after this.`,
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
      title: 'Advance to a supplier — check it',
      message: owedAfter <= 0n
        ? `Advance paid to ${party.name}: ${formatPaise(advance)}. You owe them nothing yet; when their bill is entered, ${formatPaise(advance)} will be taken off it.`
        : `Advance paid to ${party.name}: ${formatPaise(advance)}. It is not taken off the ${formatPaise(owedAfter)} you already owe them on open bills; when their next bill is entered, ${formatPaise(advance)} will be taken off it.`,
      amount: jsonAmount(amount),
      advance: jsonAmount(advance),
      party,
      direction: plan.direction,
      token: plan.key,
      effects: [
        `Paid to ${party.name} by ${how.words}.`,
        ...applied.map(({ position: bill, amount: put }) =>
          `${bill.document.number}: ${formatPaise(bill.outstanding.minor)} − ${formatPaise(put)} = ${formatPaise(bill.outstanding.minor - put)} still due on this bill`),
        ...(applied.length > 0 ? [`${formatPaise(amount)} − ${formatPaise(against)} = ${formatPaise(advance)} is kept as an advance.`] : []),
        ...(heldBefore > 0n ? [`Advances already with ${party.name}: ${formatPaise(heldBefore)} + ${formatPaise(advance)} = ${formatPaise(heldBefore + advance)}.`] : []),
        // Issue #274 — what the voucher will say it is against, before anything is saved.
        `Against: ${advanceAgainstWords(plan.particulars)}.`,
        ...(plan.particulars?.supplierReceiptVoucher ? [`Supplier's receipt voucher: No. ${plan.particulars.supplierReceiptVoucher.number} dated ${formatDate(plan.particulars.supplierReceiptVoucher.date)}.`] : []),
        `Narration: ${plan.narration ?? ''}`,
        `In your books it is kept under "Advances paid to suppliers", not as money you owe.`,
        'No GST is entered for this advance, and no GST credit is claimed on it. The credit comes with their bill.',
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
      ...(plan.advance > 0n ? { advanceToSupplier: true } : {}),
      ...(plan.particulars === undefined ? {} : { advanceParticulars: plan.particulars }),
      ...(plan.narration === undefined ? {} : { narration: plan.narration }),
    });
    // The same request twice is one payment. The same key for a different payment is a mistake, not a retry.
    if (payment.partyId !== party.id || payment.amount.minor !== amount || payment.direction !== direction) {
      throw conflict('PAYMENT_KEY_REUSED', 'This entry was already used for a different payment. Nothing new was recorded; start a fresh entry.');
    }
    return this.paymentRecordedJson(actor, payment, party, false);
  }

  private async paymentRecordedJson(actor: ActorContext, payment: Payment, party: { id: string; name: string }, deduplicated: boolean) {
    const direction = payment.direction;
    const earlier = deduplicated ? payment : null;
    const position = await this.payments.position(actor, party.id as PartyId, payment.date);
    const owed = sum(openBillsOf(position.documents, direction).map((d) => d.outstanding));
    const voucher = payment.voucherId === null ? null : await this.shop.ledger.getVoucher(actor, payment.voucherId);
    const advance = payment.advanceToSupplier === true ? payment.amount.minor - sum(payment.allocations.map((a) => a.amount)).minor : 0n;
    return {
      state: 'recorded',
      deduplicated,
      title: earlier !== null ? 'Already recorded once' : direction === 'RECEIPT' ? 'Money received recorded' : payment.advanceToSupplier === true ? 'Advance paid recorded' : 'Money paid recorded',
      message: earlier !== null
        ? `${formatPaise(payment.amount.minor)} ${direction === 'RECEIPT' ? 'from' : 'to'} ${party.name} was already recorded. It was not recorded twice.`
        : `${formatPaise(payment.amount.minor)} ${direction === 'RECEIPT' ? 'received from' : 'paid to'} ${party.name} is in your books${voucher === null ? '' : ` as ${voucher.number}`}.`,
      effects: [
        direction === 'RECEIPT' ? `${party.name} now owes ${formatPaise(owed.minor)} on open bills.` : `You now owe ${party.name} ${formatPaise(owed.minor)}.`,
        ...(direction === 'PAYMENT' && position.advancesPaid.minor > 0n
          ? [`Advance with ${party.name}, to be taken off their next bill: ${formatPaise(position.advancesPaid.minor)}.`]
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
    const chosenIds = [...new Set(billIdsOf(input))];
    const chosen = chosenIds.map((id) => {
      const found = open.find((d) => d.document.documentId === id);
      if (found !== undefined) return found;
      const settled = theirs.find((d) => d.document.documentId === id);
      if (settled !== undefined) throw invalid('PAYMENT_BILL_ALREADY_PAID', `${settled.document.number} is already fully paid, so nothing more can be put against it.`);
      throw invalid('PAYMENT_BILL_NOT_THEIRS', `That bill is not one of the open bills of ${party.name}, so this money cannot be put against it.`);
    }).sort((a, b) => a.document.date.localeCompare(b.document.date) || a.document.number.localeCompare(b.document.number));
    // Oldest chosen bill first, each up to what is still due on it. Nothing goes on a bill nobody chose.
    let remaining = amount;
    const applied: { position: DocumentPosition; amount: bigint }[] = [];
    for (const position of chosen) {
      if (remaining <= 0n) break;
      const put = remaining < position.outstanding.minor ? remaining : position.outstanding.minor;
      applied.push({ position, amount: put });
      remaining -= put;
    }
    // Issue #261 — paying a supplier before their bill is allowed, but only as an advance the person
    // chose with its own click. Without that click, money no bill takes is refused, as before.
    const advanceChosen = direction === 'PAYMENT' && chosenAsAdvance(input);
    const tick = `tick “${advanceChoiceLabel(party.name)}”`;
    if (direction === 'PAYMENT' && remaining > 0n && !advanceChosen) {
      const covered = amount - remaining;
      throw invalid('PAYMENT_MORE_THAN_BILLS', chosen.length === 0
        ? open.length === 0
          ? `You have no bill from ${party.name} yet. To pay them before their bill, ${tick}. Nothing was recorded.`
          : `Choose the bill${open.length === 1 ? '' : 's'} of ${party.name} this pays. To pay them before a bill instead, ${tick}.`
        : `The bills chosen come to ${formatPaise(covered)}, but ${formatPaise(amount)} is being paid. ${formatPaise(amount)} − ${formatPaise(covered)} = ${formatPaise(remaining)} would not settle any bill. Choose more bills, pay ${formatPaise(covered)}, or ${tick} to keep ${formatPaise(remaining)} as an advance.`);
    }
    // Issue #274 — what the advance is paid against, and its narration, only when there is an advance.
    const particulars = direction === 'PAYMENT' && remaining > 0n ? advanceParticularsOf(input, date) : undefined;
    const narration = particulars === undefined ? undefined : advanceNarration({
      party: party.name, particulars, how: how.words, reference, bills: applied.map(({ position }) => position.document.number),
    });
    return {
      direction, party, amount, date, how, reference, applied, leftOver: remaining, particulars, narration,
      advance: direction === 'PAYMENT' ? remaining : 0n,
      owedBefore: sum(open.map((d) => d.outstanding)).minor,
      key,
    };
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
    const result = await this.bankFeeds.sync(this.bankContext(actor), connectionId, String(input.idempotencyKey ?? `web-bank-sync:${connectionId}:${appToday()}`));
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
      // Issue #249 — the credit side: what the return claims against the input GST in the books.
      purchaseReconciliation: workspace.purchaseReconciliation === null ? null : {
        agrees: workspace.purchaseReconciliation.agrees,
        sentence: workspace.purchaseReconciliation.sentence['en-IN'],
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
      // Issue #192 — section 16(4)'s last date, beside the bill from the day it arrives rather than
      // on the day it is too late to do anything about it.
      lastClaimDate: line.lastClaimDate,
      lastClaimDateLabel: line.lastClaimDate === null ? null : formatClaimDate(line.lastClaimDate),
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
      // Its own figure, never folded into held back: this part comes back on no month.
      timeBarred: jsonAmount(totalItcTaxOf(workspace.timeBarred).minor),
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
          kind: 'SALES_RETURN', id: invoice.id, number: invoice.number, party: this.invoicePrints.get(invoice.id)?.document.buyer.name ?? this.config.customerName,
          date: invoice.documentDate,
          // Issue #233 — what a credit note for the whole bill would still credit, charges included.
          leftToCredit: jsonAmount((invoice.pricing?.totals.invoiceValue.minor ?? 0n) - (await this.returnNotes.listForOriginal(companyId, invoice.id))
            .filter((note) => note.kind === 'SALES_RETURN').reduce((total, note) => total + note.totals.total.minor, 0n)),
          lines: await Promise.all(invoice.lines.map(async (line) => ({
            id: line.lineId, item: invoice.pricing?.lines.find((priced) => priced.lineId === line.lineId)?.itemName ?? line.note ?? line.itemId,
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
        preview.complianceStatus === 'PENDING_ADJUSTMENT' ? 'This bill has a government e-invoice number, so this note must be reported to the government too.' : 'Nothing about this note has to be reported to the government separately.',
        ...preview.warnings,
      ],
      // Issue #186 — e.g. the 30 November deadline is close. Kept apart so every language shows it.
      warnings: preview.warnings,
    };
  }

  async recordReturn(actor: ActorContext, input: Record<string, unknown>) {
    const command = this.returnInput(input);
    const result = command.kind === 'SALES_RETURN'
      ? await this.returns.postSales(actor, command.command)
      : await this.returns.postPurchase(actor, command.command);
    await this.freezeNotePrint(result.note);
    return {
      state: 'recorded', deduplicated: result.deduplicated,
      title: result.deduplicated ? 'Return already recorded once' : 'Return recorded',
      message: result.note.summary, note: { id: result.note.id, number: result.note.number, kind: result.note.kind, amount: jsonAmount(result.note.totals.total.minor) },
    };
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
    const bill = note.kind === 'SALES_RETURN' ? this.invoicePrints.get(note.originalDocument.id) : undefined;
    const original = bill !== undefined
      ? noteOriginalFromInvoice(bill.document)
      : { counterparty: await this.notePartyPrint(note), placeOfSupplyStateCode: null, placeOfSupplyStateName: null };
    this.notePrints.set(note.id, {
      document: toCreditNoteDocument(note, original, { seller: us.seller, logoDataUri: branding.logoDataUri, signatureDataUri: us.signatureDataUri }),
      snapshot: brandedSnapshot(template, 'en-IN', String(note.documentDate), branding),
    });
  }

  /** The other party when there is no frozen bill to copy it from: a supplier, or an old bill. */
  private async notePartyPrint(note: ReturnNote): Promise<RenderableParty> {
    try {
      return customerPrint(this.config.companyId, String(note.partyId));
    } catch {
      // A supplier: the name as it stands on their bill. Their address and GSTIN are printed once the
      // supplier record carries them; nothing is invented in the meantime.
      const bill = note.kind === 'PURCHASE_RETURN' ? await this.shop.bills.findById(note.companyId, note.originalDocument.id) : null;
      // The state is known only when the supplier's bill was inside our own state.
      const state = bill?.tax.intraState === true ? this.config.gstin.slice(0, 2) : '';
      return { name: bill?.supplierName ?? String(note.partyId), addressLines: [], gstin: null, stateCode: state, stateName: state === '' ? '' : STATE_NAMES[state] ?? state };
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
      state: 'recorded', title: "Supplier's credit note added",
      message: `${note.number} now carries ${note.supplierCreditNote?.number ?? ''} dated ${note.supplierCreditNote?.date ?? ''}. The purchase check will look for it in the government's record.`,
      note: { id: note.id, number: note.number, supplierCreditNote: note.supplierCreditNote ?? null },
    };
  }

  /** Issue #186 — the printed credit or debit note: on screen, on the printer, and as a PDF. */
  async notePrint(actor: ActorContext, noteId: string, options: { readonly pdf?: boolean; readonly format?: unknown; readonly locale?: unknown } = {}) {
    const note = await this.returnNotes.findById(this.companyOf(actor), noteId);
    if (note === null) throw notFound('API_NOTE_NOT_FOUND', 'No credit or debit note was found.');
    const facts = this.notePrints.get(note.id);
    if (facts === undefined) throw notFound('API_NOTE_PRINT_FACTS', 'This note was recorded before notes could be printed, so it has no stored page.');
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
      documentDate: document.documentDate,
      recipientKind: document.recipientKind,
      recipientGstin: document.recipient.gstin,
    });
  }

  private applicabilityOf(bill: { readonly documentDate: string; readonly recipientKind: EInvoiceDocument['recipientKind']; readonly recipientGstin: string | null }) {
    const exemption = eInvoiceExemptionOf(this.config.companyId);
    return {
      documentType: 'INVOICE' as const,
      documentDate: bill.documentDate,
      recipientKind: bill.recipientKind,
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
  private eInvoiceDecisionFor(bill: { readonly id: string; readonly partyId: string; readonly customerType: 'B2B' | 'B2C'; readonly documentDate: string; readonly exportKind?: ExportParticulars['kind'] | undefined }): {
    readonly needed: 'YES' | 'NO' | 'UNKNOWN';
    readonly message: string;
    readonly askTurnover: boolean;
    readonly ruleId: string;
    /** Needed, but dated too long ago for the portal to take it (#236). */
    readonly lateForPortal?: boolean;
  } {
    let gstin: string | null = null;
    try { gstin = customerView(this.config.companyId, bill.partyId).gstin; } catch { gstin = null; }
    const recipientKind = bill.exportKind ?? this.exportSales.get(bill.id)?.kind ?? (bill.customerType === 'B2B' ? 'B2B' as const : 'B2C' as const);
    const decision = decideApplicability(this.applicabilityOf({ documentDate: bill.documentDate, recipientKind, recipientGstin: gstin }));
    const NOT_NEEDED = 'This bill does not need an e-invoice number';
    if (decision.outcome === 'APPLICABLE') {
      const deadline = reportingDeadline(bill.documentDate, this.turnoverFactsOn(bill.documentDate).lastYearTurnover ?? {}, appToday());
      // Issue #236 — a bill dated too long ago for the portal is not described as being sent.
      const late = deadline.kind === 'LIMIT' && deadline.closed;
      const message = late
        ? `This bill needs a government e-invoice number, but it cannot be sent. ${deadline.message}`
        : 'This bill needs a government e-invoice number. It is sent by itself when you issue it.';
      return { needed: 'YES', message, askTurnover: false, ruleId: decision.ruleId, lateForPortal: late };
    }
    if (decision.outcome === 'NOT_APPLICABLE') {
      const exemption = eInvoiceExemptionOf(this.config.companyId);
      const message = decision.ruleId === 'EINV.RECIPIENT.B2C'
        ? `${NOT_NEEDED}: the customer has no GST number.`
        : decision.ruleId.startsWith('EINV.EXEMPT.') && exemption !== 'NONE'
          ? `${NOT_NEEDED}: Business details says your business is ${EINVOICE_EXEMPTION_WORDS[exemption]}, and the e-invoice rules leave those out whatever the turnover.`
          : decision.ruleId.startsWith('EINV.THRESHOLD.')
            ? `${NOT_NEEDED}: Business details says your turnover has never been over ₹5 crore in any year since 2017-18.`
            : `${NOT_NEEDED}. ${decision.reason}`;
      return { needed: 'NO', message, askTurnover: false, ruleId: decision.ruleId };
    }
    if (decision.ruleId === 'EINV.TURNOVER.UNKNOWN') {
      return {
        needed: 'UNKNOWN', askTurnover: true, ruleId: decision.ruleId,
        message: "We don't know yet whether you need e-invoices: Business details does not say whether your turnover has been over ₹5 crore. Answer once in Business details. This bill can still be issued now.",
      };
    }
    return { needed: 'UNKNOWN', askTurnover: false, ruleId: decision.ruleId, message: decision.reason };
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
        try { customer = customerView(this.config.companyId, invoice.partyId).name; } catch { customer = null; }
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
            ? 'This bill needs a government e-invoice number.'
            : decision.message,
          askTurnover: decision.askTurnover,
          statusText: DemoApplication.eInvoiceStatusText(status, record?.failure ?? null, decision.needed),
          canRetry: status === 'FAILED' && record?.failure?.retryable === true && decision.needed === 'YES',
          canCancel: status === 'REGISTERED' && (record?.cancellableUntil === undefined || record.cancellableUntil > now),
        };
      }),
    };
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

    const lines = consignmentLinesOf(pricing.lines);
    const document: ConsignmentDocument = {
      documentId: invoice.id,
      documentType: 'TAX_INVOICE',
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
      if (invoice.number === null) continue;
      let customer: string | null = null;
      try { customer = customerView(this.config.companyId, invoice.partyId).name; } catch { customer = null; }
      let outcome: string = 'CANNOT_DECIDE';
      try {
        const movement = await this.movementFor(actor, invoice.id, { reason: 'SUPPLY' });
        outcome = decideEwayApplicability(movement).outcome;
      } catch { /* the check itself says what is wrong once the bill is chosen */ }
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
   * Issue #228 — a supplier bill as the purchasing module (#16, #17) needs it, from what was typed.
   *
   * The supplier is a record from the supplier list, never a typed name. Every line names an item
   * from the item list with its own quantity, price and GST rate. The kind of GST — IGST, or CGST
   * and SGST — is not asked: the real validation (#16) puts the supplier's state, read from their
   * GST number, and our godown's state to the reviewed rule, and runs the real duplicate check.
   * Anything it does not clear is refused with its own words; nothing is marked "checked" here.
   */
  private async purchaseInput(actor: ActorContext, input: Record<string, unknown>): Promise<
    | { readonly approved: ApprovedPurchase; readonly supplierState: string; readonly godownState: string }
    | { readonly alreadyRecorded: PurchaseBill; readonly message: string }
  > {
    const companyId = this.companyOf(actor);
    const supplier = resolveSupplier(companyId, String(input.supplierId ?? input.supplier ?? input.party ?? ''));
    const supplierGstin = billingAddressOf(companyId, supplier.id)?.gstin;
    if (supplierGstin === undefined) {
      throw invalid('SUPPLIER_GSTIN_MISSING', `${supplier.legalName} has no GST number saved. It decides which GST is on their bill and whether you can claim it, so add it to their record first.`);
    }
    const reference = String(input.reference ?? '').trim();
    if (!reference) throw invalid('API_REFERENCE_REQUIRED', 'Enter the supplier bill number.');
    const date = isoDate(String(input.date ?? ''));
    const lines = this.purchaseLines(companyId, input);
    const typedTotal = String(input.amount ?? '').trim() === '' ? null : paise(input.amount);
    const linesTotal = lines.reduce((total, line) => total + line.taxableValuePaise + taxOn(line.taxableValuePaise, line.gstRateBasisPoints), 0n);
    const total = typedTotal ?? linesTotal;
    const godownState = gstinStateCode(this.config.gstin);
    const supplierState = gstinStateCode(supplierGstin);

    // The same supplier's bill number twice in one financial year is the same bill: a supplier
    // numbers each bill once a year. Typed again exactly, it is a retry and is recorded once; with
    // anything different, it is refused rather than posted a second time.
    const posted = (await this.shop.bills.list(companyId)).filter((bill) => bill.state === 'POSTED');
    const gstinOf = (partyId: string) => billingAddressOf(companyId, partyId)?.gstin ?? (partyId === this.config.supplierId ? this.config.supplierGstin : undefined);
    const year = financialYearOf(date);
    const sameNumber = posted.find((bill) =>
      normaliseIdentifier(gstinOf(bill.supplierPartyId) ?? '') === normaliseIdentifier(supplierGstin)
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
        supplierGstin: typed(supplierGstin),
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
        lines,
        invoiceTotalPaise: total,
        taxLiability: 'SUPPLIER',
        creditDays: 30,
        approvedBy: actor.userId,
        approvedAt: appClock.now().toISOString(),
      },
      supplierState,
      godownState,
    };
  }

  /** The reviewed GST rules, which answer IGST against CGST and SGST from the two states (#228). */
  private static readonly purchaseTaxSplit = rulesEngineTaxSplit({ registry: shippedRegistry() });

  /**
   * Issue #228 — the lines of a supplier bill, each an item from the item list with its own
   * quantity, price and GST rate. One line is the old single-item shape; many come as `lines`.
   */
  private purchaseLines(companyId: CompanyId, input: Record<string, unknown>): ApprovedPurchaseLine[] {
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
      const gstBasisPoints = typedGst === ''
        ? declared.ratePercent === null ? 0 : Math.round(declared.ratePercent * 100)
        : Number(typedGst);
      if (!Number.isInteger(gstBasisPoints) || gstBasisPoints < 0 || gstBasisPoints > 10_000) {
        throw invalid('PURCHASE_GST_RATE', `${label}: choose the GST rate printed on the supplier's bill.`);
      }
      const goods = item.kind === 'goods';
      return {
        lineNumber: index + 1,
        itemId: item.id,
        description: item.name,
        hsnSac: item.hsnSac,
        supplyKind: goods ? 'GOODS' as const : 'SERVICES' as const,
        ...(goods ? { warehouseId: 'wh-main' } : {}),
        quantity: qty,
        ratePaise: rate,
        taxableValuePaise: lineTaxableValue(qty.scaled, rate),
        gstRateBasisPoints: gstBasisPoints,
        itcEligibility: 'ELIGIBLE' as const,
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
      : [{ item: input.itemId ?? input.item, quantity: input.quantity, unit: input.unit, rate: input.rate }];
    return rows.map((row, index) => {
      const item = resolveItem(this.config.companyId, String(row.itemId ?? row.item ?? ''));
      const unit = String(row.unit ?? '').trim().toUpperCase() || item.baseUnit;
      return {
        lineId: `line-${index + 1}`,
        itemId: item.id,
        warehouseId: 'wh-main',
        quantity: quantityFromString(String(row.quantity ?? ''), unit),
        unitPrice: money(paise(row.rate)),
        priceBasis: 'EXCLUSIVE' as const,
      };
    });
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
    const delivery = deliveryDetails(this.config.companyId, customer, input);
    return {
      partyId: customer.id as PartyId,
      customerType: customer.gstRegistrationType === 'unregistered' ? 'B2C' as const : 'B2B' as const,
      supplyKind: 'GOODS' as const,
      documentDate: date,
      dueDate: isoDate(daysAfter(date, Number.isFinite(terms) ? terms : 0)),
      deliveryStateCode: delivery.placeOfSupplyStateCode,
      placeOfSupplyStateCode: delivery.placeOfSupplyStateCode,
      lines: this.saleLines(input),
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
          idempotencyKey: `web-return:${String(input.reference || `${kind}:${documentId}:whole:${input.date}`)}`,
          documentDate: isoDate(String(input.date)), reason: String(input.reason ?? ''),
          originalInvoiceId: documentId, lines: [], wholeBill: true,
          wholeBillDisposition: String(input.disposition ?? 'ACCEPTED') as 'ACCEPTED' | 'DAMAGED' | 'SCRAPPED' | 'REPLACEMENT',
        },
      };
    }
    const quantity = quantityFromString(String(input.quantity ?? ''), String(input.unit ?? 'PCS'));
    const shared = {
      idempotencyKey: `web-return:${String(input.reference || `${kind}:${documentId}:${lineId}:${input.date}`)}`,
      documentDate: isoDate(String(input.date)), reason: String(input.reason ?? ''),
      lines: [{ originalLineId: lineId, quantity, disposition: String(input.disposition ?? 'ACCEPTED') as 'ACCEPTED' | 'DAMAGED' | 'SCRAPPED' | 'REPLACEMENT', warehouseId: 'wh-main' }],
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
