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

/**
 * Issue #236 — the band the business picked for last financial year's aggregate turnover.
 *
 * Three limits hang off this one answer, and a yes/no against ₹5 crore could only settle one:
 *
 *  - HSN digits on the bill (Notification 78/2020): more than ₹5 crore last year, six digits.
 *  - E-invoicing (Notification 13/2020 as amended by 10/2023): turnover that *exceeded* ₹5 crore in
 *    **any** financial year from 2017-18 on. A business under ₹5 crore last year that was over it
 *    in an earlier year must still e-invoice, which is why the lowest band is split in two.
 *  - The 30-day reporting limit (GSTN advisory, 5 November 2024): ₹10 crore and above, from
 *    1 April 2025. Below ₹10 crore there is no limit.
 *
 * `UNKNOWN` is "Not sure": we ask before anything depends on it, and never assume either way.
 */
export type TurnoverBand =
  | "UP_TO_5_CRORE"
  | "UP_TO_5_CRORE_EARLIER_ABOVE"
  | "5_TO_10_CRORE"
  | "10_CRORE_AND_ABOVE"
  | "UNKNOWN";

export const TURNOVER_BANDS: readonly TurnoverBand[] = [
  "UP_TO_5_CRORE", "UP_TO_5_CRORE_EARLIER_ABOVE", "5_TO_10_CRORE", "10_CRORE_AND_ABOVE", "UNKNOWN",
];

/** The yes/no against ₹5 crore last year that a band implies — what the HSN rule reads. */
export const above5CroreOf = (band: TurnoverBand): TurnoverAbove5Crore =>
  band === "UNKNOWN" ? "UNKNOWN" : band === "5_TO_10_CRORE" || band === "10_CRORE_AND_ABOVE" ? "YES" : "NO";

export interface TurnoverAnswer {
  /** Last year above ₹5 crore — derived from `band` when there is one, kept for the HSN rule. */
  readonly answer: TurnoverAbove5Crore;
  /**
   * The band itself (#236). Absent on an answer given before the bands existed: a bare "yes" says
   * nothing about ₹10 crore, and a bare "no" says nothing about the years before last, so both are
   * asked again rather than guessed.
   */
  readonly band?: TurnoverBand;
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

/** The band for a bill dated `date`, or null when that year was answered only with a yes/no, or not at all. */
export const turnoverBandOn = (answers: readonly TurnoverAnswer[] | null | undefined, date: IsoDate): TurnoverBand | null => {
  const year = financialYearOf(date);
  const given = answers?.find((candidate) => candidate.forFinancialYear === year);
  if (given === undefined) return null;
  return given.band ?? (given.answer === "UNKNOWN" ? "UNKNOWN" : null);
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
