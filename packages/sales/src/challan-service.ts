/**
 * Issue #141 — issuing, linking and cancelling delivery challans.
 *
 * The shape, from the business's side: say who the goods are going to, why, and what is on the
 * lorry; check it; issue it. The challan is numbered at that moment, from its own series, and the
 * goods may move on it. Later the e-way bill number goes on it, and where the goods were a sale,
 * the tax invoice raised after delivery is linked back to it.
 *
 * What this module deliberately does not do:
 *
 *  - **Post anything to the books.** A challan is not a sale. The sale is the invoice that follows,
 *    and that is what posts.
 *  - **Move stock.** The invoice raised after delivery issues the goods from stock, as every sale
 *    does. Issuing them here as well would take them out twice. Goods out on job work stay the
 *    business's own stock throughout, which is also why nothing moves here.
 *  - **Guess a missing fact.** No HSN, no known destination state, no reason in words where the law
 *    needs one: the challan is refused with every problem listed at once.
 */
import {
  add,
  conflict,
  invalid,
  mulDiv,
  notAllowed,
  notFound,
  compareDates,
  financialYearOf,
  formatQuantity,
  sumQuantity,
  zero,
  type Clock,
  type Money,
  type Quantity,
} from '@invoice/kernel';
import type { ActorContext, AuditPort, LedgerStore, PermissionPort } from '@invoice/ledger';
import type { GstCalculator, MasterDataReader, TaxSplit } from '@invoice/gst-calc';
import {
  CHALLAN_PERMISSIONS,
  challanReason,
  type ChallanInput,
  type ChallanLine,
  type ChallanTotals,
  type DeliveryChallan,
} from './challan-model.ts';
import {
  DEFAULT_CHALLAN_SERIES,
  challanSeriesScope,
  formatChallanNumber,
  validateChallanSeries,
  type ChallanSeries,
} from './challan-numbering.ts';
import type { ChallanRepository } from './challan-repository.ts';
import type { InvoiceProblem, SalesInvoice } from './model.ts';

const nil = (): Money => zero('INR');
const EWAY_BILL_NUMBER = /^\d{12}$/;

/** Only what linking needs from the invoice store: find one bill. */
export interface InvoiceLookupPort {
  findById(companyId: SalesInvoice['companyId'], id: string): Promise<SalesInvoice | null>;
}

export interface ChallanServiceDeps {
  readonly store: LedgerStore;
  readonly calculator: GstCalculator;
  readonly masterData: MasterDataReader;
  readonly repository: ChallanRepository;
  readonly invoices: InvoiceLookupPort;
  readonly permissions: PermissionPort;
  readonly audit: AuditPort;
  readonly clock: Clock;
  readonly series?: ChallanSeries;
  /** The invoice series prefix, so a challan series that could be mistaken for it is refused. */
  readonly invoicePrefix?: string;
  readonly idFactory?: () => string;
}

/** What the challan would say, before anything is saved or numbered. */
export type ChallanWorking =
  | { readonly ok: true; readonly challan: Omit<DeliveryChallan, 'id' | 'number' | 'financialYear' | 'createdAt' | 'idempotencyKey' | 'version'> }
  | { readonly ok: false; readonly problems: readonly InvoiceProblem[] };

export interface IssueChallanCommand {
  readonly idempotencyKey: string;
  readonly input: ChallanInput;
}

export interface AttachEwayBillCommand {
  readonly challanId: string;
  readonly ewayBillNumber: string;
  readonly ewayBillDate?: DeliveryChallan['documentDate'] | null;
  readonly transporter?: string | null;
  readonly vehicleNumber?: string | null;
  /** `PORTAL` when the number came back from the e-way bill service, `TYPED` when a person entered it. */
  readonly source: 'PORTAL' | 'TYPED';
}

export interface LinkInvoiceCommand {
  readonly challanId: string;
  readonly invoiceId: string;
}

export interface CancelChallanCommand {
  readonly challanId: string;
  readonly reason: string;
  /** Required when an e-way bill is on the challan: the person confirms it was cancelled on the portal. */
  readonly ewayBillCancelledOnPortal?: boolean;
}

const problem = (code: string, en: string, hi: string, lineId?: string): InvoiceProblem => ({
  code,
  ...(lineId === undefined ? {} : { lineId }),
  message: { 'en-IN': en, 'hi-IN': hi },
});

const EXEMPT_TREATMENTS = new Set(['NIL_RATED', 'EXEMPT', 'NON_GST']);

export class ChallanService {
  readonly #store: LedgerStore;
  readonly #calculator: GstCalculator;
  readonly #masterData: MasterDataReader;
  readonly #repo: ChallanRepository;
  readonly #invoices: InvoiceLookupPort;
  readonly #permissions: PermissionPort;
  readonly #audit: AuditPort;
  readonly #clock: Clock;
  readonly #series: ChallanSeries;
  readonly #newId: () => string;

  constructor(deps: ChallanServiceDeps) {
    this.#series = deps.series ?? DEFAULT_CHALLAN_SERIES;
    validateChallanSeries(this.#series, deps.invoicePrefix);
    this.#store = deps.store;
    this.#calculator = deps.calculator;
    this.#masterData = deps.masterData;
    this.#repo = deps.repository;
    this.#invoices = deps.invoices;
    this.#permissions = deps.permissions;
    this.#audit = deps.audit;
    this.#clock = deps.clock;
    this.#newId = deps.idFactory ?? (() => crypto.randomUUID());
  }

  get series(): ChallanSeries {
    return this.#series;
  }

  async get(actor: ActorContext, id: string): Promise<DeliveryChallan | null> {
    return this.#repo.findById(actor.companyId, id);
  }

  async list(actor: ActorContext, filter: Parameters<ChallanRepository['list']>[1] = {}): Promise<DeliveryChallan[]> {
    return this.#repo.list(actor.companyId, filter);
  }

  /** Every challan a tax invoice was linked back to, for the invoice's "Delivery Note" box. */
  async forInvoice(actor: ActorContext, invoiceId: string): Promise<DeliveryChallan[]> {
    return this.#repo.list(actor.companyId, { invoiceId });
  }

  /** Works the challan out without saving it or using a number. */
  async preview(actor: ActorContext, input: ChallanInput): Promise<ChallanWorking> {
    this.#permissions.require(actor, CHALLAN_PERMISSIONS.issue, 'check a delivery challan');
    return this.#work(actor, input, 'preview');
  }

  /**
   * Issues the challan: numbers it and saves it, together.
   *
   * Idempotent on the key, so a retry after a dropped connection returns the challan already
   * issued rather than using a second number for the same load.
   */
  async issue(actor: ActorContext, command: IssueChallanCommand): Promise<DeliveryChallan> {
    this.#permissions.require(actor, CHALLAN_PERMISSIONS.issue, 'issue a delivery challan');
    if (command.idempotencyKey.trim() === '') {
      throw invalid('CHALLAN_IDEMPOTENCY_KEY_REQUIRED', 'Every challan needs a key so a retry cannot issue a second one.');
    }
    const existing = await this.#repo.findByIdempotencyKey(actor.companyId, command.idempotencyKey);
    if (existing !== null) return existing;

    const id = this.#newId();
    const working = await this.#work(actor, command.input, id);
    if (!working.ok) {
      throw invalid(
        'CHALLAN_NOT_READY',
        `This challan cannot be issued yet. ${working.problems.map((p) => p.message['en-IN']).join(' ')}`,
        { details: { problems: working.problems.map((p) => p.code).join(',') } },
      );
    }

    const at = this.#clock.now().toISOString();
    const challan = await this.#store.transaction(actor.companyId, async (uow) => {
      const date = command.input.documentDate;
      const sequence = await uow.sequences.next(actor.companyId, challanSeriesScope(this.#series, date));
      const issued: DeliveryChallan = {
        ...working.challan,
        id,
        number: formatChallanNumber(this.#series, date, sequence),
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
      action: 'challan.issued',
      subjectType: 'delivery_challan',
      subjectId: challan.id,
      summary: `Delivery challan ${challan.number} issued for ${challan.lines.length} item${challan.lines.length === 1 ? '' : 's'}: ${challanReason(challan.reason).label['en-IN']}.`,
      details: {
        number: challan.number,
        reason: challan.reason,
        legalBasis: challanReason(challan.reason).legalBasis,
        taxableValue: String(challan.totals.taxableValue.minor),
        showsTax: String(challan.showsTax),
      },
    });
    return challan;
  }

  /** Puts the e-way bill the goods move under on the challan, so it prints (Rule 55(3)). */
  async attachEwayBill(actor: ActorContext, command: AttachEwayBillCommand): Promise<DeliveryChallan> {
    this.#permissions.require(actor, CHALLAN_PERMISSIONS.issue, 'add an e-way bill to a challan');
    const challan = await this.#require(actor, command.challanId);
    const number = command.ewayBillNumber.replace(/\s+/g, '');
    if (!EWAY_BILL_NUMBER.test(number)) {
      throw invalid('CHALLAN_EWAY_NUMBER_INVALID', `"${command.ewayBillNumber}" is not an e-way bill number. It is twelve digits, like 3210 0123 4567.`);
    }
    if (challan.state !== 'ISSUED') {
      throw notAllowed(
        'CHALLAN_NOT_OPEN',
        challan.state === 'CANCELLED'
          ? `Challan ${challan.number} was cancelled, so no goods move on it.`
          : `Challan ${challan.number} has already been billed, so the goods have been delivered.`,
      );
    }
    if (challan.ewayBill?.number === number) return challan;

    const at = this.#clock.now().toISOString();
    const next: DeliveryChallan = {
      ...challan,
      ewayBill: {
        number,
        date: command.ewayBillDate ?? null,
        transporter: command.transporter ?? challan.ewayBill?.transporter ?? null,
        vehicleNumber: command.vehicleNumber ?? challan.ewayBill?.vehicleNumber ?? null,
        source: command.source,
        recordedBy: actor.userId,
        recordedAt: at,
      },
      version: challan.version + 1,
    };
    await this.#store.transaction(actor.companyId, async () => this.#repo.update(next, challan.version));
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: 'challan.eway_bill_recorded',
      subjectType: 'delivery_challan',
      subjectId: challan.id,
      summary: `E-way bill ${number} recorded on challan ${challan.number}${command.source === 'TYPED' ? ', typed in by a person' : ''}.`,
      details: { number: challan.number, ewayBillNumber: number, previous: challan.ewayBill?.number ?? '', source: command.source },
    });
    return next;
  }

  /**
   * Links the tax invoice raised after delivery back to the challan (Rule 55(4)).
   *
   * Several challans may point at one invoice — a week of deliveries billed on Saturday is normal.
   * The invoice must be issued, for the same customer, dated on or after the challan, and must
   * carry every item the challan carried. A shortfall in quantity is recorded, not refused: goods
   * on approval may be partly returned, and a liquid-gas challan's quantity was only an estimate.
   */
  async linkInvoice(actor: ActorContext, command: LinkInvoiceCommand): Promise<DeliveryChallan> {
    this.#permissions.require(actor, CHALLAN_PERMISSIONS.issue, 'link an invoice to a challan');
    const challan = await this.#require(actor, command.challanId);
    const rule = challanReason(challan.reason);

    if (challan.state === 'INVOICED') {
      if (challan.invoice?.invoiceId === command.invoiceId) return challan;
      throw conflict('CHALLAN_ALREADY_INVOICED', `Challan ${challan.number} is already billed on invoice ${challan.invoice?.invoiceNumber}.`);
    }
    if (challan.state === 'CANCELLED') {
      throw notAllowed('CHALLAN_CANCELLED', `Challan ${challan.number} was cancelled, so there is nothing to bill.`);
    }
    if (!rule.invoiceFollows) {
      throw notAllowed(
        'CHALLAN_NO_INVOICE_FOLLOWS',
        `Goods sent for "${rule.label['en-IN'].toLowerCase()}" are not sold, so no tax invoice follows challan ${challan.number}.`,
      );
    }

    const invoice = await this.#invoices.findById(actor.companyId, command.invoiceId);
    if (invoice === null) throw notFound('CHALLAN_INVOICE_NOT_FOUND', 'That invoice does not exist in this business.');
    if (invoice.state !== 'FINAL' || invoice.number === null || invoice.pricing === null) {
      throw notAllowed('CHALLAN_INVOICE_NOT_ISSUED', 'Only an issued invoice can be linked to a challan. Issue it first.');
    }
    if (invoice.partyId !== challan.partyId) {
      throw notAllowed('CHALLAN_INVOICE_OTHER_PARTY', `Invoice ${invoice.number} is for a different customer from challan ${challan.number}.`);
    }
    if (compareDates(invoice.documentDate, challan.documentDate) < 0) {
      throw notAllowed(
        'CHALLAN_INVOICE_BEFORE_CHALLAN',
        `Invoice ${invoice.number} is dated before challan ${challan.number}. The invoice for goods sent on a challan is raised after they leave.`,
      );
    }

    const billed = new Map<string, Quantity[]>();
    for (const line of invoice.lines) billed.set(line.itemId, [...(billed.get(line.itemId) ?? []), line.quantity]);
    const missing = challan.lines.filter((l) => !billed.has(l.itemId));
    if (missing.length > 0) {
      throw notAllowed(
        'CHALLAN_INVOICE_MISSING_ITEMS',
        `Invoice ${invoice.number} does not bill ${missing.map((l) => l.itemName).join(', ')}, which went out on challan ${challan.number}.`,
      );
    }
    const differences: string[] = [];
    for (const line of challan.lines) {
      const quantities = billed.get(line.itemId) as Quantity[];
      if (quantities.some((q) => q.unit !== line.quantity.unit)) {
        differences.push(`${line.itemName}: the challan counts in ${line.quantity.unit} and the invoice does not, so the quantities could not be compared.`);
        continue;
      }
      const invoiced = sumQuantity(quantities, line.quantity.unit);
      if (line.quantityProvisional && invoiced.scaled !== line.quantity.scaled) {
        differences.push(`${line.itemName}: ${formatQuantity(line.quantity)} was an estimate on the challan; the invoice bills ${formatQuantity(invoiced)}.`);
      } else if (invoiced.scaled < line.quantity.scaled) {
        differences.push(`${line.itemName}: ${formatQuantity(line.quantity)} went out on the challan, but the invoice bills only ${formatQuantity(invoiced)}.`);
      }
    }

    const at = this.#clock.now().toISOString();
    const next: DeliveryChallan = {
      ...challan,
      state: 'INVOICED',
      invoice: {
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        invoiceDate: invoice.documentDate,
        linkedBy: actor.userId,
        linkedAt: at,
        differences,
      },
      version: challan.version + 1,
    };
    await this.#store.transaction(actor.companyId, async () => this.#repo.update(next, challan.version));
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: 'challan.invoice_linked',
      subjectType: 'delivery_challan',
      subjectId: challan.id,
      summary: `Challan ${challan.number} billed on invoice ${invoice.number}.${differences.length === 0 ? '' : ` ${differences.length} difference${differences.length === 1 ? '' : 's'} noted.`}`,
      details: { number: challan.number, invoiceNumber: invoice.number, invoiceId: invoice.id, differences: differences.join(' | ') },
    });
    return next;
  }

  /**
   * Cancels a challan the goods never moved on. The number stays used, so the series has no gap,
   * and the challan stays visible marked cancelled.
   */
  async cancel(actor: ActorContext, command: CancelChallanCommand): Promise<DeliveryChallan> {
    this.#permissions.require(actor, CHALLAN_PERMISSIONS.cancel, 'cancel a delivery challan');
    if (command.reason.trim() === '') {
      throw invalid('CHALLAN_REASON_REQUIRED', 'Please write why this challan is being cancelled.', { messageId: 'override.reason_required' });
    }
    const challan = await this.#require(actor, command.challanId);
    if (challan.state === 'CANCELLED') return challan;
    if (challan.state === 'INVOICED') {
      throw notAllowed(
        'CHALLAN_ALREADY_INVOICED',
        `Challan ${challan.number} has been billed on invoice ${challan.invoice?.invoiceNumber}. Correct the invoice instead; the challan records goods that really moved.`,
      );
    }
    if (challan.ewayBill !== null && command.ewayBillCancelledOnPortal !== true) {
      throw notAllowed(
        'CHALLAN_EWAY_STILL_LIVE',
        `E-way bill ${challan.ewayBill.number} was raised for these goods. Cancel it on the portal first, then confirm that here, so the government does not show goods moving on a cancelled challan.`,
      );
    }

    const at = this.#clock.now().toISOString();
    const next: DeliveryChallan = {
      ...challan,
      state: 'CANCELLED',
      cancelledBy: actor.userId,
      cancelledAt: at,
      cancelReason: command.reason.trim(),
      version: challan.version + 1,
    };
    await this.#store.transaction(actor.companyId, async () => this.#repo.update(next, challan.version));
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: 'challan.cancelled',
      subjectType: 'delivery_challan',
      subjectId: challan.id,
      summary: `Challan ${challan.number} cancelled.`,
      details: { number: challan.number, ewayBillNumber: challan.ewayBill?.number ?? '' },
      overrideReason: command.reason.trim(),
    });
    return next;
  }

  async #require(actor: ActorContext, id: string): Promise<DeliveryChallan> {
    const challan = await this.#repo.findById(actor.companyId, id);
    if (challan === null) throw notFound('CHALLAN_NOT_FOUND', 'That challan does not exist in this business.');
    return challan;
  }

  /**
   * Works out every line and total, or lists everything stopping the challan.
   *
   * A sale challan takes its figures from the same GST calculator the invoice uses, so the tax
   * printed on the challan is the tax the invoice that follows will charge. A challan that is not a
   * sale prints the value of the goods and no tax, as Rule 55(1)(vii) directs.
   */
  async #work(actor: ActorContext, input: ChallanInput, sourceId: string): Promise<ChallanWorking> {
    const rule = challanReason(input.reason);
    const problems: InvoiceProblem[] = [];
    const companyId = actor.companyId;

    if (input.lines.length === 0) {
      problems.push(problem('CHALLAN_NO_LINES', 'A challan needs at least one item.', 'Challan mein kam se kam ek item chahiye.'));
    }
    const note = (input.reasonNote ?? '').trim();
    if (rule.needsNote && note === '') {
      problems.push(
        problem(
          'CHALLAN_REASON_NOTE_REQUIRED',
          'Say in a few words why the goods are moving, for example "sent for repair". The e-way bill asks for it too.',
          'Kuch shabdon mein likhein ki maal kyon ja raha hai, jaise "repair ke liye". E-way bill mein bhi yeh poocha jata hai.',
        ),
      );
    }

    const company = this.#masterData.company(companyId);
    const party = this.#masterData.party(companyId, input.partyId);
    if (company === undefined) {
      problems.push(problem('CHALLAN_COMPANY_UNKNOWN', 'We do not have this business’s GST details, so we cannot say where the goods start from.', 'Is business ki GST jaankari nahin hai.'));
    }
    if (party === undefined) {
      problems.push(problem('CHALLAN_PARTY_UNKNOWN', 'We do not know who these goods are going to.', 'Maal kise ja raha hai, yeh pata nahin.'));
    }
    const toStateCode = (input.deliveryStateCode ?? '').trim() || party?.stateCode || null;
    if (party !== undefined && toStateCode === null) {
      problems.push(
        problem(
          'CHALLAN_DESTINATION_STATE_UNKNOWN',
          'We do not know which state the goods are going to. Choose the delivery state; the challan must show the place of supply if the goods cross a state border.',
          'Maal kis rajya mein ja raha hai, yeh pata nahin. Delivery ka rajya chunein.',
        ),
      );
    }

    for (const line of input.lines) {
      const item = this.#masterData.item(companyId, line.itemId);
      if (item === undefined) {
        problems.push(problem('CHALLAN_ITEM_UNKNOWN', `We do not know the item "${line.itemId}".`, `Item "${line.itemId}" pata nahin.`, line.lineId));
        continue;
      }
      if (item.kind !== 'GOODS') {
        problems.push(problem('CHALLAN_NOT_GOODS', `${item.name} is a service. A challan carries goods that physically move.`, `${item.name} ek service hai. Challan sirf maal ke liye hota hai.`, line.lineId));
      }
      if (item.hsnOrSac === null || item.hsnOrSac.trim() === '') {
        problems.push(problem('CHALLAN_HSN_MISSING', `${item.name} has no HSN code. A challan must show it (CGST Rule 55).`, `${item.name} ka HSN code nahin hai. Challan par yeh zaroori hai.`, line.lineId));
      }
      if (line.quantity.scaled <= 0n) {
        problems.push(problem('CHALLAN_QUANTITY', `The quantity of ${item.name} must be more than zero.`, `${item.name} ki matra zero se zyada honi chahiye.`, line.lineId));
      }
      if (line.unitPrice.minor < 0n) {
        problems.push(problem('CHALLAN_VALUE', `The value of ${item.name} cannot be below zero.`, `${item.name} ki keemat zero se kam nahin ho sakti.`, line.lineId));
      }
    }
    if (problems.length > 0 || company === undefined || party === undefined) return { ok: false, problems };

    const fromStateCode = company.stateCode;
    const interState = toStateCode !== null && toStateCode !== fromStateCode;
    let lines: ChallanLine[];
    let split: TaxSplit | null = null;
    let placeOfSupplyStateCode: string | null = interState ? toStateCode : null;
    let declaredRateNotice: DeliveryChallan['declaredRateNotice'] = null;

    if (rule.showsTax) {
      const result = this.#calculator.compute({
        companyId,
        documentDate: input.documentDate,
        partyId: input.partyId,
        supplyKind: 'GOODS',
        deliveryStateCode: input.deliveryStateCode ?? null,
        lines: input.lines.map((l) => ({ lineId: l.lineId, itemId: l.itemId, quantity: l.quantity, unitPrice: l.unitPrice, priceBasis: 'EXCLUSIVE' as const })),
        roundToWholeRupee: false,
        source: { kind: 'delivery_challan', id: sourceId },
      });
      if (result.status !== 'COMPUTED') {
        return {
          ok: false,
          problems: result.reasons.map((r) => ({
            code: r.code,
            ...(r.lineId === undefined ? {} : { lineId: r.lineId }),
            message: r.message,
            ...(r.messageId === undefined ? {} : { messageId: r.messageId }),
          })),
        };
      }
      split = result.split;
      placeOfSupplyStateCode = result.placeOfSupplyStateCode;
      declaredRateNotice = result.declaredRateNotice;
      lines = result.lines
        .filter((l) => l.kind === 'GOODS')
        .map((l) => {
          const given = input.lines.find((g) => g.lineId === l.lineId);
          return {
            lineId: l.lineId,
            itemId: l.itemId,
            itemName: l.itemName,
            hsnOrSac: l.hsnOrSac ?? '',
            quantity: l.quantity,
            quantityProvisional: rule.quantityProvisional,
            unitPrice: l.unitPrice,
            taxableValue: l.taxableValue,
            ratePercentTimes100: l.ratePercentTimes100,
            cgst: l.cgst,
            sgst: l.sgst,
            utgst: l.utgst,
            igst: l.igst,
            cess: l.cess,
            exemptSupply: EXEMPT_TREATMENTS.has(l.treatment),
            warehouseId: given?.warehouseId ?? null,
          };
        });
    } else {
      lines = input.lines.map((l) => {
        const item = this.#masterData.item(companyId, l.itemId) as NonNullable<ReturnType<MasterDataReader['item']>>;
        return {
          lineId: l.lineId,
          itemId: l.itemId,
          itemName: item.name,
          hsnOrSac: item.hsnOrSac ?? '',
          quantity: l.quantity,
          quantityProvisional: rule.quantityProvisional,
          unitPrice: l.unitPrice,
          taxableValue: mulDiv(l.unitPrice, l.quantity.scaled, 1_000_000n),
          ratePercentTimes100: null,
          cgst: nil(),
          sgst: nil(),
          utgst: nil(),
          igst: nil(),
          cess: nil(),
          exemptSupply: EXEMPT_TREATMENTS.has(item.treatment),
          warehouseId: l.warehouseId ?? null,
        };
      });
    }

    return {
      ok: true,
      challan: {
        companyId,
        branchId: actor.branchId ?? ('main' as DeliveryChallan['branchId']),
        state: 'ISSUED',
        documentDate: input.documentDate,
        partyId: input.partyId,
        reason: input.reason,
        reasonNote: note === '' ? null : note,
        deliveryStateCode: (input.deliveryStateCode ?? '').trim() || null,
        fromStateCode,
        toStateCode,
        interState,
        placeOfSupplyStateCode,
        showsTax: rule.showsTax,
        split,
        lines,
        totals: totalsOf(lines),
        declaredRateNotice,
        narration: input.narration ?? null,
        ewayBill: null,
        invoice: null,
        createdBy: actor.userId,
        cancelledBy: null,
        cancelledAt: null,
        cancelReason: null,
      },
    };
  }
}

export const totalsOf = (lines: readonly ChallanLine[]): ChallanTotals => {
  const total = (pick: (l: ChallanLine) => Money): Money => lines.reduce<Money>((acc, l) => add(acc, pick(l)), nil());
  const cgst = total((l) => l.cgst);
  const sgst = total((l) => l.sgst);
  const utgst = total((l) => l.utgst);
  const igst = total((l) => l.igst);
  const cess = total((l) => l.cess);
  return {
    taxableValue: total((l) => l.taxableValue),
    cgst,
    sgst,
    utgst,
    igst,
    cess,
    totalTax: [cgst, sgst, utgst, igst, cess].reduce(add, nil()),
  };
};
