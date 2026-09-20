/**
 * Issue #192 — the last date on which a supplier's bill can still carry credit.
 *
 * **CGST Act section 16(4):** a registered person may not take input tax credit on a supplier's
 * invoice or debit note after **30 November following the end of the financial year** to which the
 * invoice or debit note belongs, or after furnishing the annual return, whichever is earlier.
 *
 * Only the 30 November limb is modelled. The annual-return limb depends on a date we are not told
 * and cannot infer, and guessing it would bar credit that is still lawfully claimable. The special
 * relief in section 16(5) covers financial years 2017-18 to 2020-21 only and is deliberately not
 * modelled: applying it to a current bill would allow a claim the law does not.
 *
 * Nothing here deletes or hides a purchase. A time-barred bill stays in the books, with its GST as
 * a cost; what is refused is the credit, and the line says by which date it had to be claimed.
 */
import { financialYearOf, financialYearRange, type IsoDate } from '@invoice/kernel';
import { taxPeriodRange, type TaxPeriod } from '../../gst-returns/src/types.ts';

/** How many days before the deadline the unclaimed bills start being listed. */
export const CLAIM_WARNING_DAYS = 45;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The 30 November after the end of the financial year the document belongs to.
 *
 * A bill of 13 March 2026 belongs to 2025-26, that year ends on 31 March 2026, and the next
 * 30 November after it is 30 November 2026.
 */
export const lastClaimDateFor = (documentDate: IsoDate): IsoDate =>
  `${Number(financialYearRange(financialYearOf(documentDate)).to.slice(0, 4))}-11-30` as IsoDate;

/**
 * When a return for this period would be filed at the latest.
 *
 * GSTR-3B for a month is due on the 20th of the month after it. The filing date itself is unknown
 * while the return is being prepared, so the due date stands in for it: it is the last day on which
 * the return can be filed on time, and a credit that is barred by then is barred.
 */
export const returnDueDate = (period: TaxPeriod): IsoDate => {
  const [year, month] = taxPeriodRange(period).from.split('-').map(Number) as [number, number];
  return month === 12 ? `${year + 1}-01-20` as IsoDate : `${year}-${String(month + 1).padStart(2, '0')}-20` as IsoDate;
};

/** Whole days from one date to another, both read as plain Indian calendar dates. */
const daysBetween = (from: IsoDate, to: IsoDate): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * Whether credit on a bill of this date is still open in the return being prepared.
 *
 * The filing date is unknown while a return is being prepared, so the earliest it could be filed
 * stands in for it: the period's own due date, or today when today has already gone past it. A
 * return for March that is being prepared in December will not be filed in April, and pretending
 * otherwise would let the screen offer a credit that section 16(4) has already closed.
 */
export const isTimeBarred = (documentDate: IsoDate, period: TaxPeriod, today?: IsoDate): boolean => {
  const due = returnDueDate(period);
  const filedNoEarlierThan = today !== undefined && today > due ? today : due;
  return filedNoEarlierThan > lastClaimDateFor(documentDate);
};

/** "30 November 2026" — the deadline as a sentence names it. */
export const formatClaimDate = (date: IsoDate): string => {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${Number(date.slice(8, 10))} ${months[Number(date.slice(5, 7)) - 1] as string} ${date.slice(0, 4)}`;
};

/** Whether today is inside the window where the unclaimed bills for a year should be listed. */
export const isInWarningWindow = (today: IsoDate, lastClaimDate: IsoDate): boolean => {
  const left = daysBetween(today, lastClaimDate);
  return left >= 0 && left <= CLAIM_WARNING_DAYS;
};
