// Issue #26 [E26] — computing and checking an Invoice Reference Number.
//
// The third acceptance criterion is that the government's response is stored **and verified**
// before anything is marked registered. Verification here is unusually strong, because the IRN is
// not an opaque token the portal invents: it is a SHA-256 hash over four fields we already know.
//
//   IRN = SHA-256( supplier GSTIN + financial year + document type + document number )
//
// So we can compute what the IRN must be and compare it with what came back. A provider that
// returns an IRN for a different document — a mixed-up response, a bug in an adapter, a stale
// cached reply — is caught here rather than being written into the books as this invoice's IRN.
//
// Assumption, recorded because it matters: the concatenation above follows the published NIC
// formula with no separators and the financial year written "YYYY-YY". If a production IRP is
// ever found to differ, `verifyIrnHash` in the policy turns the hash check off while leaving the
// structural checks — which never depend on the formula — in force.

import { createHash } from "node:crypto";
import type { EInvoiceDocumentType, IrpAcknowledgement } from "./einvoice-types.ts";

/** The government's short codes for the three reportable documents. */
export const DOCUMENT_TYPE_CODES: Readonly<Record<EInvoiceDocumentType, string>> = Object.freeze({
  INVOICE: "INV",
  CREDIT_NOTE: "CRN",
  DEBIT_NOTE: "DBN",
});

/**
 * The Indian financial year a date falls in, written the way the portal writes it.
 *
 * April to March, so 15 February 2026 is "2025-26" and not "2026-27". Getting this wrong produces
 * a valid-looking IRN for the wrong year, which is exactly the class of error the hash check
 * exists to catch.
 */
export const financialYearOf = (documentDate: string): string => {
  const [yearText, monthText] = documentDate.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`"${documentDate}" is not a date we can read a financial year from.`);
  }
  const startYear = month >= 4 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
};

export interface IrnParts {
  readonly supplierGstin: string;
  readonly documentNumber: string;
  readonly documentDate: string;
  readonly documentType: EInvoiceDocumentType;
}

/** The IRN this document must have, computed from the four fields the formula uses. */
export const computeIrn = (parts: IrnParts): string => {
  const financialYear = financialYearOf(parts.documentDate);
  const material = `${parts.supplierGstin.toUpperCase()}${financialYear}${DOCUMENT_TYPE_CODES[parts.documentType]}${parts.documentNumber}`;
  return createHash("sha256").update(material).digest("hex");
};

export type AcknowledgementProblem =
  | "IRN_MISSING" | "IRN_MALFORMED" | "IRN_MISMATCH"
  | "ACK_NUMBER_MISSING" | "ACK_DATE_MISSING" | "ACK_DATE_UNREADABLE"
  | "SIGNED_QR_MISSING";

export interface AcknowledgementCheck {
  readonly ok: boolean;
  readonly problems: readonly AcknowledgementProblem[];
  /** Written for a person, saying what is wrong with the government's reply. */
  readonly explanation: string;
}

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Checks a reply from the IRP before anything is marked registered.
 *
 * Structural checks always run and never depend on the hash formula. The hash comparison runs
 * only when the policy asks for it, so a formula difference at one provider degrades to "we
 * checked everything except the hash" rather than to a refusal to work at all.
 */
export const checkAcknowledgement = (
  acknowledgement: Partial<IrpAcknowledgement>,
  parts: IrnParts,
  options: { readonly verifyIrnHash: boolean },
): AcknowledgementCheck => {
  const problems: AcknowledgementProblem[] = [];
  const irn = (acknowledgement.irn ?? "").trim().toLowerCase();

  if (irn === "") problems.push("IRN_MISSING");
  else if (!HEX_64.test(irn)) problems.push("IRN_MALFORMED");
  else if (options.verifyIrnHash && irn !== computeIrn(parts)) problems.push("IRN_MISMATCH");

  if ((acknowledgement.ackNumber ?? "").trim() === "") problems.push("ACK_NUMBER_MISSING");

  const ackDate = (acknowledgement.ackDate ?? "").trim();
  if (ackDate === "") problems.push("ACK_DATE_MISSING");
  else if (Number.isNaN(readAckDate(ackDate).getTime())) problems.push("ACK_DATE_UNREADABLE");

  // Without the signed QR the buyer's copy is not a valid e-invoice, so a reply without one is
  // not a registration we are willing to record.
  if ((acknowledgement.signedQrCode ?? "").trim() === "") problems.push("SIGNED_QR_MISSING");

  return {
    ok: problems.length === 0,
    problems,
    explanation: problems.length === 0
      ? "The government's reply is complete and matches this bill."
      : explain(problems),
  };
};

const explain = (problems: readonly AcknowledgementProblem[]): string => {
  if (problems.includes("IRN_MISMATCH")) {
    return "The e-invoice number the government sent back does not belong to this bill. Nothing has been recorded against it, because recording it would attach another document's number to your invoice.";
  }
  if (problems.includes("IRN_MISSING") || problems.includes("IRN_MALFORMED")) {
    return "The government's reply did not contain a usable e-invoice number, so this bill has not been marked as registered.";
  }
  if (problems.includes("SIGNED_QR_MISSING")) {
    return "The government's reply did not contain the signed QR code the customer's copy must carry, so this bill has not been marked as registered.";
  }
  return "The government's reply was incomplete, so this bill has not been marked as registered. Please try again.";
};

/**
 * The portal writes acknowledgement dates as "DD/MM/YYYY HH:mm:ss", which `new Date()` reads as
 * an American date or not at all. Parsed explicitly rather than hopefully.
 */
export const readAckDate = (raw: string): Date => {
  const indian = /^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw.trim());
  if (indian !== null) {
    const [, day, month, year, hour, minute, second = "00"] = indian;
    return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  }
  return new Date(raw);
};

/** The moment the government stops accepting a cancellation for this acknowledgement. */
export const cancellableUntil = (ackDate: string, windowHours: number): string => {
  const acknowledged = readAckDate(ackDate);
  if (Number.isNaN(acknowledged.getTime())) throw new Error(`"${ackDate}" is not an acknowledgement date we can read.`);
  return new Date(acknowledged.getTime() + windowHours * 3_600_000).toISOString();
};

/** The last date this document can be reported without being late, when a limit applies. */
export const reportableUntil = (documentDate: string, windowDays: number | undefined): string | undefined => {
  if (windowDays === undefined) return undefined;
  const raised = new Date(`${documentDate}T00:00:00Z`);
  if (Number.isNaN(raised.getTime())) return undefined;
  raised.setUTCDate(raised.getUTCDate() + windowDays);
  return raised.toISOString().slice(0, 10);
};
