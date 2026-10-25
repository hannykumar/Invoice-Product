// Attachment screening for the purchase inbox (issue #15, hardened under #401).
//
// Anything a supplier can send, a stranger can send too. Screening runs before a
// document is read, and its only outcomes are "safe to read" or "held with a stated
// reason". Nothing is repaired, unpacked or executed here.
//
// Issue #401: nothing the caller declares is trusted.
//   - the file's size and hash are measured from the bytes themselves (inbox.ts
//     does this before calling here), never taken from `attachment.sizeBytes`;
//   - a file no virus scanner has answered for is held, not passed — the scanner's
//     "clean" verdict releases it through `scanAnswered`;
//   - a PDF is checked by a real parser over the whole file, not a pattern over the
//     first few kilobytes. `/Encrypt` lives in the trailer at the end, and keys can
//     sit inside compressed streams, so both the raw bytes and every decompressed
//     stream are scanned, and the parsed document is asked about actions, embedded
//     files and encryption directly;
//   - a PDF that is a video in disguise or a decompression bomb is bounded: caps on
//     pages, objects, decompressed bytes and parsing time protect both the OCR call
//     and the user who later opens the file.

import { inflateSync } from "node:zlib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Attachment, QuarantineReason } from "./inbox-types.ts";

export type ScanVerdict = "clean" | "infected" | "unscanned";

export type ScreeningResult =
  | { readonly ok: true; readonly detectedType: SupportedType; readonly pageCount?: number }
  | { readonly ok: false; readonly reason: QuarantineReason; readonly message: string };

export type SupportedType = "pdf" | "jpeg" | "png" | "heic" | "json";

/** 25 MB is comfortably above a scanned multi-page invoice and below a video. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** An invoice has a handful of pages; far more means the file is not really a bill. */
export const MAX_PDF_PAGES = 250;
/** Objects beyond what a normal scanned or generated invoice can need. */
export const MAX_PDF_OBJECTS = 20_000;
/** Total bytes all Flate streams in one file may unpack to. A real invoice's content streams are small; an extreme ratio is a decompression bomb (#401). */
export const MAX_PDF_INFLATED_BYTES = 64 * 1024 * 1024;
/** How long the whole PDF check may take before the file is held as unreadable. */
export const PDF_PARSE_LIMIT_MS = 10_000;

const MAGIC: readonly { readonly type: SupportedType; readonly test: (bytes: Uint8Array, text: string) => boolean }[] = [
  { type: "pdf", test: (_bytes, text) => text.startsWith("%PDF-") },
  { type: "jpeg", test: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  { type: "png", test: (bytes) => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 },
  { type: "heic", test: (_bytes, text) => text.slice(4, 12).startsWith("ftypheic") || text.slice(4, 12).startsWith("ftypheix") || text.slice(4, 12).startsWith("ftypmif1") },
  { type: "json", test: (_bytes, text) => /^\s*[[{]/.test(text) },
];

/** The declared types a file may claim, and what each is. Exported for #341's checks before an upload. */
export const DECLARED_TO_TYPE: Readonly<Record<string, SupportedType>> = {
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
export const DANGEROUS_EXTENSION = /\.(exe|bat|cmd|com|scr|js|jse|vbs|vbe|ps1|sh|jar|apk|msi|dll|lnk|html?|svg)$/i;

/** PDF dictionary keys that mean encryption or self-running content, wherever they sit in the file. */
const ENCRYPT_TOKEN = /\/Encrypt\b/;
const ACTIVE_CONTENT_TOKEN = /\/(JavaScript|JS|OpenAction|AA|Launch|EmbeddedFile)\b/;

const tooLarge = (detail: string): ScreeningResult => ({ ok: false, reason: "FILE_TOO_LARGE", message: detail });
const unreadable = (detail: string): ScreeningResult => ({ ok: false, reason: "UNREADABLE", message: detail });

/**
 * Screens one attachment against the bytes that will actually be read — never the
 * declared size or type (#401). `bytes` is the whole file as it was received; the
 * caller measures `sizeBytes`/`sha256` from it before screening, so a lying upload
 * cannot smuggle a bigger file past the cap.
 */
export async function screenAttachment(attachment: Attachment, bytes: Uint8Array, scanVerdict: ScanVerdict = "unscanned"): Promise<ScreeningResult> {
  if (scanVerdict === "infected") return { ok: false, reason: "MALWARE_SUSPECTED", message: "This file was flagged as unsafe by the virus scanner, so it has not been opened." };
  // A file nobody has scanned is a hold, not a pass: the scanner's answer releases it (#401).
  if (scanVerdict === "unscanned") return { ok: false, reason: "AWAITING_SCAN", message: "This file is waiting for a virus check. It will be looked at as soon as the check finishes." };
  if (bytes.length === 0) return unreadable("This file is empty.");
  if (bytes.length > MAX_ATTACHMENT_BYTES) return tooLarge(`This file is larger than ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB. Please send a smaller scan or split it.`);
  if (DANGEROUS_EXTENSION.test(attachment.fileName)) return { ok: false, reason: "UNSUPPORTED_FILE_TYPE", message: "Only PDF, photo and e-invoice JSON files can be read. This file is a program or web page." };

  const text = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  const detected = MAGIC.find((candidate) => candidate.test(bytes, text))?.type;
  if (!detected) return { ok: false, reason: "UNSUPPORTED_FILE_TYPE", message: "This file is not a PDF, a photo or an e-invoice JSON file." };

  const declared = DECLARED_TO_TYPE[attachment.declaredMimeType.toLowerCase()];
  if (declared && declared !== detected) return { ok: false, reason: "FILE_TYPE_MISMATCH", message: `This file is named like a ${declared.toUpperCase()} but its contents are a ${detected.toUpperCase()} file, so it has been held for you to check.` };

  if (detected === "pdf") return screenPdf(bytes);
  return { ok: true, detectedType: detected };
}

/**
 * A PDF is unsafe, unreadable or fine. Four checks, cheap to expensive: a token scan
 * of the whole raw file (the trailer sits at the end), an object-count cap, a bounded
 * decompression of every Flate stream that also scans the unpacked text, then a real
 * parse with a hard time limit that asks the document itself about pages, scripts and
 * embedded files (#401).
 */
async function screenPdf(bytes: Uint8Array): Promise<ScreeningResult> {
  const raw = Buffer.from(bytes).toString("latin1");
  if (ENCRYPT_TOKEN.test(raw)) return { ok: false, reason: "PASSWORD_PROTECTED", message: "This PDF is password protected. Please ask the supplier for an unlocked copy." };
  if (ACTIVE_CONTENT_TOKEN.test(raw)) return { ok: false, reason: "ACTIVE_CONTENT", message: "This PDF contains an embedded script or file, which invoices do not need, so it has been held." };
  if ((raw.match(/\d+\s+\d+\s+obj\b/g)?.length ?? 0) > MAX_PDF_OBJECTS) return tooLarge(`This PDF has more than ${MAX_PDF_OBJECTS.toLocaleString("en-IN")} objects, far more than a bill needs. It has been held.`);

  const deadline = Date.now() + PDF_PARSE_LIMIT_MS;
  const streams = scanPdfStreams(raw, bytes, deadline);
  if (!streams.ok) return streams.result;

  return parsePdf(bytes, deadline);
}

/**
 * Inflates every FlateDecode stream under one shared byte budget and scans the
 * unpacked text for the same tokens — a key hidden inside a compressed object stream
 * is as dangerous as one in the clear. The budget is the defence against a
 * decompression bomb: the first stream that would push the total past
 * MAX_PDF_INFLATED_BYTES holds the file. A stream that is not really zlib data is
 * left for the parser to judge.
 */
function scanPdfStreams(raw: string, bytes: Uint8Array, deadline: number): { readonly ok: true } | { readonly ok: false; readonly result: ScreeningResult } {
  let inflated = 0;
  let position = 0;
  while (position < raw.length) {
    const at = raw.indexOf("stream", position);
    if (at === -1) return { ok: true };
    // "endstream" contains "stream"; a stream keyword never follows a letter.
    if (at > 0 && /[a-zA-Z]/.test(raw[at - 1] as string)) { position = at + 6; continue; }
    let body = at + 6;
    if (raw[body] === "\r") body += 1;
    if (raw[body] === "\n") body += 1;
    const end = raw.indexOf("endstream", body);
    if (end === -1) return { ok: true }; // truncated file; the parser will say so
    position = end + 9;

    const objectStart = Math.max(raw.lastIndexOf("obj", at), raw.lastIndexOf("endobj", at));
    const dictionary = raw.slice(objectStart === -1 ? Math.max(0, at - 4096) : objectStart, at);
    if (!/\/FlateDecode\b|\/Fl\b/.test(dictionary)) continue;

    let unpacked: Uint8Array;
    try {
      unpacked = inflateSync(bytes.subarray(body, end), { maxOutputLength: MAX_PDF_INFLATED_BYTES - inflated });
    } catch (error) {
      if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
        return { ok: false, result: tooLarge(`This PDF unpacks to far more than its size, which a bill never needs. It has been held.`) };
      }
      continue; // not really flate data — the real parser decides whether the file is readable
    }
    inflated += unpacked.length;
    const text = Buffer.from(unpacked).toString("latin1");
    if (ACTIVE_CONTENT_TOKEN.test(text)) {
      return { ok: false, result: { ok: false, reason: "ACTIVE_CONTENT", message: "This PDF contains an embedded script or file, which invoices do not need, so it has been held." } };
    }
    if (Date.now() > deadline) {
      return { ok: false, result: unreadable("This PDF took too long to check, so it has been held rather than opened.") };
    }
  }
  return { ok: true };
}

/**
 * The real parse. pdfjs rebuilds the object tree — including objects living inside
 * compressed streams that the raw scan cannot see — and answers the questions that
 * matter for a bill: is it password protected, does it run anything, does it carry
 * files, and is it small enough to be a document a shopkeeper opens. A file that
 * cannot be parsed, or does not answer within the limit, is held as unreadable.
 */
async function parsePdf(bytes: Uint8Array, deadline: number): Promise<ScreeningResult> {
  const task = getDocument({
    data: bytes.slice(),
    stopAtErrors: true,
    useSystemFonts: false,
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void task.destroy(); }, Math.max(1, deadline - Date.now()));
  try {
    const document = await task.promise;
    try {
      if (document.numPages > MAX_PDF_PAGES) return tooLarge(`This PDF has more than ${MAX_PDF_PAGES} pages, far more than a bill needs. It has been held.`);
      if ((await document.getAttachments()) !== null) {
        return { ok: false, reason: "ACTIVE_CONTENT", message: "This PDF carries a file inside it, which an invoice does not need, so it has been held." };
      }
      if ((await document.getJSActions()) !== null) return scripted();
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        if ((await (await document.getPage(pageNumber)).getJSActions()) !== null) return scripted();
      }
      return { ok: true, detectedType: "pdf", pageCount: document.numPages };
    } finally {
      await task.destroy();
    }
  } catch (error) {
    if ((error as { name?: string }).name === "PasswordException") {
      return { ok: false, reason: "PASSWORD_PROTECTED", message: "This PDF is password protected. Please ask the supplier for an unlocked copy." };
    }
    if (timedOut) return unreadable("This PDF took too long to check, so it has been held rather than opened.");
    return unreadable("This file says it is a PDF but could not be read as one. Please send a clearer copy.");
  } finally {
    clearTimeout(timer);
  }
}

const scripted = (): ScreeningResult => ({ ok: false, reason: "ACTIVE_CONTENT", message: "This PDF is set up to run something when it opens, which an invoice never needs, so it has been held." });
