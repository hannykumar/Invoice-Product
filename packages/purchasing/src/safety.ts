// Attachment screening for the purchase inbox (issues #15 and #401).
//
// Anything a supplier can send, a stranger can send too. Screening runs before a
// document is read, and its outcomes are "safe to read", "quarantined with a stated
// reason", or "held until the virus scanner has answered". Nothing is repaired, unpacked
// for use or executed here.
//
// Issue #401 (threat model I3): nothing the sender declares is trusted. Size and SHA-256
// are measured from the bytes that arrived; a declared value that disagrees is held for a
// person. The whole file is screened, not a prefix. A missing scan verdict holds.

import { createHash } from "node:crypto";
import type { Attachment, QuarantineReason } from "./inbox-types.ts";
import { PDF_SCAN_LIMITS, scanPdf } from "./pdf-scan.ts";
import type { PdfScanLimits, PdfScanResult } from "./pdf-scan.ts";

export type ScanVerdict = "clean" | "infected" | "unscanned";

export type SupportedType = "pdf" | "jpeg" | "png" | "heic" | "json";

/** Why a document is waiting rather than quarantined: a later scan can release it. */
export type HoldReason = "VIRUS_SCAN_PENDING" | "VIRUS_SCANNER_UNAVAILABLE";

/** What the sender told us about the file. Size and hash are claims, checked against the bytes. */
export type DeclaredAttachment = Omit<Attachment, "sizeBytes" | "sha256"> & {
  readonly sizeBytes?: number;
  readonly sha256?: string;
};

/** Measured on the server from the bytes that arrived. */
export interface MeasuredFile {
  readonly sizeBytes: number;
  /** Absent only when the file was refused for size before hashing. */
  readonly sha256?: string;
}

export type InspectionResult =
  | { readonly ok: true; readonly detectedType: SupportedType; readonly measured: Required<MeasuredFile> }
  | { readonly ok: false; readonly outcome: "quarantine"; readonly reason: QuarantineReason; readonly message: string; readonly measured: MeasuredFile; readonly detail?: string };

export type ScreeningResult =
  | InspectionResult
  | { readonly ok: false; readonly outcome: "hold"; readonly reason: HoldReason; readonly message: string; readonly detectedType: SupportedType; readonly measured: Required<MeasuredFile> };

/** 25 MB is comfortably above a scanned multi-page invoice and below a video. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const MAGIC: readonly { readonly type: SupportedType; readonly test: (bytes: Uint8Array, text: string) => boolean }[] = [
  { type: "pdf", test: (_bytes, text) => text.startsWith("%PDF-") },
  { type: "jpeg", test: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  { type: "png", test: (bytes) => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 },
  { type: "heic", test: (_bytes, text) => text.slice(4, 12).startsWith("ftypheic") || text.slice(4, 12).startsWith("ftypheix") || text.slice(4, 12).startsWith("ftypmif1") },
  { type: "json", test: (_bytes, text) => /^\s*[[{]/.test(text) },
];

const DECLARED_TO_TYPE: Readonly<Record<string, SupportedType>> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heic",
  "application/json": "json",
  "text/json": "json",
};

/** Executable or script extensions hidden behind a document-looking name. */
const DANGEROUS_EXTENSION = /\.(exe|bat|cmd|com|scr|js|jse|vbs|vbe|ps1|sh|jar|apk|msi|dll|lnk|html?|svg)$/i;

const MB = 1024 * 1024;

export const measureFile = (bytes: Uint8Array): Required<MeasuredFile> => ({
  sizeBytes: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

const quarantine = (reason: QuarantineReason, message: string, measured: MeasuredFile, detail?: string): InspectionResult =>
  ({ ok: false, outcome: "quarantine", reason, message, measured, ...(detail === undefined ? {} : { detail }) });

/** Shopkeeper wording for each thing the PDF scanner can find. */
function pdfFinding(result: Exclude<PdfScanResult, { kind: "clean" }>, measured: MeasuredFile, limits: PdfScanLimits): InspectionResult {
  switch (result.kind) {
    case "encrypted":
      return quarantine("PASSWORD_PROTECTED", "This PDF is locked (encrypted). Even when it opens without a password, a locked file cannot be checked safely, so it has been held. Please ask the supplier for an unlocked copy.", measured, result.where);
    case "active_content":
      return quarantine("ACTIVE_CONTENT", "This PDF contains an embedded script, automatic action or attached file, which invoices do not need, so it has been held.", measured, `${result.feature} (${result.where})`);
    case "damaged":
      return quarantine("UNREADABLE", "This PDF is damaged in a way that stops it being checked safely. Please ask the supplier to send it again.", measured, result.detail);
    case "unsupported":
      return quarantine("UNREADABLE", "This PDF uses an old or unusual kind of packing that cannot be checked safely here. Please ask the supplier to save it again as a normal PDF.", measured, result.detail);
    case "too_complex": {
      const message = {
        pages: `This PDF has more than ${limits.maxPages} pages, which is far more than an invoice. Please send only the invoice pages.`,
        objects: "This PDF is built from far more pieces than an invoice needs, so it has been held for you to check.",
        decoded_bytes: "This PDF unpacks to far more data than an invoice should, which is how some harmful files are built. It has been held; please ask the supplier for a fresh copy.",
        image_pixels: "This PDF contains a picture far larger than a scanned page, so it has been held. Please ask for a normal scan.",
        time: "This PDF took too long to check, so it has been held rather than opened. Please ask the supplier for a simpler copy.",
      }[result.limit];
      return quarantine("PDF_TOO_COMPLEX", message, measured, `${result.limit}: ${result.detail}`);
    }
  }
}

/**
 * Everything except the virus verdict. Works on the whole file — never a prefix — and on
 * measured size and hash only.
 */
export function inspectAttachment(attachment: DeclaredAttachment, bytes: Uint8Array, limits: PdfScanLimits = PDF_SCAN_LIMITS): InspectionResult {
  const sizeBytes = bytes.byteLength;
  // Size first, on the measured length, before spending anything on hashing or parsing.
  if (sizeBytes > MAX_ATTACHMENT_BYTES) return quarantine("FILE_TOO_LARGE", `This file is larger than ${Math.floor(MAX_ATTACHMENT_BYTES / MB)} MB. Please send a smaller scan or split it.`, { sizeBytes });
  if (sizeBytes <= 0) return quarantine("UNREADABLE", "This file is empty.", { sizeBytes });
  const measured = measureFile(bytes);

  // A declared size or hash that does not match what arrived means the file was cut
  // short, swapped, or described dishonestly. Either way a person should look.
  if (attachment.sizeBytes !== undefined && attachment.sizeBytes !== sizeBytes) {
    return quarantine("FILE_DETAILS_MISMATCH", "The file that arrived is not the size the sender said it would be, so it may have been cut short or swapped on the way. It has been held for you to check.", measured, `declared ${attachment.sizeBytes} bytes, received ${sizeBytes}`);
  }
  if (attachment.sha256 !== undefined && attachment.sha256.toLowerCase() !== measured.sha256) {
    return quarantine("FILE_DETAILS_MISMATCH", "The file that arrived is not the one the sender described, so it may have been swapped on the way. It has been held for you to check.", measured, "declared SHA-256 does not match");
  }

  if (DANGEROUS_EXTENSION.test(attachment.fileName)) return quarantine("UNSUPPORTED_FILE_TYPE", "Only PDF, photo and e-invoice JSON files can be read. This file is a program or web page.", measured);

  const head = bytes.subarray(0, 1024);
  const text = Buffer.from(head.buffer, head.byteOffset, head.byteLength).toString("latin1");
  const detected = MAGIC.find((candidate) => candidate.test(head, text))?.type;
  if (!detected) return quarantine("UNSUPPORTED_FILE_TYPE", "This file is not a PDF, a photo or an e-invoice JSON file.", measured);

  const declared = DECLARED_TO_TYPE[attachment.declaredMimeType.toLowerCase()];
  if (declared && declared !== detected) return quarantine("FILE_TYPE_MISMATCH", `This file is named like a ${declared.toUpperCase()} but its contents are a ${detected.toUpperCase()} file, so it has been held for you to check.`, measured);

  if (detected === "pdf") {
    const result = scanPdf(bytes, limits);
    if (result.kind !== "clean") return pdfFinding(result, measured, limits);
  }
  return { ok: true, detectedType: detected, measured };
}

/**
 * Turns an inspection plus the scanner's answer into the screening outcome. Only an
 * explicit `clean` from the scanner lets a file through; `unscanned` or no answer holds.
 */
export function applyScanVerdict(inspection: InspectionResult, scanVerdict: ScanVerdict | undefined, scannerUnavailable = false): ScreeningResult {
  if (!inspection.ok) return inspection;
  if (scanVerdict === "infected") return quarantine("MALWARE_SUSPECTED", "This file was flagged as unsafe by the virus scanner, so it has not been opened.", inspection.measured);
  if (scanVerdict === "clean") return inspection;
  return scannerUnavailable
    ? { ok: false, outcome: "hold", reason: "VIRUS_SCANNER_UNAVAILABLE", message: "The virus check is not answering right now. This file is being kept aside and will be checked again automatically before anyone opens it.", detectedType: inspection.detectedType, measured: inspection.measured }
    : { ok: false, outcome: "hold", reason: "VIRUS_SCAN_PENDING", message: "This file is waiting for its virus check. It will be opened only after the check says it is safe.", detectedType: inspection.detectedType, measured: inspection.measured };
}

/**
 * Screens one attachment: the whole file, its measured size and hash, and a verdict from
 * the virus scanner. With no verdict the answer is a hold, never a pass.
 */
export function screenAttachment(attachment: DeclaredAttachment, bytes: Uint8Array, scanVerdict?: ScanVerdict, limits: PdfScanLimits = PDF_SCAN_LIMITS): ScreeningResult {
  if (scanVerdict === "infected") return quarantine("MALWARE_SUSPECTED", "This file was flagged as unsafe by the virus scanner, so it has not been opened.", { sizeBytes: bytes.byteLength });
  return applyScanVerdict(inspectAttachment(attachment, bytes, limits), scanVerdict);
}
