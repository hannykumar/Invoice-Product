import {
  add, conflict, invalid, money, notFound, sum,
  type Clock, type IsoDate, type Money, type Quantity,
} from '@invoice/kernel';
import type { ActorContext, AuditPort, LedgerService, LedgerStore, PermissionPort } from '@invoice/ledger';
import { buildSalesReturnPosting } from './posting.ts';
import { RETURN_PERMISSIONS, type ReturnDisposition, type ReturnNote, type ReturnNoteLine, type ReturnTaxAmounts } from './model.ts';
import type { OriginalReturnLine, ReturnInventoryPort, ReturnNoteRepository, SalesReturnSourcePort } from './ports.ts';

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
}

export interface SalesReturnPreview {
  readonly originalNumber: string;
  readonly lines: readonly ReturnNoteLine[];
  readonly totals: ReturnTaxAmounts;
  readonly complianceStatus: ReturnNote['complianceStatus'];
  readonly summary: string;
}

export interface ReturnServiceDeps {
  readonly store: LedgerStore;
  readonly ledger: LedgerService;
  readonly repository: ReturnNoteRepository;
  readonly sales: SalesReturnSourcePort;
  readonly inventory: ReturnInventoryPort;
  readonly permissions: PermissionPort;
  readonly audit: AuditPort;
  readonly clock: Clock;
  readonly idFactory?: () => string;
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
});

export class ReturnService {
  readonly #store: LedgerStore;
  readonly #ledger: LedgerService;
  readonly #repo: ReturnNoteRepository;
  readonly #sales: SalesReturnSourcePort;
  readonly #inventory: ReturnInventoryPort;
  readonly #permissions: PermissionPort;
  readonly #audit: AuditPort;
  readonly #clock: Clock;
  readonly #newId: () => string;

  constructor(deps: ReturnServiceDeps) {
    this.#store = deps.store; this.#ledger = deps.ledger; this.#repo = deps.repository;
    this.#sales = deps.sales; this.#inventory = deps.inventory; this.#permissions = deps.permissions;
    this.#audit = deps.audit; this.#clock = deps.clock; this.#newId = deps.idFactory ?? (() => crypto.randomUUID());
  }

  async get(actor: ActorContext, id: string): Promise<ReturnNote | null> { return this.#repo.findById(actor.companyId, id); }

  async previewSales(actor: ActorContext, command: SalesReturnCommand): Promise<SalesReturnPreview> {
    this.#permissions.require(actor, RETURN_PERMISSIONS.create, 'make a return note');
    if (command.idempotencyKey.trim() === '') throw invalid('RETURN_IDEMPOTENCY_KEY_REQUIRED', 'Every return needs a key so a retry cannot record it twice.');
    if (command.reason.trim() === '') throw invalid('RETURN_REASON_REQUIRED', 'Please say why the goods or services are being returned.');
    if (command.lines.length === 0) throw invalid('RETURN_NO_LINES', 'Choose at least one item to return.');
    const original = await this.#sales.findSalesDocument(actor.companyId, command.originalInvoiceId);
    if (original === null) throw notFound('RETURN_ORIGINAL_NOT_FOUND', 'We could not find that issued bill in this business.');
    if (original.state !== 'FINAL') throw conflict('RETURN_ORIGINAL_NOT_FINAL', 'A cancelled bill cannot have a new return note.');

    const previous = await this.#repo.listForOriginal(actor.companyId, original.id);
    const already = new Map<string, bigint>();
    for (const note of previous) for (const line of note.lines) already.set(line.originalLineId, (already.get(line.originalLineId) ?? 0n) + line.quantity.scaled);
    const requested = new Set<string>();
    const lines: ReturnNoteLine[] = [];
    for (const input of command.lines) {
      if (requested.has(input.originalLineId)) throw invalid('RETURN_LINE_REPEATED', 'Each original line can appear only once on a return note.');
      requested.add(input.originalLineId);
      const source = original.lines.find((line) => line.lineId === input.originalLineId);
      if (source === undefined) throw invalid('RETURN_LINE_NOT_FOUND', 'One selected item is not on the original bill.');
      this.#assertQuantity(source, input.quantity, already.get(source.lineId) ?? 0n);
      const warehouseId = input.warehouseId ?? source.warehouseId;
      if (source.supplyKind === 'GOODS' && warehouseId === null) {
        throw invalid('RETURN_WAREHOUSE_REQUIRED', 'Choose the godown where the returned goods will be checked.');
      }
      if (input.disposition === 'DAMAGED' && input.warehouseId === undefined) {
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
      });
    }
    const totals = addAmounts(lines.map((line) => line.amounts));
    const summary = `${lines.length} item${lines.length === 1 ? '' : 's'} from ${original.number} will be credited for ₹${(Number(totals.total.minor) / 100).toFixed(2)}.`;
    return { originalNumber: original.number, lines, totals, complianceStatus: original.governmentRegistered ? 'PENDING_ADJUSTMENT' : 'NOT_APPLICABLE', summary };
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
      const number = `CN/${String(await uow.sequences.next(actor.companyId, `sales-return:${command.documentDate.slice(0, 4)}`)).padStart(6, '0')}`;
      const posting = await buildSalesReturnPosting(uow.accounts, actor.companyId, original.partyId, checked.totals);
      const posted = await this.#ledger.postVoucherIn(uow, actor, {
        idempotencyKey: `sales-return:ledger:${command.idempotencyKey}`,
        type: 'CREDIT_NOTE', date: command.documentDate,
        narration: `Return against ${original.number}: ${command.reason}`,
        source: { kind: 'credit_note', id, number }, lines: posting,
        ...(command.periodOverrideReason === undefined ? {} : { periodOverride: { reason: command.periodOverrideReason } }),
      });
      for (const line of checked.lines) {
        if (line.supplyKind !== 'GOODS') continue;
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
        summary: `${number} credits ₹${(Number(checked.totals.total.minor) / 100).toFixed(2)} against ${original.number}.`,
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
    return { taxableValue: adjustedTaxable, cgst, sgst, utgst, igst, cess, total: expected };
  }
}
