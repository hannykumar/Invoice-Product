// Types for the purchase-invoice inbox (issue #15).
//
// The inbox's whole job is to turn a document that arrived from somewhere into a
// reviewable draft. It never posts, never touches stock and never creates a payable.
// Issues #16 and #17 do that, after a human has looked at what is here.

import type { Id, IsoDate, Paise } from "../../masters/src/types.ts";

export type IntakeChannel = "manual_upload" | "camera" | "email" | "whatsapp" | "einvoice_json" | "api";

/**
 * Where a document is in its life. Nothing past `draft_ready` exists in this module:
 * validation is #16 and posting is #17.
 */
export type InboundStatus =
  | "received"      // stored, nothing read yet
  | "screening"     // attachment safety checks running
  | "quarantined"   // unsafe, unsupported, unroutable or too uncertain to work with
  | "extracting"    // OCR or JSON parsing running
  | "draft_ready"   // an extraction draft exists and is waiting for a human
  | "failed"        // a step failed; retryable
  | "discarded";    // a human rejected it, or it was a duplicate of another document

export type QuarantineReason =
  | "UNSUPPORTED_FILE_TYPE"
  | "FILE_TYPE_MISMATCH"
  | "FILE_TOO_LARGE"
  | "PASSWORD_PROTECTED"
  | "ACTIVE_CONTENT"
  | "MALWARE_SUSPECTED"
  | "COMPANY_NOT_IDENTIFIED"
  | "COMPANY_MISMATCH"
  | "NOT_AN_INVOICE"
  | "UNREADABLE"
  | "EXTRACTION_TOO_UNCERTAIN";

export interface Attachment {
  readonly id: Id;
  readonly fileName: string;
  /** What the sender claimed. Screening compares it against the actual bytes. */
  readonly declaredMimeType: string;
  readonly sizeBytes: number;
  /** SHA-256 of the file, the primary duplicate key. */
  readonly sha256: string;
  /** Reference in object storage. Never the bytes themselves. */
  readonly storageKey: string;
  readonly pageCount?: number;
}

export interface InboundSender {
  readonly channel: IntakeChannel;
  /** Email address, WhatsApp number or user id, depending on channel. */
  readonly address: string;
  readonly displayName?: string;
  /** Provider message id, used to make channel retries idempotent. */
  readonly providerMessageId?: string;
}

export interface InboundDocument {
  readonly id: Id;
  readonly companyId: Id;
  readonly branchId?: Id;
  readonly channel: IntakeChannel;
  readonly sender: InboundSender;
  readonly attachment: Attachment;
  readonly receivedAt: string;
  readonly status: InboundStatus;
  readonly quarantineReason?: QuarantineReason;
  /** Wording a shopkeeper can act on, shown next to the document in the inbox. */
  readonly statusMessage?: string;
  /** Set when this document is a repeat of one already in the inbox. */
  readonly duplicateOfId?: Id;
  readonly attempts: number;
  /** How the company was decided, kept so a wrong routing can be explained. */
  readonly routing?: RoutingDecision;
}

export type RoutingBasis = "buyer_gstin" | "channel_binding" | "explicit_company" | "sender_known_supplier";

export interface RoutingDecision {
  readonly basis: RoutingBasis;
  readonly evidence: string;
  readonly confidence: number;
  /** Other companies that were considered, so a mis-route is explainable. */
  readonly rejected?: readonly { readonly companyId: Id; readonly why: string }[];
}

/** Where in the source document a value was found, so the UI can highlight it. */
export interface FieldEvidence {
  /** 1-based page. 0 means the value came from structured JSON rather than a page. */
  readonly page: number;
  /** The exact text the value was read from. */
  readonly text: string;
  /** Fractional page coordinates (0-1), so any zoom level can draw the box. */
  readonly box?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** For e-invoice JSON, the path the value came from, e.g. "DocDtls.No". */
  readonly jsonPath?: string;
}

export interface ExtractedField<T> {
  readonly value: T;
  /** 0 to 1. 1 means read from signed structured data, not guessed from pixels. */
  readonly confidence: number;
  readonly evidence: FieldEvidence;
  /** Set when a cross-check disagreed with the read value. */
  readonly warning?: string;
}

export interface ExtractedLine {
  readonly description: ExtractedField<string>;
  readonly hsnSac?: ExtractedField<string>;
  readonly quantity?: ExtractedField<string>;
  readonly unit?: ExtractedField<string>;
  readonly ratePaise?: ExtractedField<Paise>;
  readonly taxableValuePaise?: ExtractedField<Paise>;
  readonly gstRateBasisPoints?: ExtractedField<number>;
}

/**
 * The reviewable result. Nothing here is a posting: it is what the document appears to
 * say, with a confidence and a source for every value.
 */
export interface ExtractionDraft {
  readonly id: Id;
  readonly companyId: Id;
  readonly documentId: Id;
  readonly source: "einvoice_json" | "ocr" | "manual";
  readonly supplierGstin?: ExtractedField<string>;
  readonly supplierName?: ExtractedField<string>;
  readonly buyerGstin?: ExtractedField<string>;
  readonly invoiceNumber?: ExtractedField<string>;
  readonly invoiceDate?: ExtractedField<IsoDate>;
  readonly taxableValuePaise?: ExtractedField<Paise>;
  readonly totalTaxPaise?: ExtractedField<Paise>;
  readonly invoiceTotalPaise?: ExtractedField<Paise>;
  readonly irn?: ExtractedField<string>;
  readonly lines: readonly ExtractedLine[];
  /** Suggested master matches. Suggestions only; #16 decides, a human confirms. */
  readonly supplierPartyId?: Id;
  /** Fields the reviewer must look at before this can move on. */
  readonly fieldsNeedingReview: readonly string[];
  /** Deterministic cross-checks that did not add up. */
  readonly arithmeticProblems: readonly string[];
  readonly createdAt: string;
}

/** A duplicate key that survives re-sends: same supplier, number, date and total. */
export interface LogicalInvoiceKey {
  readonly supplierGstin: string;
  readonly invoiceNumber: string;
  readonly invoiceDate: string;
  readonly invoiceTotalPaise: string;
}
