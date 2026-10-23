import {
  add, conflict, formatINR, invalid, money, notFound, sum,
  type Clock, type IsoDate, type Money, type Quantity,
} from '@invoice/kernel';
import type { ActorContext, AuditPort, LedgerService, LedgerStore, PermissionPort } from '@invoice/ledger';
import { buildPurchaseReturnPosting, buildSalesPriceCorrectionPosting, buildSalesReturnPosting } from './posting.ts';
import { checkCreditNoteDeadline } from './credit-note-deadline.ts';
import { formatDocumentNumber, documentSeriesScope } from '@invoice/sales';
import {
  CREDIT_NOTE_SERIES_KIND,
  DEBIT_NOTE_SERIES_KIND,
  DEFAULT_NOTE_SERIES,
  DEFAULT_OTHER_DOCUMENT_PREFIXES,
  validateNoteSeries,
  type NoteSeries,
} from './note-series.ts';
import { RETURN_PERMISSIONS, isChargeLine, isGoodsReturn, isPriceCorrection, type ReturnDisposition, type ReturnNote, type ReturnNoteLine, type ReturnTaxAmounts, type SupplierCreditNoteRef } from './model.ts';
import type { OriginalReturnLine, PurchaseReturnSourcePort, ReturnInventoryPort, ReturnNoteRepository, SalesReturnSourcePort } from './ports.ts';

export interface SalesReturnLineInput {
  readonly originalLineId: string;
  readonly quantity: Quantity;
  readonly disposition: ReturnDisposition;
  readonly warehouseId?: string | null;
  readonly batchId?: string | null;
  readonly serialNumbers?: readonly string[];
  readonly replacementSerialNumbers?: readonly string[];
}

export interface SalesReturnCommand {
  readonly idempotencyKey: string;
  readonly originalInvoiceId: string;
  readonly documentDate: IsoDate;
  readonly reason: string;
  readonly lines: readonly SalesReturnLineInput[];
  readonly periodOverrideReason?: string;
  /**
   * Issue #233 — credit everything still left on the bill: every item's remaining quantity and every
   * charge (freight, other charges) not yet credited. `lines` is ignored; `wholeBillDisposition`
   * says what happens to the goods, and they go back to the godown they left from.
   */
  readonly wholeBill?: boolean;
  readonly wholeBillDisposition?: ReturnDisposition;
  /** Issue #292 — where the goods of a whole-bill return go. Required when they come back damaged. */
  readonly wholeBillWarehouseId?: string;
}

export interface SalesReturnPreview {
  readonly originalNumber: string;
  readonly lines: readonly ReturnNoteLine[];
  readonly totals: ReturnTaxAmounts;
  readonly complianceStatus: ReturnNote['complianceStatus'];
  readonly summary: string;
  /** Issue #186 — e.g. the credit-note deadline is less than 30 days away. Empty when nothing to say. */
  readonly warnings: readonly string[];
}

/**
 * Issue #293 — a change of price on one line of an issued bill, with nothing coming back.
 *
 * Give the new rate per unit (`newUnitPrice`, before GST) or the amount off the line's value
 * (`amountOff`, before GST). A lower price makes a credit note (CGST Act s.34(1)), a higher one a
 * debit note (s.34(3)). The new price applies to the quantity the customer still keeps.
 */
export interface SalesPriceCorrectionCommand {
  readonly idempotencyKey: string;
  readonly originalInvoiceId: string;
  readonly originalLineId: string;
  readonly documentDate: IsoDate;
  readonly reason: string;
  /**
   * Why the price changes. `INVOICE_ERROR`: the bill carried the wrong price, so its taxable value or
   * tax was wrong (s.34(1)/(3)). `DISCOUNT_AFTER_SALE`: a discount agreed after the sale, which only
   * comes off the value under s.15(3)(b) and is refused here (see `previewPriceCorrection`).
   */
  readonly cause: 'INVOICE_ERROR' | 'DISCOUNT_AFTER_SALE';
  readonly newUnitPrice?: Money;
  readonly amountOff?: Money;
  readonly periodOverrideReason?: string;
}

export interface SalesPriceCorrectionPreview extends SalesReturnPreview {
  readonly kind: 'SALES_RETURN' | 'SALES_DEBIT_NOTE';
}

export type PurchaseReturnLineInput = SalesReturnLineInput;

export interface PurchaseReturnCommand {
  readonly idempotencyKey: string;
  readonly originalBillId: string;
  readonly documentDate: IsoDate;
  readonly reason: string;
  readonly lines: readonly PurchaseReturnLineInput[];
  readonly periodOverrideReason?: string;
  /**
   * Issue #249 — the supplier's own credit note for these goods, when it is already in hand. It is
   * usually not: the supplier sends it later, and it is added then with `recordSupplierCreditNote`.
   */
  readonly supplierCreditNote?: { readonly number: string; readonly date: IsoDate } | null;
}

/**
 * Issue #249 — a supplier's note number reduced to what two people typing it would agree on, the
 * same rule the purchase comparison uses to match it against the government's record (case,
 * punctuation and leading zeros set aside), so "SRS-CN-1" and "srs/cn/001" are one note.
 */
const normaliseNoteNumber = (value: string): string =>
  value.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/0*(\d+)/g, (_all, digits: string) => String(BigInt(digits)));

export type PurchaseReturnPreview = SalesReturnPreview;

export interface ReturnServiceDeps {
  readonly store: LedgerStore;
  readonly ledger: LedgerService;
  readonly repository: ReturnNoteRepository;
  readonly sales: SalesReturnSourcePort;
  readonly purchases?: PurchaseReturnSourcePort;
  readonly inventory: ReturnInventoryPort;
  readonly permissions: PermissionPort;
  readonly audit: AuditPort;
  readonly clock: Clock;
  readonly idFactory?: () => string;
  /** Issue #185 — the credit and debit note series. Defaults to `CN/26-27/…` and `DN/26-27/…`. */
  readonly noteSeries?: NoteSeries;
  /** The prefixes the business's invoices, challans and other papers use, so no note can share one. */
  readonly otherDocumentPrefixes?: readonly string[];
}

const divideHalfUp = (numerator: bigint, denominator: bigint): bigint => {
  if (denominator <= 0n) throw invalid('RETURN_ORIGINAL_QUANTITY_INVALID', 'The original quantity is not valid for a return.');
  return (numerator + denominator / 2n) / denominator;
};
const prorate = (amount: Money, returned: bigint, original: bigint): Money => money(divideHalfUp(amount.minor * returned, original));
const addAmounts = (parts: readonly ReturnTaxAmounts[]): ReturnTaxAmounts => ({
  taxableValue: sum(parts.map((part) => part.taxableValue)),
  cgst: sum(parts.map((part) => part.cgst)), sgst: sum(parts.map((part) => part.sgst)),
  utgst: sum(parts.map((part) => part.utgst)), igst: sum(parts.map((part) => part.igst)),
  cess: sum(parts.map((part) => part.cess)), total: sum(parts.map((part) => part.total)),
  ineligibleTax: sum(parts.map((part) => part.ineligibleTax)),
  reverseChargeTax: sum(parts.map((part) => part.reverseChargeTax)),
});

export class ReturnService {
  readonly #store: LedgerStore;
  readonly #ledger: LedgerService;
  readonly #repo: ReturnNoteRepository;
  readonly #sales: SalesReturnSourcePort;
  readonly #purchases: PurchaseReturnSourcePort | undefined;
  readonly #inventory: ReturnInventoryPort;
  readonly #permissions: PermissionPort;
  readonly #audit: AuditPort;
  readonly #clock: Clock;
  readonly #newId: () => string;
  readonly #noteSeries: NoteSeries;

  constructor(deps: ReturnServiceDeps) {
    this.#store = deps.store; this.#ledger = deps.ledger; this.#repo = deps.repository;
    this.#sales = deps.sales; this.#purchases = deps.purchases; this.#inventory = deps.inventory; this.#permissions = deps.permissions;
    this.#audit = deps.audit; this.#clock = deps.clock; this.#newId = deps.idFactory ?? (() => crypto.randomUUID());
    this.#noteSeries = deps.noteSeries ?? DEFAULT_NOTE_SERIES;
    validateNoteSeries(this.#noteSeries, deps.otherDocumentPrefixes ?? DEFAULT_OTHER_DOCUMENT_PREFIXES);
  }

  async get(actor: ActorContext, id: string): Promise<ReturnNote | null> { return this.#repo.findById(actor.companyId, id); }

  async previewSales(actor: ActorContext, command: SalesReturnCommand): Promise<SalesReturnPreview> {
    this.#permissions.require(actor, RETURN_PERMISSIONS.create, 'make a return note');
    if (command.idempotencyKey.trim() === '') throw invalid('RETURN_IDEMPOTENCY_KEY_REQUIRED', 'Every return needs a key so a retry cannot record it twice.');
    if (command.reason.trim() === '') throw invalid('RETURN_REASON_REQUIRED', 'Please say why the goods or services are being returned.');
    if (command.wholeBill !== true && command.lines.length === 0) throw invalid('RETURN_NO_LINES', 'Choose at least one item to return.');
    const original = await this.#sales.findSalesDocument(actor.companyId, command.originalInvoiceId);
    if (original === null) throw notFound('RETURN_ORIGINAL_NOT_FOUND', 'We could not find that issued bill in this business.');
    if (original.state !== 'FINAL') throw conflict('RETURN_ORIGINAL_NOT_FINAL', 'A cancelled bill cannot have a new return note.');
    // Issue #186 — section 34(2): past 30 November after the bill's financial year, a credit note
    // can no longer reduce GST, so this module refuses to post one that claims to.
    const deadline = checkCreditNoteDeadline(original.date, command.documentDate);
    if (deadline.late) throw invalid('RETURN_CREDIT_NOTE_TOO_LATE', deadline.refusal as string);

    const previous = await this.#repo.listForOriginal(actor.companyId, original.id);
    const already = new Map<string, bigint>();
    // Issue #293 — a price correction changes what was charged, not how much was sold.
    for (const note of previous.filter((candidate) => isGoodsReturn(candidate, 'SALES_RETURN'))) for (const line of note.lines) already.set(line.originalLineId, (already.get(line.originalLineId) ?? 0n) + line.quantity.scaled);
    // Issue #233 — the whole bill: what is left of every line, charges included.
    const inputs: readonly SalesReturnLineInput[] = command.wholeBill === true
      ? original.lines
        .filter((line) => line.quantity.scaled - (already.get(line.lineId) ?? 0n) > 0n)
        .map((line) => ({
          originalLineId: line.lineId,
          quantity: { ...line.quantity, scaled: line.quantity.scaled - (already.get(line.lineId) ?? 0n) },
          disposition: command.wholeBillDisposition ?? 'ACCEPTED',
          ...(command.wholeBillWarehouseId === undefined || isChargeLine(line) ? {} : { warehouseId: command.wholeBillWarehouseId }),
        }))
      : command.lines;
    if (inputs.length === 0) {
      throw conflict('RETURN_NOTHING_LEFT', `Everything on ${original.number} has already been credited, so there is nothing left for a credit note.`);
    }
    const requested = new Set<string>();
    const lines: ReturnNoteLine[] = [];
    for (const input of inputs) {
      if (requested.has(input.originalLineId)) throw invalid('RETURN_LINE_REPEATED', 'Each original line can appear only once on a return note.');
      requested.add(input.originalLineId);
      const source = original.lines.find((line) => line.lineId === input.originalLineId);
      if (source === undefined) throw invalid('RETURN_LINE_NOT_FOUND', 'One selected item is not on the original bill.');
      this.#assertQuantity(source, input.quantity, already.get(source.lineId) ?? 0n);
      // A charge is money, not goods: nothing comes back to a godown for freight.
      const charge = isChargeLine(source);
      const warehouseId = charge ? null : input.warehouseId ?? source.warehouseId;
      if (source.supplyKind === 'GOODS' && !charge && warehouseId === null) {
        throw invalid('RETURN_WAREHOUSE_REQUIRED', 'Choose the godown where the returned goods will be checked.');
      }
      if (!charge && input.disposition === 'DAMAGED') {
        if (input.warehouseId === undefined || input.warehouseId === null) {
          throw invalid('RETURN_DAMAGED_WAREHOUSE_REQUIRED', 'Choose the damaged or quarantine godown for these goods.');
        }
        // Issue #292 — damaged goods must not become stock that can be sold. CGST Rule 56(1) keeps
        // goods "lost, stolen, destroyed, written off" as their own entries in the stock account,
        // and AS 2 / Ind AS 2 (and ICDS II) value damaged stock separately, at the lower of cost
        // and net realisable value. So a damaged return goes only to a location the business has
        // marked not for sale; an ordinary godown, or one we cannot identify, is refused.
        if (this.#inventory.sellableLocation !== undefined && await this.#inventory.sellableLocation(actor, input.warehouseId) !== false) {
          throw invalid('RETURN_DAMAGED_INTO_SELLABLE_STOCK', 'Damaged goods cannot go back into stock that can be sold. Put them in the damaged / not for sale location.');
        }
      }
      if (input.disposition === 'REPLACEMENT' && (input.replacementSerialNumbers?.length ?? 0) > 0 &&
          (input.replacementSerialNumbers?.length ?? 0) !== (input.serialNumbers?.length ?? 0)) {
        throw invalid('RETURN_REPLACEMENT_SERIALS_MISMATCH', 'The returned and replacement serial-number counts must match.');
      }
      const amounts = this.#amountsAtCurrentPrice(source, input.quantity.scaled, previous);
      lines.push({
        originalLineId: source.lineId, itemId: source.itemId, description: source.description,
        supplyKind: source.supplyKind, quantity: input.quantity, disposition: input.disposition,
        warehouseId, batchId: input.batchId ?? null, serialNumbers: input.serialNumbers ?? [],
        replacementSerialNumbers: input.replacementSerialNumbers ?? [], amounts,
        hsnOrSac: source.hsnOrSac ?? null, ratePercentTimes100: source.ratePercentTimes100 ?? null, unitPrice: source.unitPrice ?? null,
      });
    }
    const totals = addAmounts(lines.map((line) => line.amounts));
    const summary = command.wholeBill === true
      ? `The whole of ${original.number} (${lines.length} line${lines.length === 1 ? '' : 's'}, charges included) will be credited for ${formatINR(totals.total)}.`
      : `${lines.length} item${lines.length === 1 ? '' : 's'} from ${original.number} will be credited for ${formatINR(totals.total)}.`;
    return { originalNumber: original.number, lines, totals, complianceStatus: original.governmentRegistered ? 'PENDING_ADJUSTMENT' : 'NOT_APPLICABLE', summary, warnings: deadline.warning === null ? [] : [deadline.warning] };
  }

  async postSales(actor: ActorContext, command: SalesReturnCommand): Promise<{ note: ReturnNote; deduplicated: boolean }> {
    const existing = await this.#repo.findByIdempotencyKey(actor.companyId, command.idempotencyKey);
    if (existing !== null) return { note: existing, deduplicated: true };
    const preview = await this.previewSales(actor, command);
    const original = await this.#sales.findSalesDocument(actor.companyId, command.originalInvoiceId);
    if (original === null) throw notFound('RETURN_ORIGINAL_NOT_FOUND', 'We could not find that issued bill in this business.');
    const id = this.#newId();
    const at = this.#clock.now().toISOString();
    const outcome = await this.#store.transaction(actor.companyId, async (uow) => {
      // Re-check while holding the company transaction lock, so two simultaneous returns cannot
      // both claim the final eligible quantity.
      const checked = await this.previewSales(actor, command);
      // Issue #185 — one counter per financial year, allocated inside this transaction so a failed
      // posting burns no number and two returns at once cannot receive the same one.
      const series = this.#noteSeries.creditNote;
      const sequence = await uow.sequences.next(actor.companyId, documentSeriesScope(CREDIT_NOTE_SERIES_KIND, series, command.documentDate));
      const number = formatDocumentNumber(CREDIT_NOTE_SERIES_KIND, series, command.documentDate, sequence);
      const posting = await buildSalesReturnPosting(uow.accounts, actor.companyId, original.partyId, checked.totals);
      const posted = await this.#ledger.postVoucherIn(uow, actor, {
        idempotencyKey: `sales-return:ledger:${command.idempotencyKey}`,
        type: 'CREDIT_NOTE', date: command.documentDate,
        narration: `Return against ${original.number}: ${command.reason}`,
        source: { kind: 'credit_note', id, number }, lines: posting,
        ...(command.periodOverrideReason === undefined ? {} : { periodOverride: { reason: command.periodOverrideReason } }),
      });
      for (const line of checked.lines) {
        if (line.supplyKind !== 'GOODS' || isChargeLine(line)) continue;
        await this.#inventory.applySalesReturnIn(actor, {
          noteId: id, noteNumber: number, originalDocumentId: original.id,
          originalLineId: line.originalLineId, itemId: line.itemId,
          warehouseId: line.warehouseId as string, batchId: line.batchId,
          serialNumbers: line.serialNumbers, replacementSerialNumbers: line.replacementSerialNumbers,
          quantity: line.quantity, disposition: line.disposition,
          documentDate: command.documentDate, reason: command.reason,
        });
      }
      const note: ReturnNote = {
        id, companyId: actor.companyId, kind: 'SALES_RETURN', number, documentDate: command.documentDate,
        originalDocument: { id: original.id, number: original.number, date: original.date }, partyId: original.partyId,
        reason: command.reason, lines: checked.lines, totals: checked.totals, voucherId: posted.voucher.id,
        complianceStatus: checked.complianceStatus, createdBy: actor.userId, createdAt: at,
        idempotencyKey: command.idempotencyKey,
        summary: `${number} credits ${formatINR(checked.totals.total)} against ${original.number}.`,
      };
      await this.#repo.insert(note);
      return { note, voucher: posted.voucher };
    });
    await this.#ledger.recordPosted(actor, outcome.voucher, command.periodOverrideReason);
    await this.#audit.record({
      companyId: actor.companyId, actorId: actor.userId, at, action: 'return.sales_posted',
      subjectType: 'credit_note', subjectId: outcome.note.id, summary: outcome.note.summary,
      details: { number: outcome.note.number, originalNumber: original.number, reason: command.reason, lines: String(outcome.note.lines.length), complianceStatus: outcome.note.complianceStatus },
      ...(command.periodOverrideReason === undefined ? {} : { overrideReason: command.periodOverrideReason }),
    });
    return { note: outcome.note, deduplicated: false };
  }

  /**
   * Issue #293 — what a price correction will credit or charge, checked and worked out, saving nothing.
   *
   * CGST Act 2017 s.34(1) (as substituted by the CGST (Amendment) Act 2018, in force 1 February
   * 2019): a credit note where the taxable value or tax charged on an invoice exceeds what is
   * payable; s.34(3): a debit note where it is less. Either names the invoice it corrects (CGST
   * Rule 53(1A), inserted by Notification 3/2018-Central Tax of 23 January 2018). s.34(2) (as
   * amended by Finance Act 2022, in force 1 October 2022): a credit note reduces tax only if issued
   * by 30 November after the end of the bill's financial year; a debit note has no such limit.
   * The tax on the difference is the original line's own, in the same proportion as on the bill.
   */
  async previewPriceCorrection(actor: ActorContext, command: SalesPriceCorrectionCommand): Promise<SalesPriceCorrectionPreview> {
    this.#permissions.require(actor, RETURN_PERMISSIONS.create, 'correct the price on a bill');
    if (command.idempotencyKey.trim() === '') throw invalid('RETURN_IDEMPOTENCY_KEY_REQUIRED', 'Every price correction needs a key so a retry cannot record it twice.');
    if (command.reason.trim() === '') throw invalid('PRICE_CORRECTION_REASON_REQUIRED', 'Please say why the price is being changed, for example "rate agreed was ₹95, not ₹100".');
    // A discount given after the sale is not a wrong invoice. CGST Act s.15(3)(b) (in force 1 July
    // 2017) keeps it out of the value only if it was agreed at or before the supply, is linked to
    // the invoices, and the buyer has reversed the credit; s.34(2)'s proviso refuses the cut where
    // the tax was passed on; Circular 92/11/2019-GST (7 Mar 2019) allows a commercial credit note
    // that leaves GST alone; Circular 212/6/2024-GST (26 Jun 2024) wants evidence that the buyer
    // reversed its credit. None of that is recorded here yet, so such a note is refused rather
    // than cutting GST without the conditions. (Any Finance Act 2025 change to s.15(3)(b) or to the
    // s.34(2) proviso is not verified.)
    if (command.cause === 'DISCOUNT_AFTER_SALE') {
      throw invalid('PRICE_CORRECTION_DISCOUNT_AFTER_SALE', 'A discount agreed after the sale cannot reduce GST here yet: the law asks for the agreement made before the sale and proof that the buyer gave back their GST credit. Nothing was recorded. If the bill simply had the wrong price, choose "The bill had the wrong price".');
    }
    if (command.cause !== 'INVOICE_ERROR') throw invalid('PRICE_CORRECTION_CAUSE_REQUIRED', 'Say why the price changes: the bill had the wrong price, or a discount was given after the sale.');
    const byPrice = command.newUnitPrice !== undefined, byAmount = command.amountOff !== undefined;
    if (byPrice === byAmount) throw invalid('PRICE_CORRECTION_ONE_FIGURE', 'Type either the new rate per unit or the amount off, not both.');
    if (byPrice && command.newUnitPrice!.minor < 0n) throw invalid('PRICE_CORRECTION_NEGATIVE_PRICE', 'The new rate cannot be below zero.');
    if (byAmount && command.amountOff!.minor <= 0n) throw invalid('PRICE_CORRECTION_AMOUNT_NOT_POSITIVE', 'The amount off must be more than zero.');
    const original = await this.#sales.findSalesDocument(actor.companyId, command.originalInvoiceId);
    if (original === null) throw notFound('RETURN_ORIGINAL_NOT_FOUND', 'We could not find that issued bill in this business.');
    if (original.state !== 'FINAL') throw conflict('RETURN_ORIGINAL_NOT_FINAL', 'A cancelled bill cannot have its price corrected.');
    const source = original.lines.find((line) => line.lineId === command.originalLineId);
    if (source === undefined) throw invalid('RETURN_LINE_NOT_FOUND', 'The selected item is not on the original bill.');
    if (isChargeLine(source)) throw invalid('PRICE_CORRECTION_CHARGE_LINE', 'Freight and other charges cannot be re-priced here. Choose an item on the bill.');
    // A cess charged per unit does not change with the price, and this line cannot say which kind it carries.
    if (source.cess.minor !== 0n) throw invalid('PRICE_CORRECTION_CESS_LINE', 'This item carries compensation cess, which may not change with the price. Ask your accountant to make this note.');
    if (source.taxableValue.minor <= 0n) throw invalid('PRICE_CORRECTION_FREE_LINE', 'This item was billed at nothing, so there is no tax to work a new price from. Make a new bill for it instead.');
    const previous = await this.#repo.listForOriginal(actor.companyId, original.id);
    const returned = previous.filter((note) => isGoodsReturn(note, 'SALES_RETURN')).flatMap((note) => note.lines)
      .filter((line) => line.originalLineId === source.lineId).reduce((total, line) => total + line.quantity.scaled, 0n);
    const kept = source.quantity.scaled - returned;
    if (kept <= 0n) throw conflict('PRICE_CORRECTION_NOTHING_KEPT', `All of ${source.description} on ${original.number} has already come back, so there is no price left to change.`);
    const current = this.#amountsAtCurrentPrice(source, kept, previous).taxableValue.minor;
    const difference = byPrice ? divideHalfUp(command.newUnitPrice!.minor * kept, 1_000_000n) - current : -command.amountOff!.minor;
    if (difference === 0n) throw invalid('PRICE_CORRECTION_NO_CHANGE', `That is the price already charged for ${source.description}, so there is nothing to correct.`);
    if (-difference > current) {
      throw invalid('PRICE_CORRECTION_MORE_THAN_CHARGED', `${source.description} is now billed at ${formatINR(money(current))} before GST, so no more than that can come off.`);
    }
    const kind = difference < 0n ? 'SALES_RETURN' as const : 'SALES_DEBIT_NOTE' as const;
    const deadline = checkCreditNoteDeadline(original.date, command.documentDate);
    if (kind === 'SALES_RETURN' && deadline.late) throw invalid('RETURN_CREDIT_NOTE_TOO_LATE', deadline.refusal as string);
    if (command.documentDate < original.date) throw invalid('PRICE_CORRECTION_BEFORE_BILL', `The note cannot be dated before ${original.number} of ${original.date}.`);
    const size = difference < 0n ? -difference : difference;
    const share = (amount: Money): Money => money(divideHalfUp(amount.minor * size, source.taxableValue.minor));
    const cgst = share(source.cgst), sgst = share(source.sgst), utgst = share(source.utgst), igst = share(source.igst), cess = share(source.cess);
    const taxableValue = money(size);
    const amounts: ReturnTaxAmounts = {
      taxableValue, cgst, sgst, utgst, igst, cess, ineligibleTax: money(0n), reverseChargeTax: money(0n),
      total: sum([taxableValue, cgst, sgst, utgst, igst, cess]),
    };
    const line: ReturnNoteLine = {
      originalLineId: source.lineId, itemId: source.itemId, description: source.description, supplyKind: source.supplyKind,
      quantity: { ...source.quantity, scaled: kept }, disposition: 'ACCEPTED', warehouseId: null, batchId: null,
      serialNumbers: [], replacementSerialNumbers: [], amounts,
      hsnOrSac: source.hsnOrSac ?? null, ratePercentTimes100: source.ratePercentTimes100 ?? null,
      // The printed note's rate is the difference per unit: quantity × rate is the value it changes.
      unitPrice: money(divideHalfUp(size * 1_000_000n, kept)),
    };
    const summary = kind === 'SALES_RETURN'
      ? `The price of ${source.description} on ${original.number} comes down by ${formatINR(taxableValue)} before GST. A credit note for ${formatINR(amounts.total)} reduces what the customer owes. No goods come back.`
      : `The price of ${source.description} on ${original.number} goes up by ${formatINR(taxableValue)} before GST. A debit note for ${formatINR(amounts.total)} adds to what the customer owes. No goods move.`;
    return {
      kind, originalNumber: original.number, lines: [line], totals: amounts,
      complianceStatus: original.governmentRegistered ? 'PENDING_ADJUSTMENT' : 'NOT_APPLICABLE', summary,
      warnings: kind === 'SALES_RETURN' && deadline.warning !== null ? [deadline.warning] : [],
    };
  }

  /** Issue #293 — records a price correction: a credit or debit note, its voucher, and no stock movement. */
  async postPriceCorrection(actor: ActorContext, command: SalesPriceCorrectionCommand): Promise<{ note: ReturnNote; deduplicated: boolean }> {
    const existing = await this.#repo.findByIdempotencyKey(actor.companyId, command.idempotencyKey);
    if (existing !== null) return { note: existing, deduplicated: true };
    await this.previewPriceCorrection(actor, command);
    const original = await this.#sales.findSalesDocument(actor.companyId, command.originalInvoiceId);
    if (original === null) throw notFound('RETURN_ORIGINAL_NOT_FOUND', 'We could not find that issued bill in this business.');
    const id = this.#newId();
    const at = this.#clock.now().toISOString();
    const outcome = await this.#store.transaction(actor.companyId, async (uow) => {
      // Worked out again under the company lock, so two corrections at once see each other.
      const checked = await this.previewPriceCorrection(actor, command);
      const credit = checked.kind === 'SALES_RETURN';
      const seriesKind = credit ? CREDIT_NOTE_SERIES_KIND : DEBIT_NOTE_SERIES_KIND;
      const series = credit ? this.#noteSeries.creditNote : this.#noteSeries.debitNote;
      const sequence = await uow.sequences.next(actor.companyId, documentSeriesScope(seriesKind, series, command.documentDate));
      const number = formatDocumentNumber(seriesKind, series, command.documentDate, sequence);
      const posting = await buildSalesPriceCorrectionPosting(uow.accounts, actor.companyId, original.partyId, checked.totals, {
        direction: credit ? 'DOWN' : 'UP', supplyKind: checked.lines[0]?.supplyKind ?? 'GOODS',
      });
      const posted = await this.#ledger.postVoucherIn(uow, actor, {
        idempotencyKey: `sales-price-correction:ledger:${command.idempotencyKey}`,
        type: credit ? 'CREDIT_NOTE' : 'DEBIT_NOTE', date: command.documentDate,
        narration: `Price ${credit ? 'reduced' : 'raised'} on ${original.number}: ${command.reason}`,
        source: { kind: credit ? 'credit_note' : 'debit_note', id, number }, lines: posting,
        ...(command.periodOverrideReason === undefined ? {} : { periodOverride: { reason: command.periodOverrideReason } }),
      });
      const note: ReturnNote = {
        id, companyId: actor.companyId, kind: checked.kind, number, documentDate: command.documentDate,
        originalDocument: { id: original.id, number: original.number, date: original.date }, partyId: original.partyId,
        reason: command.reason, lines: checked.lines, totals: checked.totals, voucherId: posted.voucher.id,
        complianceStatus: checked.complianceStatus, createdBy: actor.userId, createdAt: at,
        idempotencyKey: command.idempotencyKey, priceCorrection: true,
        summary: credit
          ? `${number} credits ${formatINR(checked.totals.total)} against ${original.number} for a lower price. No goods came back.`
          : `${number} charges ${formatINR(checked.totals.total)} more against ${original.number} for a higher price.`,
      };
      await this.#repo.insert(note);
      return { note, voucher: posted.voucher };
    });
    await this.#ledger.recordPosted(actor, outcome.voucher, command.periodOverrideReason);
    await this.#audit.record({
      companyId: actor.companyId, actorId: actor.userId, at, action: 'return.sales_price_corrected',
      subjectType: outcome.note.kind === 'SALES_RETURN' ? 'credit_note' : 'debit_note', subjectId: outcome.note.id, summary: outcome.note.summary,
      details: {
        number: outcome.note.number, originalNumber: original.number, reason: command.reason, line: command.originalLineId,
        difference: toTaxable(outcome.note), complianceStatus: outcome.note.complianceStatus,
      },
      ...(command.periodOverrideReason === undefined ? {} : { overrideReason: command.periodOverrideReason }),
    });
    return { note: outcome.note, deduplicated: false };
  }

  async previewPurchase(actor: ActorContext, command: PurchaseReturnCommand): Promise<PurchaseReturnPreview> {
    this.#permissions.require(actor, RETURN_PERMISSIONS.create, 'make a supplier return note');
    if (command.idempotencyKey.trim() === '') throw invalid('RETURN_IDEMPOTENCY_KEY_REQUIRED', 'Every return needs a key so a retry cannot record it twice.');
    if (command.reason.trim() === '') throw invalid('RETURN_REASON_REQUIRED', 'Please say why the goods or services are being returned.');
    if (command.lines.length === 0) throw invalid('RETURN_NO_LINES', 'Choose at least one item to return.');
    if (this.#purchases === undefined) throw invalid('PURCHASE_RETURN_UNAVAILABLE', 'Purchase returns are not connected in this workspace.');
    const original = await this.#purchases.findPurchaseDocument(actor.companyId, command.originalBillId);
    if (original === null) throw notFound('RETURN_ORIGINAL_NOT_FOUND', 'We could not find that supplier bill in this business.');
    if (original.state !== 'FINAL') throw conflict('RETURN_ORIGINAL_NOT_FINAL', 'A reversed supplier bill cannot have a new return note.');
    if (command.supplierCreditNote !== undefined && command.supplierCreditNote !== null) {
      await this.#checkSupplierCreditNote(actor, original.partyId, original.date, command.supplierCreditNote, null);
    }
    if (original.reverseCharge && original.lines.some((line) => line.ineligibleTax.minor !== 0n)) {
      throw invalid('RETURN_RCM_INELIGIBLE_REVIEW_REQUIRED', 'This reverse-charge bill includes GST that was added to cost. Put this return in the exception queue for a tax review.');
    }
    const previous = await this.#repo.listForOriginal(actor.companyId, original.id);
    const already = new Map<string, bigint>();
    for (const note of previous.filter((candidate) => candidate.kind === 'PURCHASE_RETURN')) for (const line of note.lines) already.set(line.originalLineId, (already.get(line.originalLineId) ?? 0n) + line.quantity.scaled);
    const requested = new Set<string>();
    const lines: ReturnNoteLine[] = [];
    for (const input of command.lines) {
      if (requested.has(input.originalLineId)) throw invalid('RETURN_LINE_REPEATED', 'Each original line can appear only once on a return note.');
      requested.add(input.originalLineId);
      const source = original.lines.find((line) => line.lineId === input.originalLineId);
      if (source === undefined) throw invalid('RETURN_LINE_NOT_FOUND', 'One selected item is not on the original supplier bill.');
      this.#assertQuantity(source, input.quantity, already.get(source.lineId) ?? 0n);
      const warehouseId = input.warehouseId ?? source.warehouseId;
      if (source.supplyKind === 'GOODS' && warehouseId === null) throw invalid('RETURN_WAREHOUSE_REQUIRED', 'Choose the godown the goods will leave from.');
      const returned = input.quantity.scaled;
      const cgst = prorate(source.cgst, returned, source.quantity.scaled);
      const sgst = prorate(source.sgst, returned, source.quantity.scaled);
      const utgst = prorate(source.utgst, returned, source.quantity.scaled);
      const igst = prorate(source.igst, returned, source.quantity.scaled);
      const cess = prorate(source.cess, returned, source.quantity.scaled);
      const amounts: ReturnTaxAmounts = {
        taxableValue: prorate(source.taxableValue, returned, source.quantity.scaled),
        cgst, sgst, utgst, igst, cess,
        ineligibleTax: prorate(source.ineligibleTax, returned, source.quantity.scaled),
        reverseChargeTax: original.reverseCharge ? sum([cgst, sgst, utgst, igst, cess]) : money(0n),
        total: prorate(source.total, returned, source.quantity.scaled),
      };
      lines.push({
        originalLineId: source.lineId, itemId: source.itemId, description: source.description,
        supplyKind: source.supplyKind, quantity: input.quantity, disposition: input.disposition,
        warehouseId, batchId: input.batchId ?? null, serialNumbers: input.serialNumbers ?? [],
        replacementSerialNumbers: [], amounts,
        hsnOrSac: source.hsnOrSac ?? null, ratePercentTimes100: source.ratePercentTimes100 ?? null, unitPrice: source.unitPrice ?? null,
      });
    }
    const totals = addAmounts(lines.map((line) => line.amounts));
    const summary = `${lines.length} item${lines.length === 1 ? '' : 's'} from ${original.number} will reduce the supplier balance by ${formatINR(totals.total)}.`;
    return { originalNumber: original.number, lines, totals, complianceStatus: original.governmentRegistered ? 'PENDING_ADJUSTMENT' : 'NOT_APPLICABLE', summary, warnings: [] };
  }

  async postPurchase(actor: ActorContext, command: PurchaseReturnCommand): Promise<{ note: ReturnNote; deduplicated: boolean }> {
    const existing = await this.#repo.findByIdempotencyKey(actor.companyId, command.idempotencyKey);
    if (existing !== null) return { note: existing, deduplicated: true };
    await this.previewPurchase(actor, command);
    if (this.#purchases === undefined) throw invalid('PURCHASE_RETURN_UNAVAILABLE', 'Purchase returns are not connected in this workspace.');
    const original = await this.#purchases.findPurchaseDocument(actor.companyId, command.originalBillId);
    if (original === null) throw notFound('RETURN_ORIGINAL_NOT_FOUND', 'We could not find that supplier bill in this business.');
    const id = this.#newId();
    const at = this.#clock.now().toISOString();
    const outcome = await this.#store.transaction(actor.companyId, async (uow) => {
      const checked = await this.previewPurchase(actor, command);
      const series = this.#noteSeries.debitNote;
      const sequence = await uow.sequences.next(actor.companyId, documentSeriesScope(DEBIT_NOTE_SERIES_KIND, series, command.documentDate));
      const number = formatDocumentNumber(DEBIT_NOTE_SERIES_KIND, series, command.documentDate, sequence);
      const posting = await buildPurchaseReturnPosting(uow.accounts, actor.companyId, original.partyId, checked.totals);
      const posted = await this.#ledger.postVoucherIn(uow, actor, {
        idempotencyKey: `purchase-return:ledger:${command.idempotencyKey}`,
        type: 'DEBIT_NOTE', date: command.documentDate,
        narration: `Return against ${original.number}: ${command.reason}`,
        source: { kind: 'debit_note', id, number }, lines: posting,
        ...(command.periodOverrideReason === undefined ? {} : { periodOverride: { reason: command.periodOverrideReason } }),
      });
      for (const line of checked.lines) {
        if (line.supplyKind !== 'GOODS') continue;
        await this.#inventory.applyPurchaseReturnIn(actor, {
          noteId: id, noteNumber: number, originalDocumentId: original.id,
          originalLineId: line.originalLineId, itemId: line.itemId,
          warehouseId: line.warehouseId as string, batchId: line.batchId,
          serialNumbers: line.serialNumbers, replacementSerialNumbers: [], quantity: line.quantity,
          disposition: line.disposition, documentDate: command.documentDate, reason: command.reason,
        });
      }
      const note: ReturnNote = {
        id, companyId: actor.companyId, kind: 'PURCHASE_RETURN', number, documentDate: command.documentDate,
        originalDocument: { id: original.id, number: original.number, date: original.date }, partyId: original.partyId,
        reason: command.reason, lines: checked.lines, totals: checked.totals, voucherId: posted.voucher.id,
        complianceStatus: checked.complianceStatus, createdBy: actor.userId, createdAt: at,
        idempotencyKey: command.idempotencyKey,
        summary: `${number} reduces what is owed to ${original.partyName} by ${formatINR(checked.totals.total)} against ${original.number}.`,
        supplierCreditNote: command.supplierCreditNote === undefined || command.supplierCreditNote === null
          ? null
          : { number: command.supplierCreditNote.number.trim(), date: command.supplierCreditNote.date },
      };
      await this.#repo.insert(note);
      return { note, voucher: posted.voucher };
    });
    await this.#ledger.recordPosted(actor, outcome.voucher, command.periodOverrideReason);
    await this.#audit.record({
      companyId: actor.companyId, actorId: actor.userId, at, action: 'return.purchase_posted',
      subjectType: 'debit_note', subjectId: outcome.note.id, summary: outcome.note.summary,
      details: { number: outcome.note.number, originalNumber: original.number, reason: command.reason, lines: String(outcome.note.lines.length), complianceStatus: outcome.note.complianceStatus },
      ...(command.periodOverrideReason === undefined ? {} : { overrideReason: command.periodOverrideReason }),
    });
    return { note: outcome.note, deduplicated: false };
  }

  /**
   * Issue #249 — adds the supplier's credit-note number and date to a purchase return that was
   * recorded without them, or corrects a mistyped one.
   *
   * Only the reference changes. The debit note's money, its voucher and the credit it took off are
   * posted and stay exactly as they are; the number is what the purchase comparison uses to find
   * the supplier's note in the government's record.
   */
  async recordSupplierCreditNote(
    actor: ActorContext,
    input: { readonly noteId: string; readonly number: string; readonly date: IsoDate },
  ): Promise<ReturnNote> {
    this.#permissions.require(actor, RETURN_PERMISSIONS.create, "record the supplier's credit note");
    const note = await this.#repo.findById(actor.companyId, input.noteId);
    if (note === null) throw notFound('RETURN_NOTE_NOT_FOUND', 'We could not find that return in this business.');
    if (note.kind !== 'PURCHASE_RETURN') {
      throw invalid('RETURN_NOT_A_PURCHASE_RETURN', "Only goods sent back to a supplier have a supplier's credit note.");
    }
    const reference: SupplierCreditNoteRef = { number: input.number.trim(), date: input.date };
    const current = note.supplierCreditNote ?? null;
    if (current !== null && current.number === reference.number && current.date === reference.date) return note;
    await this.#checkSupplierCreditNote(actor, note.partyId, note.originalDocument.date, reference, note.id);
    // Issue #366 — the change is its own action, so it gets its own transaction.
    const updated = await this.#store.transaction(actor.companyId, () => this.#repo.setSupplierCreditNote(actor.companyId, note.id, reference));
    await this.#audit.record({
      companyId: actor.companyId, actorId: actor.userId, at: this.#clock.now().toISOString(),
      action: 'return.supplier_credit_note_recorded', subjectType: 'debit_note', subjectId: note.id,
      summary: `Supplier's credit note ${reference.number} dated ${reference.date} recorded on ${note.number}.`,
      details: {
        number: note.number, supplierCreditNote: reference.number, supplierCreditNoteDate: reference.date,
        ...(current === null ? {} : { previousNumber: current.number, previousDate: current.date }),
      },
    });
    return updated;
  }

  /**
   * The supplier's note number is how our return is found in the government's record, so it has to
   * be one the record can hold (16 characters at most), dated no earlier than the bill it corrects,
   * and not already on another of our returns from the same supplier — two returns carrying one
   * note would look like the same return twice.
   */
  async #checkSupplierCreditNote(
    actor: ActorContext,
    partyId: string,
    billDate: IsoDate,
    reference: { readonly number: string; readonly date: IsoDate },
    exceptNoteId: string | null,
  ): Promise<void> {
    const number = reference.number.trim();
    if (number === '') throw invalid('RETURN_SUPPLIER_NOTE_NUMBER_REQUIRED', "Type the number printed on the supplier's credit note.");
    if (number.length > 16) {
      throw invalid('RETURN_SUPPLIER_NOTE_NUMBER_TOO_LONG', `"${number}" has ${number.length} letters and digits. A credit-note number on the government's record has 16 at most, so check it against the supplier's paper.`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(reference.date)) || Number.isNaN(Date.parse(`${reference.date}T00:00:00Z`))) {
      throw invalid('RETURN_SUPPLIER_NOTE_DATE_INVALID', "Enter the date printed on the supplier's credit note.");
    }
    if (reference.date < billDate) {
      throw invalid('RETURN_SUPPLIER_NOTE_BEFORE_BILL', `The supplier's credit note is dated ${reference.date}, before their bill of ${billDate}. A credit note cannot come before the bill it corrects, so check the date.`);
    }
    const wanted = normaliseNoteNumber(number);
    const clash = (await this.#repo.list(actor.companyId)).find((other) =>
      other.kind === 'PURCHASE_RETURN' && other.id !== exceptNoteId && String(other.partyId) === String(partyId)
      && other.supplierCreditNote !== undefined && other.supplierCreditNote !== null
      && normaliseNoteNumber(other.supplierCreditNote.number) === wanted);
    if (clash !== undefined) {
      throw conflict('RETURN_SUPPLIER_NOTE_ALREADY_USED', `The supplier's credit note ${number} is already recorded on return ${clash.number}. Check the number on the paper; each return here carries its own note.`);
    }
  }

  #assertQuantity(source: OriginalReturnLine, quantity: Quantity, already: bigint): void {
    if (quantity.scaled <= 0n) throw invalid('RETURN_QUANTITY_NOT_POSITIVE', 'A returned quantity must be greater than zero.');
    if (quantity.unit !== source.quantity.unit) throw invalid('RETURN_UNIT_MISMATCH', `Enter the return in ${source.quantity.unit}, as on the original bill.`);
    if (already + quantity.scaled > source.quantity.scaled) {
      throw conflict('RETURN_QUANTITY_EXCEEDS_ELIGIBLE', `Only ${(Number(source.quantity.scaled - already) / 1_000_000).toString()} ${source.quantity.unit} remain eligible for return.`);
    }
  }

  /**
   * Issue #293 — what `returned` units are worth now: their share of the original line, less every
   * price-reduction credit note and plus every debit note made on that line since, each spread over
   * the units it was made for. Goods returned after a price cut are credited at the cut price.
   */
  #amountsAtCurrentPrice(source: OriginalReturnLine, returned: bigint, notes: readonly ReturnNote[]): ReturnTaxAmounts {
    const base = this.#amounts(source, returned);
    const changes = notes.filter(isPriceCorrection).flatMap((note) => note.lines
      .filter((line) => line.originalLineId === source.lineId)
      .map((line) => ({ sign: note.kind === 'SALES_DEBIT_NOTE' ? 1n : -1n, line })));
    if (changes.length === 0) return base;
    const keys = ['taxableValue', 'cgst', 'sgst', 'utgst', 'igst', 'cess', 'total'] as const;
    const adjusted = { ...base };
    for (const key of keys) {
      adjusted[key] = money(base[key].minor + changes.reduce((total, change) =>
        total + change.sign * divideHalfUp(change.line.amounts[key].minor * returned, change.line.quantity.scaled), 0n));
    }
    // Keep the note balanced: any one-paise remainder goes into the taxable value, as above.
    const taxes = adjusted.cgst.minor + adjusted.sgst.minor + adjusted.utgst.minor + adjusted.igst.minor + adjusted.cess.minor;
    return { ...adjusted, taxableValue: money(adjusted.total.minor - taxes) };
  }

  #amounts(source: OriginalReturnLine, returned: bigint): ReturnTaxAmounts {
    const of = (amount: Money): Money => prorate(amount, returned, source.quantity.scaled);
    const taxableValue = of(source.taxableValue), cgst = of(source.cgst), sgst = of(source.sgst);
    const utgst = of(source.utgst), igst = of(source.igst), cess = of(source.cess);
    const computed = sum([taxableValue, cgst, sgst, utgst, igst, cess]);
    const expected = of(source.total);
    // Put any one-paise proration remainder into taxable value, keeping the note exactly balanced.
    const adjustedTaxable = add(taxableValue, { ...expected, minor: expected.minor - computed.minor });
    return { taxableValue: adjustedTaxable, cgst, sgst, utgst, igst, cess, ineligibleTax: money(0n), reverseChargeTax: money(0n), total: expected };
  }
}

const toTaxable = (note: ReturnNote): string => note.totals.taxableValue.minor.toString();
