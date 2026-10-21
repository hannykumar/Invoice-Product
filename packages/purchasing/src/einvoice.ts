// Reading a GST e-invoice JSON file (issue #15).
//
// The document is structured, so every value cites its JSON path and nothing is inferred:
// a field that is absent stays absent.
//
// Issue #400: structure is not proof. Anyone can type a JSON file naming any supplier and
// any buyer. Only the Invoice Registration Portal's signature (`SignedInvoice`, checked by
// `IrpSignatureVerifier` from packages/gst) shows the government registered this invoice
// unchanged (Rule 48(4)/(5) CGST Rules; see packages/gst/src/irp-signature.ts). So:
//   - signed and the signature checks out: values are read from the *signed payload* only,
//     at confidence 1; anything outside the signature is ignored;
//   - signed but the signature is wrong: `signature: "invalid"`, and the inbox holds it;
//   - unsigned, or the signature cannot be checked (no key configured): values are read at
//     `UNSIGNED_JSON_CONFIDENCE`, below the review threshold, so a person looks at every one.

import { validateGstin } from "../../masters/src/validation.ts";
import type { IsoDate, Paise } from "../../masters/src/types.ts";
import { computeIrn } from "../../gst/src/irn.ts";
import { NO_IRP_SIGNING_KEY, readUnverifiedPayload } from "../../gst/src/irp-signature.ts";
import type { IrpSignatureVerifier } from "../../gst/src/irp-signature.ts";
import type { EInvoiceDocumentType } from "../../gst/src/einvoice-types.ts";
import { rupeesToPaise } from "./money.ts";
import type { ExtractedField, ExtractedLine } from "./inbox-types.ts";

/**
 * Who vouches for this file.
 * - `verified`: the IRP's signature checked out and the values came from inside it.
 * - `unverified`: it carries a signature we could not check (no key configured).
 * - `unsigned`: it carries no signature at all.
 * - `invalid`: it carries a signature that does not match its contents. Treat as tampered.
 */
export type EInvoiceSignatureStatus = "verified" | "unverified" | "unsigned" | "invalid";

/**
 * Confidence for values read from a JSON file nobody has signed. Deliberately below
 * `REVIEW_CONFIDENCE` (0.8, inbox.ts): a typed file is no better evidence than a photo and
 * has no pixels to check it against, so every value is listed for review.
 */
export const UNSIGNED_JSON_CONFIDENCE = 0.75;

const UNSIGNED_WARNING = "This came from a file the government has not signed, so check it against the supplier's bill before approving.";

export interface EInvoiceReadResult {
  readonly ok: boolean;
  readonly signature: EInvoiceSignatureStatus;
  /** Why the signature was not verified, in words for the shopkeeper. */
  readonly signatureMessage?: string;
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
  /** Every GST number the file names, so routing can spot a document meant for someone else. */
  readonly allGstins: readonly string[];
}

type Field = <T>(value: T, jsonPath: string, text: string) => ExtractedField<T>;
const signedField: Field = (value, jsonPath, text) => ({ value, confidence: 1, evidence: { page: 0, text, jsonPath } });
const unsignedField: Field = (value, jsonPath, text) => ({ value, confidence: UNSIGNED_JSON_CONFIDENCE, evidence: { page: 0, text, jsonPath }, warning: UNSIGNED_WARNING });

const at = (source: unknown, path: string): unknown => path.split(".").reduce<unknown>((node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined), source);

const text = (source: unknown, path: string): string | undefined => {
  const value = at(source, path);
  return typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : undefined;
};

const moneyWith = (field: Field) => (source: unknown, path: string): ExtractedField<Paise> | undefined => {
  const value = at(source, path);
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const paise = rupeesToPaise(value);
  return paise === null ? undefined : field(paise, path, String(value));
};

const DOCUMENT_TYPES: Readonly<Record<string, EInvoiceDocumentType>> = { INV: "INVOICE", CRN: "CREDIT_NOTE", DBN: "DEBIT_NOTE" };

/** Where an IRP reply keeps the signed invoice: top level, or under Data / data / result. */
const signedInvoiceOf = (parsed: unknown): string | undefined => {
  for (const path of ["SignedInvoice", "Data.SignedInvoice", "data.SignedInvoice", "result.SignedInvoice"]) {
    const value = at(parsed, path);
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
};

/** e-invoice dates are DD/MM/YYYY. Anything else is reported rather than reinterpreted. */
export function parseEInvoiceDate(raw: string): IsoDate | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw.trim());
  if (!match) return null;
  const [, day = "", month = "", year = ""] = match;
  const iso = `${year}-${month}-${day}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

export function readEInvoiceJson(raw: string, options: { readonly signatures?: IrpSignatureVerifier } = {}): EInvoiceReadResult {
  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, signature: "unsigned", problems: ["This file is not readable JSON."], lines: [], allGstins: [] };
  }

  // Signature first. A verified file is read from inside the signature and nowhere else, so a
  // forger cannot keep a genuine signature and change the readable copy beside it.
  let signature: EInvoiceSignatureStatus = "unsigned";
  let signatureMessage: string | undefined;
  let document: Record<string, unknown>;
  const signedInvoice = signedInvoiceOf(parsed);
  const check = signedInvoice ? (options.signatures ?? NO_IRP_SIGNING_KEY).verify(signedInvoice) : null;
  if (check?.status === "invalid") {
    return { ok: false, signature: "invalid", signatureMessage: check.reason, problems: [check.reason], lines: [], allGstins: [] };
  }
  if (check?.status === "verified") {
    signature = "verified";
    document = check.data;
  } else {
    // A signature we could not check: show what it carries, at unsigned confidence.
    const inside = check && signedInvoice ? readUnverifiedPayload(signedInvoice) : null;
    if (check) { signature = "unverified"; signatureMessage = check.reason; }
    // Unsigned files are the invoice itself, or a portal-shaped wrapper around it.
    document = inside ?? (at(parsed, "DocDtls") ? parsed : at(parsed, "Data") ?? at(parsed, "data") ?? parsed) as Record<string, unknown>;
  }
  const signatureFacts = { signature, ...(signatureMessage ? { signatureMessage } : {}) };
  if (!at(document, "DocDtls.No")) return { ok: false, ...signatureFacts, problems: ["This JSON file does not look like a GST e-invoice: it has no document details."], lines: [], allGstins: [] };
  const field: Field = signature === "verified" ? signedField : unsignedField;
  const money = moneyWith(field);

  const supplierGstinRaw = text(document, "SellerDtls.Gstin");
  const buyerGstinRaw = text(document, "BuyerDtls.Gstin");
  for (const [label, value] of [["supplier", supplierGstinRaw], ["buyer", buyerGstinRaw]] as const) {
    if (value && !validateGstin(value).ok) problems.push(`The ${label} GST number in this file (${value}) is not a valid GST number.`);
  }
  const dateRaw = text(document, "DocDtls.Dt");
  const invoiceDate = dateRaw ? parseEInvoiceDate(dateRaw) : null;
  if (dateRaw && !invoiceDate) problems.push(`The invoice date in this file (${dateRaw}) is not in the DD/MM/YYYY form an e-invoice uses.`);

  const rawLines = at(document, "ItemList");
  const lines: ExtractedLine[] = (Array.isArray(rawLines) ? rawLines : []).map((line, index) => {
    const base = `ItemList[${index}]`;
    const description = text(line, "PrdDesc") ?? "";
    const gstRate = at(line, "GstRt");
    return {
      description: field(description, `${base}.PrdDesc`, description),
      ...(text(line, "HsnCd") ? { hsnSac: field(text(line, "HsnCd") as string, `${base}.HsnCd`, text(line, "HsnCd") as string) } : {}),
      ...(text(line, "Qty") ? { quantity: field(text(line, "Qty") as string, `${base}.Qty`, text(line, "Qty") as string) } : {}),
      ...(text(line, "Unit") ? { unit: field(text(line, "Unit") as string, `${base}.Unit`, text(line, "Unit") as string) } : {}),
      ...(money(line, "UnitPrice") ? { ratePaise: money(line, "UnitPrice") as ExtractedField<Paise> } : {}),
      ...(money(line, "AssAmt") ? { taxableValuePaise: money(line, "AssAmt") as ExtractedField<Paise> } : {}),
      ...(typeof gstRate === "number" ? { gstRateBasisPoints: field(Math.round(gstRate * 100), `${base}.GstRt`, String(gstRate)) } : {}),
    };
  });

  const cgst = money(document, "ValDtls.CgstVal");
  const sgst = money(document, "ValDtls.SgstVal");
  const igst = money(document, "ValDtls.IgstVal");
  const cess = money(document, "ValDtls.CesVal");
  const taxParts = [cgst, sgst, igst, cess].filter((part): part is ExtractedField<Paise> => part !== undefined);
  const totalTax = taxParts.length === 0 ? undefined : field(taxParts.reduce((sum, part) => sum + part.value, 0n), "ValDtls.CgstVal+SgstVal+IgstVal+CesVal", taxParts.map((part) => part.evidence.text).join(" + "));

  // Outside a verified signature an IRN is only text someone typed, and it is never taken from
  // the unsigned wrapper of a signed file.
  const irnRaw = text(document, "Irn") ?? (signature === "verified" ? undefined : text(parsed, "Irn"));
  // The IRN is a hash of supplier GSTIN, financial year, document type and number
  // (packages/gst/src/irn.ts). A mismatch means the IRN belongs to another document, or the
  // formula differs at the portal; either way a person must look, so it is reported.
  const docType = DOCUMENT_TYPES[(text(document, "DocDtls.Typ") ?? "INV").toUpperCase()];
  const documentNumber = text(document, "DocDtls.No") as string;
  if (irnRaw && supplierGstinRaw && invoiceDate && docType
    && irnRaw.toLowerCase() !== computeIrn({ supplierGstin: supplierGstinRaw, documentNumber, documentDate: invoiceDate, documentType: docType })) {
    problems.push("The e-invoice number (IRN) in this file does not belong to this supplier, invoice number and date.");
  }

  return {
    ok: problems.length === 0,
    ...signatureFacts,
    problems,
    ...(supplierGstinRaw ? { supplierGstin: field(supplierGstinRaw, "SellerDtls.Gstin", supplierGstinRaw) } : {}),
    ...(text(document, "SellerDtls.LglNm") ? { supplierName: field(text(document, "SellerDtls.LglNm") as string, "SellerDtls.LglNm", text(document, "SellerDtls.LglNm") as string) } : {}),
    ...(buyerGstinRaw ? { buyerGstin: field(buyerGstinRaw, "BuyerDtls.Gstin", buyerGstinRaw) } : {}),
    ...(documentNumber ? { invoiceNumber: field(documentNumber, "DocDtls.No", documentNumber) } : {}),
    ...(invoiceDate ? { invoiceDate: field(invoiceDate, "DocDtls.Dt", dateRaw as string) } : {}),
    ...(money(document, "ValDtls.AssVal") ? { taxableValuePaise: money(document, "ValDtls.AssVal") as ExtractedField<Paise> } : {}),
    ...(totalTax ? { totalTaxPaise: totalTax } : {}),
    ...(money(document, "ValDtls.TotInvVal") ? { invoiceTotalPaise: money(document, "ValDtls.TotInvVal") as ExtractedField<Paise> } : {}),
    ...(irnRaw ? { irn: field(irnRaw, "Irn", irnRaw) } : {}),
    allGstins: [supplierGstinRaw, buyerGstinRaw].filter((value): value is string => Boolean(value)),
    lines,
  };
}
