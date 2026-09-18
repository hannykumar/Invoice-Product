/**
 * Issue #186 — the last day a credit note can still reduce GST.
 *
 * CGST Act section 34(2): a credit note reduces the supplier's tax only if it is declared in a
 * return for a month no later than 30 November following the end of the financial year in which
 * the original supply was made, or the date the annual return is filed, whichever is earlier.
 *
 * Only 30 November is used. The product does not know when a business files its annual return, and
 * guessing an earlier date would refuse credit notes the law still allows. A business that files
 * its annual return before 30 November has to know its own earlier date; its accountant will.
 *
 * Worked example: a bill dated 15 September 2026 is in financial year 2026-27, which ends on
 * 31 March 2027. The next 30 November is 30 November 2027. A credit note dated 1 December 2027 can
 * no longer reduce GST.
 */
import { compareDates, financialYearOf, formatDate, isoDate, type IsoDate } from '@invoice/kernel';

/** How many days before the deadline a return starts carrying a warning. */
export const CREDIT_NOTE_WARNING_DAYS = 30;

/** 30 November after the end of the financial year the original bill belongs to. */
export const creditNoteDeadline = (invoiceDate: IsoDate): IsoDate =>
  isoDate(`${Number(financialYearOf(invoiceDate).slice(0, 4)) + 1}-11-30`);

const DAY_MS = 86_400_000;
const daysBetween = (from: IsoDate, to: IsoDate): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

export interface CreditNoteDeadlineCheck {
  readonly deadline: IsoDate;
  /** The note is dated after the deadline, so it cannot reduce GST. */
  readonly late: boolean;
  /** The sentence to show in the last 30 days before the deadline, or `null`. */
  readonly warning: string | null;
  /** The refusal, when `late`. */
  readonly refusal: string | null;
}

export const checkCreditNoteDeadline = (invoiceDate: IsoDate, noteDate: IsoDate): CreditNoteDeadlineCheck => {
  const deadline = creditNoteDeadline(invoiceDate);
  const year = financialYearOf(invoiceDate);
  const late = compareDates(noteDate, deadline) > 0;
  const left = daysBetween(noteDate, deadline);
  return {
    deadline,
    late,
    warning: !late && left <= CREDIT_NOTE_WARNING_DAYS
      ? `The last day to issue a credit note that reduces GST for bills of ${year} is ${formatDate(deadline)}.`
      : null,
    refusal: late
      ? `Credit notes that reduce GST for bills of ${year} could only be issued up to ${formatDate(deadline)}. Talk to your accountant: this return can be settled without reducing GST.`
      : null,
  };
};
