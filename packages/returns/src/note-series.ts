/**
 * Issue #185 — credit and debit note numbers, unique for a financial year.
 *
 * CGST Rule 53(1A)(c) asks for "a consecutive serial number not exceeding sixteen characters ...
 * unique for a financial year". The first version scoped the counter by the calendar year of the
 * note's date, so it restarted on 1 January and gave out `CN/000001` a second time in the same
 * financial year. Notes are now numbered exactly like invoices and challans, by the same shared
 * rules: `CN/26-27/0000001` and `DN/26-27/0000001`, sixteen characters each.
 *
 * Notes issued before this change keep their numbers. They carry no year, so they can never collide
 * with a number in the new form.
 */
import {
  DEFAULT_CHALLAN_SERIES,
  DEFAULT_PRESALE_SERIES,
  DEFAULT_SERIES,
  validateDocumentSeries,
  type DocumentSeries,
  type DocumentSeriesKind,
} from '@invoice/sales';

export interface NoteSeries {
  readonly creditNote: DocumentSeries;
  readonly debitNote: DocumentSeries;
}

export const DEFAULT_NOTE_SERIES: NoteSeries = {
  creditNote: { prefix: 'CN', branchCode: '' },
  debitNote: { prefix: 'DN', branchCode: '' },
};

/** The prefixes the other numbered documents use by default. */
export const DEFAULT_OTHER_DOCUMENT_PREFIXES: readonly string[] = [
  DEFAULT_SERIES.prefix,
  DEFAULT_CHALLAN_SERIES.prefix,
  DEFAULT_PRESALE_SERIES.QUOTATION.prefix,
  DEFAULT_PRESALE_SERIES.PROFORMA.prefix,
];

export const CREDIT_NOTE_SERIES_KIND: DocumentSeriesKind = {
  scope: 'sales-return',
  noun: 'credit note',
  plural: 'credit notes',
  examplePrefix: 'CN',
  codes: {
    badSequence: 'RETURN_NOTE_BAD_SEQUENCE',
    exhausted: 'RETURN_NOTE_SERIES_EXHAUSTED',
    prefixRequired: 'RETURN_NOTE_PREFIX_REQUIRED',
    characters: 'RETURN_NOTE_SERIES_CHARACTERS',
    tooFew: 'RETURN_NOTE_SERIES_TOO_FEW',
    sharesPrefix: 'RETURN_NOTE_SERIES_SHARES_PREFIX',
  },
};

export const DEBIT_NOTE_SERIES_KIND: DocumentSeriesKind = {
  ...CREDIT_NOTE_SERIES_KIND,
  scope: 'purchase-return',
  noun: 'debit note',
  plural: 'debit notes',
  examplePrefix: 'DN',
};

/**
 * Refuses note series that could share a number with another kind of document: the credit note
 * prefix must differ from every other document's, and the debit note prefix from those and from
 * the credit note's.
 */
export const validateNoteSeries = (series: NoteSeries, otherPrefixes: readonly string[] = DEFAULT_OTHER_DOCUMENT_PREFIXES): void => {
  validateDocumentSeries(CREDIT_NOTE_SERIES_KIND, series.creditNote, otherPrefixes);
  validateDocumentSeries(DEBIT_NOTE_SERIES_KIND, series.debitNote, [...otherPrefixes, series.creditNote.prefix]);
};
