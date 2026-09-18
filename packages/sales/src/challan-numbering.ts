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
import type { IsoDate } from '@invoice/kernel';
import {
  DOCUMENT_NUMBER_MAX_LENGTH,
  MIN_DOCUMENTS_PER_YEAR,
  documentSequenceDigits,
  documentSeriesScope,
  documentsPerYear,
  formatDocumentNumber,
  validateDocumentSeries,
  type DocumentSeries,
  type DocumentSeriesKind,
} from './document-series.ts';

/** The prefix is shown in the number, e.g. "DC", and must differ from the invoice prefix. */
export type ChallanSeries = DocumentSeries;

export const DEFAULT_CHALLAN_SERIES: ChallanSeries = { prefix: 'DC', branchCode: '' };

/** Rule 55(1). */
export const CHALLAN_NUMBER_MAX_LENGTH = DOCUMENT_NUMBER_MAX_LENGTH;

/** As for invoices: a series that cannot reach this many in a year is refused outright. */
export const MIN_CHALLANS_PER_YEAR = MIN_DOCUMENTS_PER_YEAR;

export const CHALLAN_SERIES_KIND: DocumentSeriesKind = {
  scope: 'challan',
  noun: 'challan',
  plural: 'challans',
  examplePrefix: 'DC',
  codes: {
    badSequence: 'CHALLAN_BAD_SEQUENCE',
    exhausted: 'CHALLAN_SERIES_EXHAUSTED',
    prefixRequired: 'CHALLAN_PREFIX_REQUIRED',
    characters: 'CHALLAN_SERIES_CHARACTERS',
    tooFew: 'CHALLAN_SERIES_TOO_FEW_CHALLANS',
    sharesPrefix: 'CHALLAN_SERIES_SHARES_INVOICE_PREFIX',
  },
};

export const challanSequenceDigits = (series: ChallanSeries): number => documentSequenceDigits(series);

export const challansPerYear = (series: ChallanSeries): number => documentsPerYear(series);

export const challanSeriesScope = (series: ChallanSeries, date: IsoDate): string =>
  documentSeriesScope(CHALLAN_SERIES_KIND, series, date);

export const formatChallanNumber = (series: ChallanSeries, date: IsoDate, sequence: number): string =>
  formatDocumentNumber(CHALLAN_SERIES_KIND, series, date, sequence);

/**
 * Refuses a series that could not number enough challans, or that could be mistaken for the
 * invoice's, before anything is issued on it.
 */
export const validateChallanSeries = (series: ChallanSeries, invoicePrefix?: string): void =>
  validateDocumentSeries(CHALLAN_SERIES_KIND, series, invoicePrefix === undefined ? [] : [invoicePrefix]);
