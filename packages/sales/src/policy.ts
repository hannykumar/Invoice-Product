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

export const DEFAULT_SALES_POLICY: SalesPolicy = {
  series: DEFAULT_SERIES,
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
