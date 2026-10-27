// Finding and unpacking the streams inside a PDF, for attachment screening (#401).
//
// A PDF can keep whole dictionaries — an /OpenAction, a /Launch — inside an object
// stream, where a scan of the raw file cannot see them. Screening therefore has to find
// every stream and its real dictionary, and unpack it the way a PDF reader would. Two
// things make that harder than a search for the word "stream":
//   - the dictionary must be read as PDF syntax: a text value such as `(obj)` or a
//     nested dictionary must not be mistaken for where the dictionary starts or ends;
//   - a name can be written with #xx escapes, so `/Fl#61teDecode` is `/FlateDecode`
//     and `/L#61unch` is `/Launch` to every PDF reader.
// When this lexer and a plain search disagree about where the streams are, the file is
// reported as one that cannot be followed, so a crafted file fails closed rather than
// hiding a stream from the check.

/** Decodes #xx escapes inside PDF names; text outside names is left as it is. */
export const decodePdfNames = (text: string): string =>
  text.includes("#")
    ? text.replace(/\/[^\s/[\]<>(){}%]+/g, (name) => (name.includes("#") ? name.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))) : name))
    : text;

export interface PdfStream {
  /** The stream's dictionary, `<< … >>`, exactly as written. */
  readonly dictionary: string;
  readonly keywordAt: number;
  readonly dataStart: number;
  readonly dataEnd: number;
}

export type PdfStreamListing =
  | { readonly ok: true; readonly streams: readonly PdfStream[] }
  | { readonly ok: false; readonly detail: string };

const DELIMITER = /[\s()<>[\]{}/%]/;
// The keyword whatever follows it on its line, so the cross-check is never stricter than pdfjs.
const STREAM_KEYWORD = /(?<![A-Za-z])stream(?![A-Za-z])/g;

/** Index just past a `( … )` text value starting at `at`, honouring nesting and escapes; -1 if it never closes. */
function skipString(raw: string, at: number): number {
  let depth = 0;
  for (let i = at; i < raw.length; i += 1) {
    const c = raw[i];
    if (c === "\\") { i += 1; continue; }
    if (c === "(") depth += 1;
    else if (c === ")") { depth -= 1; if (depth === 0) return i + 1; }
  }
  return -1;
}

/** Where a stream's data ends and lexing resumes. Trusts /Length only when `endstream` really follows it. */
function streamEnd(raw: string, dictionary: string, dataStart: number, numbers: () => ReadonlyMap<string, number>): { readonly dataEnd: number; readonly next: number } | undefined {
  const named = decodePdfNames(dictionary);
  let length: number | undefined;
  const indirect = /\/Length\s+(\d+)\s+(\d+)\s+R/.exec(named);
  if (indirect) {
    length = numbers().get(`${indirect[1]} ${indirect[2]}`);
  } else {
    const direct = /\/Length\s+(\d+)/.exec(named);
    if (direct) length = Number(direct[1]);
  }
  if (length !== undefined && dataStart + length <= raw.length) {
    const tail = /^\s*endstream/.exec(raw.slice(dataStart + length, dataStart + length + 64));
    if (tail) return { dataEnd: dataStart + length, next: dataStart + length + tail[0].length };
  }
  const at = raw.indexOf("endstream", dataStart);
  if (at === -1) return undefined;
  return { dataEnd: at, next: at + "endstream".length };
}

/**
 * Every stream in the file with its dictionary, read as PDF syntax. Fails when a text
 * value or stream never closes, or when a plain search finds a `stream` keyword that
 * the lexer did not reach — the sign of a file built to make the two disagree.
 */
export function listPdfStreams(raw: string): PdfStreamListing {
  const streams: PdfStream[] = [];
  // Objects that are a bare number (`7 0 obj 1234 endobj`), for indirect /Length — indexed once, on first need.
  let numberObjects: Map<string, number> | undefined;
  const numbers = (): ReadonlyMap<string, number> => {
    if (!numberObjects) {
      numberObjects = new Map();
      for (const match of raw.matchAll(/(?<!\d)(\d+)\s+(\d+)\s+obj\s*(\d+)\s*endobj/g)) numberObjects.set(`${match[1]} ${match[2]}`, Number(match[3]));
    }
    return numberObjects;
  };
  let depth = 0;
  let dictStart = -1;
  let lastDict: { readonly text: string; readonly end: number } | undefined;
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === "%") {
      while (i < raw.length && raw[i] !== "\n" && raw[i] !== "\r") i += 1;
      continue;
    }
    if (c === "(") {
      const next = skipString(raw, i);
      if (next === -1) return { ok: false, detail: "a text value is never closed" };
      i = next;
      continue;
    }
    if (c === "<") {
      if (raw[i + 1] === "<") {
        if (depth === 0) dictStart = i;
        depth += 1;
        i += 2;
        continue;
      }
      const close = raw.indexOf(">", i + 1);
      if (close === -1) return { ok: false, detail: "a hex value is never closed" };
      i = close + 1;
      continue;
    }
    if (c === ">" && raw[i + 1] === ">") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0) lastDict = { text: raw.slice(dictStart, i + 2), end: i + 2 };
      }
      i += 2;
      continue;
    }
    if (c === "s" && raw.startsWith("stream", i) && (i === 0 || DELIMITER.test(raw[i - 1] as string))) {
      // Like pdfjs (Parser.makeStream → skipToNextLine), the data starts after the end of
      // the keyword's line, whatever else sits on that line: `stream \n` is a stream too.
      let dataStart = i + 6;
      while (dataStart < raw.length && raw[dataStart] !== "\r" && raw[dataStart] !== "\n") dataStart += 1;
      if (raw[dataStart] === "\r") dataStart += 1;
      if (raw[dataStart] === "\n") dataStart += 1;
      if (depth === 0 && lastDict && /^\s*$/.test(raw.slice(lastDict.end, i))) {
        const end = streamEnd(raw, lastDict.text, dataStart, numbers);
        if (!end) return { ok: false, detail: "a stream is never closed" };
        streams.push({ dictionary: lastDict.text, keywordAt: i, dataStart, dataEnd: end.dataEnd });
        lastDict = undefined;
        i = end.next;
        continue;
      }
      i += 6;
      continue;
    }
    i += 1;
  }

  // Cross-check: every `stream` keyword a plain search finds must be one the lexer
  // read, or sit inside a stream's data. Anything else was hidden from the lexer.
  let s = 0;
  for (const match of raw.matchAll(STREAM_KEYWORD)) {
    const at = match.index;
    while (s < streams.length && (streams[s] as PdfStream).dataEnd <= at) s += 1;
    const current = streams[s];
    if (current && (current.keywordAt === at || (current.dataStart <= at && at < current.dataEnd))) continue;
    return { ok: false, detail: `a stream at byte ${at} could not be followed` };
  }
  return { ok: true, streams };
}

export interface StreamFilters {
  /** The filters in the order a reader applies them. */
  readonly names: readonly string[];
  /** The filter list could not be read directly: an indirect reference, a repeated key, or something that is not a name. */
  readonly unresolved: boolean;
  /** /DecodeParms is present, so the bytes after unpacking may still be transformed (for example by a predictor). */
  readonly hasParams: boolean;
}

/** Reads /Filter and /DecodeParms from a stream dictionary whose names are already decoded. */
export function streamFilters(dictionary: string): StreamFilters {
  const hasParams = /\/(DecodeParms|DP)\b/.test(dictionary);
  const keys = [...dictionary.matchAll(/\/Filter(?![A-Za-z0-9])\s*/g)];
  // More than one /Filter key (a nested dictionary, or the key repeated) is ambiguous.
  if (keys.length === 0) return { names: [], unresolved: false, hasParams };
  if (keys.length > 1) return { names: [], unresolved: true, hasParams };
  const key = keys[0] as RegExpExecArray;
  const rest = dictionary.slice(key.index + key[0].length);
  const single = /^\/([^\s/[\]<>(){}%]+)/.exec(rest);
  if (single) return { names: [single[1] as string], unresolved: false, hasParams };
  const list = /^\[([^\]]*)\]/.exec(rest);
  if (list) {
    const body = (list[1] as string).trim();
    const names = [...body.matchAll(/\/([^\s/[\]<>(){}%]+)/g)].map((match) => match[1] as string);
    const leftover = body.replace(/\/[^\s/[\]<>(){}%]+/g, "").trim();
    return { names, unresolved: leftover.length > 0, hasParams };
  }
  return { names: [], unresolved: true, hasParams };
}

export const IMAGE_FILTERS: ReadonlySet<string> = new Set(["DCTDecode", "DCT", "JPXDecode", "CCITTFaxDecode", "CCF", "JBIG2Decode"]);
const FLATE = new Set(["FlateDecode", "Fl"]);
const HEX = new Set(["ASCIIHexDecode", "AHx"]);
const A85 = new Set(["ASCII85Decode", "A85"]);

/** True when screening can unpack every filter in the list itself. */
export const canDecode = (names: readonly string[]): boolean => names.every((name) => FLATE.has(name) || HEX.has(name) || A85.has(name));

export const isFlate = (name: string): boolean => FLATE.has(name);
export const isAsciiHex = (name: string): boolean => HEX.has(name);
export const isAscii85 = (name: string): boolean => A85.has(name);

export function decodeAsciiHex(data: Uint8Array): Uint8Array {
  const text = Buffer.from(data).toString("latin1");
  const end = text.indexOf(">");
  let digits = (end === -1 ? text : text.slice(0, end)).replace(/[^0-9A-Fa-f]/g, "");
  if (digits.length % 2 === 1) digits += "0";
  return new Uint8Array(Buffer.from(digits, "hex"));
}

/** ASCII85 with an output cap; throws when the cap would be passed. */
export function decodeAscii85(data: Uint8Array, maxOutput: number): Uint8Array {
  let text = Buffer.from(data).toString("latin1");
  const end = text.indexOf("~>");
  if (end !== -1) text = text.slice(0, end);
  if (text.startsWith("<~")) text = text.slice(2);
  text = text.replace(/\s+/g, "");
  const out: number[] = [];
  const group: number[] = [];
  const flush = (count: number) => {
    let value = 0;
    for (let k = 0; k < 5; k += 1) value = value * 85 + (group[k] ?? 84);
    for (let k = 0; k < count - 1; k += 1) out.push((value >>> (24 - 8 * k)) & 0xff);
    group.length = 0;
  };
  for (const char of text) {
    if (out.length > maxOutput) throw Object.assign(new Error("ASCII85 output too large"), { code: "ERR_BUFFER_TOO_LARGE" });
    if (char === "z" && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    const code = char.charCodeAt(0) - 33;
    if (code < 0 || code > 84) throw new Error("not ASCII85 data");
    group.push(code);
    if (group.length === 5) flush(5);
  }
  if (group.length > 0) flush(group.length);
  if (out.length > maxOutput) throw Object.assign(new Error("ASCII85 output too large"), { code: "ERR_BUFFER_TOO_LARGE" });
  return new Uint8Array(out);
}
