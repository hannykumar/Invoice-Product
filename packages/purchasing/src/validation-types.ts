// Issue #16 [E16] — the vocabulary of a purchase-validation verdict.
// See docs/contracts/purchase-validation-v1.md.
//
// Nothing in this file posts anything. A verdict is an opinion about whether a draft
// from #15 is safe for #17 to post, together with the evidence behind that opinion.

import type { Id, IsoDate, Paise } from "../../masters/src/types.ts";
import type { FieldEvidence } from "./inbox-types.ts";

/**
 * MATERIAL findings block outright: confirming them is not offered, because no amount of
 * human confidence makes a duplicate payment or a mistyped GST number safe. SIGNIFICANT
 * findings need a person, and may be confirmed with a reason. MINOR findings are shown so
 * the reviewer is not surprised later, and cost nothing.
 */
export type FindingSeverity = "MATERIAL" | "SIGNIFICANT" | "MINOR";

export type FindingCode =
  | "SUPPLIER_GSTIN_INVALID"
  | "SUPPLIER_GSTIN_UNKNOWN"
  | "SUPPLIER_GSTIN_MISMATCH"
  | "SUPPLIER_NAME_MISMATCH"
  | "SUPPLIER_STATE_MISMATCH"
  | "INVOICE_NUMBER_MISSING"
  | "INVOICE_DATE_MISSING"
  | "INVOICE_DATE_IN_FUTURE"
  | "INVOICE_DATE_TOO_OLD"
  | "HSN_INVALID"
  | "LINE_ARITHMETIC"
  | "TAXABLE_VALUE_MISMATCH"
  | "TAX_MISMATCH"
  | "TOTAL_MISMATCH"
  | "TAX_SPLIT_UNDECIDED"
  | "TAX_RULES_NOT_CONSULTED"
  | "PLACE_OF_SUPPLY_UNKNOWN"
  | "GST_RATE_MISSING"
  | "DUPLICATE_CONFIRMED"
  | "DUPLICATE_LIKELY"
  | "DUPLICATE_POSSIBLE"
  | "INVOICE_AMENDMENT";

/** A single thing that did not pass cleanly, in words a shopkeeper can act on. */
export interface Finding {
  readonly code: FindingCode;
  readonly severity: FindingSeverity;
  /** The draft field this is about, e.g. "invoiceTotalPaise" or "lines[2].hsnSac". */
  readonly field: string;
  /** Written for someone who has never studied accounting. */
  readonly message: string;
  /** Where the value came from on the page, when #15 gave us one. */
  readonly evidence?: FieldEvidence;
  /** Present when the check compared two figures. Paise, as decimal strings. */
  readonly documentSays?: string;
  readonly weCalculated?: string;
}

/** The specific edit that would clear a finding. Accepting one is an idempotent command under #6. */
export interface Correction {
  readonly field: string;
  readonly clears: FindingCode;
  readonly currentValue: string | null;
  readonly suggestedValue: string | null;
  /** Why this is being suggested, in plain words. */
  readonly reason: string;
  readonly evidence?: FieldEvidence;
}

export type DuplicateVerdict = "NONE" | "POSSIBLE" | "LIKELY" | "CONFIRMED" | "AMENDMENT";

export interface DuplicateMatch {
  /** The purchase already on record that this draft resembles. */
  readonly purchaseId: Id;
  readonly invoiceNumber: string;
  readonly invoiceDate: IsoDate;
  readonly invoiceTotalPaise: string;
  readonly enteredOn: IsoDate;
  /** Fields that agreed, and fields that did not. Both are shown to the reviewer. */
  readonly agreed: readonly string[];
  readonly disagreed: readonly string[];
  /** 0 to 1, computed from which fields matched. Not a model score. */
  readonly confidence: number;
  readonly matchedBy: readonly ("LOGICAL_KEY" | "CONTENT_FINGERPRINT")[];
}

export interface DuplicateAssessment {
  readonly verdict: DuplicateVerdict;
  readonly matches: readonly DuplicateMatch[];
  /** Stable hash over the invoice's identifying content; survives a re-scan or a retype. */
  readonly fingerprint: string;
  readonly message: string;
}

/**
 * Whether tax could be checked against the rules engine (#7/#25), or only against the
 * document's own internal arithmetic. A caller must never mistake one for the other.
 */
export type TaxCheckBasis = "RULES_ENGINE" | "SELF_CONSISTENCY_ONLY";

export interface TaxCheck {
  readonly basis: TaxCheckBasis;
  /** Set when the rules engine answered. */
  readonly intraState?: boolean;
  readonly ruleSetVersion?: string;
  readonly ruleId?: string;
  /** Set when it could not answer; these are the facts it wanted. */
  readonly missingFacts?: readonly string[];
  readonly explanation: string;
}

/** Totals this contract worked out itself, from the lines upward. Never read off the page. */
export interface RecomputedTotals {
  readonly taxableValuePaise: Paise;
  readonly totalTaxPaise: Paise;
  readonly invoiceTotalPaise: Paise;
  /** Per-line taxable value, in the order the lines arrived. */
  readonly linesTaxableValuePaise: readonly Paise[];
  /** Lines whose own quantity × rate did not match the taxable value printed on them. */
  readonly lineProblems: readonly string[];
  /** True when every figure could be worked out; false means some lines were unreadable. */
  readonly complete: boolean;
}

/**
 * Per-company, effective-dated. Recorded on the verdict so a decision made last year can be
 * explained under the tolerance that was in force then. Widening it is permission-gated (#6).
 */
export interface TolerancePolicy {
  /** Absorbs ordinary GST rounding. Default ₹1. */
  readonly roundingPaise: Paise;
  readonly taxAbsolutePaise: Paise;
  readonly totalAbsolutePaise: Paise;
  /** Basis points of the invoice total. Default 10 = 0.1%. */
  readonly totalRelativeBasisPoints: number;
  readonly effectiveFrom: IsoDate;
}

export const DEFAULT_TOLERANCE: TolerancePolicy = Object.freeze({
  roundingPaise: 100n,
  taxAbsolutePaise: 100n,
  totalAbsolutePaise: 100n,
  totalRelativeBasisPoints: 10,
  effectiveFrom: "2026-04-01",
});

export type ValidationStatus = "POSTABLE" | "NEEDS_REVIEW" | "BLOCKED";

export interface PurchaseVerdict {
  readonly draftId: Id;
  readonly companyId: Id;
  readonly status: ValidationStatus;
  readonly findings: readonly Finding[];
  readonly duplicate: DuplicateAssessment;
  readonly recomputed: RecomputedTotals;
  readonly taxCheck: TaxCheck;
  readonly corrections: readonly Correction[];
  readonly policy: TolerancePolicy;
  /** Identical inputs give an identical verdict, so a retry is idempotent (#6). */
  readonly fingerprint: string;
  /** One line the reviewer sees first. */
  readonly summary: string;
}

/** A purchase already on record, as much of it as duplicate detection needs. */
export interface ExistingPurchase {
  readonly id: Id;
  readonly companyId: Id;
  readonly supplierGstin: string;
  readonly invoiceNumber: string;
  readonly invoiceDate: IsoDate;
  readonly invoiceTotalPaise: Paise;
  readonly enteredOn: IsoDate;
  readonly contentFingerprint: string;
  /** Set when this document itself says it revises another invoice. */
  readonly amendsInvoiceNumber?: string;
}

/**
 * What #16 needs from the rules engine (#7). Deliberately narrow: the whole engine is not
 * imported here, so a change inside GPT 1's package cannot break purchase posting.
 */
export interface TaxSplitPort {
  splitFor(input: {
    readonly supplierStateCode: string;
    readonly placeOfSupplyStateCode: string;
    readonly documentDate: IsoDate;
  }): TaxSplitAnswer;
}

export type TaxSplitAnswer =
  | {
      readonly kind: "SPLIT";
      readonly intraState: boolean;
      readonly ruleSetVersion: string;
      readonly ruleId: string;
      readonly explanation: string;
    }
  | { readonly kind: "CANNOT_DECIDE"; readonly missingFacts: readonly string[]; readonly explanation: string };
