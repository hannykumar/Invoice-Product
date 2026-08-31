/**
 * Issue #31 [E31] — what a purchase reconciliation is made of.
 *
 * Plain words first, because the whole module is about one everyday problem.
 *
 * When a shop buys something, the supplier charges GST on the bill. The shop has already paid that
 * tax to the supplier, so the government lets it subtract that amount from its own GST bill. That
 * subtraction is the **input tax credit**, "ITC" everywhere below.
 *
 * The catch is that the government only really allows the credit when the *supplier* has also told
 * the government about that same bill. What the suppliers reported turns up in two places a
 * business can read: **GSTR-2B**, a statement the portal produces once a month listing every
 * purchase bill the suppliers filed, and **IMS**, the newer screen where each of those documents
 * can be accepted, rejected or left pending.
 *
 * So there are two lists of the same month's purchases — ours and theirs — and this module lays
 * them side by side. Three rules run through everything here.
 *
 *   1. **A bill that is in our books but not on the portal is not credit.** It is a question for
 *      the supplier. It is never quietly added to what we claim, and it is never treated as
 *      settled by the fact that nobody looked at it.
 *   2. **Every decision shows its evidence.** A line does not say "matched"; it says which fields
 *      were compared, what each side said, and which of them differ. A match nobody can check is
 *      an opinion.
 *   3. **A person's decision survives a recomputation.** The lists are re-read constantly — a new
 *      bill is posted, a fresh 2B is imported — and re-reading must never quietly discard what
 *      somebody accepted or reject what they had already answered. When the underlying figures
 *      move under a decision, the decision is kept and flagged, not applied silently.
 *
 * The money types are the ledger's: `Money` in paise, never a float. The period and the tax-head
 * shapes are borrowed from the return workspace (#30) on purpose, so the credit figures this
 * module produces drop into GSTR-3B without a conversion in between — a conversion is exactly
 * where a rupee goes missing.
 */
import type { CompanyId, IsoDate, Money, UserId } from '@invoice/kernel';
import type { Bilingual, SourceRef, TaxAmounts, TaxPeriod } from '../../gst-returns/src/types.ts';

export type { Bilingual, SourceRef, TaxAmounts, TaxPeriod };
export { formatTaxPeriod, taxPeriod, taxPeriodOf, taxPeriodRange } from '../../gst-returns/src/types.ts';

// ---------------------------------------------------------------------------- the two sides

/** Invoice, credit note or debit note. The three kinds of paper that reach a purchase register. */
export type DocumentKind = 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE';

/**
 * Where a portal record came from.
 *
 * `TYPED` is not a lesser source and it is not a fallback bolted on later. A shop is often looking
 * at the portal on a phone with no way to download a file, and an accountant reading the figures
 * out over the phone is a real Tuesday. What changes with the source is only what the evidence
 * says about where the fact came from — a person's reading is evidence from a person, a file is
 * evidence from the portal — never what the rules then do with it.
 */
export type RecordSource = 'GSTR2B_FILE' | 'IMS_FILE' | 'PORTAL_API' | 'TYPED';

export const RECORD_SOURCE_PLAIN: Readonly<Record<RecordSource, Bilingual>> = Object.freeze({
  GSTR2B_FILE: { 'en-IN': 'from a GSTR-2B file you downloaded', 'hi-IN': 'aapke download kiye GSTR-2B file se' },
  IMS_FILE: { 'en-IN': 'from an IMS file you downloaded', 'hi-IN': 'aapke download kiye IMS file se' },
  PORTAL_API: { 'en-IN': 'fetched from the portal', 'hi-IN': 'portal se seedha liya gaya' },
  TYPED: { 'en-IN': 'typed in by a person from the portal screen', 'hi-IN': 'portal dekh kar kisi ne haath se likha' },
});

/**
 * One purchase document as the supplier reported it to the government.
 *
 * Everything the portal says is kept as the portal said it, including its own opinion about
 * whether the credit is available. That opinion is recorded, shown and never overwritten: it is
 * evidence, not our ruling.
 */
export interface PortalDocument {
  readonly id: string;
  readonly companyId: CompanyId;
  /** The 2B period the document was reported in, which need not be the month of the bill. */
  readonly period: TaxPeriod;
  readonly supplierGstin: string;
  readonly supplierName: string | null;
  readonly kind: DocumentKind;
  readonly number: string;
  readonly documentDate: IsoDate;
  readonly amounts: TaxAmounts;
  readonly invoiceValue: Money;
  /**
   * The portal's own "ITC available" flag, when it carried one.
   *
   * `null` means the file did not say. It never means yes.
   */
  readonly itcAvailableOnPortal: boolean | null;
  /** The portal's reason when it says the credit is not available, kept verbatim. */
  readonly itcUnavailableReason: string | null;
  /** Set when this document replaces an earlier one the supplier had reported. */
  readonly amends: { readonly number: string; readonly period: TaxPeriod } | null;
  /** The supplier withdrew the document after reporting it. */
  readonly reversed: boolean;
  readonly reverseCharge: boolean;
  readonly source: RecordSource;
  /** The import this row arrived on, so any figure traces back to a file and a person. */
  readonly batchId: string;
  readonly observedAt: string;
}

/**
 * One purchase document as our own books hold it, from the purchase postings (#17).
 *
 * `supplierGstin` is nullable and the null is load-bearing: a bill whose supplier registration we
 * do not hold cannot be compared with anything, and the workspace says so rather than matching it
 * on the invoice number alone and hoping.
 */
export interface BookPurchaseDocument {
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly companyId: CompanyId;
  readonly supplierPartyId: string;
  readonly supplierName: string;
  readonly supplierGstin: string | null;
  readonly kind: DocumentKind;
  readonly number: string;
  readonly documentDate: IsoDate;
  readonly period: TaxPeriod;
  readonly amounts: TaxAmounts;
  readonly invoiceValue: Money;
  /** Tax the books already treated as a cost because the law blocks the credit (section 17(5)). */
  readonly ineligibleItc: Money;
  readonly reverseCharge: boolean;
  /** Goods brought in from outside India: a different box on GSTR-3B, and never in GSTR-2B. */
  readonly imported: boolean;
  readonly voucherId: string | null;
  /** The bill was reversed in our books after posting. */
  readonly reversed: boolean;
}

// ---------------------------------------------------------------------------- matching

/**
 * What the comparison found for one pair.
 *
 * `CLOSE` is the interesting one: the same bill, from the same supplier, with a figure that does
 * not agree. It is neither a match nor a missing document, and collapsing it into either would
 * lose the only case where the shop and the supplier disagree about money.
 */
export type MatchStatus =
  | 'EXACT'
  | 'CLOSE'
  | 'ONLY_IN_BOOKS'
  | 'ONLY_ON_PORTAL'
  | 'DUPLICATE_IN_BOOKS'
  | 'DUPLICATE_ON_PORTAL';

export const MATCH_STATUS_PLAIN: Readonly<Record<MatchStatus, Bilingual>> = Object.freeze({
  EXACT: { 'en-IN': 'Agrees with the portal', 'hi-IN': 'Portal se milta hai' },
  CLOSE: { 'en-IN': 'Same bill, different figures', 'hi-IN': 'Wahi bill, figure alag' },
  ONLY_IN_BOOKS: { 'en-IN': 'In your books, not on the portal', 'hi-IN': 'Aapki books mein hai, portal par nahin' },
  ONLY_ON_PORTAL: { 'en-IN': 'On the portal, not in your books', 'hi-IN': 'Portal par hai, aapki books mein nahin' },
  DUPLICATE_IN_BOOKS: { 'en-IN': 'Recorded twice in your books', 'hi-IN': 'Aapki books mein do baar' },
  DUPLICATE_ON_PORTAL: { 'en-IN': 'Reported twice on the portal', 'hi-IN': 'Portal par do baar' },
});

/** Which fact is being compared. Exactly the five the issue names, plus the kind of document. */
export type EvidenceField =
  | 'SUPPLIER_GSTIN'
  | 'INVOICE_NUMBER'
  | 'INVOICE_DATE'
  | 'TAXABLE_VALUE'
  | 'TOTAL_TAX'
  | 'DOCUMENT_KIND';

export type EvidenceVerdict = 'AGREES' | 'DIFFERS' | 'ONLY_OURS' | 'ONLY_THEIRS';

/**
 * One fact, both sides of it, and what we made of it.
 *
 * This is the whole of the first acceptance criterion. A line's status is never asserted on its
 * own: the evidence rows are what a person reads when they want to know why the app thinks two
 * pieces of paper are the same bill, or why it thinks they are not.
 */
export interface MatchEvidence {
  readonly field: EvidenceField;
  readonly label: Bilingual;
  /** What our books say, as a person would read it. */
  readonly ours: string | null;
  /** What the portal says. */
  readonly theirs: string | null;
  readonly verdict: EvidenceVerdict;
  /** The gap, for the two money fields. Positive means our figure is the larger one. */
  readonly difference: Money | null;
}

// ---------------------------------------------------------------------------- decisions

/** The three answers IMS itself offers, in its own words. */
export type DecisionKind = 'ACCEPT' | 'REJECT' | 'PENDING';

export const DECISION_PLAIN: Readonly<Record<DecisionKind, Bilingual>> = Object.freeze({
  ACCEPT: { 'en-IN': 'Accepted', 'hi-IN': 'Maan liya' },
  REJECT: { 'en-IN': 'Rejected', 'hi-IN': 'Mana kiya' },
  PENDING: { 'en-IN': 'Kept pending', 'hi-IN': 'Abhi rok rakha hai' },
});

/**
 * A person's answer on one line.
 *
 * The fingerprint is the point of the record. It is taken over the facts that were on the screen
 * when the person pressed the button, so a later recomputation can tell "this decision still
 * covers what it decided" from "the figures moved after somebody accepted this" — and can say the
 * second one out loud instead of applying an answer to a question that has changed.
 */
export interface ItcDecision {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly period: TaxPeriod;
  readonly lineKey: string;
  readonly kind: DecisionKind;
  readonly reason: string;
  readonly decidedBy: UserId;
  readonly decidedAt: string;
  readonly fingerprint: string;
  readonly idempotencyKey: string;
}

// ---------------------------------------------------------------------------- what may be claimed

/**
 * What this module concludes about the credit on one line, and nothing more.
 *
 * It never says "you are entitled to this". Entitlement depends on facts outside any software —
 * whether the goods arrived, whether the supplier was paid within 180 days, what the goods are
 * used for. What it says is narrower and honest: whether this credit is safe to put on the return
 * this month, and if not, why not.
 */
export type ItcOutcome =
  /** Matched, the portal agrees, nobody has objected: it goes on the return. */
  | 'CLAIM_NOW'
  /** A person accepted it knowing it is not clean. It goes on the return, flagged, with their name. */
  | 'CLAIM_AT_RISK'
  /** Not on the return this month, and the line says which question is holding it. */
  | 'HELD_BACK'
  /** The books already treated the tax as a cost. There was never a credit here to claim. */
  | 'BLOCKED_IN_BOOKS';

export const OUTCOME_PLAIN: Readonly<Record<ItcOutcome, Bilingual>> = Object.freeze({
  CLAIM_NOW: { 'en-IN': 'Safe to claim this month', 'hi-IN': 'Is mahine lena theek hai' },
  CLAIM_AT_RISK: { 'en-IN': 'Claimed on your say-so, with a risk', 'hi-IN': 'Aapke kehne par liya, risk ke saath' },
  HELD_BACK: { 'en-IN': 'Held back until this is answered', 'hi-IN': 'Jawab milne tak roka gaya' },
  BLOCKED_IN_BOOKS: { 'en-IN': 'No credit here — the tax was part of the cost', 'hi-IN': 'Yahan credit nahin — tax laagat mein gaya' },
});

export type FindingSeverity = 'BLOCKING' | 'WARNING' | 'INFORMATION';

/**
 * Something a person has to know about a line or about the month.
 *
 * `whatToDo` is not optional prose. A warning a shopkeeper cannot act on is noise, and noise is
 * what teaches people to ignore the one warning that mattered.
 */
export interface ItcFinding {
  readonly code: ItcFindingCode;
  readonly severity: FindingSeverity;
  readonly message: Bilingual;
  readonly whatToDo: Bilingual;
  /** The line this is about, when it is about one. */
  readonly lineKey: string | null;
}

export type ItcFindingCode =
  | 'ITC_NO_PORTAL_DATA'
  | 'ITC_MISSING_FROM_PORTAL'
  | 'ITC_FIGURES_DIFFER'
  | 'ITC_ONLY_ON_PORTAL'
  | 'ITC_DUPLICATE_IN_BOOKS'
  | 'ITC_DUPLICATE_ON_PORTAL'
  | 'ITC_PORTAL_SAYS_UNAVAILABLE'
  | 'ITC_SUPPLIER_AMENDED'
  | 'ITC_SUPPLIER_REVERSED'
  | 'ITC_BILL_REVERSED_IN_BOOKS'
  | 'ITC_SUPPLIER_GSTIN_MISSING'
  | 'ITC_DECISION_STALE'
  | 'ITC_CLAIMED_AT_RISK';

/** One row of the reconciliation: two pieces of paper, or one and a hole where the other should be. */
export interface ReconciliationLine {
  /**
   * Stable across recomputations, which is what lets a decision outlive one.
   *
   * Built from the supplier's registration, the invoice number reduced to its characters, and the
   * kind of document — never from a figure or a date, because those are the very things that move
   * and a decision keyed on them would be lost the moment a rupee changed.
   */
  readonly key: string;
  readonly status: MatchStatus;
  readonly statusLabel: Bilingual;
  readonly book: BookPurchaseDocument | null;
  readonly portal: PortalDocument | null;
  /** Every field that was compared, agreeing or not. The whole of "match decisions show evidence". */
  readonly evidence: readonly MatchEvidence[];
  /** How confident the pairing itself is, in plain words. */
  readonly matchNote: Bilingual;
  readonly outcome: ItcOutcome;
  readonly outcomeLabel: Bilingual;
  /** The credit this line contributes to GSTR-3B. Zero on everything that is held back. */
  readonly claimable: TaxAmounts;
  /** The credit this line is keeping off the return, so a total can be shown for it. */
  readonly heldBack: TaxAmounts;
  readonly decision: ItcDecision | null;
  /** The figures moved after somebody decided. The decision stands; it is shown as out of date. */
  readonly decisionStale: boolean;
  readonly findings: readonly ItcFinding[];
  readonly sentence: Bilingual;
  /** sha256 over the facts a person would be deciding about. */
  readonly fingerprint: string;
}

// ---------------------------------------------------------------------------- the month

/** One import of portal data: which file, who, when, and what it changed. */
export interface ImportBatch {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly period: TaxPeriod;
  readonly source: RecordSource;
  readonly fileName: string | null;
  /** sha256 of the file, so the same file imported twice is recognised rather than doubled. */
  readonly checksum: string;
  readonly importedBy: UserId;
  readonly importedAt: string;
  readonly documentCount: number;
  readonly addedCount: number;
  readonly replacedCount: number;
  readonly unchangedCount: number;
  /** Rows the file carried that could not be read, with the reason. Never silently dropped. */
  readonly rejected: readonly { readonly row: string; readonly reason: string }[];
  readonly sentence: Bilingual;
}

/** Everything the reconciliation screen shows for one month. */
export interface ItcWorkspace {
  readonly period: TaxPeriod;
  readonly periodLabel: string;
  /** False when no 2B, IMS file or typed row exists for the month at all. */
  readonly portalDataPresent: boolean;
  readonly lastImport: ImportBatch | null;
  readonly lines: readonly ReconciliationLine[];
  readonly counts: Readonly<Record<MatchStatus, number>>;
  readonly outcomeCounts: Readonly<Record<ItcOutcome, number>>;
  /** Credit that goes on this month's GSTR-3B. */
  readonly claimable: TaxAmounts;
  /** Credit that does not, and the reason is on every line that makes it up. */
  readonly heldBack: TaxAmounts;
  /** Of the claimable, the part somebody accepted despite a question. */
  readonly atRisk: TaxAmounts;
  readonly findings: readonly ItcFinding[];
  readonly sentence: Bilingual;
  /** What the credit side of GSTR-3B will read, built from these decisions and no others. */
  readonly returnLinkage: Gstr3bLinkage;
}

/**
 * The bridge to the return (#30).
 *
 * The 3B module asks for an `InwardTaxSummary` and does not decide eligibility — that is written
 * into its own source. This is the object that answers it, and it is deliberately a view of the
 * lines above rather than a second calculation: if the two could disagree, one of them would be
 * wrong on a filed return.
 */
export interface Gstr3bLinkage {
  readonly period: TaxPeriod;
  /** Box 4A(5) — ordinary purchases. */
  readonly allOtherItc: TaxAmounts;
  /** Box 4A(3) — purchases where the buyer pays the tax over themselves. */
  readonly reverseChargeItc: TaxAmounts;
  /** Box 4A(4) — goods brought in from outside India. These never appear in GSTR-2B. */
  readonly importItc: TaxAmounts;
  /** Box 4B — credit given back, including credit notes the supplier reported. */
  readonly reversedItc: TaxAmounts;
  /** Tax owed on reverse-charge purchases. A liability, not a credit. */
  readonly reverseChargeLiability: TaxAmounts;
  readonly exemptInwardValue: Money;
  readonly contributions: readonly SourceRef[];
  /** Said on the 3B screen, so nobody files thinking the held-back credit was simply missed. */
  readonly caution: Bilingual;
}

// ---------------------------------------------------------------------------- policy

/**
 * How strict the comparison is for one business, effective-dated like every other tolerance here.
 *
 * The defaults are deliberately tight. A rupee of difference on a tax head is arithmetic; a
 * hundred rupees is a disagreement about money, and a product that shrugs at a hundred rupees a
 * hundred times has shrugged at ten thousand.
 */
export interface ItcMatchPolicy {
  /** Difference per tax head, in paise, still counted as agreement. */
  readonly amountTolerancePaise: bigint;
  /** How many days apart two dates may be and still be believed to be the same bill. */
  readonly dateToleranceDays: number;
  /**
   * Whether a person may accept a line the portal does not carry.
   *
   * On by default, because the credit is sometimes genuinely due and the supplier is simply late,
   * and a product that forbids it will be worked around in a spreadsheet. What it never does is
   * happen by itself: it takes a named person and a reason, and the line stays marked at risk.
   */
  readonly allowClaimWithoutPortal: boolean;
}

export const DEFAULT_MATCH_POLICY: ItcMatchPolicy = Object.freeze({
  amountTolerancePaise: 100n,
  dateToleranceDays: 7,
  allowClaimWithoutPortal: true,
});

// ---------------------------------------------------------------------------- permissions

/**
 * Four separate acts.
 *
 * Looking at the comparison is harmless. Importing portal data changes what the month says.
 * Deciding a line moves money on a return. Claiming credit the portal does not carry is the one
 * act with a real cost attached if it is wrong, so it is its own permission and not a corner of
 * the deciding one.
 */
export const ITC_PERMISSIONS = {
  view: 'itc.view',
  import: 'itc.import',
  decide: 'itc.decide',
  claimAtRisk: 'itc.claim_at_risk',
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

export const subtractAmounts = (from: TaxAmounts, less: TaxAmounts): TaxAmounts => ({
  taxableValue: { currency: 'INR', minor: from.taxableValue.minor - less.taxableValue.minor },
  cgst: { currency: 'INR', minor: from.cgst.minor - less.cgst.minor },
  sgst: { currency: 'INR', minor: from.sgst.minor - less.sgst.minor },
  igst: { currency: 'INR', minor: from.igst.minor - less.igst.minor },
  cess: { currency: 'INR', minor: from.cess.minor - less.cess.minor },
});

export const sumAmounts = (amounts: readonly TaxAmounts[]): TaxAmounts =>
  amounts.reduce((total, one) => addAmounts(total, one), emptyAmounts());

/** The tax alone, without the value of the goods. */
export const totalTaxOf = (amounts: TaxAmounts): Money => ({
  currency: 'INR',
  minor: amounts.cgst.minor + amounts.sgst.minor + amounts.igst.minor + amounts.cess.minor,
});

export const amountsAreZero = (amounts: TaxAmounts): boolean =>
  amounts.taxableValue.minor === 0n && totalTaxOf(amounts).minor === 0n;
