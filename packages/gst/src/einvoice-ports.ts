// Issue #26 [E26] — the narrow surfaces the e-invoice lifecycle needs.

import type { CompanyId } from "@invoice/kernel";
import type { Id, IsoDate } from "../../masters/src/types.ts";
import type {
  CancelReasonCode, EInvoicePolicy, EInvoiceRecord, IrpAcknowledgement,
} from "./einvoice-types.ts";
import type { EInvoiceDocument } from "./payload.ts";

/** What the Invoice Registration Portal can do, in this module's own terms. */
export interface IrpPort {
  /**
   * Registers a document and returns the government's acknowledgement.
   *
   * A provider that reports the document as already registered must return
   * `{ kind: "DUPLICATE" }` with the existing IRN rather than an error: a retry after a timeout is
   * the ordinary case, and it must end with the caller holding the right IRN.
   */
  generate(companyId: CompanyId, document: EInvoiceDocument, payload: Readonly<Record<string, unknown>>, idempotencyKey: string): Promise<IrpGenerateOutcome>;
  /** Looks up an acknowledgement the portal already holds. */
  fetch(companyId: CompanyId, irn: string): Promise<IrpFetchOutcome>;
  cancel(companyId: CompanyId, input: { readonly irn: string; readonly reasonCode: CancelReasonCode; readonly reason: string; readonly idempotencyKey: string }): Promise<IrpCancelOutcome>;
}

export type IrpGenerateOutcome =
  | { readonly kind: "REGISTERED"; readonly acknowledgement: IrpAcknowledgement }
  /** Already on the government's record. Carries the IRN it already has. */
  | { readonly kind: "DUPLICATE"; readonly acknowledgement: IrpAcknowledgement; readonly message: string }
  /** The portal refused the document itself. Retrying unchanged will refuse again. */
  | { readonly kind: "REJECTED"; readonly code: string; readonly message: string; readonly fieldHints?: readonly string[] }
  /** We could not reach the portal, or it failed. The document's state is unknown. */
  | { readonly kind: "UNAVAILABLE"; readonly code: string; readonly message: string; readonly retryable: boolean };

export type IrpFetchOutcome =
  | { readonly kind: "FOUND"; readonly acknowledgement: IrpAcknowledgement; readonly cancelled: boolean }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "UNAVAILABLE"; readonly code: string; readonly message: string; readonly retryable: boolean };

export type IrpCancelOutcome =
  | { readonly kind: "CANCELLED"; readonly cancelledAt: string }
  /** Outside the government's window, or already cancelled. */
  | { readonly kind: "REFUSED"; readonly code: string; readonly message: string }
  | { readonly kind: "UNAVAILABLE"; readonly code: string; readonly message: string; readonly retryable: boolean };

/**
 * Issue #366 — one page of a list. Rows come oldest first (`createdAt`, then `id`); `after` is the
 * id of the last row of the page before. Left out, a list returns everything, as it always has.
 */
export interface EInvoicePage { readonly limit: number; readonly after?: string }

export interface EInvoiceRepository {
  /** Refuses a second record for one sales document, or a second holder of one IRN, with `EINVOICE_DUPLICATE`. */
  insert(record: EInvoiceRecord): Promise<void>;
  update(record: EInvoiceRecord): Promise<void>;
  findById(companyId: CompanyId, id: Id): Promise<EInvoiceRecord | null>;
  /** The one that matters: one live e-invoice per sales document. */
  findByDocumentId(companyId: CompanyId, documentId: Id): Promise<EInvoiceRecord | null>;
  findByIrn(companyId: CompanyId, irn: string): Promise<EInvoiceRecord | null>;
  list(companyId: CompanyId, page?: EInvoicePage): Promise<EInvoiceRecord[]>;
  /** Registered documents whose cancellation window has not closed yet. */
  listCancellable(companyId: CompanyId, now: string, page?: EInvoicePage): Promise<EInvoiceRecord[]>;
  /** Applicable documents still not reported, so nothing quietly misses its deadline. */
  listPendingReport(companyId: CompanyId, on: IsoDate, page?: EInvoicePage): Promise<EInvoiceRecord[]>;
}

/** Per company, effective-dated. A port, so #7's versioned rules can answer this later. */
export interface EInvoicePolicyPort {
  policyFor(companyId: CompanyId, on: IsoDate): Promise<EInvoicePolicy>;
}
