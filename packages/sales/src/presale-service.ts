/**
 * Issue #142 — issuing quotations and proforma invoices, turning a quotation into a sale, and
 * linking a proforma to the invoice that followed it.
 *
 * What this module deliberately does not do, and cannot, because it holds no way to:
 *
 *  - **Post anything to the books.** It has no ledger. A quotation is an offer and a proforma is a
 *    request for payment; the sale is the tax invoice, and that is what posts.
 *  - **Move or hold stock.** It has no inventory port. Goods are held and issued by the invoice.
 *  - **Report anything for GST.** It has no compliance hook. Neither paper goes into a return.
 *
 * Turning a quotation into a sale does not skip any of that: it hands the quoted lines to the sales
 * service as a **draft** invoice, and the draft then goes through every check a sale goes through —
 * credit, stock, approval, and the tax worked out again on the day of the bill.
 */
import {
  compareDates,
  conflict,
  formatDate,
  formatINR,
  formatQuantity,
  financialYearOf,
  invalid,
  notAllowed,
  notFound,
  sumQuantity,
  zero,
  type Clock,
  type IsoDate,
  type Money,
  type Quantity,
} from '@invoice/kernel';
import type { ActorContext, AuditPort, LedgerStore, PermissionPort } from '@invoice/ledger';
import type { GstCalculator } from '@invoice/gst-calc';
import type { DraftInvoiceInput, InvoicePricing, InvoiceProblem, SalesInvoice } from './model.ts';
import { todayIn, type CreateDraftCommand } from './service.ts';
import type { InvoiceLookupPort } from './challan-service.ts';
import {
  PRESALE_PERMISSIONS,
  hasLapsed,
  preSaleKind,
  type PreSaleDocument,
  type PreSaleInput,
  type PreSaleKind,
} from './presale-model.ts';
import {
  DEFAULT_PRESALE_SERIES,
  formatPreSaleNumber,
  preSaleSeriesScope,
  validatePreSaleSeries,
  type PreSaleSeries,
} from './presale-numbering.ts';
import type { PreSaleFilter, PreSaleRepository } from './presale-repository.ts';

const nil = (): Money => zero('INR');

/** Only what a conversion needs from the sales service: start a draft bill. `SalesService` is one. */
export interface SaleDraftPort {
  createDraft(actor: ActorContext, command: CreateDraftCommand): Promise<SalesInvoice>;
}

export interface PreSaleServiceDeps {
  readonly store: LedgerStore;
  readonly calculator: GstCalculator;
  readonly repository: PreSaleRepository;
  readonly invoices: InvoiceLookupPort;
  readonly sales: SaleDraftPort;
  readonly permissions: PermissionPort;
  readonly audit: AuditPort;
  readonly clock: Clock;
  readonly series?: Partial<Record<PreSaleKind, PreSaleSeries>>;
  /** Prefixes other documents already use — the invoice's, the challan's — so neither is copied. */
  readonly takenPrefixes?: readonly string[];
  readonly idFactory?: () => string;
}

type Unsaved = Omit<PreSaleDocument, 'id' | 'number' | 'financialYear' | 'createdAt' | 'idempotencyKey' | 'version'>;

/** What the document would say, before anything is saved or numbered. */
export type PreSaleWorking =
  | { readonly ok: true; readonly document: Unsaved }
  | { readonly ok: false; readonly problems: readonly InvoiceProblem[] };

export interface IssuePreSaleCommand {
  readonly kind: PreSaleKind;
  readonly idempotencyKey: string;
  readonly input: PreSaleInput;
}

export interface ConvertToSaleCommand {
  readonly quotationId: string;
  /** The date of the bill. Today, unless the person says otherwise. */
  readonly documentDate?: IsoDate;
}

export interface ConversionResult {
  readonly quotation: PreSaleDocument;
  /** A draft: no number, nothing posted, no stock moved. The sale screen takes it from here. */
  readonly invoice: SalesInvoice;
  /** Anything the person should know before issuing the bill, in plain words. */
  readonly notes: readonly string[];
}

export interface LinkProformaInvoiceCommand {
  readonly proformaId: string;
  readonly invoiceId: string;
}

export interface CancelPreSaleCommand {
  readonly id: string;
  readonly reason: string;
}

const problem = (code: string, en: string, hi: string, lineId?: string): InvoiceProblem => ({
  code,
  ...(lineId === undefined ? {} : { lineId }),
  message: { 'en-IN': en, 'hi-IN': hi },
});

const trimmed = (value: string | null | undefined): string | null => {
  const text = (value ?? '').trim();
  return text === '' ? null : text;
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export class PreSaleService {
  readonly #store: LedgerStore;
  readonly #calculator: GstCalculator;
  readonly #repo: PreSaleRepository;
  readonly #invoices: InvoiceLookupPort;
  readonly #sales: SaleDraftPort;
  readonly #permissions: PermissionPort;
  readonly #audit: AuditPort;
  readonly #clock: Clock;
  readonly #series: Readonly<Record<PreSaleKind, PreSaleSeries>>;
  readonly #newId: () => string;

  constructor(deps: PreSaleServiceDeps) {
    this.#series = {
      QUOTATION: deps.series?.QUOTATION ?? DEFAULT_PRESALE_SERIES.QUOTATION,
      PROFORMA: deps.series?.PROFORMA ?? DEFAULT_PRESALE_SERIES.PROFORMA,
    };
    const taken = deps.takenPrefixes ?? [];
    validatePreSaleSeries('QUOTATION', this.#series.QUOTATION, [...taken, this.#series.PROFORMA.prefix]);
    validatePreSaleSeries('PROFORMA', this.#series.PROFORMA, [...taken, this.#series.QUOTATION.prefix]);
    this.#store = deps.store;
    this.#calculator = deps.calculator;
    this.#repo = deps.repository;
    this.#invoices = deps.invoices;
    this.#sales = deps.sales;
    this.#permissions = deps.permissions;
    this.#audit = deps.audit;
    this.#clock = deps.clock;
    this.#newId = deps.idFactory ?? (() => crypto.randomUUID());
  }

  series(kind: PreSaleKind): PreSaleSeries {
    return this.#series[kind];
  }

  async get(actor: ActorContext, id: string): Promise<PreSaleDocument | null> {
    return this.#repo.findById(actor.companyId, id);
  }

  async list(actor: ActorContext, filter: PreSaleFilter = {}): Promise<PreSaleDocument[]> {
    return this.#repo.list(actor.companyId, filter);
  }

  /** The quotation an invoice was made from and the proforma it billed, for the invoice's reference box. */
  async forInvoice(actor: ActorContext, invoiceId: string): Promise<PreSaleDocument[]> {
    return this.#repo.list(actor.companyId, { invoiceId });
  }

  /** Works the document out without saving it or using a number. */
  async preview(actor: ActorContext, kind: PreSaleKind, input: PreSaleInput): Promise<PreSaleWorking> {
    this.#permissions.require(actor, PRESALE_PERMISSIONS[kind].issue, `check a ${preSaleKind(kind).label['en-IN'].toLowerCase()}`);
    return this.#work(actor, kind, input, 'preview');
  }

  /**
   * Issues the document: numbers it and saves it, together.
   *
   * Idempotent on the key, so a retry after a dropped connection returns the document already
   * issued rather than using a second number for the same offer.
   */
  async issue(actor: ActorContext, command: IssuePreSaleCommand): Promise<PreSaleDocument> {
    const rule = preSaleKind(command.kind);
    this.#permissions.require(actor, PRESALE_PERMISSIONS[command.kind].issue, `issue a ${rule.label['en-IN'].toLowerCase()}`);
    if (command.idempotencyKey.trim() === '') {
      throw invalid('PRESALE_IDEMPOTENCY_KEY_REQUIRED', 'Every document needs a key so a retry cannot issue a second one.');
    }
    const existing = await this.#repo.findByIdempotencyKey(actor.companyId, command.idempotencyKey);
    if (existing !== null) return existing;

    const id = this.#newId();
    const working = await this.#work(actor, command.kind, command.input, id);
    if (!working.ok) {
      throw invalid(
        'PRESALE_NOT_READY',
        `This ${rule.label['en-IN'].toLowerCase()} cannot be issued yet. ${working.problems.map((p) => p.message['en-IN']).join(' ')}`,
        { details: { problems: working.problems.map((p) => p.code).join(',') } },
      );
    }

    const at = this.#clock.now().toISOString();
    const series = this.#series[command.kind];
    const document = await this.#store.transaction(actor.companyId, async (uow) => {
      const date = command.input.documentDate;
      const sequence = await uow.sequences.next(actor.companyId, preSaleSeriesScope(command.kind, series, date));
      const issued: PreSaleDocument = {
        ...working.document,
        id,
        number: formatPreSaleNumber(command.kind, series, date, sequence),
        financialYear: financialYearOf(date),
        createdAt: at,
        idempotencyKey: command.idempotencyKey,
        version: 1,
      };
      await this.#repo.insert(issued);
      return issued;
    });

    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: `${command.kind.toLowerCase()}.issued`,
      subjectType: command.kind.toLowerCase(),
      subjectId: document.id,
      summary: `${rule.label['en-IN']} ${document.number} issued for ${formatINR(document.pricing.totals.invoiceValue)}. Nothing was posted to the books.`,
      details: {
        number: document.number,
        value: String(document.pricing.totals.invoiceValue.minor),
        validUntil: document.validUntil ?? '',
        purpose: document.purpose ?? '',
      },
    });
    return document;
  }

  /**
   * Turns an accepted quotation into a sale, without retyping it.
   *
   * The quoted lines become a **draft** invoice. The draft gets no number, posts nothing and holds
   * no stock; the sale screen checks and issues it like any other bill. Idempotent: converting the
   * same quotation twice returns the same draft rather than starting a second bill.
   *
   * A quotation whose validity has run out can still be converted — the business decides whether to
   * honour its old price — but the person is told, and told if the total has moved since.
   */
  async convertToSale(actor: ActorContext, command: ConvertToSaleCommand): Promise<ConversionResult> {
    this.#permissions.require(actor, PRESALE_PERMISSIONS.QUOTATION.issue, 'turn a quotation into a sale');
    const quotation = await this.#require(actor, command.quotationId);
    if (quotation.kind !== 'QUOTATION') {
      throw notAllowed(
        'PRESALE_NOT_A_QUOTATION',
        `${quotation.number} is a proforma invoice. Raise the tax invoice as a sale, then link it to the proforma.`,
      );
    }
    if (quotation.state === 'CANCELLED') {
      throw notAllowed('PRESALE_CANCELLED', `Quotation ${quotation.number} was withdrawn, so it cannot become a sale.`);
    }
    if (quotation.state === 'CONVERTED' && quotation.sale !== null) {
      const invoice = await this.#invoices.findById(actor.companyId, quotation.sale.invoiceId);
      if (invoice === null) throw notFound('PRESALE_SALE_NOT_FOUND', `The bill made from quotation ${quotation.number} can no longer be found.`);
      return { quotation, invoice, notes: [] };
    }

    const today = todayIn(this.#clock);
    const input: DraftInvoiceInput = {
      partyId: quotation.partyId,
      customerType: quotation.customerType,
      supplyKind: quotation.supplyKind,
      documentDate: command.documentDate ?? today,
      deliveryStateCode: quotation.deliveryStateCode,
      placeOfSupplyStateCode: quotation.placeOfSupplyStateCode,
      lines: quotation.lines,
      freight: quotation.freight,
      otherCharges: quotation.otherCharges,
      roundToWholeRupee: quotation.roundToWholeRupee,
      narration: quotation.narration ?? `Against quotation ${quotation.number}`,
    };
    // The sales service checks its own permission to start a bill, so someone who may quote but
    // may not sell cannot use a quotation to get round that.
    const invoice = await this.#sales.createDraft(actor, { idempotencyKey: `quotation:${quotation.id}`, input });

    const notes: string[] = [];
    if (hasLapsed(quotation, input.documentDate)) {
      notes.push(`Quotation ${quotation.number} was valid until ${formatDate(quotation.validUntil as IsoDate)}. Its rates were carried over as quoted; check they still stand before issuing the bill.`);
    }
    if (invoice.pricing === null) {
      notes.push(`The bill cannot be priced yet. ${invoice.problems.map((p) => p.message['en-IN']).join(' ')}`);
    } else if (invoice.pricing.totals.invoiceValue.minor !== quotation.pricing.totals.invoiceValue.minor) {
      notes.push(
        `The quotation came to ${formatINR(quotation.pricing.totals.invoiceValue)}. Worked out on the date of the bill, it comes to ${formatINR(invoice.pricing.totals.invoiceValue)}.`,
      );
    }

    const at = this.#clock.now().toISOString();
    const next: PreSaleDocument = {
      ...quotation,
      state: 'CONVERTED',
      sale: { invoiceId: invoice.id, convertedBy: actor.userId, convertedAt: at },
      version: quotation.version + 1,
    };
    await this.#store.transaction(actor.companyId, async () => this.#repo.update(next, quotation.version));
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: 'quotation.converted',
      subjectType: 'quotation',
      subjectId: quotation.id,
      summary: `Quotation ${quotation.number} turned into a draft bill. Nothing is posted until that bill is issued.`,
      details: { number: quotation.number, invoiceId: invoice.id, notes: notes.join(' | ') },
    });
    return { quotation: next, invoice, notes };
  }

  /**
   * Links the tax invoice raised after a proforma back to it, so an advance paid against the
   * proforma can be matched to the bill.
   *
   * Refused only for what would make the link wrong: another customer, a bill that is not issued,
   * or one dated before the proforma. Anything else that differs — a part dispatch, a changed rate,
   * an extra item — is normal, so it is recorded in plain words rather than refused.
   */
  async linkInvoice(actor: ActorContext, command: LinkProformaInvoiceCommand): Promise<PreSaleDocument> {
    this.#permissions.require(actor, PRESALE_PERMISSIONS.PROFORMA.issue, 'link an invoice to a proforma');
    const proforma = await this.#require(actor, command.proformaId);
    if (proforma.kind !== 'PROFORMA') {
      throw notAllowed('PRESALE_NOT_A_PROFORMA', `${proforma.number} is a quotation. Turn it into a sale instead.`);
    }
    if (proforma.state === 'INVOICED') {
      if (proforma.invoice?.invoiceId === command.invoiceId) return proforma;
      throw conflict('PRESALE_ALREADY_INVOICED', `Proforma ${proforma.number} is already billed on invoice ${proforma.invoice?.invoiceNumber}.`);
    }
    if (proforma.state === 'CANCELLED') {
      throw notAllowed('PRESALE_CANCELLED', `Proforma ${proforma.number} was withdrawn, so there is nothing to bill.`);
    }

    const invoice = await this.#invoices.findById(actor.companyId, command.invoiceId);
    if (invoice === null) throw notFound('PRESALE_INVOICE_NOT_FOUND', 'That invoice does not exist in this business.');
    if (invoice.state !== 'FINAL' || invoice.number === null || invoice.pricing === null) {
      throw notAllowed('PRESALE_INVOICE_NOT_ISSUED', 'Only an issued invoice can be linked to a proforma. Issue it first.');
    }
    if (invoice.partyId !== proforma.partyId) {
      throw notAllowed('PRESALE_INVOICE_OTHER_PARTY', `Invoice ${invoice.number} is for a different customer from proforma ${proforma.number}.`);
    }
    if (compareDates(invoice.documentDate, proforma.documentDate) < 0) {
      throw notAllowed(
        'PRESALE_INVOICE_BEFORE_PROFORMA',
        `Invoice ${invoice.number} is dated before proforma ${proforma.number}. The tax invoice is raised after the proforma, when the goods go.`,
      );
    }

    const differences = differencesBetween(proforma, invoice, invoice.pricing);
    const at = this.#clock.now().toISOString();
    const next: PreSaleDocument = {
      ...proforma,
      state: 'INVOICED',
      invoice: {
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        invoiceDate: invoice.documentDate,
        linkedBy: actor.userId,
        linkedAt: at,
        differences,
      },
      version: proforma.version + 1,
    };
    await this.#store.transaction(actor.companyId, async () => this.#repo.update(next, proforma.version));
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: 'proforma.invoice_linked',
      subjectType: 'proforma',
      subjectId: proforma.id,
      summary: `Proforma ${proforma.number} billed on invoice ${invoice.number}.${differences.length === 0 ? '' : ` ${plural(differences.length, 'difference')} noted.`}`,
      details: { number: proforma.number, invoiceNumber: invoice.number, invoiceId: invoice.id, differences: differences.join(' | ') },
    });
    return next;
  }

  /**
   * Withdraws an offer the customer did not take up. The number stays used, so the series has no
   * gap, and the document stays visible marked cancelled.
   */
  async cancel(actor: ActorContext, command: CancelPreSaleCommand): Promise<PreSaleDocument> {
    const document = await this.#require(actor, command.id);
    const label = preSaleKind(document.kind).label['en-IN'];
    this.#permissions.require(actor, PRESALE_PERMISSIONS[document.kind].cancel, `cancel a ${label.toLowerCase()}`);
    if (command.reason.trim() === '') {
      throw invalid('PRESALE_REASON_REQUIRED', `Please write why this ${label.toLowerCase()} is being cancelled.`, { messageId: 'override.reason_required' });
    }
    if (document.state === 'CANCELLED') return document;
    if (document.state === 'CONVERTED') {
      throw notAllowed('PRESALE_ALREADY_CONVERTED', `Quotation ${document.number} has already become a bill. Delete or cancel that bill instead.`);
    }
    if (document.state === 'INVOICED') {
      throw notAllowed('PRESALE_ALREADY_INVOICED', `Proforma ${document.number} has been billed on invoice ${document.invoice?.invoiceNumber}. Correct the invoice instead.`);
    }

    const at = this.#clock.now().toISOString();
    const next: PreSaleDocument = {
      ...document,
      state: 'CANCELLED',
      cancelledBy: actor.userId,
      cancelledAt: at,
      cancelReason: command.reason.trim(),
      version: document.version + 1,
    };
    await this.#store.transaction(actor.companyId, async () => this.#repo.update(next, document.version));
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: `${document.kind.toLowerCase()}.cancelled`,
      subjectType: document.kind.toLowerCase(),
      subjectId: document.id,
      summary: `${label} ${document.number} cancelled.`,
      details: { number: document.number },
      overrideReason: command.reason.trim(),
    });
    return next;
  }

  async #require(actor: ActorContext, id: string): Promise<PreSaleDocument> {
    const document = await this.#repo.findById(actor.companyId, id);
    if (document === null) throw notFound('PRESALE_NOT_FOUND', 'That quotation or proforma does not exist in this business.');
    return document;
  }

  /**
   * Works out every line and total, or lists everything stopping the document.
   *
   * The figures come from the same GST calculator the invoice uses, on the same inputs, so the tax
   * a buyer is shown on a quotation is the tax the bill will charge if nothing changes in between.
   */
  async #work(actor: ActorContext, kind: PreSaleKind, input: PreSaleInput, sourceId: string): Promise<PreSaleWorking> {
    const rule = preSaleKind(kind);
    const problems: InvoiceProblem[] = [];

    if (input.lines.length === 0) {
      problems.push(problem('PRESALE_NO_LINES', `A ${rule.label['en-IN'].toLowerCase()} needs at least one item.`, 'Kam se kam ek item chahiye.'));
    }
    for (const line of input.lines) {
      if (line.quantity.scaled <= 0n) {
        problems.push(problem('PRESALE_QUANTITY', 'Every quantity must be more than zero.', 'Har matra zero se zyada honi chahiye.', line.lineId));
      }
      if (line.unitPrice.minor < 0n) {
        problems.push(problem('PRESALE_RATE', 'A rate cannot be below zero.', 'Rate zero se kam nahin ho sakta.', line.lineId));
      }
    }
    const validUntil = input.validUntil ?? null;
    if (validUntil !== null && compareDates(validUntil, input.documentDate) < 0) {
      problems.push(
        problem(
          'PRESALE_VALIDITY_BEFORE_DATE',
          `"Valid until" is before the date of the ${rule.label['en-IN'].toLowerCase()}, so the prices would never have held.`,
          '"Kab tak valid" ki taarikh document ki taarikh se pehle hai.',
        ),
      );
    }
    const purpose = trimmed(input.purpose);
    if (rule.needsPurpose && purpose === null) {
      problems.push(
        problem(
          'PRESALE_PURPOSE_REQUIRED',
          'Say what this proforma is for, for example "advance for order of 500 boxes before dispatch". It is how the invoice raised later is matched to it.',
          'Likhein ki yeh proforma kis liye hai, jaise "500 dabbe bhejne se pehle advance". Isi se baad wala invoice iske saath joda jata hai.',
        ),
      );
    }

    const result = this.#calculator.compute({
      companyId: actor.companyId,
      documentDate: input.documentDate,
      partyId: input.partyId,
      supplyKind: input.supplyKind,
      deliveryStateCode: input.deliveryStateCode ?? null,
      placeOfSupplyStateCode: input.placeOfSupplyStateCode ?? null,
      lines: input.lines.map((l) => ({
        lineId: l.lineId,
        itemId: l.itemId,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        priceBasis: l.priceBasis,
        ...(l.discount === undefined ? {} : { discount: l.discount }),
      })),
      freight: input.freight ?? nil(),
      otherCharges: input.otherCharges ?? nil(),
      roundToWholeRupee: input.roundToWholeRupee ?? false,
      source: { kind: kind.toLowerCase(), id: sourceId },
    });
    if (result.status !== 'COMPUTED') {
      for (const r of result.reasons) {
        problems.push({
          code: r.code,
          ...(r.lineId === undefined ? {} : { lineId: r.lineId }),
          message: r.message,
          ...(r.messageId === undefined ? {} : { messageId: r.messageId }),
        });
      }
    }
    if (problems.length > 0 || result.status !== 'COMPUTED') return { ok: false, problems };

    return {
      ok: true,
      document: {
        companyId: actor.companyId,
        branchId: actor.branchId ?? ('main' as PreSaleDocument['branchId']),
        kind,
        state: 'ISSUED',
        documentDate: input.documentDate,
        validUntil,
        partyId: input.partyId,
        customerType: input.customerType,
        supplyKind: input.supplyKind,
        deliveryStateCode: trimmed(input.deliveryStateCode),
        placeOfSupplyStateCode: trimmed(input.placeOfSupplyStateCode),
        lines: input.lines,
        freight: input.freight ?? nil(),
        otherCharges: input.otherCharges ?? nil(),
        roundToWholeRupee: input.roundToWholeRupee ?? false,
        pricing: {
          placeOfSupplyStateCode: result.placeOfSupplyStateCode,
          split: result.split,
          mayChargeGst: result.mayChargeGst,
          lines: result.lines,
          totals: result.totals,
          // A quotation is not a sale, so nothing is collected at source on one (issue #145).
          tcs: null,
          explanation: result.explanation,
          decisions: result.decisions.map((d) => ({ ruleId: d.ruleId, ruleVersion: d.ruleVersion, topic: d.topic })),
        },
        declaredRateNotice: result.declaredRateNotice,
        terms: trimmed(input.terms),
        narration: trimmed(input.narration),
        // A quotation carries none of the proforma's fields, even if a form sent them.
        purpose: kind === 'PROFORMA' ? purpose : null,
        buyerOrderNumber: kind === 'PROFORMA' ? trimmed(input.buyerOrderNumber) : null,
        paymentTerms: kind === 'PROFORMA' ? trimmed(input.paymentTerms) : null,
        sale: null,
        invoice: null,
        createdBy: actor.userId,
        cancelledBy: null,
        cancelledAt: null,
        cancelReason: null,
      },
    };
  }
}

/**
 * What the invoice bills differently from what the proforma asked for, in plain words.
 *
 * Compared item by item, in the item's own unit. An item counted in different units on the two
 * papers is named rather than compared, because 10 boxes and 120 pieces cannot be set side by side.
 */
export const differencesBetween = (proforma: PreSaleDocument, invoice: SalesInvoice, invoicePricing: InvoicePricing): string[] => {
  const names = new Map<string, string>();
  for (const line of [...proforma.pricing.lines, ...invoicePricing.lines]) {
    if (line.itemId !== null && line.itemId !== undefined) names.set(line.itemId, line.itemName);
  }
  const nameOf = (itemId: string): string => names.get(itemId) ?? itemId;
  const byItem = (lines: readonly { itemId: string; quantity: Quantity }[]): Map<string, Quantity[]> => {
    const grouped = new Map<string, Quantity[]>();
    for (const line of lines) grouped.set(line.itemId, [...(grouped.get(line.itemId) ?? []), line.quantity]);
    return grouped;
  };
  const asked = byItem(proforma.lines);
  const billed = byItem(invoice.lines);
  const differences: string[] = [];

  for (const [itemId, quantities] of asked) {
    const unit = (quantities[0] as Quantity).unit;
    const onInvoice = billed.get(itemId);
    if (onInvoice === undefined) {
      differences.push(`${nameOf(itemId)} was on the proforma but is not on invoice ${invoice.number}.`);
      continue;
    }
    if ([...quantities, ...onInvoice].some((q) => q.unit !== unit)) {
      differences.push(`${nameOf(itemId)} is counted in different units on the two papers, so the quantities were not compared.`);
      continue;
    }
    const wanted = sumQuantity(quantities, unit);
    const got = sumQuantity(onInvoice, unit);
    if (wanted.scaled !== got.scaled) {
      differences.push(`${nameOf(itemId)}: the proforma asked for ${formatQuantity(wanted)}; the invoice bills ${formatQuantity(got)}.`);
    }
  }
  for (const itemId of billed.keys()) {
    if (!asked.has(itemId)) differences.push(`${nameOf(itemId)} is on invoice ${invoice.number} but was not on the proforma.`);
  }
  const proformaTotal = proforma.pricing.totals.invoiceValue;
  const invoiceTotal = invoicePricing.totals.invoiceValue;
  if (proformaTotal.minor !== invoiceTotal.minor) {
    differences.push(`The proforma came to ${formatINR(proformaTotal)}; invoice ${invoice.number} comes to ${formatINR(invoiceTotal)}.`);
  }
  return differences;
};
