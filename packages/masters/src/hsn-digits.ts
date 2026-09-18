/**
 * Issue #187 — how many digits of HSN code a bill must carry.
 *
 * Notification 78/2020-Central Tax (15 October 2020, in force from 1 April 2021), under CGST Rule
 * 46(g):
 *
 *  - aggregate turnover in the previous financial year up to ₹5 crore: at least **4** digits on tax
 *    invoices to **registered** customers; a bill to an unregistered customer may leave the code off;
 *  - above ₹5 crore: at least **6** digits on **every** tax invoice.
 *
 * The e-way bill and e-invoice portals refuse shorter codes on the same split: 6 digits above
 * ₹5 crore, 4 otherwise, whoever the customer is. SAC for services is always 6 digits and is checked
 * by `validateHsnOrSac`. More digits than the minimum are always allowed.
 *
 * The product does not guess turnover from the bills it holds — most businesses start with less than
 * a year of history in it — so the business answers the question itself. "Not sure", and a question
 * nobody has answered, count as "above ₹5 crore": six digits is always lawful, four may not be.
 */
import { financialYearOf, type IsoDate } from "@invoice/kernel";

/** The business's answer to "was last financial year's turnover more than ₹5 crore?". */
export type TurnoverAbove5Crore = "YES" | "NO" | "UNKNOWN";

export interface TurnoverAnswer {
  readonly answer: TurnoverAbove5Crore;
  /**
   * The financial year the answer was given for, e.g. "2026-27" — the year whose bills it governs.
   * On 1 April a new year starts, last year's answer no longer describes "the previous year", and the
   * question has to be asked again.
   */
  readonly forFinancialYear: string;
}

/**
 * The answer that governs a bill dated `date`: the one given for that bill's financial year. A year
 * nobody answered for counts as "not sure", so a new year starting on 1 April asks again rather than
 * quietly carrying last year's answer forward.
 */
export const turnoverAnswerOn = (answers: readonly TurnoverAnswer[] | null | undefined, date: IsoDate): TurnoverAbove5Crore => {
  const year = financialYearOf(date);
  return answers?.find((candidate) => candidate.forFinancialYear === year)?.answer ?? "UNKNOWN";
};

/** Records a new answer for one financial year, replacing any earlier answer for that same year. */
export const withTurnoverAnswer = (answers: readonly TurnoverAnswer[] | null | undefined, next: TurnoverAnswer): readonly TurnoverAnswer[] => [
  ...(answers ?? []).filter((candidate) => candidate.forFinancialYear !== next.forFinancialYear),
  next,
];

/**
 * The fewest HSN digits a goods line on a tax invoice may carry, or `null` when the code may be left
 * off altogether (a business up to ₹5 crore billing an unregistered customer).
 */
export const minimumHsnDigitsOnInvoice = (answer: TurnoverAbove5Crore, customerRegistered: boolean): 4 | 6 | null =>
  answer !== "NO" ? 6 : customerRegistered ? 4 : null;

/** The fewest HSN digits the e-way bill portal accepts, whoever the customer is. */
export const minimumHsnDigitsOnEWayBill = (answer: TurnoverAbove5Crore): 4 | 6 => (answer === "NO" ? 4 : 6);

/**
 * The warning to show when an item is saved with a code too short for some bills. Never an error:
 * a small shop selling only to unregistered customers may use a 2-digit code.
 */
export const hsnLengthWarning = (code: string, kind: "goods" | "service", answer: TurnoverAbove5Crore): string | null => {
  if (kind !== "goods") return null;
  const digits = code.replace(/\s/g, "").length;
  if (answer !== "NO" && digits < 6) {
    return `This code has ${digits} digits. Your bills need at least 6 digits${answer === "UNKNOWN" ? " until you tell us your turnover was ₹5 crore or less last year" : ""}.`;
  }
  if (digits < 4) return "A code shorter than 4 digits cannot be used on bills to GST-registered customers.";
  return null;
};
