// Issue #19 [E19] — the vocabulary of a supplier warning.
//
// This module exists to say true things about a supplier and to stop short of saying untrue ones.
// A cancelled GST number is a fact with a date and a source. "This supplier is a fraud" is a
// judgement we are not entitled to make, cannot support, and would be sued over — so nothing here
// can produce it, and `supplier-risk-wording.ts` enforces that mechanically.
//
// Three rules shape every type below:
//
//   1. Every warning carries its evidence: what was seen, where it came from, and when.
//   2. Government data we could not fetch, or fetched a week ago, is labelled as such and can
//      never on its own make a supplier look bad. Absence of evidence is not evidence.
//   3. A model's opinion is never evidence. It may be shown, clearly marked as a guess, and it
//      can never raise the level on its own.

import type { Id, IsoDate, Paise } from "../../masters/src/types.ts";

// ---------------------------------------------------------------------------- evidence

/**
 * Where a fact came from. The user sees this named on every warning, because "the GST portal said
 * so on Tuesday" and "our own books say so" carry very different weight in an argument.
 */
export type EvidenceSource =
  /** The government's GST records, through the `gst` connector (#8). */
  | "GST_PORTAL"
  /** IMS / GSTR-2B, when #31 supplies it. Optional throughout. */
  | "IMS_GSTR2B"
  /** This company's own books, masters and payment history. Always available, never stale. */
  | "OUR_RECORDS"
  /** What the supplier's own document claims. A claim, not an independent fact. */
  | "SUPPLIER_DOCUMENT";

/** Why a source could not answer. Never blamed on the supplier. */
export type UnavailableReason = "PROVIDER_OUTAGE" | "TIMEOUT" | "NOT_CONFIGURED" | "NOT_PERMITTED" | "NO_RECORD";

/**
 * One observed fact.
 *
 * `observedAt` is the moment we asked, and is what makes staleness visible: a GST status read
 * eleven days ago is still shown, but it is shown as eleven days old rather than as the truth.
 */
export interface Evidence {
  readonly source: EvidenceSource;
  /** The fact, stated plainly and without inference. */
  readonly statement: string;
  /** When the fact itself took effect, where the source gives a date — e.g. cancellation date. */
  readonly effectiveFrom?: IsoDate;
  /** When we read it. Absent only for `OUR_RECORDS`, which is read live. */
  readonly observedAt?: string;
  /** How old the reading was when this assessment was made. */
  readonly ageInDays?: number;
  /** True when the reading is older than the company's freshness policy allows. */
  readonly stale: boolean;
  /** Set when the source could not answer at all. `statement` then says so in plain words. */
  readonly unavailable?: { readonly reason: UnavailableReason; readonly retryable: boolean };
}

// ------------------------------------------------------------------------ GST records

/**
 * A GST registration's status, as the portal reports it.
 *
 * `UNKNOWN` is not a status the portal returns — it is what we record when we could not ask, and
 * it is deliberately distinct from `NOT_FOUND`, which is the portal actively saying there is no
 * such registration. Collapsing the two would turn an outage into an accusation.
 */
export type GstinStatus =
  | "ACTIVE" | "CANCELLED" | "SUSPENDED" | "PROVISIONAL" | "INACTIVE" | "NOT_FOUND" | "UNKNOWN";

/** A return the supplier has filed, as far as the portal will tell us. */
export interface FilingRecord {
  /** GST return period, "MM-YYYY" as the portal writes it. */
  readonly period: string;
  readonly returnType: "GSTR1" | "GSTR3B";
  readonly filedOn?: IsoDate;
  readonly status: "FILED" | "NOT_FILED";
}

export interface GstinRecord {
  readonly gstin: string;
  readonly status: GstinStatus;
  readonly legalName?: string;
  readonly tradeName?: string;
  readonly stateCode?: string;
  readonly registeredOn?: IsoDate;
  /** The date a cancellation or suspension took effect. The whole user example turns on this. */
  readonly statusChangedOn?: IsoDate;
  /** Most recent periods first. Empty means the portal did not tell us, not "never filed". */
  readonly filings: readonly FilingRecord[];
  /** Whether this taxpayer is required to issue e-invoices, where the portal says. */
  readonly eInvoiceEnabled?: boolean;
  /** When this reading was taken. */
  readonly observedAt: string;
}

/** What a lookup returned, or why it could not. */
export type GstinLookupOutcome =
  | { readonly kind: "FOUND"; readonly record: GstinRecord }
  | {
      readonly kind: "UNAVAILABLE";
      readonly reason: UnavailableReason;
      readonly retryable: boolean;
      /** A reading we already had, however old. Shown as stale rather than thrown away. */
      readonly lastKnown?: GstinRecord;
      readonly explanation: string;
    };

// ----------------------------------------------------------------- our own records

/** A change to where a supplier wants to be paid. The classic invoice-redirection warning. */
export interface BankDetailChange {
  readonly bankAccountId: Id;
  readonly changedOn: IsoDate;
  readonly recordedAt: string;
  readonly recordedBy: Id;
  /** Masked to the last four digits. A full account number never leaves this module. */
  readonly previousAccountMasked: string;
  readonly currentAccountMasked: string;
  readonly previousIfsc?: string;
  readonly currentIfsc?: string;
  readonly reason?: string;
}

/** What our own books say about this supplier. Always available, so never stale. */
export interface SupplierHistory {
  /** How many bills we have recorded from them, ever. Zero means they are new to us. */
  readonly billsRecorded: number;
  readonly firstBillDate?: IsoDate;
  readonly totalOutstandingPaise: Paise;
  /** Bills of theirs we are past the due date on. Our problem, but relevant to the relationship. */
  readonly overdueDocuments: number;
  readonly oldestOverdueDays: number;
  /** Bills someone here has marked as disputed, with the reason kept. */
  readonly openDisputes: readonly { readonly documentNumber: string; readonly raisedOn: IsoDate; readonly note: string }[];
  readonly bankDetailChanges: readonly BankDetailChange[];
}

/**
 * The optional signal #31 will supply once IMS/GSTR-2B reconciliation exists.
 *
 * Everything here is optional and absence is never held against the supplier: until #31 ships,
 * every assessment simply says this was not checked.
 */
export interface Gstr2bSignal {
  readonly period: string;
  /** Whether this invoice appeared in the data we hold. */
  readonly present: boolean;
  /** Set when it appeared but the figures differ. Paise, as decimal strings. */
  readonly theirTaxableValue?: string;
  readonly ourTaxableValue?: string;
  readonly observedAt: string;
}

/**
 * A model's opinion, if the product ever has one.
 *
 * Deliberately typed and deliberately inert: `assessSupplierRisk` shows it, labels it as a guess,
 * and never lets it change the level. The acceptance criterion is that no party is called
 * fraudulent from a score, and the cheapest way to guarantee that is to make it impossible.
 */
export interface ModelHint {
  readonly label: string;
  /** 0 to 1. Recorded for the record, never compared against a threshold here. */
  readonly score: number;
  readonly explanation: string;
  readonly modelVersion: string;
}

// ------------------------------------------------------------------------- warnings

export type SupplierRiskCode =
  /** The registration was cancelled on or before the date of the bill. The user's own example. */
  | "GSTIN_CANCELLED_BEFORE_INVOICE"
  /** Cancelled, but after the bill was raised — the bill itself may still be perfectly good. */
  | "GSTIN_CANCELLED_AFTER_INVOICE"
  | "GSTIN_SUSPENDED"
  | "GSTIN_INACTIVE"
  /** The portal has no such registration. Different from "we could not ask". */
  | "GSTIN_NOT_FOUND"
  | "GSTIN_PROVISIONAL"
  | "GSTIN_REGISTERED_RECENTLY"
  | "GSTIN_NAME_DIFFERS"
  | "GSTIN_STATE_DIFFERS"
  | "RETURNS_NOT_FILED"
  | "EINVOICE_EXPECTED_BUT_ABSENT"
  /** From #31 when it exists. */
  | "NOT_IN_GSTR2B"
  | "GSTR2B_VALUE_DIFFERS"
  | "BANK_DETAILS_CHANGED"
  | "OVERDUE_TO_SUPPLIER"
  | "OPEN_DISPUTE"
  | "FIRST_TIME_SUPPLIER"
  /** We have a reading, but an old one. */
  | "GOVERNMENT_DATA_STALE"
  /** We have no reading at all. */
  | "GOVERNMENT_DATA_UNAVAILABLE"
  /** IMS/GSTR-2B has not been connected yet (#31). */
  | "GSTR2B_NOT_CHECKED"
  /** A model's guess, shown as a guess. */
  | "MODEL_HINT";

/**
 * How much attention a warning deserves.
 *
 * There is no "FRAUD" level and there never will be. `SERIOUS` means "stop and check before you
 * pay", which is the strongest thing a buyer's own software is entitled to say.
 */
export type RiskLevel = "INFORMATION" | "CAUTION" | "SERIOUS";

export interface SupplierRiskWarning {
  readonly code: SupplierRiskCode;
  readonly level: RiskLevel;
  /** Written for a shopkeeper, factual, and never an accusation. */
  readonly message: string;
  /** What a person should actually do about it. */
  readonly suggestedAction: string;
  /** At least one, always. A warning with no evidence is not a warning we are willing to show. */
  readonly evidence: readonly Evidence[];
}

/** Which sources answered, so the reader knows how complete the picture is. */
export interface SourceStatus {
  readonly source: EvidenceSource;
  readonly consulted: boolean;
  readonly answered: boolean;
  readonly stale: boolean;
  readonly observedAt?: string;
  readonly note: string;
}

/**
 * `COMPLETE` — every source we wanted answered, and answered recently.
 * `PARTIAL` — something was stale, unavailable or not yet connected, and the reader is told which.
 */
export type AssessmentConfidence = "COMPLETE" | "PARTIAL";

export interface SupplierRiskAssessment {
  readonly companyId: Id;
  readonly supplierPartyId: Id;
  readonly supplierName: string;
  readonly gstin?: string;
  /** The bill this was assessed for, when it was assessed against one. */
  readonly invoiceNumber?: string;
  readonly invoiceDate?: IsoDate;
  /** The highest level among the warnings. `INFORMATION` when there is nothing to flag. */
  readonly level: RiskLevel;
  readonly warnings: readonly SupplierRiskWarning[];
  readonly sources: readonly SourceStatus[];
  readonly confidence: AssessmentConfidence;
  readonly policy: RiskPolicy;
  /** Identical inputs give an identical assessment, so a retry is idempotent (#6). */
  readonly fingerprint: string;
  /** One line the buyer reads first. Never an accusation. */
  readonly summary: string;
  readonly assessedAt: string;
}

/**
 * Per company and effective-dated, recorded on every assessment, so a decision taken last year is
 * explained under the policy in force then. Same reasoning as #16's and #18's tolerances.
 */
export interface RiskPolicy {
  /** A government reading older than this is shown as stale. Default 7 days. */
  readonly governmentDataStaleAfterDays: number;
  /** A registration younger than this is worth mentioning. Default 180 days. */
  readonly newRegistrationDays: number;
  /** A bank-detail change more recent than this is worth mentioning. Default 90 days. */
  readonly bankChangeRecentDays: number;
  /** Missed return periods before it is worth mentioning. Default 2. */
  readonly missedReturnPeriods: number;
  readonly effectiveFrom: IsoDate;
}

export const DEFAULT_RISK_POLICY: RiskPolicy = Object.freeze({
  governmentDataStaleAfterDays: 7,
  newRegistrationDays: 180,
  bankChangeRecentDays: 90,
  missedReturnPeriods: 2,
  effectiveFrom: "2026-04-01",
});

/**
 * A person deciding to go ahead despite a warning, with their reason kept.
 *
 * Pinned to the assessment's fingerprint, so acknowledging "their GST number was cancelled" does
 * not silently cover a different warning that appears next week.
 */
export interface RiskAcknowledgement {
  readonly assessmentFingerprint: string;
  readonly supplierPartyId: Id;
  readonly acknowledgedBy: Id;
  readonly acknowledgedAt: string;
  readonly reason: string;
  readonly accepted: readonly SupplierRiskCode[];
}
