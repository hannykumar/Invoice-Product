/**
 * Issue #9 [E09] — invoice numbering.
 *
 * A number is allocated **only when an invoice becomes final**, from a sequence held per company,
 * branch and financial year. Drafts never consume one, so a shopkeeper who starts three bills and
 * finishes one does not leave two gaps in a legally significant series.
 *
 * Allocation happens inside the same transaction as the rest of finalisation, so two tills
 * finalising at the same instant cannot receive the same number, and a failed finalisation does
 * not burn one.
 */
import { financialYearOf, invalid, type IsoDate } from '@invoice/kernel';

export interface NumberSeries {
  /** Shown in the number, e.g. "INV". */
  readonly prefix: string;
  /** Shown in the number, usually the branch's short code, e.g. "KB". */
  readonly branchCode: string;
  readonly padding: number;
}

/**
 * **This default does not fit the government's e-invoice limit, and that is a decision waiting to
 * be made rather than an oversight.**
 *
 * `formatNumber` produces `PREFIX/BRANCH/2026-27/00001`. The three slashes and the financial year
 * are ten characters before a business writes anything of its own, so this default comes to
 * twenty-two — and NIC refuses any document number over **sixteen**, which it did when a real sale
 * was put through the sandbox. A business below the e-invoice threshold is unaffected; one above it
 * cannot register a single bill.
 *
 * Nothing is quietly truncated, because an invoice number is a legally significant series and
 * shortening one already issued would be worse than refusing to send it. `buildEInvoicePayload`
 * catches the length and says so in words a shopkeeper can act on.
 *
 * Fixing the default properly means choosing what to give up — a shorter financial year in the
 * number, no branch code, or fewer digits — and that changes what customers and auditors see.
 */
export const DEFAULT_SERIES: NumberSeries = { prefix: 'INV', branchCode: 'MAIN', padding: 5 };

export const seriesScope = (series: NumberSeries, date: IsoDate): string =>
  `sales:${series.prefix}:${series.branchCode}:${financialYearOf(date)}`;

export const formatNumber = (series: NumberSeries, date: IsoDate, sequence: number): string => {
  if (sequence < 1) throw invalid('SALES_BAD_SEQUENCE', 'An invoice number starts at 1.');
  return `${series.prefix}/${series.branchCode}/${financialYearOf(date)}/${String(sequence).padStart(series.padding, '0')}`;
};

/** Splits a number back apart, so a person quoting one can be found. */
export const parseNumber = (value: string): { prefix: string; branchCode: string; financialYear: string; sequence: number } | null => {
  const parts = value.split('/');
  if (parts.length !== 4) return null;
  const [prefix, branchCode, financialYear, sequenceText] = parts as [string, string, string, string];
  const sequence = Number(sequenceText);
  if (!Number.isInteger(sequence) || sequence < 1) return null;
  return { prefix, branchCode, financialYear, sequence };
};
