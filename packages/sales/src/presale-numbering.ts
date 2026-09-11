/**
 * Issue #142 — the quotation's and the proforma's own number series.
 *
 * Each has a counter of its own: `QTN/26-27/00001` and `PI/26-27/00001` by default. The reason is a
 * rule about the *invoice*, not about these papers. CGST Rule 46(b) asks for tax invoices to be
 * numbered consecutively in their series, and a proforma that took a number from that series would
 * leave a gap in it — or worse, would itself look like a tax invoice. So neither ever touches the
 * invoice counter, and a prefix that could be mistaken for the invoice's or the challan's is refused.
 *
 * GST sets no length for these numbers. They are held to the sixteen characters an invoice number
 * may have anyway — a design choice, not a legal one — so every number this product prints fits the
 * same box on the page.
 *
 * The number is allocated in the same transaction that saves the document, so two people issuing at
 * once cannot receive the same number, and a refused document uses none.
 */
import { financialYearOf, invalid, type IsoDate } from '@invoice/kernel';
import type { PreSaleKind } from './presale-model.ts';

export interface PreSaleSeries {
  /** Shown in the number, e.g. "QTN". */
  readonly prefix: string;
  /** A short branch code, or empty for one series across the business. */
  readonly branchCode: string;
  readonly padding: number;
}

export const DEFAULT_PRESALE_SERIES: Readonly<Record<PreSaleKind, PreSaleSeries>> = {
  QUOTATION: { prefix: 'QTN', branchCode: '', padding: 5 },
  PROFORMA: { prefix: 'PI', branchCode: '', padding: 5 },
};

export const PRESALE_NUMBER_MAX_LENGTH = 16;

const ALLOWED = /^[A-Za-z0-9/-]+$/;
const NAMES: Record<PreSaleKind, string> = { QUOTATION: 'quotation', PROFORMA: 'proforma invoice' };

const shortYear = (date: IsoDate): string => financialYearOf(date).slice(2);
const partsOf = (series: PreSaleSeries, year: string, sequence: string): string =>
  [series.prefix, ...(series.branchCode === '' ? [] : [series.branchCode]), year, sequence].join('/');

export const preSaleSeriesScope = (kind: PreSaleKind, series: PreSaleSeries, date: IsoDate): string =>
  `${kind.toLowerCase()}:${series.prefix}:${series.branchCode}:${financialYearOf(date)}`;

export const formatPreSaleNumber = (kind: PreSaleKind, series: PreSaleSeries, date: IsoDate, sequence: number): string => {
  if (!Number.isInteger(sequence) || sequence < 1) throw invalid('PRESALE_BAD_SEQUENCE', `A ${NAMES[kind]} number starts at 1.`);
  const number = partsOf(series, shortYear(date), String(sequence).padStart(series.padding, '0'));
  if (number.length > PRESALE_NUMBER_MAX_LENGTH) {
    throw invalid(
      'PRESALE_NUMBER_TOO_LONG',
      `${NAMES[kind][0]?.toUpperCase()}${NAMES[kind].slice(1)} number ${number} is ${number.length} characters long. Keep it to ${PRESALE_NUMBER_MAX_LENGTH}, like an invoice number, by choosing a shorter prefix or branch code.`,
    );
  }
  return number;
};

/**
 * Refuses a series that could not produce a usable number, or that could be mistaken for another
 * document's, before anything is issued on it.
 *
 * `taken` is every other prefix in use — the invoice's, the challan's, and the other of these two —
 * because a buyer's clerk tells documents apart by the first few letters of the number.
 */
export const validatePreSaleSeries = (kind: PreSaleKind, series: PreSaleSeries, taken: readonly string[] = []): void => {
  const name = NAMES[kind];
  if (series.prefix.trim() === '') throw invalid('PRESALE_PREFIX_REQUIRED', `A ${name} series needs a prefix, such as ${DEFAULT_PRESALE_SERIES[kind].prefix}.`);
  for (const part of [series.prefix, series.branchCode]) {
    if (part !== '' && !ALLOWED.test(part)) {
      throw invalid('PRESALE_SERIES_CHARACTERS', `A ${name} number may contain only letters, digits, "-" and "/".`);
    }
  }
  if (taken.includes(series.prefix)) {
    throw invalid(
      'PRESALE_SERIES_SHARES_PREFIX',
      `Another document already starts with ${series.prefix}. A ${name} must be told apart from an invoice at a glance, so give it its own prefix.`,
    );
  }
  const widest = partsOf(series, '26-27', '9'.repeat(Math.max(series.padding, 1)));
  if (widest.length > PRESALE_NUMBER_MAX_LENGTH) {
    throw invalid(
      'PRESALE_NUMBER_TOO_LONG',
      `This series would print numbers like ${widest}, which is ${widest.length} characters. Keep it to ${PRESALE_NUMBER_MAX_LENGTH}, like an invoice number.`,
    );
  }
};
