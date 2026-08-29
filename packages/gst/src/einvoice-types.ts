// Issue #26 [E26] — what an e-invoice is, and what it is not.
//
// The issue's second non-goal is "assume every GST invoice needs an IRN", and it is the one most
// easily broken by accident: the safe-looking default is to register everything, and it is wrong.
// Most invoices a small shop raises need no IRN at all, and registering one that did not need it
// puts a document on the government's record that cannot be quietly withdrawn after 24 hours.
//
// So applicability is a decision with a reason, a rule id and an effective date — never a default.
//
// The other thing this file exists to keep straight is the difference between an invoice and a
// registered e-invoice. They are different documents with different states, and the first
// acceptance criterion is that the two are never confused.

import type { Id, IsoDate, Paise } from "../../masters/src/types.ts";

// ------------------------------------------------------------------------ applicability

/** What kind of document is being reported. Only these three can carry an IRN. */
export type EInvoiceDocumentType = "INVOICE" | "CREDIT_NOTE" | "DEBIT_NOTE";

/**
 * Who the document is for, in the government's terms rather than ours.
 *
 * `B2C` is here so it can be ruled out explicitly: a business-to-consumer sale never carries an
 * IRN, however large it is. Large B2C invoices need a dynamic QR code, which is a different
 * obligation and is not this module's.
 */
export type EInvoiceRecipientKind =
  | "B2B"
  | "B2C"
  | "EXPORT_WITH_PAYMENT"
  | "EXPORT_WITHOUT_PAYMENT"
  | "SEZ_WITH_PAYMENT"
  | "SEZ_WITHOUT_PAYMENT"
  | "DEEMED_EXPORT";

/**
 * Businesses the notifications exempt from e-invoicing whatever their turnover.
 *
 * Kept as a list on the company rather than inferred, because guessing that a taxpayer is a bank
 * from its name is exactly the sort of invention rule 4 of the brief forbids.
 */
export type ExemptCategory =
  | "SEZ_UNIT"
  | "INSURANCE"
  | "BANKING_OR_NBFC"
  | "GOODS_TRANSPORT_AGENCY"
  | "PASSENGER_TRANSPORT"
  | "CINEMA_ADMISSION"
  | "GOVERNMENT_DEPARTMENT";

/**
 * One turnover threshold and the notification that set it.
 *
 * Effective-dated because the threshold has moved five times, and an invoice raised in 2022 must
 * be judged under the threshold in force in 2022 rather than today's.
 */
export interface TurnoverThreshold {
  readonly effectiveFrom: IsoDate;
  /** Aggregate annual turnover at or above which e-invoicing applies, in paise. */
  readonly thresholdPaise: Paise;
  /** The notification this came from, so the decision can be traced to paper (#54). */
  readonly sourceRef: string;
  readonly ruleId: string;
}

/** What the caller must tell us about the supplier. Nothing here is guessed. */
export interface EInvoiceSupplierFacts {
  readonly gstin: string;
  /** Aggregate annual turnover for the relevant year, in paise. */
  readonly aggregateTurnoverPaise?: Paise;
  /** Which year that turnover figure is for, e.g. "2024-2025". */
  readonly turnoverFinancialYear?: string;
  readonly exemptCategories?: readonly ExemptCategory[];
  /** Set when the business has been told by the department that it must report, regardless. */
  readonly mandatedByDepartment?: boolean;
}

export interface EInvoiceApplicabilityInput {
  readonly documentType: EInvoiceDocumentType;
  readonly documentDate: IsoDate;
  readonly recipientKind: EInvoiceRecipientKind;
  /** The buyer's GSTIN. Required for B2B; its absence is itself a reason. */
  readonly recipientGstin?: string;
  readonly supplier: EInvoiceSupplierFacts;
  /** A bill of supply carries no tax and never carries an IRN. */
  readonly isBillOfSupply?: boolean;
}

export type ApplicabilityOutcome =
  /** An IRN must be obtained before this invoice is given to the customer. */
  | "APPLICABLE"
  /** No IRN is needed. The ordinary case for most small businesses. */
  | "NOT_APPLICABLE"
  /** We were not told something we need, and will not guess. Goes to the exception queue. */
  | "CANNOT_DECIDE";

export interface ApplicabilityDecision {
  readonly outcome: ApplicabilityOutcome;
  /** Written for a shopkeeper, saying what was decided and why. */
  readonly reason: string;
  /** The rule that decided it, so the decision is explainable years later. */
  readonly ruleId: string;
  readonly ruleSetVersion: string;
  /** The notification or circular behind the rule. */
  readonly sourceRef?: string;
  /** Facts we would have needed. Only set on `CANNOT_DECIDE`. */
  readonly missingFacts?: readonly string[];
  /** The threshold in force on the document date, when turnover was the deciding factor. */
  readonly thresholdApplied?: TurnoverThreshold;
}

// ------------------------------------------------------------------------ the IRN record

/**
 * Where a document stands with the government.
 *
 * `NOT_APPLICABLE` and `REGISTERED` are the two ends, and everything between them is honest about
 * not being either. In particular `PENDING` never reads as registered: an invoice whose IRP call
 * timed out is not a registered e-invoice, and showing it as one would be the single most
 * damaging thing this module could do.
 */
export type EInvoiceStatus =
  | "NOT_APPLICABLE"
  | "PENDING"
  | "REGISTERED"
  | "CANCELLED"
  | "FAILED";

/** What the government sent back, kept exactly as received so it can be produced on demand. */
export interface IrpAcknowledgement {
  /** 64 lowercase hex characters. Verified before anything is marked registered. */
  readonly irn: string;
  readonly ackNumber: string;
  readonly ackDate: string;
  /** The signed QR code the buyer's copy must carry. Stored verbatim, never regenerated. */
  readonly signedQrCode: string;
  /** The signed invoice JSON, when the provider returns one. */
  readonly signedInvoice?: string;
  /** Set when the IRP generated an e-way bill alongside. #27 owns what happens next. */
  readonly ewayBillNumber?: string;
  readonly providerRequestId: string;
  readonly receivedAt: string;
}

/** Why an e-invoice was cancelled. The government accepts only these four. */
export type CancelReasonCode = "DUPLICATE" | "DATA_ENTRY_MISTAKE" | "ORDER_CANCELLED" | "OTHER";

export interface EInvoiceRecord {
  readonly id: Id;
  readonly companyId: Id;
  /** The sales invoice (#9) this belongs to. One live e-invoice per document, ever. */
  readonly documentId: Id;
  readonly documentNumber: string;
  readonly documentDate: IsoDate;
  readonly documentType: EInvoiceDocumentType;
  readonly supplierGstin: string;
  readonly recipientGstin?: string;
  readonly financialYear: string;
  readonly status: EInvoiceStatus;
  readonly applicability: ApplicabilityDecision;
  /** Present once registered. Absent while pending, and after a failure. */
  readonly acknowledgement?: IrpAcknowledgement;
  /** Plain words about the last thing that happened, including a failure. */
  readonly message: string;
  /** Set when the IRP refused. Kept so a person can act on it. */
  readonly failure?: { readonly code: string; readonly message: string; readonly retryable: boolean };
  readonly cancelledAt?: string;
  readonly cancelReasonCode?: CancelReasonCode;
  readonly cancelReason?: string;
  /** The last moment this may still be cancelled with the government. */
  readonly cancellableUntil?: string;
  /** The last moment this may still be reported without being late. */
  readonly reportableUntil?: IsoDate;
  readonly createdBy: Id;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly idempotencyKey: string;
}

/**
 * Per company and effective-dated, recorded on every decision, exactly as #16's tolerance and
 * #18's are. Two businesses may be under different thresholds on the same day.
 */
export interface EInvoicePolicy {
  /** Hours after acknowledgement during which the government still accepts a cancellation. */
  readonly cancellationWindowHours: number;
  /** Days after the document date within which it must be reported, when a limit applies. */
  readonly reportingWindowDays?: number;
  /** Whether to check the IRN the provider returned against the published formula. */
  readonly verifyIrnHash: boolean;
  readonly effectiveFrom: IsoDate;
}

export const DEFAULT_EINVOICE_POLICY: EInvoicePolicy = Object.freeze({
  cancellationWindowHours: 24,
  reportingWindowDays: 30,
  verifyIrnHash: true,
  effectiveFrom: "2026-04-01",
});
