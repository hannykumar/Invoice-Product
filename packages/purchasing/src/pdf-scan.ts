// Bounded structural PDF scanner for the purchase inbox (issue #401, threat model I3).
//
// This is NOT a PDF parser and does not try to render or understand a document. It walks
// the whole file looking for the features an invoice never needs (scripts, automatic
// actions, embedded files, encryption) and enforces hard caps on how much work a file can
// make us do. It is written with Node built-ins only because adding a parsing library
// needs the owner's approval (AGENTS.md); choosing a real parser is an open decision
// recorded in the #401 pull request.
//
// How it stays safe without a full parser:
// - The file is split into the "object layer" (everything outside stream bodies, which
//   includes every dictionary, the trailer and incremental-update trailers) and stream
//   bodies. Every name in the object layer is checked, after decoding `#xx` hex escapes,
//   against the full list of dangerous names.
// - Compressed object streams (`/Type /ObjStm`, PDF 1.5+) hold dictionaries too, so they
//   are decompressed and checked against the full list as well. An object stream we cannot
//   decompress is quarantined: we never wave through what we could not read.
// - Every other stream body is checked raw, and again after decompression, against the
//   long dangerous names. Two-letter names (/JS, /AA) are skipped inside binary data only
//   because random bytes produce them by chance; neither can do anything on its own — a
//   script action always carries /S /JavaScript and a launch always carries /S /Launch,
//   and those long names are checked everywhere.
// - Every FlateDecode stream is inflated with `maxOutputLength`, against a per-stream and
//   a whole-file budget, so a compression bomb is caught before it can tie up OCR. Filters
//   that can expand without a cheap bound (LZW, RunLength) or that we do not implement are
//   quarantined rather than skipped.
// - Caps on objects, pages, image pixels and wall-clock time; exceeding any of them is a
//   quarantine, never a pass.

import { inflateSync, constants as zlibConstants } from "node:zlib";
import { performance } from "node:perf_hooks";

export interface PdfScanLimits {
  /** Indirect objects, including those packed inside object streams. */
  readonly maxObjects: number;
  /** Objects whose dictionary says `/Type /Page`. */
  readonly maxPages: number;
  /** Bytes one stream may decompress to. */
  readonly maxStreamDecodedBytes: number;
  /** Bytes all streams together may decompress to. */
  readonly maxTotalDecodedBytes: number;
  /** Width x height of one image, when both are written directly in its dictionary. */
  readonly maxImagePixels: number;
  /** Wall-clock budget for the whole scan, checked between steps. */
  readonly timeBudgetMs: number;
}

/**
 * Caps chosen for invoices, not for arbitrary PDFs. A long multi-page purchase invoice is
 * a few dozen pages and a few hundred objects; a 600 dpi A4 colour scan is about 35
 * megapixels and about 100 MB uncompressed. Anything past these is far outside what a
 * supplier needs to send us and is held for a person instead.
 */
export const PDF_SCAN_LIMITS: PdfScanLimits = Object.freeze({
  maxObjects: 20_000,
  maxPages: 200,
  maxStreamDecodedBytes: 64 * 1024 * 1024,
  maxTotalDecodedBytes: 256 * 1024 * 1024,
  maxImagePixels: 100_000_000,
  timeBudgetMs: 5_000,
});

export type PdfLimitName = "objects" | "pages" | "decoded_bytes" | "image_pixels" | "time";

export type PdfScanResult =
  | { readonly kind: "clean"; readonly pages: number; readonly objects: number; readonly decodedBytes: number }
  | { readonly kind: "encrypted"; readonly where: string }
  | { readonly kind: "active_content"; readonly feature: string; readonly where: string }
  | { readonly kind: "too_complex"; readonly limit: PdfLimitName; readonly detail: string }
  | { readonly kind: "damaged"; readonly detail: string }
  | { readonly kind: "unsupported"; readonly detail: string };

/** Names that make a PDF do something by itself, or carry something other than the invoice. */
const DANGEROUS_NAMES: ReadonlySet<string> = new Set([
  "JavaScript", "JS", "OpenAction", "AA", "Launch",
  "EmbeddedFile", "EmbeddedFiles", "RichMedia", "RichMediaExecute", "XFA",
  "SubmitForm", "ImportData", "GoToE", "GoToR",
]);
/** The subset checked inside binary stream data, where very short names occur by chance. */
const LONG_DANGEROUS_NAMES: ReadonlySet<string> = new Set([...DANGEROUS_NAMES].filter((name) => name.length >= 3));

const FILTER_ALIASES: Readonly<Record<string, string>> = {
  Fl: "FlateDecode", AHx: "ASCIIHexDecode", A85: "ASCII85Decode", LZW: "LZWDecode",
  RL: "RunLengthDecode", DCT: "DCTDecode", CCF: "CCITTFaxDecode",
};
/** Image codecs we leave encoded: they are handed to OCR as pictures, not unpacked here. */
const IMAGE_FILTERS: ReadonlySet<string> = new Set(["DCTDecode", "JPXDecode", "CCITTFaxDecode", "JBIG2Decode"]);

// PDF whitespace is NUL, TAB, LF, FF, CR and space; delimiters are ( ) < > [ ] { } / %.
const NAME_TOKEN = /\/([^\x00\t\n\f\r \/()<>[\]{}%]{1,256})/g;
const OBJECT_HEADER = /(?<![0-9])[0-9]{1,10}[\x00\t\n\f\r ]+[0-9]{1,5}[\x00\t\n\f\r ]+obj(?![A-Za-z])/g;
const STREAM_KEYWORD = /(?<![A-Za-z0-9])stream(?![A-Za-z0-9])/g;

/** Decodes `#xx` escapes in a PDF name, so `/J#61vaScript` reads as `/JavaScript`. */
export function decodePdfName(raw: string): string {
  if (!raw.includes("#")) return raw;
  return raw.replace(/#([0-9A-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function firstDangerousName(text: string, start: number, end: number, names: ReadonlySet<string>): string | null {
  const region = start === 0 && end === text.length ? text : text.slice(start, end);
  NAME_TOKEN.lastIndex = 0;
  for (let match = NAME_TOKEN.exec(region); match; match = NAME_TOKEN.exec(region)) {
    const name = decodePdfName(match[1] as string);
    if (name === "Encrypt") return "Encrypt";
    if (names.has(name)) return name;
  }
  return null;
}

/** Rewrites every name with its escapes decoded, for the small dictionary lookups below. */
function normaliseNames(text: string): string {
  return text.replace(NAME_TOKEN, (_match, raw: string) => `/${decodePdfName(raw)}`);
}

function countPages(normalised: string): number {
  return normalised.match(/\/Type[\x00\t\n\f\r ]*\/Page(?![^\x00\t\n\f\r \/()<>[\]{}%])/g)?.length ?? 0;
}

function countObjectHeaders(text: string): number {
  return text.match(OBJECT_HEADER)?.length ?? 0;
}

interface StreamInfo {
  readonly dict: string;
  /** Range scanned as stream data rather than as dictionaries. */
  readonly bodyStart: number;
  readonly bodyEnd: number;
  /** Range decompressed; may run past `bodyEnd` when /Length says so. */
  readonly decodeEnd: number;
  /** Where scanning of the object layer resumes. */
  readonly resumeAt: number;
}

interface StreamDict {
  readonly filters: readonly string[];
  readonly filterKeyCount: number;
  readonly isObjectStream: boolean;
  readonly isImage: boolean;
  readonly width: number | null;
  readonly height: number | null;
  readonly predictor: number | null;
  readonly objectCount: number | null;
  readonly length: { readonly value: number } | { readonly ref: string } | null;
}

function readStreamDict(rawDict: string): StreamDict {
  const dict = normaliseNames(rawDict);
  const filterKeyCount = dict.match(/\/Filter(?![^\x00\t\n\f\r \/()<>[\]{}%])/g)?.length ?? 0;
  const filterMatch = /\/Filter[\x00\t\n\f\r ]*(\[[^\]]*\]|\/[^\x00\t\n\f\r \/()<>[\]{}%]+)/.exec(dict);
  const filters = filterMatch
    ? [...(filterMatch[1] as string).matchAll(/\/([^\x00\t\n\f\r \/()<>[\]{}%]+)/g)].map((m) => FILTER_ALIASES[m[1] as string] ?? (m[1] as string))
    : [];
  const int = (key: string): number | null => {
    const found = new RegExp(`/${key}[\\x00\\t\\n\\f\\r ]+([0-9]{1,15})(?![0-9]*[\\x00\\t\\n\\f\\r ]+[0-9]+[\\x00\\t\\n\\f\\r ]+R)`).exec(dict);
    return found ? Number(found[1]) : null;
  };
  const lengthRef = /\/Length[\x00\t\n\f\r ]+([0-9]{1,10})[\x00\t\n\f\r ]+([0-9]{1,5})[\x00\t\n\f\r ]+R(?![A-Za-z])/.exec(dict);
  const lengthValue = int("Length");
  const isObjectStream = /\/Type[\x00\t\n\f\r ]*\/ObjStm(?![A-Za-z])/.test(dict) || (/\/N[\x00\t\n\f\r ]/.test(dict) && /\/First[\x00\t\n\f\r ]/.test(dict));
  return {
    filters,
    filterKeyCount,
    isObjectStream,
    isImage: /\/Subtype[\x00\t\n\f\r ]*\/Image(?![A-Za-z])/.test(dict),
    width: int("Width"),
    height: int("Height"),
    predictor: int("Predictor"),
    objectCount: int("N"),
    length: lengthRef ? { ref: `${lengthRef[1]} ${lengthRef[2]}` } : lengthValue === null ? null : { value: lengthValue },
  };
}

type Decoded = { readonly ok: true; readonly data: Buffer; readonly fullyDecoded: boolean } | { readonly ok: false; readonly why: "too_big" | "unsupported" | "error"; readonly detail: string };

function asciiHexDecode(input: Buffer): Buffer {
  const text = input.toString("latin1");
  const end = text.indexOf(">");
  const digits = (end === -1 ? text : text.slice(0, end)).replace(/[^0-9A-Fa-f]/g, "");
  return Buffer.from(digits.length % 2 === 1 ? `${digits}0` : digits, "hex");
}

function ascii85Decode(input: Buffer, limit: number): Buffer | null {
  const text = input.toString("latin1");
  const end = text.indexOf("~>");
  const body = (end === -1 ? text : text.slice(0, end)).replace(/^<~/, "");
  // Each character yields at most four bytes ("z"), so this bounds memory up front.
  const out = Buffer.alloc(Math.min(limit + 4, body.length * 4));
  let written = 0;
  const group: number[] = [];
  const flush = (count: number): void => {
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    const word = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    for (let index = 0; index < count; index += 1) out[written++] = word[index] as number;
  };
  for (let index = 0; index < body.length; index += 1) {
    if (written > limit) return null;
    const code = body.charCodeAt(index);
    if (code === 0x7a && group.length === 0) { out.fill(0, written, written + 4); written += 4; continue; }
    if (code < 33 || code > 117) continue;
    group.push(code - 33);
    if (group.length === 5) { flush(4); group.length = 0; }
  }
  if (group.length > 1) {
    const kept = group.length - 1;
    while (group.length < 5) group.push(84);
    flush(kept);
  }
  if (written > limit) return null;
  return out.subarray(0, written);
}

function decodeChain(raw: Buffer, filters: readonly string[], limit: number): Decoded {
  let data = raw;
  for (let index = 0; index < filters.length; index += 1) {
    const filter = filters[index] as string;
    if (IMAGE_FILTERS.has(filter)) {
      if (index !== filters.length - 1) return { ok: false, why: "unsupported", detail: `${filter} followed by another filter` };
      return { ok: true, data, fullyDecoded: false };
    }
    if (filter === "FlateDecode") {
      if (limit <= 0) return { ok: false, why: "too_big", detail: "no decompression budget left" };
      try {
        // maxOutputLength stops zlib as soon as the output would pass the budget, so a
        // bomb costs at most `limit` bytes of memory and the time to produce them.
        data = inflateSync(data, { maxOutputLength: limit, finishFlush: zlibConstants.Z_SYNC_FLUSH });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "ERR_BUFFER_TOO_LARGE" || error instanceof RangeError) return { ok: false, why: "too_big", detail: "FlateDecode output passed the budget" };
        return { ok: false, why: "error", detail: "FlateDecode data is corrupt" };
      }
      if (data.length >= limit) return { ok: false, why: "too_big", detail: "FlateDecode output reached the budget" };
      continue;
    }
    if (filter === "ASCIIHexDecode") { data = asciiHexDecode(data); continue; }
    if (filter === "ASCII85Decode") {
      const decoded = ascii85Decode(data, limit);
      if (!decoded) return { ok: false, why: "too_big", detail: "ASCII85Decode output passed the budget" };
      data = decoded;
      continue;
    }
    // LZW and RunLength can expand by large factors and have no built-in bound here;
    // Crypt means encryption; anything else is unknown. None is waved through.
    return { ok: false, why: "unsupported", detail: filter };
  }
  if (data.length > limit) return { ok: false, why: "too_big", detail: "decoded data passed the budget" };
  return { ok: true, data, fullyDecoded: true };
}

function locateStreams(text: string, limits: PdfScanLimits, deadline: number): StreamInfo[] | PdfScanResult {
  const simpleIntegers = new Map<string, number>();
  for (const match of text.matchAll(/(?<![0-9])([0-9]{1,10})[\x00\t\n\f\r ]+([0-9]{1,5})[\x00\t\n\f\r ]+obj[\x00\t\n\f\r ]*([0-9]{1,15})[\x00\t\n\f\r ]*endobj/g)) {
    simpleIntegers.set(`${match[1]} ${match[2]}`, Number(match[3]));
  }
  const streams: StreamInfo[] = [];
  let cursor = 0;
  while (true) {
    STREAM_KEYWORD.lastIndex = cursor;
    const keyword = STREAM_KEYWORD.exec(text);
    if (!keyword) break;
    if (streams.length >= limits.maxObjects) return { kind: "too_complex", limit: "objects", detail: `more than ${limits.maxObjects} streams` };
    if (performance.now() > deadline) return { kind: "too_complex", limit: "time", detail: "locating streams" };
    // The stream's dictionary is whatever follows the nearest object header before it.
    const windowStart = Math.max(cursor, keyword.index - 65_536);
    const window = text.slice(windowStart, keyword.index);
    let dictStart = 0;
    OBJECT_HEADER.lastIndex = 0;
    for (let header = OBJECT_HEADER.exec(window); header; header = OBJECT_HEADER.exec(window)) dictStart = header.index + header[0].length;
    const dict = window.slice(dictStart);
    // Data starts after the keyword and one end-of-line (CRLF, LF or a lone CR).
    let bodyStart = keyword.index + "stream".length;
    while (text.charCodeAt(bodyStart) === 0x20 || text.charCodeAt(bodyStart) === 0x09) bodyStart += 1;
    if (text.startsWith("\r\n", bodyStart)) bodyStart += 2;
    else if (text[bodyStart] === "\n" || text[bodyStart] === "\r") bodyStart += 1;
    const endKeyword = text.indexOf("endstream", bodyStart);
    if (endKeyword === -1) return { kind: "damaged", detail: "a stream has no end" };
    const info = readStreamDict(dict);
    let declaredLength: number | null = null;
    if (info.length && "value" in info.length) declaredLength = info.length.value;
    else if (info.length && "ref" in info.length) declaredLength = simpleIntegers.get(info.length.ref) ?? null;
    // A reader that trusts /Length and one that searches for "endstream" can disagree.
    // We take the stricter view of both: dictionaries are looked for anywhere either
    // reader might see them, and decompression covers the longer of the two.
    const lengthEnd = declaredLength === null ? endKeyword : Math.min(text.length, bodyStart + declaredLength);
    const bodyEnd = Math.min(lengthEnd, endKeyword);
    const decodeEnd = Math.max(lengthEnd, endKeyword);
    streams.push({ dict, bodyStart, bodyEnd, decodeEnd, resumeAt: endKeyword + "endstream".length });
    cursor = endKeyword + "endstream".length;
  }
  return streams;
}

/**
 * Scans a whole PDF. `bytes` must be the complete file as received; screening refuses to
 * work from a prefix (issue #401).
 */
export function scanPdf(bytes: Uint8Array, limits: PdfScanLimits = PDF_SCAN_LIMITS): PdfScanResult {
  const started = performance.now();
  const deadline = started + limits.timeBudgetMs;
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = buffer.toString("latin1");

  const located = locateStreams(text, limits, deadline);
  if (!Array.isArray(located)) return located;
  const streams = located;

  // 1. The object layer: everything outside stream data, trailer included.
  const objectLayer: string[] = [];
  let cursor = 0;
  for (const stream of streams) {
    objectLayer.push(text.slice(cursor, stream.bodyStart));
    // Anything between where /Length ends and "endstream" is visible to a /Length reader.
    objectLayer.push(text.slice(stream.bodyEnd, stream.resumeAt));
    cursor = stream.resumeAt;
  }
  objectLayer.push(text.slice(cursor));
  const layer = objectLayer.join("\n");
  const layerHit = firstDangerousName(layer, 0, layer.length, DANGEROUS_NAMES);
  if (layerHit === "Encrypt") return { kind: "encrypted", where: "document dictionary or trailer" };
  if (layerHit) return { kind: "active_content", feature: layerHit, where: "document structure" };
  const normalisedLayer = normaliseNames(layer);
  let objects = countObjectHeaders(layer);
  let pages = countPages(normalisedLayer);
  if (objects > limits.maxObjects) return { kind: "too_complex", limit: "objects", detail: `${objects} objects` };
  if (pages > limits.maxPages) return { kind: "too_complex", limit: "pages", detail: `${pages} pages` };
  if (performance.now() > deadline) return { kind: "too_complex", limit: "time", detail: "scanning the document structure" };

  // 2. Stream data.
  let decodedBytes = 0;
  for (const stream of streams) {
    if (performance.now() > deadline) return { kind: "too_complex", limit: "time", detail: "unpacking streams" };
    const info = readStreamDict(stream.dict);
    if (info.filterKeyCount > 1) return { kind: "unsupported", detail: "a stream names its compression more than once" };
    if (info.isImage && info.width !== null && info.height !== null && info.width * info.height > limits.maxImagePixels) {
      return { kind: "too_complex", limit: "image_pixels", detail: `${info.width} x ${info.height} image` };
    }
    const rawHit = firstDangerousName(text, stream.bodyStart, stream.bodyEnd, LONG_DANGEROUS_NAMES);
    if (rawHit === "Encrypt") return { kind: "encrypted", where: "inside a stream" };
    if (rawHit) return { kind: "active_content", feature: rawHit, where: "inside a stream" };
    if (info.filters.length === 0 && !info.isObjectStream) continue;

    const budget = Math.min(limits.maxStreamDecodedBytes, limits.maxTotalDecodedBytes - decodedBytes);
    const decoded = decodeChain(buffer.subarray(stream.bodyStart, stream.decodeEnd), info.filters, budget);
    if (!decoded.ok) {
      if (decoded.why === "too_big") return { kind: "too_complex", limit: "decoded_bytes", detail: decoded.detail };
      if (decoded.why === "unsupported") return { kind: "unsupported", detail: `compression ${decoded.detail}` };
      // A corrupt image or page stream is a damaged picture, not a hidden feature: readers
      // stop at the same point we do. A corrupt object stream could hide dictionaries.
      if (info.isObjectStream) return { kind: "damaged", detail: "an object stream could not be unpacked" };
      continue;
    }
    decodedBytes += decoded.data.length;
    if (decodedBytes >= limits.maxTotalDecodedBytes) return { kind: "too_complex", limit: "decoded_bytes", detail: "total decompressed size" };
    if (!decoded.fullyDecoded) {
      if (info.isObjectStream) return { kind: "unsupported", detail: "an object stream compressed as an image" };
      continue;
    }
    const decodedText = decoded.data.toString("latin1");
    if (info.isObjectStream) {
      if (info.predictor !== null && info.predictor > 1) return { kind: "unsupported", detail: "an object stream with a predictor" };
      const hit = firstDangerousName(decodedText, 0, decodedText.length, DANGEROUS_NAMES);
      if (hit === "Encrypt") return { kind: "encrypted", where: "inside an object stream" };
      if (hit) return { kind: "active_content", feature: hit, where: "inside an object stream" };
      objects += Math.max(info.objectCount ?? 0, countObjectHeaders(decodedText));
      pages += countPages(normaliseNames(decodedText));
      if (objects > limits.maxObjects) return { kind: "too_complex", limit: "objects", detail: `${objects} objects` };
      if (pages > limits.maxPages) return { kind: "too_complex", limit: "pages", detail: `${pages} pages` };
    } else {
      const hit = firstDangerousName(decodedText, 0, decodedText.length, LONG_DANGEROUS_NAMES);
      if (hit === "Encrypt") return { kind: "encrypted", where: "inside a compressed stream" };
      if (hit) return { kind: "active_content", feature: hit, where: "inside a compressed stream" };
    }
  }
  objects = Math.max(objects, streams.length);
  if (objects > limits.maxObjects) return { kind: "too_complex", limit: "objects", detail: `${objects} objects` };
  return { kind: "clean", pages, objects, decodedBytes };
}
