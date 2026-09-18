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

/** The arithmetic is shared with challans and credit and debit notes (#185). */
export type NumberSeries = DocumentSeries;

/** `INV/26-27/000001` — sixteen characters, and room for 999,999 bills in a financial year. */
export const DEFAULT_SERIES: NumberSeries = { prefix: 'INV', branchCode: '' };

/** Rule 46(b). */
export const INVOICE_NUMBER_MAX_LENGTH = DOCUMENT_NUMBER_MAX_LENGTH;

/**
 * A series that cannot reach 99,999 bills in a year is refused outright. That is what this product
 * managed before the running number was widened, so no choice a business makes here can leave it
 * worse off than it already was.
 */
export const MIN_BILLS_PER_YEAR = MIN_DOCUMENTS_PER_YEAR;

export const INVOICE_SERIES_KIND: DocumentSeriesKind = {
  scope: 'sales',
  noun: 'invoice',
  plural: 'bills',
  examplePrefix: 'INV',
  codes: {
    badSequence: 'SALES_BAD_SEQUENCE',
    exhausted: 'SALES_SERIES_EXHAUSTED',
    prefixRequired: 'SALES_PREFIX_REQUIRED',
    characters: 'SALES_SERIES_CHARACTERS',
    tooFew: 'SALES_SERIES_TOO_FEW_BILLS',
    sharesPrefix: 'SALES_SERIES_SHARES_PREFIX',
  },
};

/** How many digits are left for the running number once the prefix and the year have had their share. */
export const sequenceDigits = (series: NumberSeries): number => documentSequenceDigits(series);

/** The most bills this series can number in one financial year. */
export const billsPerYear = (series: NumberSeries): number => documentsPerYear(series);

export const seriesScope = (series: NumberSeries, date: IsoDate): string => documentSeriesScope(INVOICE_SERIES_KIND, series, date);

export const formatNumber = (series: NumberSeries, date: IsoDate, sequence: number): string =>
  formatDocumentNumber(INVOICE_SERIES_KIND, series, date, sequence);

/**
 * Refuses a series that could not number enough bills, before a single one is issued on it.
 *
 * There is no overflow to check for at issue time any more — the running number is as wide as the
 * sixteen characters allow — so what is checked here is whether the prefix and branch code have
 * eaten so much of the number that too little is left.
 */
export const validateSeries = (series: NumberSeries): void => validateDocumentSeries(INVOICE_SERIES_KIND, series);

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
