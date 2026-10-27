/**
 * Issue #9 [E09] — the choices a business makes about its own billing.
 *
 * These are configuration, not code. A threshold that lives in an `if` is a threshold nobody can
 * change without a deployment, and "cancellation follows configured approval and reversal policy"
 * is an acceptance criterion of this issue.
 */
import { compareDates, type IsoDate, type Money } from '@invoice/kernel';
import { DEFAULT_SERIES, type NumberSeries } from './numbering.ts';

export interface SalesPolicy {
  readonly series: NumberSeries;
  /**
   * Issue #296 — the series a composition business's bills of supply are numbered in (Rule 49 asks
   * for a consecutive serial number not exceeding sixteen characters, like Rule 46). Kept apart from
   * `series` so a business that leaves the scheme keeps a clean run of tax invoices.
   */
  readonly billOfSupplySeries?: NumberSeries;
  /** A bill at or above this needs someone's approval. `null` means approval is never required. */
  readonly approvalRequiredAtOrAbove: Money | null;
  /** How many days after the document date a final invoice may still be cancelled. */
  readonly cancellationWindowDays: number;
  /**
   * Whether an invoice already registered with the government may be cancelled here. Default is
   * `false`: once a number has been reported, the correction is a credit note (assumption A6).
   */
  readonly allowCancelAfterGovernmentRegistration: boolean;
  readonly defaultDueDays: number;
  readonly roundToWholeRupee: boolean;
}

export const DEFAULT_BILL_OF_SUPPLY_SERIES: NumberSeries = { prefix: 'BOS', branchCode: '' };

export const DEFAULT_SALES_POLICY: SalesPolicy = {
  series: DEFAULT_SERIES,
  billOfSupplySeries: DEFAULT_BILL_OF_SUPPLY_SERIES,
  approvalRequiredAtOrAbove: null,
  cancellationWindowDays: 7,
  allowCancelAfterGovernmentRegistration: false,
  defaultDueDays: 30,
  roundToWholeRupee: true,
};

export const needsApproval = (policy: SalesPolicy, invoiceValue: Money): boolean =>
  policy.approvalRequiredAtOrAbove !== null && invoiceValue.minor >= policy.approvalRequiredAtOrAbove.minor;

const addDays = (date: IsoDate, days: number): IsoDate => {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10) as IsoDate;
};

export const dueDateFor = (policy: SalesPolicy, documentDate: IsoDate): IsoDate =>
  addDays(documentDate, policy.defaultDueDays);

export const withinCancellationWindow = (policy: SalesPolicy, documentDate: IsoDate, today: IsoDate): boolean =>
  compareDates(today, addDays(documentDate, policy.cancellationWindowDays)) <= 0;
