/**
 * Issue #30 [E30] — implementations of the ports, so the workspace can actually run.
 *
 * Three kinds of thing live here and it is worth keeping them apart in your head.
 *
 *  - **In-memory stores.** Real behaviour, no database: optimistic locking that actually refuses a
 *    stale write, company scoping that actually isolates. The tests and the local web app run on
 *    these, and a bug they find is a real bug.
 *  - **Adapters over other modules.** `salesInvoiceToDocument` and `returnNoteToDocument` turn
 *    somebody else's shape into ours. They are the only place in this package that knows what a
 *    `SalesInvoice` looks like, and they refuse rather than invent when a fact is missing.
 *  - **A synthetic intermediary.** `SyntheticGspChannel` behaves like a licensed GST intermediary
 *    including its unpleasant behaviours — duplicate submissions, timeouts, rejections with the
 *    portal's own error codes — so those paths are exercised without a production credential.
 */
import { conflict, invalid, toQuantityString, type CompanyId, type Money, type Quantity } from '@invoice/kernel';
import type { JournalLine, UnitOfWork, Voucher } from '@invoice/ledger';
import type {
  BookTaxPort, GovernmentReturnPort, GovernmentSubmitOutcome, GovernmentSubmitRequest, InwardTaxPort,
  OutwardSupplyPort, PeriodLockPort, ReturnPolicy, ReturnPolicyPort, ReturnPreparationRepository,
} from './ports.ts';
import type { BookTaxTotals } from './reconcile.ts';
import { emptyInward } from './gstr3b.ts';
import {
  emptyAmounts,
  taxPeriodOf,
  taxPeriodRange,
  type InwardTaxSummary,
  type OutwardDocument,
  type OutwardLine,
  type ReturnPreparation,
  type SourceRef,
  type SupplyTreatment,
  type TaxPeriod,
} from './types.ts';

// ---------------------------------------------------------------------------- storage

export class InMemoryReturnPreparations implements ReturnPreparationRepository {
  readonly #rows = new Map<string, ReturnPreparation>();

  #key(companyId: CompanyId, period: TaxPeriod, returnType: string): string {
    return `${companyId}|${period}|${returnType}`;
  }

  async find(companyId: CompanyId, period: TaxPeriod, returnType: 'GSTR1' | 'GSTR3B'): Promise<ReturnPreparation | null> {
    return this.#rows.get(this.#key(companyId, period, returnType)) ?? null;
  }

  async findByIdempotencyKey(companyId: CompanyId, key: string): Promise<ReturnPreparation | null> {
    for (const row of this.#rows.values()) {
      if (row.companyId === companyId && row.idempotencyKey === key) return row;
    }
    return null;
  }

  async insert(preparation: ReturnPreparation): Promise<void> {
    const key = this.#key(preparation.companyId, preparation.period, preparation.returnType);
    if (this.#rows.has(key)) {
      throw conflict('GST_RETURN_EXISTS', `${preparation.period} has already been started.`);
    }
    this.#rows.set(key, preparation);
  }

  /** Refuses a write built on a version somebody else has already replaced. */
  async update(preparation: ReturnPreparation, expectedVersion: number): Promise<void> {
    const key = this.#key(preparation.companyId, preparation.period, preparation.returnType);
    const current = this.#rows.get(key);
    if (current === undefined) {
      throw conflict('GST_RETURN_MISSING', `${preparation.period} is not stored, so it cannot be updated.`);
    }
    if (current.version !== expectedVersion) {
      throw conflict(
        'GST_RETURN_CHANGED',
        'Somebody else changed this return while you were working on it. Open it again so you are looking at their figures before you change anything.',
      );
    }
    this.#rows.set(key, preparation);
  }

  async list(companyId: CompanyId): Promise<readonly ReturnPreparation[]> {
    return [...this.#rows.values()].filter((row) => row.companyId === companyId);
  }
}

/** A fixed policy, for a composition that has no per-company settings yet. */
export class StaticReturnPolicy implements ReturnPolicyPort {
  readonly #policy: ReturnPolicy;
  constructor(policy: ReturnPolicy) { this.#policy = policy; }
  async policyFor(): Promise<ReturnPolicy> { return this.#policy; }
}

// ---------------------------------------------------------------------------- other modules

/**
 * The narrow slice of a sales invoice this package needs.
 *
 * Structural rather than an import of `SalesInvoice`, so the sales module (#9) can add and rename
 * fields without breaking the return, and so this adapter can be handed a bill from anywhere —
 * a migration from an old system, a fixture, a test.
 */
export interface SalesInvoiceLike {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly state: string;
  readonly number: string | null;
  readonly documentDate: string;
  readonly partyId: string;
  readonly customerType: 'B2B' | 'B2C';
  readonly placeOfSupplyStateCode: string | null;
  readonly voucherId: string | null;
  readonly pricing: {
    readonly lines: readonly {
      readonly lineId: string;
      readonly itemId: string;
      readonly itemName: string;
      readonly hsnOrSac: string | null;
      /**
       * The quantity as the sales module holds it: an exact scaled decimal with its unit.
       *
       * It used to be declared here as a `string`, which is what the return form wants, and the
       * conversion was left to a caller who did not exist. A real bill therefore reached
       * `parseQuantity` as an object and the HSN summary crashed on it. Taking the real shape and
       * converting here is the adapter's whole job.
       */
      readonly quantity: Quantity;
      readonly ratePercentTimes100: bigint | null;
      readonly taxableValue: Money;
      readonly cgst: Money;
      readonly sgst: Money;
      readonly utgst: Money;
      readonly igst: Money;
      readonly cess: Money;
      readonly reverseCharge: boolean;
      readonly rateBasis: 'REGISTER' | 'BUSINESS_DECLARED' | null;
      /**
       * What the calculator decided the line was: taxable, nil-rated, exempt, outside GST, or
       * unclassified. It reaches the return because the form counts those separately, and a
       * nil-rated sale reported as an ordinary taxable one at zero percent is a wrong return.
       */
      readonly treatment?: 'TAXABLE' | 'NIL_RATED' | 'EXEMPT' | 'NON_GST' | 'UNKNOWN';
    }[];
    /**
     * The bill total including tax.
     *
     * Named exactly as the sales module (#9) names it. It used to be `invoiceTotal` here, which no
     * real sales invoice has, so every bill converted to `invoiceValue: undefined` and the return
     * crashed on the first fingerprint. Both modules' own tests passed throughout, because each was
     * fed a fixture shaped like its own idea of the other — which is what #44 exists to catch.
     */
    readonly totals: { readonly invoiceValue: Money };
  } | null;
  /** Set where the seller marked the bill as an export, an SEZ supply or a deemed export. */
  readonly supplyTreatment?: SupplyTreatment;
}

export interface CounterpartyFacts {
  readonly name: string;
  readonly gstin: string | null;
  readonly stateCode: string | null;
  /** True only when a person has confirmed the buyer genuinely has no GST number. */
  readonly unregisteredConfirmed: boolean;
}

export interface SupplierFacts {
  readonly gstin: string;
  readonly stateCode: string;
}

/**
 * Turns a final sales invoice into a return document.
 *
 * It refuses rather than filling a gap. A bill with no number, no pricing or no final state is not
 * a sale that can be reported, and returning a plausible document for one would put an invented
 * figure on a government filing. The refusal names the bill and the missing fact, and the caller
 * turns it into an exception a person can act on.
 *
 * UTGST — the union-territory tax that stands in for SGST in places like Chandigarh — is folded
 * into the SGST column, because that is the column the return form has. The distinction is real in
 * the ledger and is kept there; it does not exist on GSTR-1.
 */
/**
 * The whole bill's treatment, worked out from its lines.
 *
 * GSTR-1 counts a document, not a line, so a bill has one treatment. Where every line agrees the
 * answer is obvious. Where they do not — a nil-rated item and a taxable one on one bill — the
 * document is `REGULAR` and the tax on the nil lines is simply zero, which is what the form's
 * rate-wise rows already say. What is refused is an `UNKNOWN` line: an unclassified item has no
 * treatment to report, and putting it anywhere would be choosing one.
 */
const treatmentOfLines = (
  lines: readonly { readonly treatment?: 'TAXABLE' | 'NIL_RATED' | 'EXEMPT' | 'NON_GST' | 'UNKNOWN' }[],
  number: string,
): SupplyTreatment => {
  const treatments = new Set(lines.map((line) => line.treatment ?? 'TAXABLE'));
  if (treatments.has('UNKNOWN')) {
    throw invalid(
      'GSTR1_SOURCE_UNCLASSIFIED',
      `Bill ${number} has an item nobody has said what it is for GST. The return cannot report it until the item is classified.`,
    );
  }
  if (treatments.size === 1) {
    const only = [...treatments][0];
    if (only === 'NIL_RATED') return 'NIL_RATED';
    if (only === 'EXEMPT') return 'EXEMPT';
    if (only === 'NON_GST') return 'NON_GST';
  }
  return 'REGULAR';
};

export const salesInvoiceToDocument = (
  invoice: SalesInvoiceLike,
  counterparty: CounterpartyFacts,
  supplier: SupplierFacts,
): OutwardDocument => {
  if (invoice.state !== 'FINAL') {
    throw invalid('GSTR1_SOURCE_NOT_FINAL', `Bill ${invoice.number ?? invoice.id} is not final, so it is not a sale yet and cannot go on a return.`);
  }
  if (invoice.number === null) {
    throw invalid('GSTR1_SOURCE_NO_NUMBER', `A final bill with no number cannot be reported. Check bill ${invoice.id}.`);
  }
  if (invoice.pricing === null) {
    throw invalid('GSTR1_SOURCE_NO_PRICING', `Bill ${invoice.number} has no tax worked out on it, so there is nothing to report.`);
  }

  const lines: OutwardLine[] = invoice.pricing.lines.map((line) => ({
    lineId: line.lineId,
    itemId: line.itemId,
    description: line.itemName,
    hsnOrSac: line.hsnOrSac,
    supplyKind: 'GOODS',
    unit: line.quantity.unit,
    quantity: toQuantityString(line.quantity),
    ratePercentTimes100: line.ratePercentTimes100,
    amounts: {
      taxableValue: line.taxableValue,
      cgst: line.cgst,
      // The return form has no separate union-territory column; the ledger keeps the difference.
      sgst: { currency: 'INR', minor: line.sgst.minor + line.utgst.minor },
      igst: line.igst,
      cess: line.cess,
    },
    rateBasis: line.rateBasis,
    reverseCharge: line.reverseCharge,
  }));

  return {
    companyId: invoice.companyId,
    sourceKind: 'sales_invoice',
    sourceId: invoice.id,
    voucherId: invoice.voucherId,
    kind: 'INVOICE',
    number: invoice.number,
    documentDate: invoice.documentDate as OutwardDocument['documentDate'],
    treatment: invoice.supplyTreatment ?? treatmentOfLines(invoice.pricing.lines, invoice.number),
    supplierGstin: supplier.gstin,
    supplierStateCode: supplier.stateCode,
    partyId: invoice.partyId,
    partyName: counterparty.name,
    counterpartyGstin: counterparty.gstin,
    counterpartyStateCode: counterparty.stateCode,
    placeOfSupplyStateCode: invoice.placeOfSupplyStateCode,
    reverseCharge: lines.some((line) => line.reverseCharge),
    lines,
    invoiceValue: invoice.pricing.totals.invoiceValue,
    unregisteredConfirmed: counterparty.gstin !== null || counterparty.unregisteredConfirmed,
  };
};

/** The slice of a credit or debit note this package needs, from the returns module (#45). */
export interface ReturnNoteLike {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly kind: string;
  readonly number: string;
  readonly documentDate: string;
  readonly partyId: string;
  readonly voucherId: string | null;
  readonly originalDocument: { readonly number: string; readonly date: string };
  readonly lines: readonly {
    readonly originalLineId: string;
    readonly itemId: string;
    readonly description: string;
    readonly supplyKind: 'GOODS' | 'SERVICES';
    /** As the returns module holds it, for the same reason as on a sales invoice above. */
    readonly quantity: Quantity;
    readonly amounts: {
      readonly taxableValue: Money; readonly cgst: Money; readonly sgst: Money;
      readonly utgst: Money; readonly igst: Money; readonly cess: Money; readonly total: Money;
    };
  }[];
  readonly totals: { readonly total: Money };
}

/**
 * Turns a sales return into a credit note on GSTR-1.
 *
 * A purchase return is not converted: it reduces the credit the business claims, which is the
 * inward side and issue #31's, and putting it on GSTR-1 would report somebody else's sale.
 */
export const returnNoteToDocument = (
  note: ReturnNoteLike,
  counterparty: CounterpartyFacts,
  supplier: SupplierFacts,
  facts: { readonly placeOfSupplyStateCode: string | null; readonly hsnByItem?: Readonly<Record<string, string>>; readonly rateByLine?: Readonly<Record<string, bigint>> },
): OutwardDocument => {
  if (note.kind !== 'SALES_RETURN') {
    throw invalid(
      'GSTR1_NOT_AN_OUTWARD_NOTE',
      `Note ${note.number} is a purchase return. It changes the credit you claim on your purchases, which is a different part of the return, so it does not go on GSTR-1.`,
    );
  }

  const lines: OutwardLine[] = note.lines.map((line) => ({
    lineId: line.originalLineId,
    itemId: line.itemId,
    description: line.description,
    hsnOrSac: facts.hsnByItem?.[line.itemId] ?? null,
    supplyKind: line.supplyKind,
    unit: line.quantity.unit,
    quantity: toQuantityString(line.quantity),
    ratePercentTimes100: facts.rateByLine?.[line.originalLineId] ?? null,
    amounts: {
      taxableValue: line.amounts.taxableValue,
      cgst: line.amounts.cgst,
      sgst: { currency: 'INR', minor: line.amounts.sgst.minor + line.amounts.utgst.minor },
      igst: line.amounts.igst,
      cess: line.amounts.cess,
    },
    rateBasis: null,
    reverseCharge: false,
  }));

  return {
    companyId: note.companyId,
    sourceKind: 'credit_note',
    sourceId: note.id,
    voucherId: note.voucherId,
    kind: 'CREDIT_NOTE',
    number: note.number,
    documentDate: note.documentDate as OutwardDocument['documentDate'],
    treatment: 'REGULAR',
    supplierGstin: supplier.gstin,
    supplierStateCode: supplier.stateCode,
    partyId: note.partyId,
    partyName: counterparty.name,
    counterpartyGstin: counterparty.gstin,
    counterpartyStateCode: counterparty.stateCode,
    placeOfSupplyStateCode: facts.placeOfSupplyStateCode,
    reverseCharge: false,
    lines,
    invoiceValue: note.totals.total,
    originalDocument: {
      number: note.originalDocument.number,
      date: note.originalDocument.date as OutwardDocument['documentDate'],
    },
    unregisteredConfirmed: counterparty.gstin !== null || counterparty.unregisteredConfirmed,
  };
};

/** An outward source backed by a list held in memory, for tests, fixtures and the local app. */
export class InMemoryOutwardSupplies implements OutwardSupplyPort {
  readonly #documents: OutwardDocument[] = [];
  readonly #cancelled: { kind: OutwardDocument['kind']; number: string; period: TaxPeriod }[] = [];

  add(...documents: readonly OutwardDocument[]): void {
    this.#documents.push(...documents);
  }

  /** Replaces a document in place, so a test can move the books under an approved return. */
  replace(sourceId: string, document: OutwardDocument): void {
    const index = this.#documents.findIndex((existing) => existing.sourceId === sourceId);
    if (index === -1) throw invalid('GSTR1_NO_SUCH_DOCUMENT', `No document ${sourceId} is held.`);
    this.#documents[index] = document;
  }

  remove(sourceId: string): void {
    const index = this.#documents.findIndex((existing) => existing.sourceId === sourceId);
    if (index !== -1) this.#documents.splice(index, 1);
  }

  cancel(kind: OutwardDocument['kind'], number: string, period: TaxPeriod): void {
    this.#cancelled.push({ kind, number, period });
  }

  async documentsFor(companyId: CompanyId, period: TaxPeriod): Promise<readonly OutwardDocument[]> {
    return this.#documents.filter(
      (document) => document.companyId === companyId && taxPeriodOf(document.documentDate) === period,
    );
  }

  async cancelledNumbersFor(_companyId: CompanyId, period: TaxPeriod): Promise<readonly { kind: OutwardDocument['kind']; number: string }[]> {
    return this.#cancelled.filter((entry) => entry.period === period).map(({ kind, number }) => ({ kind, number }));
  }
}

/** An inward summary held in memory, until issue #31 supplies the real one. */
export class InMemoryInwardTax implements InwardTaxPort {
  readonly #rows = new Map<string, InwardTaxSummary>();

  set(companyId: CompanyId, summary: InwardTaxSummary): void {
    this.#rows.set(`${companyId}|${summary.period}`, summary);
  }

  async summaryFor(companyId: CompanyId, period: TaxPeriod): Promise<InwardTaxSummary> {
    return this.#rows.get(`${companyId}|${period}`) ?? emptyInward(period);
  }
}

/**
 * The output-tax movement in the ledger for a period, for the reconciliation.
 *
 * It reads the ledger through `UnitOfWork` rather than through the reports module, because a
 * reconciliation that reads the same summary the return was built from proves nothing. The two
 * sides have to come from different places for the comparison to be worth making.
 */
export const ledgerBookTaxPort = (uow: UnitOfWork): BookTaxPort => ({
  async totalsFor(companyId: CompanyId, period: TaxPeriod): Promise<BookTaxTotals> {
    const range = taxPeriodRange(period);
    const accounts = await uow.accounts.listAll(companyId);
    const roleOf = new Map<string, string>();
    for (const account of accounts) {
      if (account.systemRole !== null && account.systemRole !== undefined && !account.isGroup) {
        roleOf.set(account.id, account.systemRole);
      }
    }

    const vouchers = await uow.vouchers.list(companyId, {});
    const totals = { CGST: 0n, SGST: 0n, IGST: 0n, CESS: 0n };
    const contributions: SourceRef[] = [];

    for (const voucher of vouchers as readonly Voucher[]) {
      if (voucher.state !== 'FINAL' && voucher.state !== 'REVERSED') continue;
      if (voucher.date < range.from || voucher.date > range.to) continue;
      let touched = 0n;
      for (const line of voucher.lines as readonly JournalLine[]) {
        const role = roleOf.get(line.accountId);
        if (role === undefined) continue;
        // Output tax is a liability: a sale credits it, a credit note debits it back.
        const net = line.credit.minor - line.debit.minor;
        if (role === 'OUTPUT_CGST') { totals.CGST += net; touched += net; }
        else if (role === 'OUTPUT_SGST' || role === 'OUTPUT_UTGST') { totals.SGST += net; touched += net; }
        else if (role === 'OUTPUT_IGST') { totals.IGST += net; touched += net; }
        else if (role === 'OUTPUT_CESS') { totals.CESS += net; touched += net; }
      }
      if (touched !== 0n) {
        contributions.push({
          sourceKind: voucher.source?.kind ?? 'voucher',
          sourceId: voucher.source?.id ?? voucher.id,
          number: voucher.source?.number ?? voucher.number ?? voucher.id,
          date: voucher.date,
          voucherId: voucher.id,
          amount: { currency: 'INR', minor: touched },
        });
      }
    }

    return {
      period,
      cgst: { currency: 'INR', minor: totals.CGST },
      sgst: { currency: 'INR', minor: totals.SGST },
      igst: { currency: 'INR', minor: totals.IGST },
      cess: { currency: 'INR', minor: totals.CESS },
      contributions,
    };
  },
});

/**
 * The tax already paid on purchases, read out of the ledger's input-tax accounts.
 *
 * A stand-in until issue #31 ships. It answers the honest question — what did the books put in the
 * input-tax accounts this month — and deliberately not the harder one, which is how much of that
 * may actually be claimed. Everything it returns lands in the form's "all other ITC" line, because
 * that is where an ordinary purchase belongs and because pretending to split imports and
 * reverse-charge credits out of accounts that do not distinguish them would be inventing detail.
 */
export const ledgerInwardTaxPort = (uow: UnitOfWork): InwardTaxPort => ({
  async summaryFor(companyId: CompanyId, period: TaxPeriod): Promise<InwardTaxSummary> {
    const range = taxPeriodRange(period);
    const accounts = await uow.accounts.listAll(companyId);
    const roleOf = new Map<string, string>();
    for (const account of accounts) {
      if (account.systemRole !== null && account.systemRole !== undefined && !account.isGroup) {
        roleOf.set(account.id, account.systemRole);
      }
    }

    const vouchers = await uow.vouchers.list(companyId, {});
    const totals = { CGST: 0n, SGST: 0n, IGST: 0n, CESS: 0n };
    const contributions: SourceRef[] = [];

    for (const voucher of vouchers as readonly Voucher[]) {
      if (voucher.state !== 'FINAL' && voucher.state !== 'REVERSED') continue;
      if (voucher.date < range.from || voucher.date > range.to) continue;
      let touched = 0n;
      for (const line of voucher.lines as readonly JournalLine[]) {
        const role = roleOf.get(line.accountId);
        if (role === undefined) continue;
        // Input tax is an asset: a purchase debits it, a purchase return credits it back.
        const net = line.debit.minor - line.credit.minor;
        if (role === 'INPUT_CGST') { totals.CGST += net; touched += net; }
        else if (role === 'INPUT_SGST' || role === 'INPUT_UTGST') { totals.SGST += net; touched += net; }
        else if (role === 'INPUT_IGST') { totals.IGST += net; touched += net; }
        else if (role === 'INPUT_CESS') { totals.CESS += net; touched += net; }
      }
      if (touched !== 0n) {
        contributions.push({
          sourceKind: voucher.source?.kind ?? 'voucher',
          sourceId: voucher.source?.id ?? voucher.id,
          number: voucher.source?.number ?? voucher.number ?? voucher.id,
          date: voucher.date,
          voucherId: voucher.id,
          amount: { currency: 'INR', minor: touched },
        });
      }
    }

    return inwardWithOrdinaryCredit(
      period,
      { cgst: totals.CGST, sgst: totals.SGST, igst: totals.IGST, cess: totals.CESS },
      contributions,
    );
  },
});

/** A book-tax source held in memory, for tests that are not exercising the ledger. */
export class InMemoryBookTax implements BookTaxPort {
  readonly #rows = new Map<string, BookTaxTotals>();

  set(companyId: CompanyId, totals: BookTaxTotals): void {
    this.#rows.set(`${companyId}|${totals.period}`, totals);
  }

  async totalsFor(companyId: CompanyId, period: TaxPeriod): Promise<BookTaxTotals> {
    return (
      this.#rows.get(`${companyId}|${period}`) ?? {
        period,
        cgst: { currency: 'INR', minor: 0n },
        sgst: { currency: 'INR', minor: 0n },
        igst: { currency: 'INR', minor: 0n },
        cess: { currency: 'INR', minor: 0n },
        contributions: [],
      }
    );
  }
}

/** A period-lock source held in memory. */
export class InMemoryPeriodLocks implements PeriodLockPort {
  readonly #locks = new Map<string, 'OPEN' | 'SOFT_LOCKED' | 'HARD_LOCKED'>();

  set(companyId: CompanyId, period: TaxPeriod, state: 'OPEN' | 'SOFT_LOCKED' | 'HARD_LOCKED'): void {
    this.#locks.set(`${companyId}|${period}`, state);
  }

  async stateOf(companyId: CompanyId, on: string): Promise<'OPEN' | 'SOFT_LOCKED' | 'HARD_LOCKED'> {
    return this.#locks.get(`${companyId}|${on.slice(0, 7)}`) ?? 'OPEN';
  }

  async softLock(companyId: CompanyId, period: TaxPeriod): Promise<void> {
    this.#locks.set(`${companyId}|${period}`, 'SOFT_LOCKED');
  }
}

// ---------------------------------------------------------------------------- the intermediary

/**
 * A stand-in for a licensed GST intermediary.
 *
 * It is not a happy-path mock. It remembers idempotency keys and answers a repeat with the
 * original reference rather than filing twice; it can be told to reject with the portal's own
 * error codes; and it can be told to time out, which produces `UNKNOWN` rather than a failure —
 * the state that is most easily got wrong and most expensive when it is.
 */
export class SyntheticGspChannel implements GovernmentReturnPort {
  readonly provider = 'synthetic-gsp';
  readonly #filed = new Map<string, string>();
  #behaviour: 'ACCEPT' | 'REJECT' | 'TIMEOUT' = 'ACCEPT';
  #errors: readonly { code: string; detail: string }[] = [];
  #sequence = 0;
  readonly #at: () => string;

  constructor(at: () => string = () => new Date().toISOString()) {
    this.#at = at;
  }

  willAccept(): void { this.#behaviour = 'ACCEPT'; }

  willReject(errors: readonly { code: string; detail: string }[]): void {
    this.#behaviour = 'REJECT';
    this.#errors = errors;
  }

  willTimeOut(): void { this.#behaviour = 'TIMEOUT'; }

  /** Every filing it has accepted, so a test can prove a retry did not file twice. */
  filings(): readonly string[] { return [...this.#filed.keys()]; }

  async submit(request: GovernmentSubmitRequest): Promise<GovernmentSubmitOutcome> {
    const already = this.#filed.get(request.idempotencyKey);
    if (already !== undefined) {
      // The portal's own duplicate reply. Treated as success, because it is: the return is filed.
      return { kind: 'ACCEPTED', reference: already, acknowledgedAt: this.#at() };
    }
    if (this.#behaviour === 'TIMEOUT') {
      return { kind: 'UNKNOWN', retryable: true, at: this.#at(), detail: 'the intermediary did not answer in time' };
    }
    if (this.#behaviour === 'REJECT') {
      return { kind: 'REJECTED', errors: this.#errors, at: this.#at() };
    }
    this.#sequence += 1;
    const reference = `ARN${request.period.replace('-', '')}${String(this.#sequence).padStart(6, '0')}`;
    this.#filed.set(request.idempotencyKey, reference);
    return { kind: 'ACCEPTED', reference, acknowledgedAt: this.#at() };
  }

  async health(): Promise<'healthy' | 'degraded' | 'unavailable'> {
    return this.#behaviour === 'TIMEOUT' ? 'degraded' : 'healthy';
  }
}

/** An inward summary with only the ordinary credit filled in. Convenience for fixtures and tests. */
export const inwardWithOrdinaryCredit = (
  period: TaxPeriod,
  credit: { readonly cgst?: bigint; readonly sgst?: bigint; readonly igst?: bigint; readonly cess?: bigint },
  contributions: readonly SourceRef[] = [],
): InwardTaxSummary => ({
  ...emptyInward(period),
  allOtherItc: {
    ...emptyAmounts(),
    cgst: { currency: 'INR', minor: credit.cgst ?? 0n },
    sgst: { currency: 'INR', minor: credit.sgst ?? 0n },
    igst: { currency: 'INR', minor: credit.igst ?? 0n },
    cess: { currency: 'INR', minor: credit.cess ?? 0n },
  },
  contributions,
});

