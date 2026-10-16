/**
 * Issue #31 [E31] — the four surfaces this module sits on, and the one it owns.
 *
 * Only the storage below is ours. The purchase register belongs to #17, the portal belongs to the
 * government and reaches us through GPT 2's connector when it reaches us at all, and the policy is
 * a company setting. Naming them as ports is what lets the whole reconciliation run in a test in
 * two lines, and what lets the file path work for a business that will never have a licensed
 * intermediary.
 *
 * `PortalRecordSource` is optional everywhere on purpose. "File import first and GSP download
 * later" means the download must never become the thing the feature depends on: a shop with a
 * downloaded file and no intermediary gets exactly the same reconciliation, out of the same
 * reader, as a shop with a paid connection.
 */
import type { CompanyId, IsoDate } from '@invoice/kernel';
import type { ParsedPortalRecord } from './import.ts';
import type {
  BookPurchaseDocument,
  ImportBatch,
  ItcClaim,
  ItcDecision,
  ItcMatchPolicy,
  PortalDocument,
  TaxPeriod,
} from './types.ts';

/**
 * The purchases our own books hold up to a period, from the postings of #17.
 *
 * The adapter converts; it never invents. A bill whose supplier registration is unknown comes
 * through with `supplierGstin: null` and is reported as a question, because a bill matched on its
 * number alone could be matched to another supplier's bill entirely. The ITC service removes bills
 * already claimed in an earlier period; the books port must not hide an older unclaimed bill.
 */
export interface PurchaseBookPort {
  documentsFor(companyId: CompanyId, period: TaxPeriod): Promise<readonly BookPurchaseDocument[]>;
}

/**
 * The portal, when a business has a way to reach it.
 *
 * It returns the file's own text rather than parsed rows, so the downloaded path and the imported
 * path go through one reader and cannot drift apart. That is what makes the file/API equivalence
 * test a real test rather than a comparison of two copies of the same code.
 */
export interface PortalRecordSource {
  readonly provider: string;
  fetchGstr2b(companyId: CompanyId, gstin: string, period: TaxPeriod): Promise<PortalFetchOutcome>;
  health?(): Promise<'healthy' | 'degraded' | 'unavailable'>;
}

export type PortalFetchOutcome =
  | { readonly kind: 'FETCHED'; readonly content: string; readonly at: string }
  /** The statement is not published yet. A perfectly ordinary answer in the first half of a month. */
  | { readonly kind: 'NOT_READY'; readonly at: string; readonly detail: string }
  /** We do not know. Never reported as "no purchases were reported", which is a different fact. */
  | { readonly kind: 'UNAVAILABLE'; readonly retryable: boolean; readonly at: string; readonly detail: string };

/**
 * Issue #366 — one page of a list, in the order the rows were written.
 *
 * `after` is the `id` of the last row of the page before. Left out altogether, a list method
 * returns everything, as it always has.
 */
export interface Page {
  readonly limit: number;
  readonly after?: string;
}

/** The portal rows we hold, one row per company, period, supplier, document and kind. */
export interface PortalRecordRepository {
  listForPeriod(companyId: CompanyId, period: TaxPeriod, page?: Page): Promise<readonly PortalDocument[]>;
  /** Prior portal evidence remains relevant while its purchase bill is still unclaimed. */
  listThroughPeriod(companyId: CompanyId, period: TaxPeriod, page?: Page): Promise<readonly PortalDocument[]>;
  /** Used by #19's supplier check, which asks about one bill and not a month. */
  findByDocument(
    companyId: CompanyId,
    input: { readonly supplierGstin: string; readonly invoiceNumber: string },
  ): Promise<PortalDocument | null>;
  /**
   * Stores a batch's rows, replacing a row this company already held for the same document.
   *
   * Replacing rather than appending is deliberate: two imports of the same month are two readings
   * of one statement, not two statements, and keeping both would double every figure. The import
   * batch keeps the history of who imported what and when.
   */
  put(
    companyId: CompanyId,
    period: TaxPeriod,
    records: readonly PortalDocument[],
  ): Promise<{ readonly added: number; readonly replaced: number; readonly unchanged: number }>;
}

export interface ImportBatchRepository {
  /** A second batch with the same id, or the same file for the same month, is refused (`ITC_IMPORT_DUPLICATE`). */
  insert(batch: ImportBatch): Promise<void>;
  /** A file imported twice is recognised by its checksum and not imported again. */
  findByChecksum(companyId: CompanyId, period: TaxPeriod, checksum: string): Promise<ImportBatch | null>;
  latestFor(companyId: CompanyId, period: TaxPeriod): Promise<ImportBatch | null>;
  list(companyId: CompanyId, period: TaxPeriod, page?: Page): Promise<readonly ImportBatch[]>;
}

/**
 * Decisions, append-only.
 *
 * A person who accepts a line, changes their mind and rejects it has done two things, and both
 * belong in the record. `latestFor` is what the workspace reads; the rest is what an auditor
 * reads.
 */
export interface ItcDecisionRepository {
  /** A second decision with the same id or idempotency key is refused (`ITC_DECISION_DUPLICATE`). */
  insert(decision: ItcDecision): Promise<void>;
  latestForPeriod(companyId: CompanyId, period: TaxPeriod, page?: Page): Promise<readonly ItcDecision[]>;
  findByIdempotencyKey(companyId: CompanyId, key: string): Promise<ItcDecision | null>;
  history(companyId: CompanyId, lineKey: string, page?: Page): Promise<readonly ItcDecision[]>;
}

/** One immutable claim per purchase document, regardless of how many later workspaces are opened. */
export interface ItcClaimRepository {
  insert(claim: ItcClaim): Promise<{ readonly claim: ItcClaim; readonly inserted: boolean }>;
  listForCompany(companyId: CompanyId, page?: Page): Promise<readonly ItcClaim[]>;
}

/** Per-company and effective-dated, exactly as #18's tolerances are. */
export interface ItcPolicyPort {
  policyFor(companyId: CompanyId, on: IsoDate): Promise<ItcMatchPolicy>;
}

/** What a parsed row becomes once it belongs to a company and an import. */
export interface StoredRecordInput {
  readonly record: ParsedPortalRecord;
  readonly period: TaxPeriod;
  readonly batchId: string;
  readonly observedAt: string;
}
