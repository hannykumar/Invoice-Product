/**
 * Issue #9 [E09] — the sales invoice lifecycle.
 *
 * The shape of a sale, from the user's side, is three steps (issue #46): who and what, check, give
 * the bill. From this module's side it is: draft, price, reserve, approve if required, then one
 * atomic finalisation that allocates the number, posts the entry and issues the stock together.
 *
 * The properties that matter:
 *
 *  - **A draft never consumes a number.** Numbers are allocated at finalisation only.
 *  - **Finalisation is one unit of work.** Number, ledger entry and invoice are written together,
 *    inside the ledger's transaction, so a crash cannot leave a numbered bill with no entry.
 *  - **Totals are reproducible.** Finalisation recomputes the tax and refuses if it has moved
 *    since the person looked at it.
 *  - **A final bill is never edited.** Cancellation posts a reversal; after the window closes the
 *    correction is a credit note.
 */
import {
  conflict,
  forbidden,
  invalid,
  isoDate,
  notAllowed,
  notFound,
  toDecimalString,
  zero,
  type Clock,
  type IsoDate,
  type Money,
  type UserId,
  type VoucherId,
} from '@invoice/kernel';
import type { ActorContext, AuditPort, LedgerService, LedgerStore, PermissionPort } from '@invoice/ledger';
import { buildSalePosting } from './posting.ts';
import type { GstCalculator, ComputeResult } from '@invoice/gst-calc';
import {
  SALES_PERMISSIONS,
  isEditable,
  type CustomerType,
  type DraftInvoiceInput,
  type InvoicePricing,
  type InvoiceProblem,
  type SalesInvoice,
  type SalesInvoiceLineInput,
} from './model.ts';
import { formatNumber, seriesScope } from './numbering.ts';
import { DEFAULT_SALES_POLICY, dueDateFor, needsApproval, withinCancellationWindow, type SalesPolicy } from './policy.ts';
import type { ComplianceHookPort, InventoryPort, SalesRepository } from './ports.ts';

const nil = (): Money => zero('INR');

export interface SalesServiceDeps {
  readonly store: LedgerStore;
  readonly ledger: LedgerService;
  readonly calculator: GstCalculator;
  readonly repository: SalesRepository;
  readonly inventory: InventoryPort;
  readonly compliance: ComplianceHookPort;
  readonly permissions: PermissionPort;
  readonly audit: AuditPort;
  readonly clock: Clock;
  readonly policy?: SalesPolicy;
  readonly idFactory?: () => string;
}

export interface CreateDraftCommand {
  readonly idempotencyKey: string;
  readonly input: DraftInvoiceInput;
}

export interface FinaliseCommand {
  readonly idempotencyKey: string;
  readonly invoiceId: string;
}

export interface CancelCommand {
  readonly idempotencyKey: string;
  readonly invoiceId: string;
  readonly reason: string;
  /** Today's date, supplied so the cancellation window is testable and never reads the clock. */
  readonly today: IsoDate;
}

export interface FinaliseResult {
  readonly invoice: SalesInvoice;
  readonly voucherId: VoucherId;
  readonly deduplicated: boolean;
  readonly registrations: readonly { kind: string; status: string; reference: string | null }[];
}

export class SalesService {
  readonly #store: LedgerStore;
  readonly #ledger: LedgerService;
  readonly #calculator: GstCalculator;
  readonly #repo: SalesRepository;
  readonly #inventory: InventoryPort;
  readonly #compliance: ComplianceHookPort;
  readonly #permissions: PermissionPort;
  readonly #audit: AuditPort;
  readonly #clock: Clock;
  readonly #policy: SalesPolicy;
  readonly #newId: () => string;

  constructor(deps: SalesServiceDeps) {
    this.#store = deps.store;
    this.#ledger = deps.ledger;
    this.#calculator = deps.calculator;
    this.#repo = deps.repository;
    this.#inventory = deps.inventory;
    this.#compliance = deps.compliance;
    this.#permissions = deps.permissions;
    this.#audit = deps.audit;
    this.#clock = deps.clock;
    this.#policy = deps.policy ?? DEFAULT_SALES_POLICY;
    this.#newId = deps.idFactory ?? (() => crypto.randomUUID());
  }

  get policy(): SalesPolicy {
    return this.#policy;
  }

  async get(actor: ActorContext, id: string): Promise<SalesInvoice | null> {
    return this.#repo.findById(actor.companyId, id);
  }

  /** Starts a bill. Idempotent: the same key returns the bill it already started. */
  async createDraft(actor: ActorContext, command: CreateDraftCommand): Promise<SalesInvoice> {
    this.#permissions.require(actor, SALES_PERMISSIONS.draft, 'start a bill');
    if (command.idempotencyKey.trim().length === 0) {
      throw invalid('SALES_IDEMPOTENCY_KEY_REQUIRED', 'Every bill needs a key so a retry cannot start a second one.');
    }
    if (command.input.lines.length === 0) {
      throw invalid('SALES_NO_LINES', 'A bill needs at least one item.');
    }

    const existing = await this.#repo.findByIdempotencyKey(actor.companyId, command.idempotencyKey);
    if (existing !== null) return existing;

    const input = command.input;
    const invoice: SalesInvoice = {
      id: this.#newId(),
      companyId: actor.companyId,
      branchId: actor.branchId ?? ('main' as SalesInvoice['branchId']),
      state: 'DRAFT',
      number: null,
      financialYear: null,
      documentDate: input.documentDate,
      dueDate: input.dueDate ?? dueDateFor(this.#policy, input.documentDate),
      partyId: input.partyId,
      customerType: input.customerType,
      supplyKind: input.supplyKind,
      deliveryStateCode: input.deliveryStateCode ?? null,
      placeOfSupplyStateCode: input.placeOfSupplyStateCode ?? null,
      lines: input.lines,
      freight: input.freight ?? nil(),
      otherCharges: input.otherCharges ?? nil(),
      roundToWholeRupee: input.roundToWholeRupee ?? this.#policy.roundToWholeRupee,
      narration: input.narration ?? null,
      pricing: null,
      problems: [],
      voucherId: null,
      cancellationVoucherId: null,
      createdBy: actor.userId,
      createdAt: this.#clock.now().toISOString(),
      finalisedBy: null,
      finalisedAt: null,
      cancelledBy: null,
      cancelledAt: null,
      cancelReason: null,
      approvedBy: null,
      approvedAt: null,
      idempotencyKey: command.idempotencyKey,
      version: 1,
    };

    await this.#store.transaction(actor.companyId, async () => {
      await this.#repo.insert(invoice);
    });
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at: invoice.createdAt,
      action: 'sales.draft_created',
      subjectType: 'sales_invoice',
      subjectId: invoice.id,
      summary: `Bill started for ${input.lines.length} item${input.lines.length === 1 ? '' : 's'}.`,
      details: { lines: String(input.lines.length), documentDate: input.documentDate },
    });
    return this.#priceInternal(actor, invoice);
  }

  /** Changes an unfinished bill. Refuses if someone else changed it first. */
  async updateDraft(
    actor: ActorContext,
    invoiceId: string,
    patch: Partial<Pick<DraftInvoiceInput, 'lines' | 'freight' | 'otherCharges' | 'placeOfSupplyStateCode' | 'deliveryStateCode' | 'documentDate' | 'dueDate' | 'narration'>>,
    expectedVersion: number,
  ): Promise<SalesInvoice> {
    this.#permissions.require(actor, SALES_PERMISSIONS.draft, 'change this bill');
    const invoice = await this.#require(actor, invoiceId);
    if (!isEditable(invoice)) {
      throw notAllowed('SALES_NOT_EDITABLE', `${invoice.number ?? 'This bill'} has already been issued, so it cannot be changed.`, {
        messageId: 'final.cannot_edit',
        details: { documentNumber: invoice.number ?? '' },
      });
    }
    const next: SalesInvoice = {
      ...invoice,
      ...(patch.lines === undefined ? {} : { lines: patch.lines }),
      ...(patch.freight === undefined ? {} : { freight: patch.freight }),
      ...(patch.otherCharges === undefined ? {} : { otherCharges: patch.otherCharges }),
      ...(patch.placeOfSupplyStateCode === undefined ? {} : { placeOfSupplyStateCode: patch.placeOfSupplyStateCode }),
      ...(patch.deliveryStateCode === undefined ? {} : { deliveryStateCode: patch.deliveryStateCode }),
      ...(patch.documentDate === undefined ? {} : { documentDate: patch.documentDate }),
      ...(patch.dueDate === undefined ? {} : { dueDate: patch.dueDate }),
      ...(patch.narration === undefined ? {} : { narration: patch.narration }),
      state: 'DRAFT',
      version: invoice.version + 1,
    };
    await this.#store.transaction(actor.companyId, async () => {
      await this.#repo.update(next, expectedVersion);
    });
    return this.#priceInternal(actor, next);
  }

  /** Works out the tax and the totals, and records anything that stops the bill. */
  async price(actor: ActorContext, invoiceId: string): Promise<SalesInvoice> {
    const invoice = await this.#require(actor, invoiceId);
    return this.#priceInternal(actor, invoice);
  }

  async #priceInternal(actor: ActorContext, invoice: SalesInvoice): Promise<SalesInvoice> {
    const result = this.#compute(invoice);
    const next: SalesInvoice =
      result.status === 'COMPUTED'
        ? {
            ...invoice,
            state: invoice.state === 'NEEDS_INFO' ? 'DRAFT' : invoice.state,
            placeOfSupplyStateCode: result.placeOfSupplyStateCode,
            pricing: {
              placeOfSupplyStateCode: result.placeOfSupplyStateCode,
              split: result.split,
              mayChargeGst: result.mayChargeGst,
              lines: result.lines,
              totals: result.totals,
              explanation: result.explanation,
              decisions: result.decisions.map((d) => ({ ruleId: d.ruleId, ruleVersion: d.ruleVersion, topic: d.topic })),
            },
            problems: [],
            version: invoice.version + 1,
          }
        : {
            ...invoice,
            state: 'NEEDS_INFO',
            pricing: null,
            problems: result.reasons.map(
              (r): InvoiceProblem => ({
                code: r.code,
                ...(r.lineId === undefined ? {} : { lineId: r.lineId }),
                message: r.message,
                ...(r.messageId === undefined ? {} : { messageId: r.messageId }),
              }),
            ),
            version: invoice.version + 1,
          };
    await this.#store.transaction(actor.companyId, async () => {
      await this.#repo.update(next, invoice.version);
    });
    return next;
  }

  #compute(invoice: SalesInvoice): ComputeResult {
    return this.#calculator.compute({
      companyId: invoice.companyId,
      documentDate: invoice.documentDate,
      partyId: invoice.partyId,
      supplyKind: invoice.supplyKind,
      deliveryStateCode: invoice.deliveryStateCode,
      placeOfSupplyStateCode: invoice.placeOfSupplyStateCode,
      lines: invoice.lines.map((l: SalesInvoiceLineInput) => ({
        lineId: l.lineId,
        itemId: l.itemId,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        priceBasis: l.priceBasis,
        ...(l.discount === undefined ? {} : { discount: l.discount }),
      })),
      freight: invoice.freight,
      otherCharges: invoice.otherCharges,
      roundToWholeRupee: invoice.roundToWholeRupee,
      source: { kind: 'sales_invoice', id: invoice.id },
    });
  }

  /** Holds the stock and asks for approval when the business's policy requires one. */
  async submitForApproval(actor: ActorContext, invoiceId: string): Promise<SalesInvoice> {
    this.#permissions.require(actor, SALES_PERMISSIONS.draft, 'send this bill for approval');
    const invoice = await this.#require(actor, invoiceId);
    if (invoice.state !== 'DRAFT') {
      throw notAllowed('SALES_NOT_DRAFT', 'Only an unfinished bill can be sent for approval.');
    }
    const priced = await this.#requirePriced(invoice);
    const reserved = await this.#reserve(actor, priced);
    if (reserved.state === 'NEEDS_INFO') return reserved;

    const next: SalesInvoice = { ...reserved, state: 'PENDING_APPROVAL', version: reserved.version + 1 };
    await this.#store.transaction(actor.companyId, async () => {
      await this.#repo.update(next, reserved.version);
    });
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at: this.#clock.now().toISOString(),
      action: 'sales.submitted_for_approval',
      subjectType: 'sales_invoice',
      subjectId: invoice.id,
      summary: `Bill of ${toDecimalString(next.pricing?.totals.invoiceValue ?? nil())} sent for approval.`,
      details: { value: toDecimalString(next.pricing?.totals.invoiceValue ?? nil()) },
    });
    return next;
  }

  async #reserve(actor: ActorContext, invoice: SalesInvoice): Promise<SalesInvoice> {
    if (invoice.supplyKind === 'SERVICES') return invoice;
    const result = await this.#inventory.reserve(actor, {
      companyId: invoice.companyId,
      documentId: invoice.id,
      documentDate: invoice.documentDate,
      lines: invoice.lines.map((l) => ({
        lineId: l.lineId,
        itemId: l.itemId,
        warehouseId: l.warehouseId ?? null,
        quantity: l.quantity,
      })),
    });
    if (result.ok) return invoice;

    const next: SalesInvoice = {
      ...invoice,
      state: 'NEEDS_INFO',
      problems: result.shortfalls.map(
        (s): InvoiceProblem => ({
          code: 'STOCK_NOT_ENOUGH',
          lineId: s.lineId,
          messageId: 'stock.not_enough',
          message: {
            'en-IN': `Not enough stock. You have ${s.available} ${s.unit} of ${s.itemName} at ${s.warehouseName}. This bill needs ${s.required} ${s.unit}, so ${s.shortfall} ${s.unit} are missing.`,
            'hi-IN': `Stock kam hai. ${s.warehouseName} mein ${s.itemName} ke ${s.available} ${s.unit} hain. Is bill ke liye ${s.required} ${s.unit} chahiye, yaani ${s.shortfall} ${s.unit} kam hain.`,
          },
        }),
      ),
      version: invoice.version + 1,
    };
    await this.#store.transaction(actor.companyId, async () => {
      await this.#repo.update(next, invoice.version);
    });
    return next;
  }

  /**
   * Issues the bill.
   *
   * Everything that must happen together happens inside one transaction: the number is allocated,
   * the entry is posted and the invoice is saved. If any of it fails, none of it happened — no
   * gap in the number series, no entry without a bill, no bill without an entry.
   */
  async finalise(actor: ActorContext, command: FinaliseCommand): Promise<FinaliseResult> {
    this.#permissions.require(actor, SALES_PERMISSIONS.finalise, 'issue this bill');
    const invoice = await this.#require(actor, command.invoiceId);

    if (invoice.state === 'FINAL') {
      return {
        invoice,
        voucherId: invoice.voucherId as VoucherId,
        deduplicated: true,
        registrations: [],
      };
    }
    if (invoice.state === 'CANCELLED') {
      throw notAllowed('SALES_CANCELLED', 'This bill was cancelled and cannot be issued.');
    }
    if (invoice.state === 'NEEDS_INFO') {
      throw notAllowed(
        'SALES_NEEDS_INFO',
        `This bill cannot be issued yet. ${invoice.problems.map((p) => p.message['en-IN']).join(' ')}`,
      );
    }

    const priced = await this.#requirePriced(invoice);
    const pricing = priced.pricing as InvoicePricing;

    // Approval, if the business asked for one on bills this size.
    if (needsApproval(this.#policy, pricing.totals.invoiceValue) && priced.state !== 'PENDING_APPROVAL') {
      throw notAllowed(
        'SALES_APPROVAL_REQUIRED',
        `A bill of ${toDecimalString(pricing.totals.invoiceValue)} needs approval before it can be issued.`,
        { messageId: 'approval.needed', details: { reason: 'the amount is above the limit your business set', approverRole: 'a manager' } },
      );
    }
    if (priced.state === 'PENDING_APPROVAL') {
      this.#permissions.require(actor, SALES_PERMISSIONS.approve, 'approve this bill');
      if (priced.createdBy === actor.userId) {
        throw forbidden(
          'SALES_SELF_APPROVAL',
          'The person who made a bill cannot approve it. Ask someone else to look at it.',
        );
      }
    }

    // Hold the stock before issuing.
    //
    // A bill that needs no approval goes straight from draft to final, so nothing has held its
    // goods yet. Without this, such a bill would be issued and post no stock movement at all —
    // the books would say the goods were sold and the godown would say they were still there.
    // Re-holding is idempotent: it replaces this document's own hold rather than stacking on it.
    if (priced.supplyKind === 'GOODS') {
      const reserved = await this.#reserve(actor, priced);
      if (reserved.state === 'NEEDS_INFO') {
        throw notAllowed(
          'SALES_NEEDS_INFO',
          `This bill cannot be issued yet. ${reserved.problems.map((p) => p.message['en-IN']).join(' ')}`,
        );
      }
    }

    // Totals must still be what the person looked at. If a rate or a rule moved underneath them,
    // stop rather than issue a bill they never saw.
    const recomputed = this.#compute(priced);
    if (recomputed.status !== 'COMPUTED') {
      throw notAllowed(
        'SALES_PRICING_CHANGED',
        'Something about this bill changed while it was open, so we did not issue it. Please check it again.',
      );
    }
    if (recomputed.totals.invoiceValue.minor !== pricing.totals.invoiceValue.minor) {
      throw conflict(
        'SALES_PRICING_CHANGED',
        `The total changed from ${toDecimalString(pricing.totals.invoiceValue)} to ${toDecimalString(recomputed.totals.invoiceValue)} while this bill was open. Please check it again.`,
      );
    }

    const at = this.#clock.now().toISOString();
    const outcome = await this.#store.transaction(actor.companyId, async (uow) => {
      const sequence = await uow.sequences.next(actor.companyId, seriesScope(this.#policy.series, priced.documentDate));
      const number = formatNumber(this.#policy.series, priced.documentDate, sequence);

      const lines = await buildSalePosting(uow.accounts, actor.companyId, priced.partyId, priced.supplyKind, pricing);
      const posted = await this.#ledger.postVoucherIn(uow, actor, {
        idempotencyKey: `sales:finalise:${priced.id}`,
        type: 'SALE',
        date: priced.documentDate,
        narration: priced.narration ?? `Bill ${number}`,
        source: { kind: 'sales_invoice', id: priced.id, number },
        lines,
      });

      const final: SalesInvoice = {
        ...priced,
        state: 'FINAL',
        number,
        financialYear: number.split('/')[2] ?? null,
        voucherId: posted.voucher.id,
        finalisedBy: actor.userId,
        finalisedAt: at,
        approvedBy: priced.state === 'PENDING_APPROVAL' ? actor.userId : null,
        approvedAt: priced.state === 'PENDING_APPROVAL' ? at : null,
        version: priced.version + 1,
      };
      await this.#repo.update(final, priced.version);
      return { final, voucher: posted.voucher, deduplicated: posted.deduplicated };
    });

    await this.#ledger.recordPosted(actor, outcome.voucher);
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: 'sales.invoice_finalised',
      subjectType: 'sales_invoice',
      subjectId: outcome.final.id,
      summary: `Bill ${outcome.final.number} issued for ${toDecimalString(pricing.totals.invoiceValue)}.`,
      details: {
        number: outcome.final.number ?? '',
        value: toDecimalString(pricing.totals.invoiceValue),
        voucherId: outcome.voucher.id,
        placeOfSupply: pricing.placeOfSupplyStateCode,
        split: pricing.split,
      },
    });

    // The books are already safe. Stock and the government come after, and a failure there never
    // unmakes the bill — it shows as a retryable state (issue #46, `gov.service_unavailable`).
    if (outcome.final.supplyKind === 'GOODS') {
      await this.#inventory.issue(actor, outcome.final.id, outcome.final.documentDate, outcome.final.number);
    }
    const registrations = await this.#compliance.onInvoiceFinalised(outcome.final);

    return {
      invoice: outcome.final,
      voucherId: outcome.voucher.id,
      deduplicated: outcome.deduplicated,
      registrations: registrations.map((r) => ({ kind: r.kind, status: r.status, reference: r.reference })),
    };
  }

  /**
   * Cancels a bill that has been issued, following the business's configured policy.
   *
   * The bill is not deleted and not edited. A reversal is posted, the goods go back, and both the
   * bill and its cancellation stay visible. Once the window has closed, the correction is a credit
   * note instead (assumption A6 in the product specification).
   */
  async cancel(actor: ActorContext, command: CancelCommand): Promise<SalesInvoice> {
    this.#permissions.require(actor, SALES_PERMISSIONS.cancel, 'cancel this bill');
    if (command.reason.trim().length === 0) {
      throw invalid('SALES_REASON_REQUIRED', 'Please write why this bill is being cancelled.', {
        messageId: 'override.reason_required',
      });
    }
    const invoice = await this.#require(actor, command.invoiceId);

    if (invoice.state === 'CANCELLED') return invoice;
    if (invoice.state !== 'FINAL') {
      throw notAllowed(
        'SALES_NOT_FINAL',
        'An unfinished bill is deleted, not cancelled.',
      );
    }
    if (!withinCancellationWindow(this.#policy, invoice.documentDate, command.today)) {
      throw notAllowed(
        'SALES_CANCEL_WINDOW_CLOSED',
        `${invoice.number} can no longer be cancelled. Make a return note instead, so both documents stay visible.`,
        { messageId: 'final.cannot_edit', details: { documentNumber: invoice.number ?? '' } },
      );
    }

    const at = this.#clock.now().toISOString();
    const reversal = await this.#ledger.reverseVoucher(actor, {
      idempotencyKey: `sales:cancel:${invoice.id}`,
      voucherId: invoice.voucherId as VoucherId,
      date: command.today,
      reason: command.reason,
    });

    const cancelled: SalesInvoice = {
      ...invoice,
      state: 'CANCELLED',
      cancellationVoucherId: reversal.voucher.id,
      cancelledBy: actor.userId,
      cancelledAt: at,
      cancelReason: command.reason,
      version: invoice.version + 1,
    };
    await this.#store.transaction(actor.companyId, async () => {
      await this.#repo.update(cancelled, invoice.version);
    });

    if (invoice.supplyKind === 'GOODS') {
      await this.#inventory.returnToStock(actor, invoice.id, command.today, command.reason);
    }
    await this.#compliance.onInvoiceCancelled(cancelled);
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: 'sales.invoice_cancelled',
      subjectType: 'sales_invoice',
      subjectId: invoice.id,
      summary: `Bill ${invoice.number} cancelled.`,
      details: { number: invoice.number ?? '', reversalVoucherId: reversal.voucher.id },
      overrideReason: command.reason,
    });
    return cancelled;
  }

  async #require(actor: ActorContext, id: string): Promise<SalesInvoice> {
    const invoice = await this.#repo.findById(actor.companyId, id);
    if (invoice === null) throw notFound('SALES_INVOICE_NOT_FOUND', 'That bill does not exist in this business.');
    return invoice;
  }

  async #requirePriced(invoice: SalesInvoice): Promise<SalesInvoice> {
    if (invoice.pricing === null) {
      throw notAllowed(
        'SALES_NOT_PRICED',
        `This bill cannot go forward yet. ${invoice.problems.map((p) => p.message['en-IN']).join(' ')}`.trim(),
      );
    }
    return invoice;
  }
}

export const todayIn = (clock: Clock): IsoDate => isoDate(clock.now().toISOString().slice(0, 10));

export type { UserId };
