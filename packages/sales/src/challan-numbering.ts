/**
 * Issue #141 — the delivery challan's own number series. Width rule from issue #162.
 *
 * CGST Rule 55(1) asks for "a consecutive serial number not exceeding sixteen characters, in one or
 * multiple series", unique for the financial year. So a challan number:
 *
 *  - comes from a counter of its own, never the invoice counter, so issuing a challan can never
 *    leave a gap in the invoice series or the other way round;
 *  - is allocated in the same transaction that saves the challan, so two people issuing at once
 *    cannot receive the same number;
 *  - spends every one of its sixteen characters, exactly as the invoice number does.
 *
 * The financial year is written short ("26-27") because the long form would spend seven of the
 * sixteen characters on the year alone. How many digits the running number gets is not a setting:
 * it is whatever is left, so `DC/26-27/0000001` carries a business to 9,999,999 challans in a
 * financial year without anyone having to predict how many it will need.
 */
import { financialYearOf, invalid, type IsoDate } from '@invoice/kernel';

export interface ChallanSeries {
  /** Shown in the number, e.g. "DC". Must differ from the invoice prefix. */
  readonly prefix: string;
  /** A short branch code, or empty for one series across the business. */
  readonly branchCode: string;
}

export const DEFAULT_CHALLAN_SERIES: ChallanSeries = { prefix: 'DC', branchCode: '' };

/** Rule 55(1). */
export const CHALLAN_NUMBER_MAX_LENGTH = 16;

/** As for invoices: a series that cannot reach this many in a year is refused outright. */
export const MIN_CHALLANS_PER_YEAR = 99_999;

const SHORT_YEAR_LENGTH = 5; // "26-27"
const ALLOWED = /^[A-Za-z0-9-]+$/;

const shortYear = (date: IsoDate): string => financialYearOf(date).slice(2);
const partsOf = (series: ChallanSeries, year: string, sequence: string): string =>
  [series.prefix, ...(series.branchCode === '' ? [] : [series.branchCode]), year, sequence].join('/');

const fixedLength = (series: ChallanSeries): number =>
  series.prefix.length + 1 + (series.branchCode === '' ? 0 : series.branchCode.length + 1) + SHORT_YEAR_LENGTH + 1;

export const challanSequenceDigits = (series: ChallanSeries): number => CHALLAN_NUMBER_MAX_LENGTH - fixedLength(series);

export const challansPerYear = (series: ChallanSeries): number => {
  const digits = challanSequenceDigits(series);
  return digits < 1 ? 0 : 10 ** digits - 1;
};

export const challanSeriesScope = (series: ChallanSeries, date: IsoDate): string =>
  `challan:${series.prefix}:${series.branchCode}:${financialYearOf(date)}`;

export const formatChallanNumber = (series: ChallanSeries, date: IsoDate, sequence: number): string => {
  if (!Number.isInteger(sequence) || sequence < 1) throw invalid('CHALLAN_BAD_SEQUENCE', 'A challan number starts at 1.');
  const ceiling = challansPerYear(series);
  if (sequence > ceiling) {
    throw invalid(
      'CHALLAN_SERIES_EXHAUSTED',
      `This series has issued all ${ceiling.toLocaleString('en-IN')} of the challans it can number this financial year. Start a second series with its own prefix; GST allows more than one.`,
    );
  }
  return partsOf(series, shortYear(date), String(sequence).padStart(challanSequenceDigits(series), '0'));
};

/**
 * Refuses a series that could not number enough challans, or that could be mistaken for the
 * invoice's, before anything is issued on it.
 */
export const validateChallanSeries = (series: ChallanSeries, invoicePrefix?: string): void => {
  if (series.prefix.trim() === '') throw invalid('CHALLAN_PREFIX_REQUIRED', 'A challan series needs a prefix, such as DC.');
  for (const part of [series.prefix, series.branchCode]) {
    if (part !== '' && !ALLOWED.test(part)) {
      throw invalid('CHALLAN_SERIES_CHARACTERS', 'A challan prefix and branch code may contain only letters, digits and "-".');
    }
  }
  if (invoicePrefix !== undefined && series.prefix === invoicePrefix) {
    throw invalid(
      'CHALLAN_SERIES_SHARES_INVOICE_PREFIX',
      `Challans and invoices both start with ${series.prefix}. They must be told apart at a glance, so give challans their own prefix.`,
    );
  }
  const ceiling = challansPerYear(series);
  if (ceiling < MIN_CHALLANS_PER_YEAR) {
    const sample = partsOf(series, '26-27', '0'.repeat(Math.max(challanSequenceDigits(series) - 1, 0)) + '1');
    throw invalid(
      'CHALLAN_SERIES_TOO_FEW_CHALLANS',
      `A number like ${sample} leaves room for only ${ceiling.toLocaleString('en-IN')} challans in a financial year, and GST allows the number no more than ${CHALLAN_NUMBER_MAX_LENGTH} characters in total. Shorten the prefix or drop the branch code.`,
    );
  }
};
