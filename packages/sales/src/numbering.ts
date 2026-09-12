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
 * ## Sixteen characters, all sixteen of them
 *
 * CGST Rule 46(b) asks for "a consecutive serial number not exceeding sixteen characters", and the
 * e-invoice portal refuses a document number longer than that. Two things follow, and the second is
 * as important as the first.
 *
 * The financial year is written short ("26-27"). The long form spent seven of the sixteen
 * characters on the year alone, which is what made the old numbers twenty to twenty-two.
 *
 * **How many digits the running number gets is not a setting.** It is whatever is left once the
 * prefix and the year have taken their share, so the default `INV/26-27/000001` is sixteen
 * characters exactly and carries a business to 999,999 bills in one financial year. Asking a
 * business to choose the width instead is really asking it to predict how many bills it will ever
 * issue in a year; it cannot know, and guessing low goes wrong on an ordinary working day, long
 * after the numbers it has already given customers can be changed. Nothing here leaves a character
 * spare: a character not spent on the running number is an order of magnitude of headroom thrown
 * away for no reason, and it cannot be reclaimed later without renumbering bills that are already
 * in customers' hands.
 */
import { financialYearOf, invalid, type IsoDate } from '@invoice/kernel';

export interface NumberSeries {
  /** Shown in the number, e.g. "INV". */
  readonly prefix: string;
  /**
   * Shown in the number, usually the branch's short code, e.g. "KB". Empty for one series across the
   * business, which is the default — every character it takes is taken from the running number.
   */
  readonly branchCode: string;
}

/** `INV/26-27/000001` — sixteen characters, and room for 999,999 bills in a financial year. */
export const DEFAULT_SERIES: NumberSeries = { prefix: 'INV', branchCode: '' };

/** Rule 46(b). */
export const INVOICE_NUMBER_MAX_LENGTH = 16;

/**
 * A series that cannot reach 99,999 bills in a year is refused outright. That is what this product
 * managed before the running number was widened, so no choice a business makes here can leave it
 * worse off than it already was.
 */
export const MIN_BILLS_PER_YEAR = 99_999;

const SHORT_YEAR_LENGTH = 5; // "26-27"
const ALLOWED = /^[A-Za-z0-9-]+$/;

const shortYear = (date: IsoDate): string => financialYearOf(date).slice(2);
const partsOf = (series: NumberSeries, year: string, sequence: string): string =>
  [series.prefix, ...(series.branchCode === '' ? [] : [series.branchCode]), year, sequence].join('/');

/** Everything in the number that is not the running number, separators included. */
const fixedLength = (series: NumberSeries): number =>
  series.prefix.length + 1 + (series.branchCode === '' ? 0 : series.branchCode.length + 1) + SHORT_YEAR_LENGTH + 1;

/** How many digits are left for the running number once the prefix and the year have had their share. */
export const sequenceDigits = (series: NumberSeries): number => INVOICE_NUMBER_MAX_LENGTH - fixedLength(series);

/** The most bills this series can number in one financial year. */
export const billsPerYear = (series: NumberSeries): number => {
  const digits = sequenceDigits(series);
  return digits < 1 ? 0 : 10 ** digits - 1;
};

export const seriesScope = (series: NumberSeries, date: IsoDate): string =>
  `sales:${series.prefix}:${series.branchCode}:${financialYearOf(date)}`;

export const formatNumber = (series: NumberSeries, date: IsoDate, sequence: number): string => {
  if (!Number.isInteger(sequence) || sequence < 1) throw invalid('SALES_BAD_SEQUENCE', 'An invoice number starts at 1.');
  const ceiling = billsPerYear(series);
  if (sequence > ceiling) {
    throw invalid(
      'SALES_SERIES_EXHAUSTED',
      `This series has issued all ${ceiling.toLocaleString('en-IN')} of the bills it can number this financial year. Start a second series with its own prefix; GST allows more than one.`,
    );
  }
  return partsOf(series, shortYear(date), String(sequence).padStart(sequenceDigits(series), '0'));
};

/**
 * Refuses a series that could not number enough bills, before a single one is issued on it.
 *
 * There is no overflow to check for at issue time any more — the running number is as wide as the
 * sixteen characters allow — so what is checked here is whether the prefix and branch code have
 * eaten so much of the number that too little is left.
 */
export const validateSeries = (series: NumberSeries): void => {
  if (series.prefix.trim() === '') throw invalid('SALES_PREFIX_REQUIRED', 'An invoice series needs a prefix, such as INV.');
  for (const part of [series.prefix, series.branchCode]) {
    if (part !== '' && !ALLOWED.test(part)) {
      throw invalid('SALES_SERIES_CHARACTERS', 'An invoice prefix and branch code may contain only letters, digits and "-".');
    }
  }
  const ceiling = billsPerYear(series);
  if (ceiling < MIN_BILLS_PER_YEAR) {
    const sample = partsOf(series, '26-27', '0'.repeat(Math.max(sequenceDigits(series) - 1, 0)) + '1');
    throw invalid(
      'SALES_SERIES_TOO_FEW_BILLS',
      `A number like ${sample} leaves room for only ${ceiling.toLocaleString('en-IN')} bills in a financial year, and GST allows the number no more than ${INVOICE_NUMBER_MAX_LENGTH} characters in total. Shorten the prefix or drop the branch code so the running number has more digits.`,
    );
  }
};

/**
 * Splits a number back apart, so a person quoting one can be found. The branch code is optional, so
 * both `INV/26-27/000001` and `INV/KB/26-27/00001` parse; `financialYear` comes back as printed.
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
