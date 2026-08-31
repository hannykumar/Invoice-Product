/**
 * Issue #30 [E30] — the five surfaces the return workspace sits on.
 *
 * The point of naming them separately is that four of the five are somebody else's. The sales
 * ledger, the purchase postings, the period locks and the government submission channel all belong
 * to other modules and other issues, and each of them will change. Only the workspace's own
 * storage is this module's.
 *
 * `GovernmentReturnPort` matters most. The whole product promise about GSP access is that the
 * manual export path never depends on it — so the port is optional everywhere, and a workspace
 * built with no submission channel at all still prepares, checks, approves and exports a return.
 */
import type { CompanyId, IsoDate } from '@invoice/kernel';
import type { BookTaxTotals } from './reconcile.ts';
import type {
  InwardTaxSummary,
  OutwardDocument,
  ReturnPreparation,
  TaxPeriod,
} from './types.ts';

/**
 * Everything the business sold in a period, as documents the return can read.
 *
 * The implementation is an adapter over the sales module (#9) and the credit-note module (#45).
 * It is the adapter's job — not this module's — to refuse to convert a document whose facts are
 * incomplete, and to say which document and which fact.
 */
export interface OutwardSupplyPort {
  /**
   * Only documents that are final and not cancelled. A draft bill is not a sale, and a return
   * built from drafts would change under the preparer as somebody in the shop kept typing.
   */
  documentsFor(companyId: CompanyId, period: TaxPeriod): Promise<readonly OutwardDocument[]>;
  /** Numbers that were issued and then cancelled, for the document-series table. */
  cancelledNumbersFor?(
    companyId: CompanyId,
    period: TaxPeriod,
  ): Promise<readonly { readonly kind: OutwardDocument['kind']; readonly number: string }[]>;
}

/**
 * The tax already paid on purchases, from the purchase postings (#17).
 *
 * This port answers what the books hold. It does not answer what may be claimed: eligibility, the
 * match against the government's GSTR-2B and the reversal rules are issue #31.
 */
export interface InwardTaxPort {
  summaryFor(companyId: CompanyId, period: TaxPeriod): Promise<InwardTaxSummary>;
}

/** What the ledger says was collected, for the book-to-return reconciliation. */
export interface BookTaxPort {
  totalsFor(companyId: CompanyId, period: TaxPeriod): Promise<BookTaxTotals>;
}

/**
 * Whether the accounting period is still open.
 *
 * A period whose return has been filed should be locked in the books too, or the two will drift
 * apart the first time somebody back-dates an entry. The workspace does not lock it — that is the
 * ledger's own machine, `fiscal_period` — it asks, and it refuses to approve over an open period
 * only when the business has said periods must be closed first.
 */
export interface PeriodLockPort {
  stateOf(companyId: CompanyId, on: IsoDate): Promise<'OPEN' | 'SOFT_LOCKED' | 'HARD_LOCKED'>;
  /** Called after a return is filed, so the books cannot quietly move under a filed return. */
  softLock?(companyId: CompanyId, period: TaxPeriod, reason: string): Promise<void>;
}

/**
 * A licensed intermediary that can submit a return.
 *
 * Optional everywhere. A business with no GSP prepares and exports exactly as one with a GSP does;
 * only the last button differs. Like every government adapter in this product it returns an
 * outcome rather than throwing, because "we do not know whether it went through" is an answer that
 * has to be stored and shown.
 */
export interface GovernmentReturnPort {
  readonly provider: string;
  submit(request: GovernmentSubmitRequest): Promise<GovernmentSubmitOutcome>;
  /** Whether the channel is answering at all, for the settings screen. */
  health?(): Promise<'healthy' | 'degraded' | 'unavailable'>;
}

export interface GovernmentSubmitRequest {
  readonly companyId: CompanyId;
  readonly gstin: string;
  readonly period: TaxPeriod;
  readonly returnType: 'GSTR1' | 'GSTR3B';
  readonly payload: Record<string, unknown>;
  /** Makes a retry after a timeout reach the portal as the same filing, not a second one. */
  readonly idempotencyKey: string;
}

export type GovernmentSubmitOutcome =
  | { readonly kind: 'ACCEPTED'; readonly reference: string; readonly acknowledgedAt: string }
  | {
      readonly kind: 'REJECTED';
      readonly errors: readonly { readonly code: string; readonly detail: string }[];
      readonly at: string;
    }
  | {
      /** The channel did not answer, or answered something we cannot read. Never "failed". */
      readonly kind: 'UNKNOWN';
      readonly retryable: boolean;
      readonly at: string;
      readonly detail: string;
    };

/**
 * The workspace's own storage: one row per company, period and return type.
 *
 * A preparation is replaced as it moves through its states rather than versioned here, because the
 * audit trail already records every move with its actor and its moment, and a second history would
 * be two accounts of the same thing.
 */
export interface ReturnPreparationRepository {
  find(companyId: CompanyId, period: TaxPeriod, returnType: 'GSTR1' | 'GSTR3B'): Promise<ReturnPreparation | null>;
  findByIdempotencyKey(companyId: CompanyId, key: string): Promise<ReturnPreparation | null>;
  insert(preparation: ReturnPreparation): Promise<void>;
  /** Refuses when `expectedVersion` no longer matches, so two preparers cannot overwrite each other. */
  update(preparation: ReturnPreparation, expectedVersion: number): Promise<void>;
  list(companyId: CompanyId): Promise<readonly ReturnPreparation[]>;
}

/** How the workspace behaves for one business, and the one setting a shop actually notices. */
export interface ReturnPolicy {
  /** `production` refuses an unreviewed threshold; `development` uses it and says so. */
  readonly mode: 'production' | 'development';
  /** Refuse approval while the accounting period is still open. Off by default. */
  readonly requireClosedPeriod: boolean;
  /** Refuse approval while the return and the books disagree. On by default, and rightly. */
  readonly requireBooksToAgree: boolean;
}

export const DEFAULT_RETURN_POLICY: ReturnPolicy = Object.freeze({
  mode: 'development',
  requireClosedPeriod: false,
  requireBooksToAgree: true,
});

export interface ReturnPolicyPort {
  policyFor(companyId: CompanyId, period: TaxPeriod): Promise<ReturnPolicy>;
}
