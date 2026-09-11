/**
 * Issue #141 — the delivery challan's own number series.
 *
 * CGST Rule 55(1) asks for "a consecutive serial number not exceeding sixteen characters, in one or
 * multiple series", unique for the financial year. So a challan number:
 *
 *  - comes from a counter of its own, never the invoice counter, so issuing a challan can never
 *    leave a gap in the invoice series or the other way round;
 *  - is allocated in the same transaction that saves the challan, so two people issuing at once
 *    cannot receive the same number;
 *  - is refused outright if it would run past sixteen characters, rather than printed too long.
 *
 * The financial year is written short ("26-27") because the long form would spend seven of the
 * sixteen characters on the year alone.
 */
import { financialYearOf, invalid, type IsoDate } from '@invoice/kernel';

export interface ChallanSeries {
  /** Shown in the number, e.g. "DC". Must differ from the invoice prefix. */
  readonly prefix: string;
  /** A short branch code, or empty for one series across the business. */
  readonly branchCode: string;
  readonly padding: number;
}

export const DEFAULT_CHALLAN_SERIES: ChallanSeries = { prefix: 'DC', branchCode: '', padding: 5 };

/** Rule 55(1). */
export const CHALLAN_NUMBER_MAX_LENGTH = 16;

const ALLOWED = /^[A-Za-z0-9/-]+$/;

const shortYear = (date: IsoDate): string => financialYearOf(date).slice(2);

export const challanSeriesScope = (series: ChallanSeries, date: IsoDate): string =>
  `challan:${series.prefix}:${series.branchCode}:${financialYearOf(date)}`;

export const formatChallanNumber = (series: ChallanSeries, date: IsoDate, sequence: number): string => {
  if (!Number.isInteger(sequence) || sequence < 1) throw invalid('CHALLAN_BAD_SEQUENCE', 'A challan number starts at 1.');
  const parts = [series.prefix, ...(series.branchCode === '' ? [] : [series.branchCode]), shortYear(date), String(sequence).padStart(series.padding, '0')];
  const number = parts.join('/');
  if (number.length > CHALLAN_NUMBER_MAX_LENGTH) {
    throw invalid(
      'CHALLAN_NUMBER_TOO_LONG',
      `Challan number ${number} is ${number.length} characters long. GST allows at most ${CHALLAN_NUMBER_MAX_LENGTH}, so choose a shorter prefix or branch code.`,
    );
  }
  return number;
};

/**
 * Refuses a series that could not produce a legal number, before anything is issued on it.
 *
 * Checked with the widest sequence the padding allows, so a series that works for challan 1 and
 * breaks at challan 10,000 is refused on the first day rather than on the ten-thousandth.
 */
export const validateChallanSeries = (series: ChallanSeries, invoicePrefix?: string): void => {
  if (series.prefix.trim() === '') throw invalid('CHALLAN_PREFIX_REQUIRED', 'A challan series needs a prefix, such as DC.');
  for (const part of [series.prefix, series.branchCode]) {
    if (part !== '' && !ALLOWED.test(part)) {
      throw invalid('CHALLAN_SERIES_CHARACTERS', 'A challan number may contain only letters, digits, "-" and "/".');
    }
  }
  if (invoicePrefix !== undefined && series.prefix === invoicePrefix) {
    throw invalid(
      'CHALLAN_SERIES_SHARES_INVOICE_PREFIX',
      `Challans and invoices both start with ${series.prefix}. They must be told apart at a glance, so give challans their own prefix.`,
    );
  }
  const widest = [series.prefix, ...(series.branchCode === '' ? [] : [series.branchCode]), '26-27', '9'.repeat(Math.max(series.padding, 1))].join('/');
  if (widest.length > CHALLAN_NUMBER_MAX_LENGTH) {
    throw invalid(
      'CHALLAN_NUMBER_TOO_LONG',
      `This series would print numbers like ${widest}, which is ${widest.length} characters. GST allows at most ${CHALLAN_NUMBER_MAX_LENGTH}.`,
    );
  }
};
