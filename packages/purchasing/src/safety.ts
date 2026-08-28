// Attachment screening for the purchase inbox (issue #15).
//
// Anything a supplier can send, a stranger can send too. Screening runs before a
// document is read, and its only outcomes are "safe to read" or "quarantined with a
// stated reason". Nothing is repaired, unpacked or executed here.

import type { Attachment, QuarantineReason } from "./inbox-types.ts";

export type ScanVerdict = "clean" | "infected" | "unscanned";

export type ScreeningResult =
  | { readonly ok: true; readonly detectedType: SupportedType }
  | { readonly ok: false; readonly reason: QuarantineReason; readonly message: string };

export type SupportedType = "pdf" | "jpeg" | "png" | "heic" | "json";

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

/**
 * Screens one attachment. `head` is the first few kilobytes of the file, which is
 * enough to identify the real type and to spot the PDF features that make a document
 * unsafe or unreadable without ever loading the whole file into memory.
 */
export function screenAttachment(attachment: Attachment, head: Uint8Array, scanVerdict: ScanVerdict = "unscanned"): ScreeningResult {
  if (scanVerdict === "infected") return { ok: false, reason: "MALWARE_SUSPECTED", message: "This file was flagged as unsafe by the virus scanner, so it has not been opened." };
  if (attachment.sizeBytes > MAX_ATTACHMENT_BYTES) return { ok: false, reason: "FILE_TOO_LARGE", message: `This file is larger than ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB. Please send a smaller scan or split it.` };
  if (attachment.sizeBytes <= 0) return { ok: false, reason: "UNREADABLE", message: "This file is empty." };
  if (DANGEROUS_EXTENSION.test(attachment.fileName)) return { ok: false, reason: "UNSUPPORTED_FILE_TYPE", message: "Only PDF, photo and e-invoice JSON files can be read. This file is a program or web page." };

  const text = Buffer.from(head.subarray(0, 1024)).toString("latin1");
  const detected = MAGIC.find((candidate) => candidate.test(head, text))?.type;
  if (!detected) return { ok: false, reason: "UNSUPPORTED_FILE_TYPE", message: "This file is not a PDF, a photo or an e-invoice JSON file." };

  const declared = DECLARED_TO_TYPE[attachment.declaredMimeType.toLowerCase()];
  if (declared && declared !== detected) return { ok: false, reason: "FILE_TYPE_MISMATCH", message: `This file is named like a ${declared.toUpperCase()} but its contents are a ${detected.toUpperCase()} file, so it has been held for you to check.` };

  if (detected === "pdf") {
    const body = Buffer.from(head).toString("latin1");
    if (/\/Encrypt\b/.test(body)) return { ok: false, reason: "PASSWORD_PROTECTED", message: "This PDF is password protected. Please ask the supplier for an unlocked copy." };
    if (/\/JavaScript\b|\/JS\b|\/OpenAction\b|\/Launch\b|\/EmbeddedFile\b/.test(body)) return { ok: false, reason: "ACTIVE_CONTENT", message: "This PDF contains an embedded script or file, which invoices do not need, so it has been held." };
  }
  return { ok: true, detectedType: detected };
}

/** Convenience for callers that already hold the whole file. */
export const headOf = (bytes: Uint8Array, size = 8192): Uint8Array => bytes.subarray(0, size);
