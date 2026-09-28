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
import { indiaDateOf } from '@invoice/kernel';
import {
  conflict,
  financialYearOf,
  forbidden,
  invalid,
  isoDate,
  notAllowed,
  notFound,
  formatINR,
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
import { formatNumber, seriesScope, validateSeries } from './numbering.ts';
import { DEFAULT_SALES_POLICY, dueDateFor, needsApproval, withinCancellationWindow, type SalesPolicy } from './policy.ts';
import { noCancellationGuard, type CancellationGuardPort, type ComplianceHookPort, type InventoryPort, type SalesRepository } from './ports.ts';

const nil = (): Money => zero('INR');

/** "50.000" reads as "50" and "12.500" as "12.5": a shopkeeper counts kilos, not decimal places. */
/** Issue #262 — what to do when the goods are short. There is no other way through. */
export const STOCK_WAY_THROUGH = {
  'en-IN': 'If the goods have arrived, enter their purchase bill first, then make this sale.',
  'hi-IN': 'Agar maal aa gaya hai, to pehle uska purchase bill darj karen, phir yeh bikri karen.',
} as const;

const plain = (amount: string): string => (amount.includes('.') ? amount.replace(/0+$/, '').replace(/\.$/, '') : amount);

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
  /** Issue #233 — what else stops an issued bill being cancelled. None by default. */
  readonly cancellationGuard?: CancellationGuardPort;
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
  readonly #guard: CancellationGuardPort;

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
    validateSeries(this.#policy.series);
    this.#newId = deps.idFactory ?? (() => crypto.randomUUID());
    this.#guard = deps.cancellationGuard ?? noCancellationGuard;
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
      ...(input.zeroRated === undefined ? {} : { zeroRated: input.zeroRated }),
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
      ...(invoice.zeroRated === undefined ? {} : { zeroRated: invoice.zeroRated }),
      source: { kind: 'sales_invoice', id: invoice.id },
    });
  }

  /**
   * Issue #229 — can this bill be filled from the godown? Asked at the review, before anything is
   * issued.
   *
   * The goods are held only for the moment of the check and let go again, so a review that is
   * never recorded locks nothing. When a line asks for more than is free to sell, the bill is
   * marked as needing attention with one plain sentence per line, and it can then not be issued.
   * A bill already issued is not checked again: pressing Record twice is not a second sale.
   */
  async checkStock(actor: ActorContext, invoiceId: string): Promise<SalesInvoice> {
    const invoice = await this.#require(actor, invoiceId);
    if (invoice.supplyKind !== 'GOODS' || invoice.pricing === null) return invoice;
    if (invoice.state !== 'DRAFT' && invoice.state !== 'NEEDS_INFO') return invoice;
    const checked = await this.#reserve(actor, invoice);
    if (checked.state === 'NEEDS_INFO' && checked !== invoice) return checked;
    await this.#inventory.release(actor, invoice.id);
    if (invoice.state === 'DRAFT') return invoice;
    // It was short before and the goods have come in since: the bill may go forward again.
    const cleared: SalesInvoice = { ...invoice, state: 'DRAFT', problems: [], version: invoice.version + 1 };
    await this.#store.transaction(actor.companyId, async () => {
      await this.#repo.update(cleared, invoice.version);
    });
    return cleared;
  }

  /**
   * Issue #256 — forgets a bill that was only ever a review: one the app refused (not enough stock,
   * no tax it could stand behind), or one a later review of the same sale replaced.
   *
   * Only a bill nobody has been given is forgotten. It has no number, so the number series is not
   * touched, and it has no entry in the books. A bill held for approval was held on purpose and is
   * refused here; it stays waiting until someone approves or rejects it. Any goods held for it are
   * let go. Returns false when there was nothing to forget.
   */
  async discardDraft(actor: ActorContext, invoiceId: string, reason: string): Promise<boolean> {
    this.#permissions.require(actor, SALES_PERMISSIONS.draft, 'discard this bill');
    const invoice = await this.#repo.findById(actor.companyId, invoiceId);
    if (invoice === null) return false;
    if (!isEditable(invoice) || invoice.number !== null || invoice.voucherId !== null) {
      throw notAllowed('SALES_NOT_DISCARDABLE', invoice.state === 'PENDING_APPROVAL'
        ? 'This bill is waiting for approval. Approve it or send it back; it is not thrown away.'
        : `${invoice.number ?? 'This bill'} has already been issued, so it stays on record.`);
    }
    await this.#inventory.release(actor, invoice.id);
    await this.#store.transaction(actor.companyId, async () => {
      await this.#repo.remove(actor.companyId, invoice.id);
    });
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at: this.#clock.now().toISOString(),
      action: 'sales.draft_discarded',
      subjectType: 'sales_invoice',
      subjectId: invoice.id,
      summary: `An unissued bill was discarded: ${reason}`,
      details: { reason, state: invoice.state },
    });
    return true;
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
      summary: `Bill of ${formatINR(next.pricing?.totals.invoiceValue ?? nil())} sent for approval.`,
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
            // Issue #262 — a sale without the goods is always stopped; the one way through is the
            // purchase bill, so the refusal says so.
            'en-IN': `You have ${plain(s.available)} ${s.unit} of ${s.itemName} in ${s.warehouseName}. This bill asks for ${plain(s.required)} ${s.unit}. ${STOCK_WAY_THROUGH['en-IN']}`,
            'hi-IN': `${s.warehouseName} mein ${s.itemName} ke ${plain(s.available)} ${s.unit} hain. Yeh bill ${plain(s.required)} ${s.unit} maangta hai. ${STOCK_WAY_THROUGH['hi-IN']}`,
          },
          stock: {
            itemId: s.itemId,
            itemName: s.itemName,
            warehouseId: invoice.lines.find((line) => line.lineId === s.lineId)?.warehouseId ?? null,
            warehouseName: s.warehouseName,
            unit: s.unit,
            available: plain(s.available),
            required: plain(s.required),
            shortBy: plain(s.shortfall),
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
        `A bill of ${formatINR(pricing.totals.invoiceValue)} needs approval before it can be issued.`,
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
        `The total changed from ${formatINR(pricing.totals.invoiceValue)} to ${formatINR(recomputed.totals.invoiceValue)} while this bill was open. Please check it again.`,
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
        // From the date, never scraped out of the printed number: the number writes the year short.
        financialYear: financialYearOf(priced.documentDate),
        voucherId: posted.voucher.id,
        finalisedBy: actor.userId,
        finalisedAt: at,
        approvedBy: priced.state === 'PENDING_APPROVAL' ? actor.userId : null,
        approvedAt: priced.state === 'PENDING_APPROVAL' ? at : null,
        version: priced.version + 1,
      };
      // Issue #229 — the goods leave the godown in this same unit of work. If they cannot (someone
      // else took them in the meantime), the bill is not issued, no number is used up and no entry
      // is posted. Issuing is keyed on the bill's lines, so a second press moves nothing twice.
      if (final.supplyKind === 'GOODS') {
        await this.#inventory.issue(actor, final.id, final.documentDate, number);
      }
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
      summary: `Bill ${outcome.final.number} issued for ${formatINR(pricing.totals.invoiceValue)}.`,
      details: {
        number: outcome.final.number ?? '',
        value: toDecimalString(pricing.totals.invoiceValue),
        voucherId: outcome.voucher.id,
        placeOfSupply: pricing.placeOfSupplyStateCode,
        split: pricing.split,
      },
    });

    // The books and the stock are already safe. The government comes after, and a failure there
    // never unmakes the bill — it shows as a retryable state (issue #46, `gov.service_unavailable`).
    const registrations = await this.#compliance.onInvoiceFinalised(outcome.final);

    return {
      invoice: outcome.final,
      voucherId: outcome.voucher.id,
      deduplicated: outcome.deduplicated,
      registrations: registrations.map((r) => ({ kind: r.kind, status: r.status, reference: r.reference })),
    };
  }

  /**
   * Issue #233 — whether this bill may be cancelled today, without changing anything.
   *
   * The screen asks this before it shows the Cancel button's review, and `cancel` asks it again
   * inside the same checks, so what the person was told and what happens cannot differ. A stop the
   * person can clear from the same screen (a live e-invoice or e-way bill still inside the
   * government's window) is skipped only when `ignoreClearable` names it, because the caller is
   * about to cancel that document with the portal first.
   */
  async checkCancel(
    actor: ActorContext,
    command: Omit<CancelCommand, 'idempotencyKey'> & { readonly ignoreClearable?: readonly ('EINVOICE' | 'EWAY_BILL')[] },
  ): Promise<SalesInvoice> {
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
    // The stops that send the person to a credit note come first: clearing an e-invoice with the
    // government is pointless if the bill could not be cancelled afterwards anyway.
    const blockers = await this.#guard.blockers(actor, invoice);
    const final = blockers.find((blocker) => blocker.clearable === null);
    if (final !== undefined) {
      throw notAllowed(final.code, final.message, { details: { documentNumber: invoice.number ?? '', route: 'CREDIT_NOTE' } });
    }
    if (!withinCancellationWindow(this.#policy, invoice.documentDate, command.today)) {
      throw notAllowed(
        'SALES_CANCEL_WINDOW_CLOSED',
        `${invoice.number} can no longer be cancelled. Make a return note instead, so both documents stay visible.`,
        { messageId: 'final.cannot_edit', details: { documentNumber: invoice.number ?? '', route: 'CREDIT_NOTE' } },
      );
    }
    const ignored = new Set(command.ignoreClearable ?? []);
    const clearable = blockers.find((blocker) => blocker.clearable !== null && !ignored.has(blocker.clearable));
    if (clearable !== undefined) {
      throw notAllowed(clearable.code, clearable.message, {
        details: { documentNumber: invoice.number ?? '', clearFirst: clearable.clearable ?? '' },
      });
    }
    return invoice;
  }

  /**
   * Cancels a bill that has been issued, following the business's configured policy.
   *
   * The bill is not deleted and not edited, and its number is never given out again. The entry is
   * reversed, the goods go back at the cost they went out at, and the bill is marked cancelled —
   * all in one unit of work, so a failure half way leaves the bill exactly as it was. Once the
   * bill's month is in an approved or filed return, or the window has closed, the correction is a
   * credit note instead (CGST s.34).
   *
   * The reversal and the goods coming back are dated on the bill's own date. A cancelled bill is
   * reported as if it never happened (GSTR-1 counts it only as a cancelled number), so the books for
   * that month must not keep its tax either, or the month's books and its return would disagree.
   */
  async cancel(actor: ActorContext, command: CancelCommand): Promise<SalesInvoice> {
    const invoice = await this.checkCancel(actor, command);
    if (invoice.state === 'CANCELLED') return invoice;

    const at = this.#clock.now().toISOString();
    const reason = command.reason.trim();
    const outcome = await this.#store.transaction(actor.companyId, async (uow) => {
      const reversal = await this.#ledger.reverseVoucherIn(uow, actor, {
        idempotencyKey: `sales:cancel:${invoice.id}`,
        voucherId: invoice.voucherId as VoucherId,
        date: invoice.documentDate,
        reason,
      });
      const cancelled: SalesInvoice = {
        ...invoice,
        state: 'CANCELLED',
        cancellationVoucherId: reversal.voucher.id,
        cancelledBy: actor.userId,
        cancelledAt: at,
        cancelReason: reason,
        version: invoice.version + 1,
      };
      await this.#repo.update(cancelled, invoice.version);
      // Issue #229 — the goods come back at the cost each movement went out at, in this same save.
      if (invoice.supplyKind === 'GOODS') {
        await this.#inventory.returnToStock(actor, invoice.id, invoice.documentDate, reason);
      }
      return { cancelled, reversal };
    });

    if (!outcome.reversal.deduplicated) await this.#ledger.recordPosted(actor, outcome.reversal.voucher, reason);
    await this.#compliance.onInvoiceCancelled(outcome.cancelled);
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: 'sales.invoice_cancelled',
      subjectType: 'sales_invoice',
      subjectId: invoice.id,
      summary: `Bill ${invoice.number} cancelled.`,
      details: { number: invoice.number ?? '', reversalVoucherId: outcome.reversal.voucher.id },
      overrideReason: reason,
    });
    return outcome.cancelled;
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

export const todayIn = (clock: Clock): IsoDate => indiaDateOf(clock.now());

export type { UserId };
