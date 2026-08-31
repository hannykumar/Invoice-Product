/**
 * Issue #30 [E30] — building GSTR-1 out of the classified documents.
 *
 * The classifier decided which table each bill belongs in. This file turns those decisions into
 * the rows the form actually carries, and it is where the shape of the tables differs:
 *
 *  - **Listed tables** (`B2B`, `B2CL`, `CDNR`, `CDNUR`, `EXP` and their correction tables) carry
 *    one row per bill per rate. A bill with a 5% line and an 18% line is two rows.
 *  - **Summary tables** (`B2CS`) carry no bill numbers at all: one row per state per rate, added
 *    up. A credit note below the listing limit is subtracted inside that row.
 *  - **`HSN`** groups by the goods or services code and rate across everything, ignoring who the
 *    buyer was.
 *  - **`DOCS`** does not look at money at all. It reports which bill numbers were used.
 *
 * Every row keeps the documents that made it. That is not decoration: it is the first acceptance
 * criterion of the issue, and the reconciliation in `reconcile.ts` reads those same references to
 * prove the return and the books agree.
 */
import { formatINR } from '@invoice/kernel';
import { classifyDocument, isNote, sourceRefOf, stateNameOf, type ClassifyContext } from './classify.ts';
import {
  GSTR1_SECTION_NAMES,
  addAmounts,
  amountsAreZero,
  emptyAmounts,
  formatTaxPeriod,
  negateAmounts,
  sumAmounts,
  totalTaxOf,
  type Bilingual,
  type DocumentSeriesRow,
  type Gstr1Return,
  type Gstr1Row,
  type Gstr1Section,
  type Gstr1SectionId,
  type HsnRow,
  type OutwardDocument,
  type ReturnFinding,
  type SourceRef,
  type TaxAmounts,
  type TaxPeriod,
} from './types.ts';

/** Tables where each bill is listed on its own; everything else is a summary. */
const LISTED: readonly Gstr1SectionId[] = ['B2B', 'B2CL', 'CDNR', 'CDNUR', 'EXP', 'AT', 'B2BA', 'B2CLA', 'CDNRA', 'CDNURA'];

/**
 * The order the sections appear on screen and in the file.
 *
 * It follows the form rather than the alphabet, because a preparer checking a return against the
 * portal is reading the two side by side.
 */
export const SECTION_ORDER: readonly Gstr1SectionId[] = [
  'B2B', 'B2CL', 'B2CS', 'CDNR', 'CDNUR', 'EXP', 'NIL', 'AT',
  'B2BA', 'B2CLA', 'B2CSA', 'CDNRA', 'CDNURA',
];

export interface Gstr1BuildInput {
  readonly period: TaxPeriod;
  readonly gstin: string;
  readonly documents: readonly OutwardDocument[];
  /** Numbers that were issued and then cancelled, for the document-series table. */
  readonly cancelledNumbers?: readonly { readonly kind: OutwardDocument['kind']; readonly number: string }[];
}

export interface Gstr1BuildResult {
  readonly return: Gstr1Return;
  /** Documents the classifier could not place, with the questions that would place them. */
  readonly unresolved: readonly { readonly document: OutwardDocument; readonly findings: readonly ReturnFinding[] }[];
  readonly findings: readonly ReturnFinding[];
  /** Why each placed document landed where it did, for the "why is this here" panel. */
  readonly reasons: readonly { readonly sourceId: string; readonly section: Gstr1SectionId; readonly reason: Bilingual }[];
}

/**
 * A note reduces what was sold, so its amounts enter the return as negatives.
 *
 * A debit note does the opposite and keeps its sign. Doing this once, here, is why no table below
 * has to remember which way a note points.
 */
const signedAmounts = (document: OutwardDocument, amounts: TaxAmounts): TaxAmounts =>
  document.kind === 'CREDIT_NOTE' || document.kind === 'REFUND_VOUCHER' ? negateAmounts(amounts) : amounts;

const lineAmountsByRate = (document: OutwardDocument): Map<string, { rate: bigint | null; amounts: TaxAmounts }> => {
  const byRate = new Map<string, { rate: bigint | null; amounts: TaxAmounts }>();
  for (const line of document.lines) {
    const key = line.ratePercentTimes100 === null ? 'none' : line.ratePercentTimes100.toString();
    const existing = byRate.get(key) ?? { rate: line.ratePercentTimes100, amounts: emptyAmounts() };
    byRate.set(key, { rate: existing.rate, amounts: addAmounts(existing.amounts, line.amounts) });
  }
  return byRate;
};

const rowsForListed = (document: OutwardDocument, section: Gstr1SectionId): Gstr1Row[] => {
  const source = sourceRefOf(document);
  return [...lineAmountsByRate(document).entries()].map(([key, entry]) => ({
    section,
    key: `${section}|${document.sourceId}|${key}`,
    counterpartyGstin: document.counterpartyGstin,
    counterpartyName: document.partyName,
    placeOfSupplyStateCode: document.placeOfSupplyStateCode,
    documentNumber: document.number,
    documentDate: document.documentDate,
    documentKind: document.kind,
    treatment: document.treatment,
    ratePercentTimes100: entry.rate,
    reverseCharge: document.reverseCharge,
    invoiceValue: document.invoiceValue,
    amounts: signedAmounts(document, entry.amounts),
    ...(document.amends === undefined ? {} : { amendmentOf: document.amends }),
    sources: [source],
  }));
};

/**
 * Summary rows, keyed by state and rate.
 *
 * The key deliberately excludes the bill, because that is the point of a summary table: the
 * government is told that ₹40,000 of 18% sales happened in Maharashtra, not who bought what. The
 * bills are still on the row in `sources`, so the shopkeeper can still open it up.
 */
const mergeSummary = (
  into: Map<string, Gstr1Row>,
  document: OutwardDocument,
  section: Gstr1SectionId,
): void => {
  const source = sourceRefOf(document);
  for (const [rateKey, entry] of lineAmountsByRate(document)) {
    const state = document.placeOfSupplyStateCode ?? 'unknown';
    const key = `${section}|${state}|${rateKey}`;
    const existing = into.get(key);
    const amounts = signedAmounts(document, entry.amounts);
    into.set(key, {
      section,
      key,
      counterpartyGstin: null,
      counterpartyName: null,
      placeOfSupplyStateCode: document.placeOfSupplyStateCode,
      documentNumber: null,
      documentDate: null,
      documentKind: null,
      treatment: document.treatment,
      ratePercentTimes100: entry.rate,
      reverseCharge: false,
      invoiceValue: null,
      amounts: existing === undefined ? amounts : addAmounts(existing.amounts, amounts),
      sources: existing === undefined ? [source] : [...existing.sources, source],
    });
  }
};

/**
 * The nil table, which counts value by reason rather than by rate.
 *
 * Nil-rated, exempt and outside-GST are three different things in law and three different columns
 * on the form, so they are three different rows here rather than one "no tax" total.
 */
const mergeNil = (into: Map<string, Gstr1Row>, document: OutwardDocument): void => {
  const source = sourceRefOf(document);
  const interState = document.placeOfSupplyStateCode !== document.supplierStateCode;
  const registered = document.counterpartyGstin !== null;
  const key = `NIL|${document.treatment}|${interState ? 'inter' : 'intra'}|${registered ? 'b2b' : 'b2c'}`;
  const existing = into.get(key);
  const amounts = signedAmounts(document, sumAmounts(document.lines.map((l) => l.amounts)));
  into.set(key, {
    section: 'NIL',
    key,
    counterpartyGstin: null,
    counterpartyName: null,
    placeOfSupplyStateCode: document.placeOfSupplyStateCode,
    documentNumber: null,
    documentDate: null,
    documentKind: null,
    treatment: document.treatment,
    ratePercentTimes100: null,
    reverseCharge: false,
    invoiceValue: null,
    amounts: existing === undefined ? amounts : addAmounts(existing.amounts, amounts),
    sources: existing === undefined ? [source] : [...existing.sources, source],
  });
};

/** Groups every line of every document by code and rate, for the HSN summary table. */
const buildHsn = (documents: readonly OutwardDocument[]): { rows: HsnRow[]; findings: ReturnFinding[] } => {
  const rows = new Map<string, { row: HsnRow; quantity: bigint; scale: number }>();
  const findings: ReturnFinding[] = [];
  const withoutCode = new Set<string>();

  for (const document of documents) {
    const source = sourceRefOf(document);
    for (const line of document.lines) {
      if (line.hsnOrSac === null || line.hsnOrSac.trim() === '') {
        withoutCode.add(document.number);
        continue;
      }
      const rateKey = line.ratePercentTimes100 === null ? 'none' : line.ratePercentTimes100.toString();
      const key = `${line.hsnOrSac}|${rateKey}|${line.unit ?? ''}`;
      const amounts = signedAmounts(document, line.amounts);
      const existing = rows.get(key);
      const quantity = parseQuantity(line.quantity);
      if (existing === undefined) {
        rows.set(key, {
          quantity: quantity.value * (document.kind === 'CREDIT_NOTE' ? -1n : 1n),
          scale: quantity.scale,
          row: {
            hsnOrSac: line.hsnOrSac,
            description: line.description,
            unit: line.unit,
            quantity: line.quantity,
            ratePercentTimes100: line.ratePercentTimes100,
            amounts,
            sources: [source],
          },
        });
      } else {
        const scale = Math.max(existing.scale, quantity.scale);
        const total = rescale(existing.quantity, existing.scale, scale) +
          rescale(quantity.value, quantity.scale, scale) * (document.kind === 'CREDIT_NOTE' ? -1n : 1n);
        rows.set(key, {
          quantity: total,
          scale,
          row: {
            ...existing.row,
            amounts: addAmounts(existing.row.amounts, amounts),
            quantity: formatQuantity(total, scale),
            sources: [...existing.row.sources, source],
          },
        });
      }
    }
  }

  if (withoutCode.size > 0) {
    const numbers = [...withoutCode].sort();
    findings.push({
      code: 'GSTR1_HSN_MISSING',
      severity: 'WARNING',
      origin: 'VALIDATION',
      message: {
        'en-IN': `${numbers.length === 1 ? 'One bill has' : `${numbers.length} bills have`} a line with no goods or services code on it: ${numbers.join(', ')}.`,
        'hi-IN': `${numbers.length === 1 ? 'Ek bill' : `${numbers.length} bill`} par kisi line ka saaman ya service code nahi hai: ${numbers.join(', ')}.`,
      },
      whatToDo: {
        'en-IN': 'Add the code on the item so it reaches the code-wise summary. The rest of the return is unaffected, but the summary will be short by this much.',
        'hi-IN': 'Item par code bhariye taki code wale summary me aaye. Baaki return par asar nahi, par summary itna kam rahega.',
      },
    });
  }

  return {
    rows: [...rows.values()]
      .map((entry) => ({ ...entry.row, quantity: formatQuantity(entry.quantity, entry.scale) }))
      .sort((a, b) => a.hsnOrSac.localeCompare(b.hsnOrSac) || Number((a.ratePercentTimes100 ?? 0n) - (b.ratePercentTimes100 ?? 0n))),
    findings,
  };
};

/** Quantities are exact decimal strings everywhere in this product; they are added as scaled integers. */
const parseQuantity = (value: string | null): { value: bigint; scale: number } => {
  if (value === null || value.trim() === '') return { value: 0n, scale: 0 };
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (match === null) return { value: 0n, scale: 0 };
  const fraction = match[3] ?? '';
  const sign = match[1] === '-' ? -1n : 1n;
  return { value: sign * BigInt(`${match[2] as string}${fraction}`), scale: fraction.length };
};

const rescale = (value: bigint, from: number, to: number): bigint => value * 10n ** BigInt(to - from);

const formatQuantity = (value: bigint, scale: number): string => {
  if (scale === 0) return value.toString();
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  return `${negative ? '-' : ''}${whole}.${digits.slice(digits.length - scale)}`;
};

/**
 * The document-series table.
 *
 * The government asks which bill numbers a business used in the month and how many of them were
 * cancelled, because a gap in a numbered series is how an unreported sale shows up. The product
 * reports the range it actually issued rather than a range a person types, so the answer cannot
 * disagree with the books.
 */
const buildDocumentSeries = (
  documents: readonly OutwardDocument[],
  cancelled: readonly { kind: OutwardDocument['kind']; number: string }[],
): DocumentSeriesRow[] => {
  const byKind = new Map<OutwardDocument['kind'], string[]>();
  for (const document of documents) {
    byKind.set(document.kind, [...(byKind.get(document.kind) ?? []), document.number]);
  }
  for (const entry of cancelled) {
    byKind.set(entry.kind, [...(byKind.get(entry.kind) ?? []), entry.number]);
  }

  return [...byKind.entries()]
    .map(([kind, numbers]) => {
      const sorted = [...numbers].sort();
      const cancelledHere = cancelled.filter((c) => c.kind === kind).length;
      return {
        kind,
        from: sorted[0] as string,
        to: sorted[sorted.length - 1] as string,
        total: sorted.length,
        cancelled: cancelledHere,
        issued: sorted.length - cancelledHere,
      };
    })
    .sort((a, b) => a.kind.localeCompare(b.kind));
};

const sectionSentence = (id: Gstr1SectionId, rows: readonly Gstr1Row[], totals: TaxAmounts, documents: number): Bilingual => {
  if (rows.length === 0) {
    return { 'en-IN': 'Nothing in this part.', 'hi-IN': 'Is hisse me kuch nahi.' };
  }
  const tax = totalTaxOf(totals);
  const thing = LISTED.includes(id) ? (documents === 1 ? '1 document' : `${documents} documents`) : (rows.length === 1 ? '1 line' : `${rows.length} lines`);
  return {
    'en-IN': `${thing}, ${formatINR(totals.taxableValue)} before tax and ${formatINR(tax)} of GST.`,
    'hi-IN': `${thing}, tax se pehle ${formatINR(totals.taxableValue)} aur ${formatINR(tax)} GST.`,
  };
};

/**
 * Builds the whole of GSTR-1 from a set of documents.
 *
 * Nothing here reads a database or a clock; hand it the same documents and it produces the same
 * return, byte for byte, which is what makes the snapshot fingerprint in `service.ts` meaningful.
 */
export const buildGstr1 = (input: Gstr1BuildInput, context: ClassifyContext): Gstr1BuildResult => {
  const listedRows = new Map<Gstr1SectionId, Gstr1Row[]>();
  const summaryRows = new Map<string, Gstr1Row>();
  const documentsBySection = new Map<Gstr1SectionId, Set<string>>();
  const unresolved: { document: OutwardDocument; findings: readonly ReturnFinding[] }[] = [];
  const findings: ReturnFinding[] = [];
  const reasons: { sourceId: string; section: Gstr1SectionId; reason: Bilingual }[] = [];
  const placed: OutwardDocument[] = [];

  for (const document of input.documents) {
    const decision = classifyDocument(document, context);
    if (decision.outcome === 'UNRESOLVED') {
      unresolved.push({ document, findings: decision.findings });
      findings.push(...decision.findings);
      continue;
    }
    placed.push(document);
    findings.push(...decision.findings);
    reasons.push({ sourceId: document.sourceId, section: decision.section, reason: decision.reason });

    const seen = documentsBySection.get(decision.section) ?? new Set<string>();
    seen.add(document.sourceId);
    documentsBySection.set(decision.section, seen);

    if (decision.section === 'NIL') {
      mergeNil(summaryRows, document);
    } else if (LISTED.includes(decision.section)) {
      listedRows.set(decision.section, [...(listedRows.get(decision.section) ?? []), ...rowsForListed(document, decision.section)]);
    } else {
      mergeSummary(summaryRows, document, decision.section);
    }
  }

  const sections: Gstr1Section[] = SECTION_ORDER.map((id) => {
    const rows = LISTED.includes(id)
      ? [...(listedRows.get(id) ?? [])].sort((a, b) => (a.documentNumber ?? '').localeCompare(b.documentNumber ?? '') || a.key.localeCompare(b.key))
      : [...summaryRows.values()].filter((row) => row.section === id).sort((a, b) => a.key.localeCompare(b.key));
    const totals = sumAmounts(rows.map((row) => row.amounts));
    const documentCount = documentsBySection.get(id)?.size ?? 0;
    return {
      id,
      name: GSTR1_SECTION_NAMES[id],
      rows,
      totals,
      documentCount,
      sentence: sectionSentence(id, rows, totals, documentCount),
    };
  }).filter((section) => section.rows.length > 0 || !amountsAreZero(section.totals));

  const hsn = buildHsn(placed);
  findings.push(...hsn.findings);

  const totals = sumAmounts(sections.map((section) => section.totals));
  const tax = totalTaxOf(totals);

  return {
    return: {
      period: input.period,
      gstin: input.gstin,
      sections,
      hsn: hsn.rows,
      documents: buildDocumentSeries(placed, input.cancelledNumbers ?? []),
      totals,
      documentCount: placed.length,
      sentence: {
        'en-IN': `${formatTaxPeriod(input.period)}: ${placed.length === 1 ? '1 document' : `${placed.length} documents`} worth ${formatINR(totals.taxableValue)} before tax, carrying ${formatINR(tax)} of GST.`,
        'hi-IN': `${formatTaxPeriod(input.period)}: ${placed.length === 1 ? '1 document' : `${placed.length} document`}, tax se pehle ${formatINR(totals.taxableValue)}, aur ${formatINR(tax)} GST.`,
      },
    },
    unresolved,
    findings,
    reasons,
  };
};

/** Every document standing behind a section, de-duplicated, for the drill-down screen. */
export const sourcesOfSection = (section: Gstr1Section): readonly SourceRef[] => {
  const seen = new Map<string, SourceRef>();
  for (const row of section.rows) {
    for (const source of row.sources) seen.set(`${source.sourceKind}:${source.sourceId}`, source);
  }
  return [...seen.values()].sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
};

/** A one-line description of a summary row, since it has no bill number to show. */
export const describeRow = (row: Gstr1Row): string => {
  const rate = row.ratePercentTimes100 === null ? 'no rate' : `${Number(row.ratePercentTimes100) / 100}%`;
  if (row.documentNumber !== null) return `${row.documentNumber} at ${rate}`;
  return `${stateNameOf(row.placeOfSupplyStateCode)} at ${rate}`;
};

/** Exported for the reconciliation, which counts notes separately from bills. */
export const documentIsNote = (document: OutwardDocument): boolean => isNote(document.kind);

