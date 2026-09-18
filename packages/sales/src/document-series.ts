/**
 * Issue #185 — one set of numbering rules for every numbered document: the invoice, the delivery
 * challan, the credit note and the debit note.
 *
 * GST asks the same thing of all four. Rule 46(b) for the invoice, 55(1) for the challan and 53(1A)
 * for credit and debit notes each want "a consecutive serial number not exceeding sixteen
 * characters, in one or multiple series", unique for a financial year. Each series had grown its own
 * copy of the arithmetic, and the notes' copy scoped its counter by calendar year, so it restarted
 * on 1 January and issued the same number twice in one financial year. There is now one copy.
 *
 * A number is `PREFIX[/BRANCH]/YY-YY/RUNNING`. The year is written short, and the running number is
 * given every character that is left, so the default series use all sixteen. How many digits that
 * is, is not a setting: a business cannot predict how many documents it will issue in a year, and a
 * character left unused is headroom thrown away (#169).
 */
import { financialYearOf, invalid, type IsoDate } from '@invoice/kernel';

export interface DocumentSeries {
  /** Shown in the number, e.g. "INV". */
  readonly prefix: string;
  /** A short branch code, or empty for one series across the business. */
  readonly branchCode: string;
}

/** What differs between one kind of document and another: its name, and its error codes. */
export interface DocumentSeriesKind {
  /** The counter's name in the scope key, e.g. "sales" or "sales-return". */
  readonly scope: string;
  /** In a sentence: "invoice", "credit note". */
  readonly noun: string;
  /** In a sentence, counted: "bills", "credit notes". */
  readonly plural: string;
  readonly examplePrefix: string;
  readonly codes: {
    readonly badSequence: string;
    readonly exhausted: string;
    readonly prefixRequired: string;
    readonly characters: string;
    readonly tooFew: string;
    readonly sharesPrefix: string;
  };
}

/** Rules 46(b), 53(1A) and 55(1). */
export const DOCUMENT_NUMBER_MAX_LENGTH = 16;

/** A series that cannot number this many documents in a year is refused outright. */
export const MIN_DOCUMENTS_PER_YEAR = 99_999;

const SHORT_YEAR_LENGTH = 5; // "26-27"
const ALLOWED = /^[A-Za-z0-9-]+$/;

const shortYear = (date: IsoDate): string => financialYearOf(date).slice(2);
const partsOf = (series: DocumentSeries, year: string, sequence: string): string =>
  [series.prefix, ...(series.branchCode === '' ? [] : [series.branchCode]), year, sequence].join('/');

/** Everything in the number that is not the running number, separators included. */
const fixedLength = (series: DocumentSeries): number =>
  series.prefix.length + 1 + (series.branchCode === '' ? 0 : series.branchCode.length + 1) + SHORT_YEAR_LENGTH + 1;

/** How many digits are left for the running number once the prefix and the year have had their share. */
export const documentSequenceDigits = (series: DocumentSeries): number => DOCUMENT_NUMBER_MAX_LENGTH - fixedLength(series);

/** The most documents this series can number in one financial year. */
export const documentsPerYear = (series: DocumentSeries): number => {
  const digits = documentSequenceDigits(series);
  return digits < 1 ? 0 : 10 ** digits - 1;
};

/** The counter a number is drawn from: one per kind, prefix, branch and financial year. */
export const documentSeriesScope = (kind: DocumentSeriesKind, series: DocumentSeries, date: IsoDate): string =>
  `${kind.scope}:${series.prefix}:${series.branchCode}:${financialYearOf(date)}`;

export const formatDocumentNumber = (kind: DocumentSeriesKind, series: DocumentSeries, date: IsoDate, sequence: number): string => {
  if (!Number.isInteger(sequence) || sequence < 1) throw invalid(kind.codes.badSequence, `A ${kind.noun} number starts at 1.`);
  const ceiling = documentsPerYear(series);
  if (sequence > ceiling) {
    throw invalid(
      kind.codes.exhausted,
      `This series has issued all ${ceiling.toLocaleString('en-IN')} of the ${kind.plural} it can number this financial year. Start a second series with its own prefix; GST allows more than one.`,
    );
  }
  return partsOf(series, shortYear(date), String(sequence).padStart(documentSequenceDigits(series), '0'));
};

/**
 * Refuses a series that could not number enough documents, or that could be mistaken for another
 * kind of document's, before anything is issued on it. `taken` is every other prefix in use: a
 * clerk tells an invoice from a credit note by the first letters of the number, and two kinds on one
 * prefix could carry the same number.
 */
export const validateDocumentSeries = (kind: DocumentSeriesKind, series: DocumentSeries, taken: readonly string[] = []): void => {
  if (series.prefix.trim() === '') {
    throw invalid(kind.codes.prefixRequired, `A ${kind.noun} series needs a prefix, such as ${kind.examplePrefix}.`);
  }
  for (const part of [series.prefix, series.branchCode]) {
    if (part !== '' && !ALLOWED.test(part)) {
      throw invalid(kind.codes.characters, `A ${kind.noun} prefix and branch code may contain only letters, digits and "-".`);
    }
  }
  if (taken.includes(series.prefix)) {
    throw invalid(
      kind.codes.sharesPrefix,
      `Another kind of document already starts with ${series.prefix}. Every ${kind.noun} must be told apart from it at a glance, so give ${kind.plural} their own prefix.`,
    );
  }
  const ceiling = documentsPerYear(series);
  if (ceiling < MIN_DOCUMENTS_PER_YEAR) {
    const sample = partsOf(series, '26-27', '0'.repeat(Math.max(documentSequenceDigits(series) - 1, 0)) + '1');
    throw invalid(
      kind.codes.tooFew,
      `A number like ${sample} leaves room for only ${ceiling.toLocaleString('en-IN')} ${kind.plural} in a financial year, and GST allows the number no more than ${DOCUMENT_NUMBER_MAX_LENGTH} characters in total. Shorten the prefix or drop the branch code so the running number has more digits.`,
    );
  }
};
