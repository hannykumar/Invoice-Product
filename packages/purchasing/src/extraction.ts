// Reading invoice facts off OCR output (issue #15).
//
// Deterministic patterns only. Every value carries the page, the exact text and the box
// it was read from, so the reviewer can see the evidence rather than trust a number.
// Where the document is ambiguous the confidence drops and the field is listed for
// review; nothing is filled in from a guess, and nothing here posts anything.

import { normaliseIdentifier, validateGstin } from "../../masters/src/validation.ts";
import type { IsoDate, Paise } from "../../masters/src/types.ts";
import { parsePaise } from "./money.ts";
import type { ExtractedField, ExtractedLine, FieldEvidence } from "./inbox-types.ts";
import type { OcrBlock, OcrPage } from "./ocr.ts";

export interface OcrReadResult {
  readonly problems: readonly string[];
  readonly supplierGstin?: ExtractedField<string>;
  readonly supplierName?: ExtractedField<string>;
  readonly buyerGstin?: ExtractedField<string>;
  readonly invoiceNumber?: ExtractedField<string>;
  readonly invoiceDate?: ExtractedField<IsoDate>;
  readonly taxableValuePaise?: ExtractedField<Paise>;
  readonly totalTaxPaise?: ExtractedField<Paise>;
  readonly invoiceTotalPaise?: ExtractedField<Paise>;
  readonly irn?: ExtractedField<string>;
  readonly lines: readonly ExtractedLine[];
  /** Every GST number found anywhere on the document, valid or not, in page order. */
  readonly allGstins: readonly string[];
  /** True when no page could be read at all. */
  readonly unreadable: boolean;
}

interface Located { readonly block: OcrBlock; readonly page: number }

const GSTIN_PATTERN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g;
const IRN_PATTERN = /\b[a-f0-9]{64}\b/i;

const evidenceOf = (located: Located, text: string): FieldEvidence => ({ page: located.page, text, box: located.block.box });

const field = <T>(value: T, located: Located, text: string, confidence: number, warning?: string): ExtractedField<T> => ({
  value,
  confidence: Number(Math.min(1, Math.max(0, confidence)).toFixed(3)),
  evidence: evidenceOf(located, text),
  ...(warning === undefined ? {} : { warning }),
});

function locate(pages: readonly OcrPage[]): readonly Located[] {
  return pages.filter((page) => page.readable).flatMap((page) => page.blocks.map((block) => ({ block, page: page.pageNumber })));
}

/** Indian invoices write dates day-first. A date that could be read either way says so. */
export function parseInvoiceDate(raw: string): { iso: IsoDate; ambiguous: boolean } | null {
  const trimmed = raw.trim();
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (isoMatch) return { iso: trimmed, ambiguous: false };
  const match = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(trimmed);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const yearPart = match[3] as string;
  const year = yearPart.length === 2 ? 2000 + Number(yearPart) : Number(yearPart);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) return null;
  return { iso, ambiguous: day <= 12 };
}

function findLabelled(located: readonly Located[], pattern: RegExp): { located: Located; captured: string; whole: string } | null {
  for (const item of located) {
    const match = pattern.exec(item.block.text);
    pattern.lastIndex = 0;
    if (match?.[1]) return { located: item, captured: match[1].trim(), whole: match[0] };
  }
  return null;
}

/**
 * Reads what the document appears to say. `companyGstins` tells the reader which of the
 * GST numbers on the page belongs to the buyer; without it, both are reported and the
 * caller must ask rather than assume.
 */
export function readInvoiceFromOcr(pages: readonly OcrPage[], options: { readonly companyGstins?: readonly string[] } = {}): OcrReadResult {
  const problems: string[] = [];
  const located = locate(pages);
  if (located.length === 0) {
    return { problems: ["None of the pages could be read. Please send a clearer photo or the PDF."], lines: [], allGstins: [], unreadable: true };
  }
  if (pages.some((page) => !page.readable)) problems.push(`Page ${pages.filter((page) => !page.readable).map((page) => page.pageNumber).join(", ")} could not be read, so anything printed there is missing.`);

  // --- GST numbers -----------------------------------------------------------
  const gstinHits: { located: Located; value: string; valid: boolean }[] = [];
  for (const item of located) {
    for (const match of item.block.text.toUpperCase().matchAll(GSTIN_PATTERN)) {
      const value = match[0];
      if (!gstinHits.some((hit) => hit.value === value)) gstinHits.push({ located: item, value, valid: validateGstin(value).ok });
    }
  }
  for (const hit of gstinHits.filter((candidate) => !candidate.valid)) {
    problems.push(`The GST number ${hit.value} printed on this document fails its own check digit, so it was probably scanned wrongly or is incorrect.`);
  }
  const own = new Set((options.companyGstins ?? []).map((gstin) => normaliseIdentifier(gstin)));
  const buyerHit = gstinHits.find((hit) => own.has(hit.value));
  const supplierHit = gstinHits.find((hit) => hit !== buyerHit);

  // --- Simple labelled fields ------------------------------------------------
  const invoiceNumberHit = findLabelled(located, /(?:invoice|bill|inv)\s*(?:no\.?|number|#)\s*[:\-]?\s*([A-Z0-9][A-Z0-9/\-]{1,})/i);
  const dateHit = findLabelled(located, /(?:invoice\s*date|bill\s*date|dated|date)\s*[:\-]?\s*(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{4}-\d{2}-\d{2})/i);
  const taxableHit = findLabelled(located, /taxable\s*(?:value|amount)?\s*[:\-]?\s*((?:₹|Rs\.?|INR)?\s*[\d,]+(?:\.\d{1,2})?)/i);
  const totalHit = findLabelled(located, /(?:grand\s*total|invoice\s*total|amount\s*payable|total\s*amount|total)\s*[:\-]?\s*((?:₹|Rs\.?|INR)?\s*[\d,]+(?:\.\d{1,2})?)/i);
  const supplierNameHit = located.find((item) => /^(?:m\/s\.?\s+)?[A-Z][A-Za-z&.,'\- ]{4,}$/.test(item.block.text.trim()) && !/invoice|tax|gstin|total|address/i.test(item.block.text));

  // --- Tax components --------------------------------------------------------
  let taxTotal = 0n;
  let taxEvidence: Located | null = null;
  const taxTexts: string[] = [];
  let taxConfidence = 1;
  for (const item of located) {
    if (!/\b(cgst|sgst|utgst|igst|cess)\b/i.test(item.block.text)) continue;
    // "IGST 18%: 5,760.00" holds a rate and an amount. Percentages are removed first so
    // the rate is never mistaken for the tax, and the amount is the last number left.
    const withoutRates = item.block.text.replace(/\d+(?:\.\d+)?\s*%/g, " ");
    const numbers = [...withoutRates.matchAll(/(?:₹|Rs\.?|INR)?\s*[\d,]+(?:\.\d{1,2})?/g)].map((match) => match[0]).filter((text) => /\d/.test(text));
    const last = numbers[numbers.length - 1];
    const amount = last ? parsePaise(last) : null;
    if (amount === null) continue;
    taxTotal += amount;
    taxEvidence ??= item;
    taxTexts.push(item.block.text.trim());
    taxConfidence = Math.min(taxConfidence, item.block.confidence);
  }

  const parsedDate = dateHit ? parseInvoiceDate(dateHit.captured) : null;
  if (dateHit && !parsedDate) problems.push(`The invoice date "${dateHit.captured}" could not be understood.`);

  const taxable = taxableHit ? parsePaise(taxableHit.captured) : null;
  const total = totalHit ? parsePaise(totalHit.captured) : null;
  const irnMatch = located.map((item) => ({ item, match: IRN_PATTERN.exec(item.block.text) })).find((candidate) => candidate.match);

  return {
    problems,
    unreadable: false,
    ...(supplierHit ? { supplierGstin: field(supplierHit.value, supplierHit.located, supplierHit.value, supplierHit.valid ? supplierHit.located.block.confidence : 0.3, supplierHit.valid ? undefined : "This GST number fails its check digit.") } : {}),
    ...(supplierNameHit ? { supplierName: field(supplierNameHit.block.text.trim(), supplierNameHit, supplierNameHit.block.text.trim(), supplierNameHit.block.confidence * 0.8) } : {}),
    ...(buyerHit ? { buyerGstin: field(buyerHit.value, buyerHit.located, buyerHit.value, buyerHit.located.block.confidence) } : {}),
    ...(invoiceNumberHit ? { invoiceNumber: field(invoiceNumberHit.captured, invoiceNumberHit.located, invoiceNumberHit.whole, invoiceNumberHit.located.block.confidence * 0.98) } : {}),
    ...(parsedDate && dateHit ? { invoiceDate: field(parsedDate.iso, dateHit.located, dateHit.whole, dateHit.located.block.confidence * (parsedDate.ambiguous ? 0.75 : 0.98), parsedDate.ambiguous ? "This date could be read as day/month or month/day. Please confirm it." : undefined) } : {}),
    ...(taxable !== null && taxableHit ? { taxableValuePaise: field(taxable, taxableHit.located, taxableHit.whole, taxableHit.located.block.confidence * 0.95) } : {}),
    ...(taxEvidence ? { totalTaxPaise: field(taxTotal, taxEvidence, taxTexts.join(" + "), taxConfidence * 0.9) } : {}),
    ...(total !== null && totalHit ? { invoiceTotalPaise: field(total, totalHit.located, totalHit.whole, totalHit.located.block.confidence * 0.95) } : {}),
    ...(irnMatch?.match ? { irn: field(irnMatch.match[0], irnMatch.item, irnMatch.match[0], irnMatch.item.block.confidence) } : {}),
    allGstins: gstinHits.map((hit) => hit.value),
    lines: [],
  };
}

/**
 * Arithmetic the document must satisfy. These are checks, not corrections: a mismatch
 * is reported for a human, never silently reconciled.
 */
export function crossCheck(read: { taxableValuePaise?: ExtractedField<Paise>; totalTaxPaise?: ExtractedField<Paise>; invoiceTotalPaise?: ExtractedField<Paise>; lines: readonly ExtractedLine[] }): readonly string[] {
  const problems: string[] = [];
  const taxable = read.taxableValuePaise?.value;
  const tax = read.totalTaxPaise?.value;
  const total = read.invoiceTotalPaise?.value;
  if (taxable !== undefined && tax !== undefined && total !== undefined && taxable + tax !== total) {
    problems.push(`Taxable value plus tax does not equal the invoice total (${taxable + tax} paise against ${total} paise). Check for a rounding line or a missed charge.`);
  }
  const lineSum = read.lines.reduce<bigint | null>((sum, line) => (sum === null || line.taxableValuePaise === undefined ? null : sum + line.taxableValuePaise.value), 0n);
  if (lineSum !== null && read.lines.length > 0 && taxable !== undefined && lineSum !== taxable) {
    problems.push(`The line items add up to ${lineSum} paise but the invoice shows a taxable value of ${taxable} paise.`);
  }
  return problems;
}
