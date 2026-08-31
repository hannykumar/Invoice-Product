/**
 * Issue #31 [E31] — putting our bill and the supplier's report side by side.
 *
 * Matching two lists of invoices sounds like a join and is not. Invoice numbers are typed by
 * people at both ends: "INV-001", "INV/001", "inv 1" and "INV0001" are one bill written four ways,
 * and the supplier's accountant will use a fifth. Dates slip by a day across a month end. Figures
 * differ by a rupee because somebody rounded, or by nine hundred because somebody was wrong.
 *
 * So the comparison is done in two passes, and the two are kept apart deliberately:
 *
 *   1. **Exact.** Same registration, same invoice number character for character, same date. This
 *      is the pass that handles almost everything, and it needs no judgement at all.
 *   2. **Fuzzy.** Same registration, and then a number that agrees once punctuation and leading
 *      zeros are set aside, or a date within a few days with the taxable value agreeing. Never
 *      across registrations: two different suppliers' bills are never the same bill, whatever
 *      their numbers look like, and a product that guessed otherwise would move credit between
 *      two real businesses.
 *
 * A fuzzy pairing is not presented as a fact. Every pair, exact or not, carries the field-by-field
 * evidence that produced it, and a pair with any figure out of tolerance is reported as `CLOSE` —
 * the same bill, different money — rather than as a match. The one thing this file will not do is
 * decide anything about credit; that is `itc.ts`, downstream of the evidence.
 */
import { formatINR, type Money } from '@invoice/kernel';
import {
  DEFAULT_MATCH_POLICY,
  MATCH_STATUS_PLAIN,
  totalTaxOf,
  type Bilingual,
  type BookPurchaseDocument,
  type DocumentKind,
  type EvidenceField,
  type ItcMatchPolicy,
  type MatchEvidence,
  type MatchStatus,
  type PortalDocument,
  type TaxAmounts,
} from './types.ts';

// ---------------------------------------------------------------------------- normalisation

/**
 * An invoice number reduced to what two people typing it would still agree on.
 *
 * Case and punctuation go, because "inv/001" and "INV-001" are the same number in every shop in
 * India. Leading zeros inside each run of digits go too, so "INV001" meets "INV1". Nothing else is
 * touched: "INV1A" and "INV1B" stay different, because they are.
 */
export const normaliseNumber = (value: string): string =>
  value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/0*(\d+)/g, (_all, digits: string) => String(BigInt(digits)));

/** The exact key: nothing forgiven except case and spacing around the number. */
const exactKey = (gstin: string, number: string, date: string, kind: DocumentKind): string =>
  `${gstin.toUpperCase()}|${number.trim().toUpperCase()}|${date}|${kind}`;

/** The loose key, used only after the exact pass has taken everything it can. */
const fuzzyKey = (gstin: string, number: string, kind: DocumentKind): string =>
  `${gstin.toUpperCase()}|${normaliseNumber(number)}|${kind}`;

/**
 * The identity a decision is filed under.
 *
 * Exported because the service stores decisions against it and has to rebuild it from either side
 * of the comparison — the line for a bill missing from the portal must keep the same key after the
 * supplier finally reports it, or the accountant's answer would vanish the week it started to
 * matter.
 */
export const lineKeyOf = (gstin: string | null, number: string, kind: DocumentKind): string =>
  `${(gstin ?? 'NO-GSTIN').toUpperCase()}|${normaliseNumber(number)}|${kind}`;

const daysBetween = (a: string, b: string): number => {
  const left = Date.parse(`${a}T00:00:00Z`);
  const right = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(left) || Number.isNaN(right)) return Number.MAX_SAFE_INTEGER;
  return Math.abs(Math.round((left - right) / 86_400_000));
};

const within = (a: Money, b: Money, tolerance: bigint): boolean => {
  const gap = a.minor - b.minor;
  return (gap < 0n ? -gap : gap) <= tolerance;
};

// ---------------------------------------------------------------------------- evidence

const FIELD_LABELS: Readonly<Record<EvidenceField, Bilingual>> = Object.freeze({
  SUPPLIER_GSTIN: { 'en-IN': "Supplier's GST number", 'hi-IN': 'Supplier ka GST number' },
  INVOICE_NUMBER: { 'en-IN': 'Bill number', 'hi-IN': 'Bill number' },
  INVOICE_DATE: { 'en-IN': 'Bill date', 'hi-IN': 'Bill ki tareekh' },
  TAXABLE_VALUE: { 'en-IN': 'Value before GST', 'hi-IN': 'GST se pehle rakam' },
  TOTAL_TAX: { 'en-IN': 'GST on the bill', 'hi-IN': 'Bill par GST' },
  DOCUMENT_KIND: { 'en-IN': 'Kind of document', 'hi-IN': 'Kis tarah ka document' },
});

const KIND_PLAIN: Readonly<Record<DocumentKind, string>> = Object.freeze({
  INVOICE: 'bill',
  CREDIT_NOTE: 'credit note',
  DEBIT_NOTE: 'debit note',
});

const evidenceRow = (
  field: EvidenceField,
  ours: string | null,
  theirs: string | null,
  agrees: boolean,
  difference: Money | null = null,
): MatchEvidence => ({
  field,
  label: FIELD_LABELS[field],
  ours,
  theirs,
  verdict: ours === null ? 'ONLY_THEIRS' : theirs === null ? 'ONLY_OURS' : agrees ? 'AGREES' : 'DIFFERS',
  difference,
});

/**
 * The five comparisons the issue asks for, computed for whichever sides exist.
 *
 * A one-sided line still produces evidence. "We hold this and the portal holds nothing" is exactly
 * the fact somebody needs to see, and an empty evidence list would say nothing at all.
 */
export const evidenceFor = (
  book: BookPurchaseDocument | null,
  portal: PortalDocument | null,
  policy: ItcMatchPolicy = DEFAULT_MATCH_POLICY,
): readonly MatchEvidence[] => {
  const rows: MatchEvidence[] = [];

  rows.push(evidenceRow(
    'SUPPLIER_GSTIN',
    book?.supplierGstin ?? null,
    portal?.supplierGstin ?? null,
    (book?.supplierGstin ?? '').toUpperCase() === (portal?.supplierGstin ?? '').toUpperCase(),
  ));
  rows.push(evidenceRow(
    'INVOICE_NUMBER',
    book?.number ?? null,
    portal?.number ?? null,
    normaliseNumber(book?.number ?? '') === normaliseNumber(portal?.number ?? ''),
  ));
  rows.push(evidenceRow(
    'INVOICE_DATE',
    book?.documentDate ?? null,
    portal?.documentDate ?? null,
    book !== null && portal !== null && book.documentDate === portal.documentDate,
  ));
  rows.push(evidenceRow(
    'DOCUMENT_KIND',
    book === null ? null : KIND_PLAIN[book.kind],
    portal === null ? null : KIND_PLAIN[portal.kind],
    book !== null && portal !== null && book.kind === portal.kind,
  ));

  const ourTaxable = book?.amounts.taxableValue ?? null;
  const theirTaxable = portal?.amounts.taxableValue ?? null;
  rows.push(evidenceRow(
    'TAXABLE_VALUE',
    ourTaxable === null ? null : formatINR(ourTaxable),
    theirTaxable === null ? null : formatINR(theirTaxable),
    ourTaxable !== null && theirTaxable !== null && within(ourTaxable, theirTaxable, policy.amountTolerancePaise),
    ourTaxable === null || theirTaxable === null
      ? null
      : { currency: 'INR', minor: ourTaxable.minor - theirTaxable.minor },
  ));

  const ourTax = book === null ? null : totalTaxOf(book.amounts);
  const theirTax = portal === null ? null : totalTaxOf(portal.amounts);
  rows.push(evidenceRow(
    'TOTAL_TAX',
    ourTax === null ? null : formatINR(ourTax),
    theirTax === null ? null : formatINR(theirTax),
    ourTax !== null && theirTax !== null && within(ourTax, theirTax, policy.amountTolerancePaise),
    ourTax === null || theirTax === null ? null : { currency: 'INR', minor: ourTax.minor - theirTax.minor },
  ));

  return rows;
};

/** The fields that do not agree, which is what a screen leads with. */
export const disagreements = (evidence: readonly MatchEvidence[]): readonly MatchEvidence[] =>
  evidence.filter((row) => row.verdict === 'DIFFERS');

// ---------------------------------------------------------------------------- pairing

export interface MatchPair {
  readonly book: BookPurchaseDocument | null;
  readonly portal: PortalDocument | null;
  readonly status: MatchStatus;
  readonly evidence: readonly MatchEvidence[];
  readonly matchNote: Bilingual;
  /** True when the pairing itself came from the forgiving pass rather than an exact key. */
  readonly fuzzy: boolean;
}

export interface MatchInput {
  readonly books: readonly BookPurchaseDocument[];
  readonly portal: readonly PortalDocument[];
  readonly policy?: ItcMatchPolicy;
}

/**
 * Both lists in, one list of pairs out.
 *
 * Order is deterministic — by supplier registration, then bill number — because a screen that
 * reshuffles itself between two reads of the same month makes a person lose their place, and
 * because a test that has to sort before comparing is a test that is not checking the order.
 */
export const matchDocuments = (input: MatchInput): readonly MatchPair[] => {
  const policy = input.policy ?? DEFAULT_MATCH_POLICY;
  const pairs: MatchPair[] = [];

  const booksLeft = new Map<string, BookPurchaseDocument[]>();
  const portalLeft = new Map<string, PortalDocument[]>();

  // Duplicates are found here, before matching, because a duplicate is a fact about one side on
  // its own: the same bill recorded twice in our books is wrong whether or not the portal has it.
  const duplicateBooks = new Map<string, BookPurchaseDocument[]>();
  const duplicatePortal = new Map<string, PortalDocument[]>();

  for (const book of input.books) {
    const key = lineKeyOf(book.supplierGstin, book.number, book.kind);
    const bucket = duplicateBooks.get(key) ?? [];
    bucket.push(book);
    duplicateBooks.set(key, bucket);
  }
  for (const document of input.portal) {
    const key = lineKeyOf(document.supplierGstin, document.number, document.kind);
    const bucket = duplicatePortal.get(key) ?? [];
    bucket.push(document);
    duplicatePortal.set(key, bucket);
  }

  // The first of each duplicate group takes part in matching; the rest become their own lines, so
  // the credit is counted once and the second copy is visible rather than silently dropped.
  const extraBooks: BookPurchaseDocument[] = [];
  const extraPortal: PortalDocument[] = [];
  /**
   * Bills whose supplier registration we do not hold.
   *
   * They cannot be compared with anything — a bill number on its own belongs to no supplier — so
   * they are carried through as their own lines rather than dropped. A purchase that vanishes from
   * the comparison because a field was missing is precisely the silent hole this module exists to
   * close.
   */
  const unmatchable: BookPurchaseDocument[] = [];

  for (const [, group] of duplicateBooks) {
    const [first, ...rest] = group as [BookPurchaseDocument, ...BookPurchaseDocument[]];
    if (first.supplierGstin === null) {
      unmatchable.push(first);
      extraBooks.push(...rest);
      continue;
    }
    const key = exactKey(first.supplierGstin, first.number, first.documentDate, first.kind);
    const bucket = booksLeft.get(key) ?? [];
    bucket.push(first);
    booksLeft.set(key, bucket);
    extraBooks.push(...rest);
  }
  for (const [, group] of duplicatePortal) {
    const [first, ...rest] = group as [PortalDocument, ...PortalDocument[]];
    const key = exactKey(first.supplierGstin, first.number, first.documentDate, first.kind);
    const bucket = portalLeft.get(key) ?? [];
    bucket.push(first);
    portalLeft.set(key, bucket);
    extraPortal.push(...rest);
  }

  const matchedBooks = new Set<BookPurchaseDocument>();
  const matchedPortal = new Set<PortalDocument>();

  // Pass one: the exact key.
  for (const [key, group] of booksLeft) {
    const theirs = portalLeft.get(key);
    if (theirs === undefined || theirs.length === 0) continue;
    const book = group[0] as BookPurchaseDocument;
    const portal = theirs[0] as PortalDocument;
    matchedBooks.add(book);
    matchedPortal.add(portal);
    pairs.push(pairOf(book, portal, policy, false));
  }

  // Pass two: the forgiving one, over what is left.
  const remainingBooks = [...booksLeft.values()].flat().filter((book) => !matchedBooks.has(book));
  const remainingPortal = [...portalLeft.values()].flat().filter((document) => !matchedPortal.has(document));

  for (const book of remainingBooks) {
    if (book.supplierGstin === null) continue;
    const candidate = remainingPortal.find((document) => {
      if (matchedPortal.has(document)) return false;
      if (document.supplierGstin.toUpperCase() !== (book.supplierGstin as string).toUpperCase()) return false;
      if (document.kind !== book.kind) return false;
      const sameNumber = fuzzyKey(document.supplierGstin, document.number, document.kind)
        === fuzzyKey(book.supplierGstin as string, book.number, book.kind);
      if (sameNumber) return true;
      // A renumbered bill is still findable when the date and the money both agree; either alone
      // is not enough, because one supplier can raise several bills on one day.
      const closeDate = daysBetween(book.documentDate, document.documentDate) <= policy.dateToleranceDays;
      const sameValue = within(book.amounts.taxableValue, document.amounts.taxableValue, policy.amountTolerancePaise);
      return closeDate && sameValue;
    });
    if (candidate === undefined) continue;
    matchedBooks.add(book);
    matchedPortal.add(candidate);
    pairs.push(pairOf(book, candidate, policy, true));
  }

  for (const book of remainingBooks) {
    if (matchedBooks.has(book)) continue;
    pairs.push(pairOf(book, null, policy, false));
  }
  for (const document of remainingPortal) {
    if (matchedPortal.has(document)) continue;
    pairs.push(pairOf(null, document, policy, false));
  }
  for (const book of unmatchable) {
    pairs.push(pairOf(book, null, policy, false));
  }
  for (const book of extraBooks) {
    pairs.push({ ...pairOf(book, null, policy, false), status: 'DUPLICATE_IN_BOOKS', matchNote: DUPLICATE_BOOKS_NOTE });
  }
  for (const document of extraPortal) {
    pairs.push({ ...pairOf(null, document, policy, false), status: 'DUPLICATE_ON_PORTAL', matchNote: DUPLICATE_PORTAL_NOTE });
  }

  return pairs.sort((left, right) => sortKeyOf(left).localeCompare(sortKeyOf(right)));
};

const sortKeyOf = (pair: MatchPair): string => {
  const gstin = pair.book?.supplierGstin ?? pair.portal?.supplierGstin ?? 'ZZ';
  const number = pair.book?.number ?? pair.portal?.number ?? '';
  return `${gstin}|${normaliseNumber(number)}`;
};

const DUPLICATE_BOOKS_NOTE: Bilingual = {
  'en-IN': 'This bill number is in your books more than once for this supplier. Credit can only be taken once.',
  'hi-IN': 'Yeh bill number is supplier ke liye aapki books mein ek se zyada baar hai. Credit sirf ek baar milta hai.',
};

const DUPLICATE_PORTAL_NOTE: Bilingual = {
  'en-IN': 'The portal carries this bill number more than once for this supplier.',
  'hi-IN': 'Portal par is supplier ka yeh bill number ek se zyada baar hai.',
};

const pairOf = (
  book: BookPurchaseDocument | null,
  portal: PortalDocument | null,
  policy: ItcMatchPolicy,
  fuzzy: boolean,
): MatchPair => {
  const evidence = evidenceFor(book, portal, policy);
  const status = statusOf(book, portal, evidence);
  return { book, portal, status, evidence, matchNote: noteFor(status, evidence, fuzzy), fuzzy };
};

const statusOf = (
  book: BookPurchaseDocument | null,
  portal: PortalDocument | null,
  evidence: readonly MatchEvidence[],
): MatchStatus => {
  if (book === null) return 'ONLY_ON_PORTAL';
  if (portal === null) return 'ONLY_IN_BOOKS';
  const moneyDisagrees = evidence.some(
    (row) => (row.field === 'TAXABLE_VALUE' || row.field === 'TOTAL_TAX') && row.verdict === 'DIFFERS',
  );
  const dateDisagrees = evidence.some((row) => row.field === 'INVOICE_DATE' && row.verdict === 'DIFFERS');
  const numberDisagrees = evidence.some((row) => row.field === 'INVOICE_NUMBER' && row.verdict === 'DIFFERS');
  return moneyDisagrees || dateDisagrees || numberDisagrees ? 'CLOSE' : 'EXACT';
};

const noteFor = (status: MatchStatus, evidence: readonly MatchEvidence[], fuzzy: boolean): Bilingual => {
  if (status === 'EXACT') {
    return fuzzy
      ? {
        'en-IN': 'Matched on the supplier and the bill number written slightly differently. Every figure agrees.',
        'hi-IN': 'Supplier aur thoda alag likhe bill number se mila. Saare figure milte hain.',
      }
      : {
        'en-IN': 'The supplier, the bill number, the date and every figure agree.',
        'hi-IN': 'Supplier, bill number, tareekh aur har figure milta hai.',
      };
  }
  if (status === 'CLOSE') {
    const differing = disagreements(evidence).map((row) => row.label['en-IN'].toLowerCase());
    const differingHindi = disagreements(evidence).map((row) => row.label['hi-IN']);
    return {
      'en-IN': `Almost certainly the same bill, but ${differing.join(' and ')} ${differing.length === 1 ? 'does' : 'do'} not agree.`,
      'hi-IN': `Bill wahi lagta hai, par ${differingHindi.join(' aur ')} nahin milta.`,
    };
  }
  return MATCH_STATUS_PLAIN[status];
};

/** Sums a set of tax amounts, for the workspace totals. Kept here so the two agree by construction. */
export const totalOf = (amounts: readonly TaxAmounts[]): TaxAmounts =>
  amounts.reduce(
    (total, one) => ({
      taxableValue: { currency: 'INR', minor: total.taxableValue.minor + one.taxableValue.minor },
      cgst: { currency: 'INR', minor: total.cgst.minor + one.cgst.minor },
      sgst: { currency: 'INR', minor: total.sgst.minor + one.sgst.minor },
      igst: { currency: 'INR', minor: total.igst.minor + one.igst.minor },
      cess: { currency: 'INR', minor: total.cess.minor + one.cess.minor },
    }),
    {
      taxableValue: { currency: 'INR', minor: 0n } as Money,
      cgst: { currency: 'INR', minor: 0n } as Money,
      sgst: { currency: 'INR', minor: 0n } as Money,
      igst: { currency: 'INR', minor: 0n } as Money,
      cess: { currency: 'INR', minor: 0n } as Money,
    },
  );
