/**
 * Issue #9 [E09] — invoice numbering. Length rule from issue #162.
 *
 * A number is allocated **only when an invoice becomes final**, from a sequence held per company,
 * branch and financial year. Drafts never consume one, so a shopkeeper who starts three bills and
 * finishes one does not leave two gaps in a legally significant series.
 *
 * Allocation happens inside the same transaction as the rest of finalisation, so two tills
 * finalising at the same instant cannot receive the same number, and a failed finalisation does
 * not burn one.
 *
 * CGST Rule 46(b) asks for "a consecutive serial number not exceeding sixteen characters", and the
 * e-invoice portal refuses a document number longer than that outright. So the financial year is
 * written short ("26-27"): the long form would spend seven of the sixteen characters on the year
 * alone, which is what pushed our old numbers to twenty-two. A series that could not stay inside
 * sixteen is refused when it is configured, not on the day it overflows.
 */
import { financialYearOf, invalid, type IsoDate } from '@invoice/kernel';

export interface NumberSeries {
  /** Shown in the number, e.g. "INV". */
  readonly prefix: string;
  /** Shown in the number, usually the branch's short code, e.g. "KB". Empty for one series across the business. */
  readonly branchCode: string;
  readonly padding: number;
}

/** `INV/26-27/00001` — fifteen characters, and room for 99,999 bills in a year. */
export const DEFAULT_SERIES: NumberSeries = { prefix: 'INV', branchCode: '', padding: 5 };

/** Rule 46(b). */
export const INVOICE_NUMBER_MAX_LENGTH = 16;

const ALLOWED = /^[A-Za-z0-9/-]+$/;

const shortYear = (date: IsoDate): string => financialYearOf(date).slice(2);
const partsOf = (series: NumberSeries, year: string, sequence: string): string =>
  [series.prefix, ...(series.branchCode === '' ? [] : [series.branchCode]), year, sequence].join('/');

export const seriesScope = (series: NumberSeries, date: IsoDate): string =>
  `sales:${series.prefix}:${series.branchCode}:${financialYearOf(date)}`;

export const formatNumber = (series: NumberSeries, date: IsoDate, sequence: number): string => {
  if (!Number.isInteger(sequence) || sequence < 1) throw invalid('SALES_BAD_SEQUENCE', 'An invoice number starts at 1.');
  const number = partsOf(series, shortYear(date), String(sequence).padStart(series.padding, '0'));
  if (number.length > INVOICE_NUMBER_MAX_LENGTH) {
    throw invalid(
      'SALES_NUMBER_TOO_LONG',
      `Invoice number ${number} is ${number.length} characters long. GST allows at most ${INVOICE_NUMBER_MAX_LENGTH}, so choose a shorter prefix or branch code.`,
    );
  }
  return number;
};

/**
 * Refuses a series that could not produce a legal number, before a single bill is issued on it.
 *
 * Checked with the widest sequence the padding allows, so a series that works for bill 1 and breaks
 * at bill 10,000 is refused on the first day rather than on the ten-thousandth.
 */
export const validateSeries = (series: NumberSeries): void => {
  if (series.prefix.trim() === '') throw invalid('SALES_PREFIX_REQUIRED', 'An invoice series needs a prefix, such as INV.');
  for (const part of [series.prefix, series.branchCode]) {
    if (part !== '' && !ALLOWED.test(part)) {
      throw invalid('SALES_SERIES_CHARACTERS', 'An invoice number may contain only letters, digits, "-" and "/".');
    }
  }
  if (!Number.isInteger(series.padding) || series.padding < 1) {
    throw invalid('SALES_SERIES_PADDING', 'An invoice series needs at least one digit of sequence.');
  }
  const widest = partsOf(series, '26-27', '9'.repeat(series.padding));
  if (widest.length > INVOICE_NUMBER_MAX_LENGTH) {
    throw invalid(
      'SALES_NUMBER_TOO_LONG',
      `This series would print numbers like ${widest}, which is ${widest.length} characters. GST allows at most ${INVOICE_NUMBER_MAX_LENGTH}, so choose a shorter prefix or branch code.`,
    );
  }
};

/**
 * Splits a number back apart, so a person quoting one can be found. The branch code is optional, so
 * both `INV/26-27/00001` and `INV/KB/26-27/001` parse; `financialYear` comes back as printed.
 */
export const parseNumber = (value: string): { prefix: string; branchCode: string; financialYear: string; sequence: number } | null => {
  const parts = value.split('/');
  if (parts.length !== 3 && parts.length !== 4) return null;
  const [prefix, branchCode, financialYear, sequenceText] =
    parts.length === 4 ? (parts as [string, string, string, string]) : ([parts[0], '', parts[1], parts[2]] as [string, string, string, string]);
  const sequence = Number(sequenceText);
  if (!Number.isInteger(sequence) || sequence < 1) return null;
  return { prefix, branchCode, financialYear, sequence };
};
