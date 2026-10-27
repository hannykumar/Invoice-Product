// #401 follow-up: active content hidden where a raw scan cannot see it.
//
// Each file here is a real PDF that pdfjs opens. Before this change every "hidden"
// case below passed screening as clean: the /Launch sat in an object stream whose
// filter was named by reference, packed with a filter other than Flate, or written
// with #xx escapes.

import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { screenAttachment } from "../src/index.ts";
import type { Attachment } from "../src/index.ts";
import { decodeAscii85, decodePdfNames, listPdfStreams, streamFilters } from "../src/pdf-streams.ts";

const attachment: Attachment = { id: "att-1", fileName: "invoice.pdf", declaredMimeType: "application/pdf", sizeBytes: 0, sha256: "declared", storageKey: "s3://inbox/doc-1" };
const latin1 = (text: string): Buffer => Buffer.from(text, "latin1");
const screen = async (bytes: Uint8Array) => {
  const result = await screenAttachment(attachment, bytes, "clean");
  return result.ok ? "ok" : result.reason;
};

const CLEAN = "<< /Type /Catalog /Pages 2 0 R >>";
const LAUNCH = "<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /Launch /F (calc.exe) >> >>";

/** A one-page PDF with the catalog written in the clear. */
function plainPdf(catalog: string): Uint8Array {
  const objects = [`1 0 obj ${catalog} endobj`, "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj", "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj"];
  let pdf = "%PDF-1.7\n";
  const offsets: number[] = [];
  for (const object of objects) { offsets.push(pdf.length); pdf += `${object}\n`; }
  const xrefAt = pdf.length;
  pdf += `xref\n0 4\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return new Uint8Array(latin1(pdf));
}

/**
 * A one-page PDF whose catalog, page tree and page live inside object stream 4, found
 * through a cross-reference stream. `streamKeys` is written into the object stream's
 * dictionary; `before` is raw text placed ahead of it; `extra` becomes object 6.
 */
function objectStreamPdf(catalog: string, streamKeys: string, encode: (data: Buffer) => Buffer, options: { readonly extra?: string; readonly before?: string; readonly afterKeyword?: string } = {}): Uint8Array {
  const inner = [catalog, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"];
  let body = "";
  const relative: number[] = [];
  for (const object of inner) { relative.push(body.length); body += `${object}\n`; }
  const header = `1 ${relative[0]} 2 ${relative[1]} 3 ${relative[2]} `;
  const data = encode(Buffer.concat([latin1(header), latin1(body)]));
  const parts: Buffer[] = [];
  let length = 0;
  const push = (part: Buffer) => { parts.push(part); length += part.length; };
  push(latin1(`%PDF-1.7\n${options.before ?? ""}`));
  const at4 = length;
  push(latin1(`4 0 obj << /Type /ObjStm /N 3 /First ${header.length} /Length ${data.length} ${streamKeys} >> stream${options.afterKeyword ?? ""}\n`));
  push(data);
  push(latin1("\nendstream endobj\n"));
  let at6 = 0;
  if (options.extra) { at6 = length; push(latin1(`6 0 obj ${options.extra} endobj\n`)); }
  const at5 = length;
  const rows: Buffer[] = [];
  const row = (type: number, a: number, b: number) => { const entry = Buffer.alloc(7); entry[0] = type; entry.writeUInt32BE(a, 1); entry.writeUInt16BE(b, 5); rows.push(entry); };
  row(0, 0, 65535); row(2, 4, 0); row(2, 4, 1); row(2, 4, 2); row(1, at4, 0); row(1, at5, 0);
  if (options.extra) row(1, at6, 0);
  const xref = Buffer.concat(rows);
  push(latin1(`5 0 obj << /Type /XRef /Size ${rows.length} /W [1 4 2] /Root 1 0 R /Length ${xref.length} >> stream\n`));
  push(xref);
  push(latin1(`\nendstream endobj\nstartxref\n${at5}\n%%EOF`));
  return new Uint8Array(Buffer.concat(parts));
}

const asciiHex = (data: Buffer): Buffer => latin1(`${data.toString("hex")}>`);

test("#401: clean PDFs, plain or with a Flate object stream, still pass", async () => {
  assert.equal(await screen(plainPdf(CLEAN)), "ok");
  assert.equal(await screen(objectStreamPdf(CLEAN, "/Filter /FlateDecode", deflateSync)), "ok");
  assert.equal(await screen(objectStreamPdf(CLEAN, "/Filter [/ASCIIHexDecode /FlateDecode]", (data) => asciiHex(deflateSync(data)))), "ok");
});

test("#401: a /Launch written with #xx escapes is found", async () => {
  assert.equal(await screen(plainPdf("<< /Type /Catalog /Pages 2 0 R /Open#41ction << /S /L#61unch /F (calc.exe) >> >>")), "ACTIVE_CONTENT");
  assert.equal(await screen(objectStreamPdf(LAUNCH, "/Filter /Fl#61teDecode", deflateSync)), "ACTIVE_CONTENT");
});

test("#401: a /Launch inside an object stream is found whatever filter packs it", async () => {
  assert.equal(await screen(objectStreamPdf(LAUNCH, "/Filter /FlateDecode", deflateSync)), "ACTIVE_CONTENT");
  assert.equal(await screen(objectStreamPdf(LAUNCH, "/Filter /ASCIIHexDecode", asciiHex)), "ACTIVE_CONTENT");
  assert.equal(await screen(objectStreamPdf(LAUNCH, "/Filter [/ASCIIHexDecode /FlateDecode]", (data) => asciiHex(deflateSync(data)))), "ACTIVE_CONTENT");
});

test("#401: an object stream screening cannot unpack is held, not skipped", async () => {
  // The filter named by reference: pdfjs resolves it, a dictionary search does not.
  assert.equal(await screen(objectStreamPdf(LAUNCH, "/Filter 6 0 R", deflateSync, { extra: "/FlateDecode" })), "UNREADABLE");
  // Decode parameters (a predictor) would scramble the unpacked text the scan reads.
  assert.equal(await screen(objectStreamPdf(CLEAN, "/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 4 >>", deflateSync)), "UNREADABLE");
  // A filter screening does not decode.
  assert.equal(await screen(objectStreamPdf(CLEAN, "/Filter /LZWDecode", (data) => data)), "UNREADABLE");
});

test("#401: tricks that make a simple scanner lose its place are held", async () => {
  // A text value containing "obj" used to move where the dictionary was thought to start.
  assert.equal(await screen(objectStreamPdf(LAUNCH, "/X (obj) /Filter /ASCIIHexDecode", asciiHex)), "ACTIVE_CONTENT");
  // An unclosed "<<" ahead of the stream hides it from the lexer; the cross-check catches it.
  assert.equal(await screen(objectStreamPdf(LAUNCH, "/Filter 6 0 R", deflateSync, { extra: "/FlateDecode", before: "% junk\n<< /Hide\n" })), "UNREADABLE");
  // pdfjs starts the data after the keyword's line, so `stream \n` and `stream junk\n` are streams (found in review).
  assert.equal(await screen(objectStreamPdf(LAUNCH, "/Filter /ASCIIHexDecode", asciiHex, { afterKeyword: " " })), "ACTIVE_CONTENT");
  assert.equal(await screen(objectStreamPdf(LAUNCH, "/Filter /FlateDecode", deflateSync, { afterKeyword: "\t junk" })), "ACTIVE_CONTENT");
  assert.equal(await screen(objectStreamPdf(CLEAN, "/Filter /FlateDecode", deflateSync, { afterKeyword: " " })), "ok");
  // An unclosed "(" ahead of the stream swallows it into a text value.
  assert.equal(await screen(objectStreamPdf(LAUNCH, "/Filter 6 0 R", deflateSync, { extra: "/FlateDecode", before: "(\n" })), "UNREADABLE");
});

test("pdf-streams: names, filters and ASCII85 are read the way a PDF reader reads them", () => {
  assert.equal(decodePdfNames("/L#61unch (a#62c) /Plain"), "/Launch (a#62c) /Plain");
  assert.deepEqual(streamFilters("<< /Filter [/AHx /Fl] >>"), { names: ["AHx", "Fl"], unresolved: false, hasParams: false });
  assert.equal(streamFilters("<< /Filter 6 0 R >>").unresolved, true);
  assert.equal(streamFilters("<< /Filter [/Fl 6 0 R] >>").unresolved, true);
  assert.equal(streamFilters("<< /Inner << /Filter /Fl >> /Filter /AHx >>").unresolved, true);
  assert.equal(Buffer.from(decodeAscii85(latin1("<~87cURD]i,\"Ebo80~>"), 100)).toString("latin1"), "Hello World!");
  assert.equal(Buffer.from(decodeAscii85(latin1("87cURD]i,\"Ebo7~>"), 100)).toString("latin1"), "Hello World");
  assert.throws(() => decodeAscii85(latin1("zzzz~>"), 8));
  const listing = listPdfStreams("1 0 obj << /Length 3 /T (a) >> stream\nabc\nendstream endobj");
  assert.equal(listing.ok && listing.streams.length, 1);
  // A reader follows the cross-reference table and never lexes bytes between objects, so a
  // "stream" keyword this lexer took to be inside a text value cannot be trusted: fail closed.
  assert.equal(listPdfStreams("1 0 obj << /Length 3 /T (a stream\n) >> stream\nabc\nendstream endobj").ok, false);
});
