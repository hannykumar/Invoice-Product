/**
 * Issue #30 [E30] — what a GST return is made of, in this product's words.
 *
 * Two returns are prepared here.
 *
 *  - **GSTR-1** is the list of everything the business sold in a month. The government does not
 *    want one total; it wants the sales split into named tables — sales to registered buyers, sales
 *    to ordinary consumers, credit notes, a rate-wise summary, an HSN summary, and a count of the
 *    bill numbers used. Those tables are what `Gstr1Return` holds.
 *  - **GSTR-3B** is the short summary that decides how much money moves. It carries the tax the
 *    business collected on sales (the liability) and the tax it already paid on purchases (the
 *    input tax credit, "ITC"), head by head.
 *
 * Three rules run through this file and everything built on it.
 *
 *   1. **Every figure names its documents.** A `SectionAmounts` is never a bare number: each row
 *      keeps the source vouchers that made it, so any total on the return can be opened up until a
 *      bill is on the screen. That is the first acceptance criterion of the issue.
 *   2. **A missing fact is a question, not a default.** A buyer with no GST number is not assumed
 *      to be a consumer, and a bill with no place of supply is not assumed to be local. Both stop
 *      and become an item in the exception workspace.
 *   3. **A snapshot is a photograph, not a live view.** Once a period is prepared the documents
 *      that went into it are fingerprinted. If the books move afterwards, the workspace says so
 *      rather than quietly showing different numbers than the ones that were approved.
 */
import type { CompanyId, IsoDate, Money, UserId } from '@invoice/kernel';

/** English and the romanised Hindi this product prints beside it, as everywhere else. */
export interface Bilingual {
  readonly 'en-IN': string;
  readonly 'hi-IN': string;
}

// ---------------------------------------------------------------------------- the period

/**
 * The month a return covers, written the way the government writes it: `"2026-07"`.
 *
 * Quarterly filing (the QRMP scheme) still reports month by month inside the quarter, so a month
 * is the smallest honest unit and the only one stored here.
 */
export type TaxPeriod = string & { readonly __taxPeriod: unique symbol };

const PERIOD = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const taxPeriod = (value: string): TaxPeriod => {
  if (!PERIOD.test(value)) throw new RangeError(`"${value}" is not a tax period in YYYY-MM form`);
  return value as TaxPeriod;
};

export const taxPeriodOf = (date: IsoDate): TaxPeriod => taxPeriod(date.slice(0, 7));

/** The first and last day of the period, inclusive. */
export const taxPeriodRange = (period: TaxPeriod): { readonly from: IsoDate; readonly to: IsoDate } => {
  const [year, month] = period.split('-').map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: `${period}-01` as IsoDate,
    to: `${period}-${String(lastDay).padStart(2, '0')}` as IsoDate,
  };
};

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "July 2026". A screen that says "2026-07" at a shopkeeper has not said a month to them. */
export const formatTaxPeriod = (period: TaxPeriod): string => {
  const [year, month] = period.split('-') as [string, string];
  return `${MONTH_NAMES[Number(month) - 1] as string} ${year}`;
};

/** The government's own form of the period on an uploaded file: "072026". */
export const governmentPeriod = (period: TaxPeriod): string => {
  const [year, month] = period.split('-') as [string, string];
  return `${month}${year}`;
};

// ---------------------------------------------------------------------------- the documents

/**
 * What kind of paper this is. Only these five reach a return.
 *
 * A `DEBIT_NOTE` raises what the customer owes and a `CREDIT_NOTE` lowers it; on the return they
 * sit in the same table with opposite signs, which is why they share a shape here.
 */
export type OutwardDocumentKind = 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE' | 'ADVANCE_RECEIPT' | 'REFUND_VOUCHER';

/**
 * How the supply is treated, as the form asks it.
 *
 * `REGULAR` is an ordinary taxed sale. `EXPORT_WITH_TAX` and `EXPORT_WITHOUT_TAX` are sales out of
 * India, which the form keeps apart because the second one is made against a bond or an
 * undertaking (a "LUT") and carries no tax. `SEZ_*` are supplies to a special economic zone, which
 * the law treats like exports. `NIL_RATED`, `EXEMPT` and `NON_GST` carry no tax for three different
 * reasons and the form counts them separately.
 */
export type SupplyTreatment =
  | 'REGULAR'
  | 'EXPORT_WITH_TAX'
  | 'EXPORT_WITHOUT_TAX'
  | 'SEZ_WITH_TAX'
  | 'SEZ_WITHOUT_TAX'
  | 'DEEMED_EXPORT'
  | 'NIL_RATED'
  | 'EXEMPT'
  | 'NON_GST';

/** The five tax heads, always carried together so a figure can never lose one of them. */
export interface TaxAmounts {
  readonly taxableValue: Money;
  readonly cgst: Money;
  readonly sgst: Money;
  readonly igst: Money;
  readonly cess: Money;
}

/**
 * One line of one document, at one rate.
 *
 * The rate matters as much as the amount: GSTR-1 reports sales rate by rate, so two lines of the
 * same bill at 5% and 18% are two rows on the return even though they are one bill in the shop.
 */
export interface OutwardLine {
  readonly lineId: string;
  readonly itemId: string;
  readonly description: string;
  readonly hsnOrSac: string | null;
  readonly supplyKind: 'GOODS' | 'SERVICES';
  readonly unit: string | null;
  /** Exact decimal string, as quantities are held everywhere in this product. */
  readonly quantity: string | null;
  /** The whole GST rate times 100. 18% is 1800n. `null` only where no rate applies at all. */
  readonly ratePercentTimes100: bigint | null;
  readonly amounts: TaxAmounts;
  /** Where the rate came from: a notification, or the business's own declaration (#25). */
  readonly rateBasis: 'REGISTER' | 'BUSINESS_DECLARED' | null;
  readonly reverseCharge: boolean;
}

/**
 * A sale, credit note or debit note as the return preparer sees it.
 *
 * This is deliberately not `SalesInvoice`. The sales module (#9) and the returns module (#45) own
 * their own shapes and may change them; an adapter turns each into this, and the return tables are
 * built from this alone. A document that cannot be turned into this shape without inventing a fact
 * is not converted — it becomes an exception.
 */
export interface OutwardDocument {
  readonly companyId: CompanyId;
  /** `sales_invoice`, `credit_note`, and so on: which module the paper came from. */
  readonly sourceKind: string;
  readonly sourceId: string;
  /** The ledger voucher this document posted, so a return figure reaches the books. */
  readonly voucherId: string | null;
  readonly kind: OutwardDocumentKind;
  readonly number: string;
  readonly documentDate: IsoDate;
  readonly treatment: SupplyTreatment;
  /** The seller's own registration, needed on the file the government reads. */
  readonly supplierGstin: string;
  /** The state the seller is registered in. Two digits, as on the GST number. */
  readonly supplierStateCode: string;
  readonly partyId: string;
  readonly partyName: string;
  /** The buyer's GST number, or `null` for an ordinary consumer. Never blank-as-unknown. */
  readonly counterpartyGstin: string | null;
  /** Set when the buyer has no GST number and a person has confirmed that. See `unregisteredConfirmed`. */
  readonly counterpartyStateCode: string | null;
  /** Which state the sale counts as made in. This decides IGST against CGST plus SGST. */
  readonly placeOfSupplyStateCode: string | null;
  readonly reverseCharge: boolean;
  readonly lines: readonly OutwardLine[];
  /** Bill total including tax. The B2CL test in the form is on this figure, not on the taxable value. */
  readonly invoiceValue: Money;
  /** Set on a credit or debit note: the bill it adjusts. */
  readonly originalDocument?: {
    readonly number: string;
    readonly date: IsoDate;
    /** Present when the original was itself reported on an earlier return. */
    readonly reportedInPeriod?: TaxPeriod;
  };
  /**
   * A correction to something already filed. The government calls this an amendment, and it goes in
   * its own table naming the period and the document being corrected.
   */
  readonly amends?: {
    readonly period: TaxPeriod;
    readonly number: string;
    readonly date: IsoDate;
    readonly reason: string;
  };
  /** The e-invoice reference, where the bill has one (#26). Carried through so the two agree. */
  readonly irn?: string | null;
  /**
   * True only when a person has confirmed the buyer is genuinely unregistered.
   *
   * The difference between "this customer has no GST number" and "nobody typed one in" is the
   * difference between a B2C sale and a missing fact, and the product refuses to guess which.
   */
  readonly unregisteredConfirmed: boolean;
}

/**
 * The tax already paid on purchases, read from the books, for GSTR-3B's credit side.
 *
 * The return does not recompute purchases. It reads what the purchase postings (#17) put in the
 * input-tax accounts for the period, which is why every figure here names its vouchers too.
 */
export interface InwardTaxSummary {
  readonly period: TaxPeriod;
  /** Ordinary credit on purchases of goods and services. */
  readonly allOtherItc: TaxAmounts;
  /** Credit on purchases where the buyer pays the tax themselves (reverse charge). */
  readonly reverseChargeItc: TaxAmounts;
  /** Credit on goods brought in from outside India. */
  readonly importItc: TaxAmounts;
  /** Credit that has to be given back — the form's "reversed" line. */
  readonly reversedItc: TaxAmounts;
  /** Tax owed on purchases under reverse charge; it is a liability, not a credit. */
  readonly reverseChargeLiability: TaxAmounts;
  /** Purchases that carried no GST at all, reported as a memorandum figure. */
  readonly exemptInwardValue: Money;
  readonly contributions: readonly SourceRef[];
}

// ---------------------------------------------------------------------------- traceability

/**
 * One document standing behind one figure.
 *
 * This is what makes "every return number traces to source vouchers" true rather than aspirational.
 * Every row of every table carries these, and the workspace can print them.
 */
export interface SourceRef {
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly number: string;
  readonly date: IsoDate;
  readonly voucherId: string | null;
  readonly amount: Money;
}

// ---------------------------------------------------------------------------- GSTR-1

/**
 * The tables of GSTR-1 this product prepares, named as the form names them.
 *
 * `B2CL` — sales to a consumer in another state above a value threshold — is the one table whose
 * boundary is a number set by notification rather than by arithmetic. See `thresholds.ts`.
 */
export type Gstr1SectionId =
  | 'B2B'
  | 'B2CL'
  | 'B2CS'
  | 'CDNR'
  | 'CDNUR'
  | 'EXP'
  | 'NIL'
  | 'HSN'
  | 'DOCS'
  | 'AT'
  | 'B2BA'
  | 'B2CLA'
  | 'B2CSA'
  | 'CDNRA'
  | 'CDNURA';

export const GSTR1_SECTION_NAMES: Readonly<Record<Gstr1SectionId, Bilingual>> = Object.freeze({
  B2B: { 'en-IN': 'Sales to businesses with a GST number', 'hi-IN': 'GST number wale businesses ko bikri' },
  B2CL: { 'en-IN': 'Large sales to consumers in another state', 'hi-IN': 'Doosre state ke customer ko badi bikri' },
  B2CS: { 'en-IN': 'Everyday sales to consumers', 'hi-IN': 'Aam customer ko rozana bikri' },
  CDNR: { 'en-IN': 'Credit and debit notes to businesses', 'hi-IN': 'Business ko credit aur debit note' },
  CDNUR: { 'en-IN': 'Credit and debit notes to consumers', 'hi-IN': 'Customer ko credit aur debit note' },
  EXP: { 'en-IN': 'Sales outside India', 'hi-IN': 'India ke bahar bikri' },
  NIL: { 'en-IN': 'Sales that carried no GST', 'hi-IN': 'Bina GST wali bikri' },
  HSN: { 'en-IN': 'Summary by goods and services code', 'hi-IN': 'Saaman aur service code ka summary' },
  DOCS: { 'en-IN': 'Bill numbers used this month', 'hi-IN': 'Is mahine ke bill number' },
  AT: { 'en-IN': 'Advances received', 'hi-IN': 'Pehle mila paisa' },
  B2BA: { 'en-IN': 'Corrections to business sales already filed', 'hi-IN': 'Pehle bheji business bikri ke sudhaar' },
  B2CLA: { 'en-IN': 'Corrections to large consumer sales already filed', 'hi-IN': 'Pehle bheji badi bikri ke sudhaar' },
  B2CSA: { 'en-IN': 'Corrections to everyday sales already filed', 'hi-IN': 'Pehle bheji rozana bikri ke sudhaar' },
  CDNRA: { 'en-IN': 'Corrections to business credit notes already filed', 'hi-IN': 'Pehle bheje business note ke sudhaar' },
  CDNURA: { 'en-IN': 'Corrections to consumer credit notes already filed', 'hi-IN': 'Pehle bheje customer note ke sudhaar' },
});

/** One row of a GSTR-1 table: a bill, or a rate-wise line within one, with its sources. */
export interface Gstr1Row {
  readonly section: Gstr1SectionId;
  /** A stable key for the row, so two preparations of the same books produce the same rows. */
  readonly key: string;
  readonly counterpartyGstin: string | null;
  readonly counterpartyName: string | null;
  readonly placeOfSupplyStateCode: string | null;
  readonly documentNumber: string | null;
  readonly documentDate: IsoDate | null;
  readonly documentKind: OutwardDocumentKind | null;
  readonly treatment: SupplyTreatment;
  readonly ratePercentTimes100: bigint | null;
  readonly reverseCharge: boolean;
  readonly invoiceValue: Money | null;
  readonly amounts: TaxAmounts;
  readonly amendmentOf?: { readonly period: TaxPeriod; readonly number: string; readonly date: IsoDate; readonly reason: string };
  readonly sources: readonly SourceRef[];
}

export interface Gstr1Section {
  readonly id: Gstr1SectionId;
  readonly name: Bilingual;
  readonly rows: readonly Gstr1Row[];
  readonly totals: TaxAmounts;
  readonly documentCount: number;
  /** One sentence a non-accountant can read, e.g. "2 bills to businesses, ₹1,18,000 of tax". */
  readonly sentence: Bilingual;
}

/** A row of the HSN summary: one code, one rate, added up. */
export interface HsnRow {
  readonly hsnOrSac: string;
  readonly description: string;
  readonly unit: string | null;
  readonly quantity: string | null;
  readonly ratePercentTimes100: bigint | null;
  readonly amounts: TaxAmounts;
  readonly sources: readonly SourceRef[];
}

/** A row of the document-series table: which numbers were used, and how many were cancelled. */
export interface DocumentSeriesRow {
  readonly kind: OutwardDocumentKind;
  readonly from: string;
  readonly to: string;
  readonly total: number;
  readonly cancelled: number;
  readonly issued: number;
}

export interface Gstr1Return {
  readonly period: TaxPeriod;
  readonly gstin: string;
  readonly sections: readonly Gstr1Section[];
  readonly hsn: readonly HsnRow[];
  readonly documents: readonly DocumentSeriesRow[];
  /** Everything sold, added up across every table. The headline figure on the screen. */
  readonly totals: TaxAmounts;
  readonly documentCount: number;
  readonly sentence: Bilingual;
}

// ---------------------------------------------------------------------------- GSTR-3B

/** One line of GSTR-3B, numbered as the form numbers it, with the documents behind it. */
export interface Gstr3bLine {
  readonly boxId: string;
  readonly label: Bilingual;
  readonly amounts: TaxAmounts;
  readonly sources: readonly SourceRef[];
}

/** What is owed and what is available, head by head. The set-off order is not decided here. */
export interface Gstr3bHead {
  readonly head: 'IGST' | 'CGST' | 'SGST' | 'CESS';
  readonly liability: Money;
  readonly credit: Money;
  /** Liability less credit within the same head. Negative means credit is left over. */
  readonly difference: Money;
}

export interface Gstr3bReturn {
  readonly period: TaxPeriod;
  readonly gstin: string;
  /** Table 3.1 — what was supplied. */
  readonly outward: readonly Gstr3bLine[];
  /** Table 3.2 — of the consumer sales above, what went to each other state. */
  readonly interStateToUnregistered: readonly {
    readonly stateCode: string;
    readonly taxableValue: Money;
    readonly igst: Money;
    readonly sources: readonly SourceRef[];
  }[];
  /** Table 4 — the credit side. */
  readonly credit: readonly Gstr3bLine[];
  /** Table 5 — purchases that carried no GST. */
  readonly exemptInwardValue: Money;
  readonly heads: readonly Gstr3bHead[];
  readonly sentence: Bilingual;
  /**
   * Said plainly on every 3B this product prepares: the order in which leftover IGST credit is
   * used against CGST and SGST is a choice the law leaves partly open, and it is made when the
   * payment is prepared, not here.
   */
  readonly caution: Bilingual;
}

// ---------------------------------------------------------------------------- findings

/** How serious a finding is. `BLOCKING` stops approval; the others are shown and can be accepted. */
export type FindingSeverity = 'BLOCKING' | 'WARNING' | 'INFORMATION';

/**
 * Something the preparer must look at before the return goes out.
 *
 * A finding is never a number the product changed on its own. It names the document, says what is
 * wrong in plain words, and says what would fix it.
 */
export interface ReturnFinding {
  readonly code: string;
  readonly severity: FindingSeverity;
  readonly message: Bilingual;
  readonly whatToDo: Bilingual;
  readonly source?: SourceRef;
  /** Where the finding came from, so an audit can tell a rule from a reconciliation. */
  readonly origin: 'CLASSIFICATION' | 'VALIDATION' | 'RECONCILIATION' | 'SNAPSHOT';
}

// ---------------------------------------------------------------------------- the preparation

/**
 * Where a period's preparation stands. Mirrors `docs/product/spec/states.json`, machine
 * `gst_return`.
 *
 * `APPROVED` is the point of no quiet change: from there on, the figures are the ones a person
 * signed off, and a later change in the books is reported as a difference rather than absorbed.
 */
export type ReturnState =
  | 'DRAFT'
  | 'NEEDS_ATTENTION'
  | 'APPROVED'
  | 'EXPORTED'
  | 'SUBMITTING'
  | 'FILED'
  | 'SUBMISSION_FAILED';

export const RETURN_STATE_PLAIN: Readonly<Record<ReturnState, Bilingual>> = Object.freeze({
  DRAFT: { 'en-IN': 'Being prepared', 'hi-IN': 'Tayyar ho raha hai' },
  NEEDS_ATTENTION: { 'en-IN': 'Something must be decided first', 'hi-IN': 'Pehle kuch tay karna hai' },
  APPROVED: { 'en-IN': 'Checked and approved, not yet sent', 'hi-IN': 'Jaanch kar approve kiya, abhi bheja nahi' },
  EXPORTED: { 'en-IN': 'File downloaded for upload', 'hi-IN': 'File download ho gayi' },
  SUBMITTING: { 'en-IN': 'Being sent to the government', 'hi-IN': 'Government ko bheja ja raha hai' },
  FILED: { 'en-IN': 'Filed with the government', 'hi-IN': 'Government ke paas file ho gaya' },
  SUBMISSION_FAILED: { 'en-IN': 'It did not go through. Nothing was filed.', 'hi-IN': 'Nahi gaya. Kuch file nahi hua.' },
});

/**
 * The photograph of the books that a return was built from.
 *
 * `fingerprint` is a hash of every document that went in — its number, date, treatment and every
 * amount. Recomputing it later and getting a different answer is proof the books moved, and that
 * is exactly what the second acceptance criterion asks the product to notice.
 */
export interface BookSnapshot {
  readonly period: TaxPeriod;
  readonly takenAt: string;
  readonly takenBy: UserId;
  readonly documentCount: number;
  readonly fingerprint: string;
  /** Every document in the snapshot, so the return can be rebuilt exactly as it was approved. */
  readonly documents: readonly OutwardDocument[];
  readonly inward: InwardTaxSummary;
}

export interface ReturnApproval {
  readonly approvedBy: UserId;
  readonly approvedAt: string;
  /** The fingerprint at the moment of approval. Compared against the books on every later read. */
  readonly fingerprint: string;
  readonly note: string | null;
}

export interface GovernmentSubmission {
  readonly reference: string | null;
  readonly attemptedAt: string;
  readonly outcome: 'ACCEPTED' | 'REJECTED' | 'UNKNOWN';
  readonly message: string;
  /** The government's own errors, kept verbatim so a rejection can be acted on. */
  readonly errors: readonly { readonly code: string; readonly detail: string }[];
}

export interface ReturnPreparation {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly gstin: string;
  readonly period: TaxPeriod;
  readonly returnType: 'GSTR1' | 'GSTR3B';
  readonly state: ReturnState;
  readonly snapshot: BookSnapshot;
  readonly findings: readonly ReturnFinding[];
  readonly approval: ReturnApproval | null;
  readonly exportedAt: string | null;
  readonly submission: GovernmentSubmission | null;
  readonly createdBy: UserId;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly version: number;
}

export const GST_RETURN_PERMISSIONS = {
  view: 'gst_returns.view',
  prepare: 'gst_returns.prepare',
  approve: 'gst_returns.approve',
  export: 'gst_returns.export',
  submit: 'gst_returns.submit',
  reopen: 'gst_returns.reopen',
} as const;

// ---------------------------------------------------------------------------- arithmetic

export const emptyAmounts = (): TaxAmounts => ({
  taxableValue: { currency: 'INR', minor: 0n },
  cgst: { currency: 'INR', minor: 0n },
  sgst: { currency: 'INR', minor: 0n },
  igst: { currency: 'INR', minor: 0n },
  cess: { currency: 'INR', minor: 0n },
});

export const addAmounts = (a: TaxAmounts, b: TaxAmounts): TaxAmounts => ({
  taxableValue: { currency: 'INR', minor: a.taxableValue.minor + b.taxableValue.minor },
  cgst: { currency: 'INR', minor: a.cgst.minor + b.cgst.minor },
  sgst: { currency: 'INR', minor: a.sgst.minor + b.sgst.minor },
  igst: { currency: 'INR', minor: a.igst.minor + b.igst.minor },
  cess: { currency: 'INR', minor: a.cess.minor + b.cess.minor },
});

export const sumAmounts = (all: readonly TaxAmounts[]): TaxAmounts => all.reduce(addAmounts, emptyAmounts());

/** Flips every sign. A credit note reduces a return figure, so it is added as its negative. */
export const negateAmounts = (a: TaxAmounts): TaxAmounts => ({
  taxableValue: { currency: 'INR', minor: -a.taxableValue.minor },
  cgst: { currency: 'INR', minor: -a.cgst.minor },
  sgst: { currency: 'INR', minor: -a.sgst.minor },
  igst: { currency: 'INR', minor: -a.igst.minor },
  cess: { currency: 'INR', minor: -a.cess.minor },
});

export const totalTaxOf = (a: TaxAmounts): Money => ({
  currency: 'INR',
  minor: a.cgst.minor + a.sgst.minor + a.igst.minor + a.cess.minor,
});

export const amountsAreZero = (a: TaxAmounts): boolean =>
  a.taxableValue.minor === 0n && a.cgst.minor === 0n && a.sgst.minor === 0n && a.igst.minor === 0n && a.cess.minor === 0n;
