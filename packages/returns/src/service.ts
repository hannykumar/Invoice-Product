import {
  add, conflict, formatINR, invalid, money, notFound, sum,
  type Clock, type IsoDate, type Money, type Quantity,
} from '@invoice/kernel';
import type { ActorContext, AuditPort, LedgerService, LedgerStore, PermissionPort } from '@invoice/ledger';
import { buildPurchaseReturnPosting, buildSalesReturnPosting } from './posting.ts';
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
import { RETURN_PERMISSIONS, isChargeLine, type ReturnDisposition, type ReturnNote, type ReturnNoteLine, type ReturnTaxAmounts, type SupplierCreditNoteRef } from './model.ts';
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
    for (const note of previous.filter((candidate) => candidate.kind === 'SALES_RETURN')) for (const line of note.lines) already.set(line.originalLineId, (already.get(line.originalLineId) ?? 0n) + line.quantity.scaled);
    // Issue #233 — the whole bill: what is left of every line, charges included.
    const inputs: readonly SalesReturnLineInput[] = command.wholeBill === true
      ? original.lines
        .filter((line) => line.quantity.scaled - (already.get(line.lineId) ?? 0n) > 0n)
        .map((line) => ({
          originalLineId: line.lineId,
          quantity: { ...line.quantity, scaled: line.quantity.scaled - (already.get(line.lineId) ?? 0n) },
          disposition: command.wholeBillDisposition ?? 'ACCEPTED',
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
      if (!charge && input.disposition === 'DAMAGED' && input.warehouseId === undefined) {
        throw invalid('RETURN_DAMAGED_WAREHOUSE_REQUIRED', 'Choose the damaged or quarantine godown for these goods.');
      }
      if (input.disposition === 'REPLACEMENT' && (input.replacementSerialNumbers?.length ?? 0) > 0 &&
          (input.replacementSerialNumbers?.length ?? 0) !== (input.serialNumbers?.length ?? 0)) {
        throw invalid('RETURN_REPLACEMENT_SERIALS_MISMATCH', 'The returned and replacement serial-number counts must match.');
      }
      const amounts = this.#amounts(source, input.quantity.scaled);
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
    const updated = await this.#repo.setSupplierCreditNote(actor.companyId, note.id, reference);
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
