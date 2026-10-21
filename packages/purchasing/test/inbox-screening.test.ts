// Issue #401 (threat model I3): screening measures what arrived, reads the whole file,
// and never lets a file through without an answer from the virus scanner.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { AuditLog, PlatformCommandService } from "../../platform/src/index.ts";
import { syntheticGstin } from "../../masters/src/index.ts";
import { EICAR_TEST_STRING, MockOcrAdapter, MockVirusScanner, PDF_SCAN_LIMITS, PurchaseInboxService, inspectAttachment, pageFromLines, scanPdf, screenAttachment } from "../src/index.ts";
import type { CompanyRoutingProfile, DeclaredAttachment, PdfScanLimits, VirusScanPort } from "../src/index.ts";

const BUYER_GSTIN = syntheticGstin("29", "AAACB1234M");
const SUPPLIER_GSTIN = syntheticGstin("27", "AAECS5678D");
const COMPANIES: readonly CompanyRoutingProfile[] = [
  { companyId: "company-a", legalName: "Sampoorna Traders", gstins: [BUYER_GSTIN], emailAliases: ["bills-sampoorna@invoices.example"], whatsappNumbers: ["+91 98450 12345"] },
];
const PAGE = pageFromLines(1, [
  "SHREE RAM STEELS PRIVATE LIMITED", `GSTIN: ${SUPPLIER_GSTIN}`, "TAX INVOICE", "Invoice No: SRS/2026/0042", "Invoice Date: 21/07/2026",
  `GSTIN: ${BUYER_GSTIN}`, "Taxable Value: 32,000.00", "IGST 18%: 5,760.00", "Grand Total: 37,760.00",
]);

// ------------------------------------------------------------------ PDF builders

type Part = string | Buffer;
const latin1 = (text: string): Buffer => Buffer.from(text, "latin1");

/** A deterministic pseudo-random byte source, standing in for compressed image data. */
function noise(length: number, seed = 401): Buffer {
  const out = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    out[index] = state >>> 24;
  }
  return out;
}

function streamObject(number: number, dict: string, data: Buffer): Buffer {
  return Buffer.concat([latin1(`${number} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`), data, latin1("\nendstream\nendobj\n")]);
}

/** Joins objects into a file with an xref table and trailer, as a real writer would. */
function pdf(objects: readonly Part[], trailerExtra = ""): Uint8Array {
  const parts: Buffer[] = [latin1("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  for (const object of objects) {
    const buffer = typeof object === "string" ? latin1(object) : object;
    offsets.push(length);
    parts.push(buffer);
    length += buffer.length;
  }
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)].join("");
  parts.push(latin1(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${length}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}

/** A plausible one-page invoice: compressed page content, a font, and a scanned image. */
function cleanInvoicePdf(extra: readonly Part[] = [], trailerExtra = ""): Uint8Array {
  const content = deflateSync(latin1("BT /F1 12 Tf 72 720 Td (TAX INVOICE SRS/2026/0042) Tj ET\nq 400 0 0 200 72 400 cm /Im1 Do Q\n"));
  return pdf([
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> /Annots [7 0 R] >>\nendobj\n",
    streamObject(4, "/Filter /FlateDecode", content),
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    // 2 MB of high-entropy "JPEG" data: random bytes must not look like a script by chance.
    streamObject(6, "/Type /XObject /Subtype /Image /Width 2480 /Height 3508 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode", noise(2 * 1024 * 1024)),
    // A web link is normal on an invoice and is not active content.
    "7 0 obj\n<< /Type /Annot /Subtype /Link /Rect [72 100 300 120] /A << /S /URI /URI (https://shreeram.example) >> >>\nendobj\n",
    ...extra,
  ], `/Info << /Producer (Tally) >> /ID [<0123456789abcdef><0123456789abcdef>] ${trailerExtra}`);
}

const PADDING = (n: number) => streamObject(n, "", latin1("0 0 m 1 1 l S\n".repeat(1_500))); // ~20 KB of plain page content

const att = (overrides: Partial<DeclaredAttachment> = {}): DeclaredAttachment => ({ id: "att-1", fileName: "invoice.pdf", declaredMimeType: "application/pdf", storageKey: "s3://inbox/doc-1", ...overrides });
const reasonOf = (result: ReturnType<typeof screenAttachment>) => (result.ok ? "OK" : result.reason);

function setup(scanner: VirusScanPort = new MockVirusScanner()) {
  const audit = new AuditLog();
  const ocr = new MockOcrAdapter({ "s3://inbox/doc-1": [PAGE] });
  return { audit, ocr, inbox: new PurchaseInboxService(new PlatformCommandService(audit, []), audit, ocr, COMPANIES, scanner) };
}
const upload = (bytes: Uint8Array, attachment: DeclaredAttachment = att(), key = "k1") => ({
  channel: "manual_upload" as const, sender: { channel: "manual_upload" as const, address: "owner@sampoorna.example" }, attachment, bytes, explicitCompanyId: "company-a", idempotencyKey: key,
});

// ------------------------------------------------------------------ the whole file is read

test("a clean, realistic invoice PDF passes once the scanner says clean", () => {
  const file = cleanInvoicePdf();
  assert.ok(file.byteLength > 2 * 1024 * 1024);
  const scan = scanPdf(file);
  assert.equal(scan.kind, "clean");
  assert.equal(scan.kind === "clean" && scan.pages, 1);
  assert.equal(reasonOf(screenAttachment(att(), file, "clean")), "OK");
});

test("an automatic action placed after the first 8 KB is still found", () => {
  const file = pdf([
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    PADDING(2),
    "3 0 obj\n<< /Type /Catalog /OpenAction 4 0 R >>\nendobj\n",
    "4 0 obj\n<< /S /JavaScript /JS (app.alert(1)) >>\nendobj\n",
  ]);
  const body = Buffer.from(file).toString("latin1");
  assert.ok(body.indexOf("/OpenAction") > 8192, "the fixture must put the action past 8 KB");
  const result = screenAttachment(att(), file, "clean");
  assert.equal(reasonOf(result), "ACTIVE_CONTENT");
  assert.match(result.ok ? "" : result.message, /script|automatic action/);
});

test("encryption declared only in the trailer at the end of the file is found", () => {
  const file = pdf(["1 0 obj\n<< /Type /Catalog >>\nendobj\n", PADDING(2), "3 0 obj\n<< /Filter /Standard /V 2 /R 3 /O <00> /U <00> /P -4 >>\nendobj\n"], "/Encrypt 3 0 R");
  assert.ok(Buffer.from(file).toString("latin1").lastIndexOf("/Encrypt") > 8192);
  assert.equal(reasonOf(screenAttachment(att(), file, "clean")), "PASSWORD_PROTECTED");
});

test("names disguised with #xx hex escapes are decoded before they are checked", () => {
  for (const disguised of ["/J#61vaScript", "/#4A#53", "/Open#41ction", "/L#61unch", "/Embedded#46ile", "/#41#41"]) {
    const file = pdf(["1 0 obj\n<< /Type /Catalog >>\nendobj\n", PADDING(2), `3 0 obj\n<< ${disguised} 4 0 R >>\nendobj\n`]);
    assert.equal(reasonOf(screenAttachment(att(), file, "clean")), "ACTIVE_CONTENT", disguised);
  }
  const encrypted = pdf(["1 0 obj\n<< /Type /Catalog >>\nendobj\n"], "/#45ncrypt 2 0 R");
  assert.equal(reasonOf(screenAttachment(att(), encrypted, "clean")), "PASSWORD_PROTECTED");
});

test("every kind of active content is caught: embedded files, rich media, forms, launch", () => {
  for (const feature of ["/EmbeddedFiles << /Names [] >>", "/RichMedia 4 0 R", "/XFA 4 0 R", "/S /Launch /F (cmd.exe)", "/S /SubmitForm", "/S /ImportData", "/S /GoToE", "/AA << /O 4 0 R >>"]) {
    const file = pdf(["1 0 obj\n<< /Type /Catalog >>\nendobj\n", `2 0 obj\n<< ${feature} >>\nendobj\n`]);
    assert.equal(reasonOf(screenAttachment(att(), file, "clean")), "ACTIVE_CONTENT", feature);
  }
});

test("a script hidden inside a compressed object stream is found", () => {
  const packed = deflateSync(latin1("5 0 6 40 << /Type /Catalog /Names << /JavaScript 6 0 R >> >> << /S /JavaScript /JS (x) >>"));
  const file = pdf([streamObject(1, "/Type /ObjStm /N 2 /First 8 /Filter /FlateDecode", packed)]);
  const result = screenAttachment(att(), file, "clean");
  assert.equal(reasonOf(result), "ACTIVE_CONTENT");
  // The two-letter /AA, which is only checked in dictionaries, is found in an object stream too.
  const aa = pdf([streamObject(1, "/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode", deflateSync(latin1("5 0 << /AA << /O 9 0 R >> >>")))]);
  assert.equal(reasonOf(screenAttachment(att(), aa, "clean")), "ACTIVE_CONTENT");
  // ASCIIHex then Flate, a chain old PostScript tools still write.
  const hexed = latin1(`${deflateSync(latin1("5 0 << /S /JavaScript >>")).toString("hex")}>`);
  const chained = pdf([streamObject(1, "/Type /ObjStm /N 1 /First 4 /Filter [/ASCIIHexDecode /FlateDecode]", hexed)]);
  assert.equal(reasonOf(screenAttachment(att(), chained, "clean")), "ACTIVE_CONTENT");
});

test("an object hidden between a short /Length and the endstream keyword is found", () => {
  const sneaky = Buffer.concat([latin1("2 0 obj\n<< /Length 5 >>\nstream\nAAAAA\n9 0 obj << /AA << /O 4 0 R >> >> endobj\nendstream\nendobj\n")]);
  const file = pdf(["1 0 obj\n<< /Type /Catalog >>\nendobj\n", sneaky]);
  assert.equal(reasonOf(screenAttachment(att(), file, "clean")), "ACTIVE_CONTENT");
});

test("an object stream that cannot be unpacked is quarantined, never skipped", () => {
  const corrupt = pdf([streamObject(1, "/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode", noise(500))]);
  assert.equal(reasonOf(screenAttachment(att(), corrupt, "clean")), "UNREADABLE");
  const lzw = pdf([streamObject(1, "/Filter /LZWDecode", noise(64))]);
  assert.equal(reasonOf(screenAttachment(att(), lzw, "clean")), "UNREADABLE");
  const twoFilters = pdf([streamObject(1, "/DecodeParms << /Filter /DCTDecode >> /Filter [/AHx /Fl]", noise(64))]);
  assert.equal(reasonOf(screenAttachment(att(), twoFilters, "clean")), "UNREADABLE");
  const unterminated = new Uint8Array(latin1("%PDF-1.7\n1 0 obj\n<< /Length 999 >>\nstream\nabc"));
  assert.equal(reasonOf(screenAttachment(att(), unterminated, "clean")), "UNREADABLE");
});

// ------------------------------------------------------------------ caps

test("a compression bomb is stopped at the decompression budget", () => {
  const bomb = deflateSync(Buffer.alloc(PDF_SCAN_LIMITS.maxStreamDecodedBytes + 1024 * 1024));
  assert.ok(bomb.length < 200 * 1024, "the bomb must be small on the wire");
  const file = pdf(["1 0 obj\n<< /Type /Catalog >>\nendobj\n", streamObject(2, "/Filter /FlateDecode", bomb)]);
  const result = screenAttachment(att(), file, "clean");
  assert.equal(reasonOf(result), "PDF_TOO_COMPLEX");
  assert.match(result.ok ? "" : result.message, /unpacks to far more data/);

  // Many streams each under the per-stream cap still hit the whole-file cap.
  const limits: PdfScanLimits = { ...PDF_SCAN_LIMITS, maxStreamDecodedBytes: 2 * 1024 * 1024, maxTotalDecodedBytes: 3 * 1024 * 1024 };
  const chunk = deflateSync(Buffer.alloc(1024 * 1024));
  const several = pdf([1, 2, 3, 4].map((n) => streamObject(n, "/Filter /FlateDecode", chunk)));
  assert.equal(scanPdf(several, limits).kind, "too_complex");
});

test("page, object, picture and time limits each quarantine with their own reason", () => {
  const pages = pdf(Array.from({ length: PDF_SCAN_LIMITS.maxPages + 1 }, (_, i) => `${i + 1} 0 obj\n<< /Type /Page /Parent 999 0 R >>\nendobj\n`));
  const tooManyPages = screenAttachment(att(), pages, "clean");
  assert.equal(reasonOf(tooManyPages), "PDF_TOO_COMPLEX");
  assert.match(tooManyPages.ok ? "" : tooManyPages.message, /more than 200 pages/);
  // "/Type /Pages" is the page tree, not a page.
  assert.equal(scanPdf(pdf(["1 0 obj << /Type /Pages /Count 0 >> endobj\n"])).kind, "clean");

  const objects = pdf(Array.from({ length: 60 }, (_, i) => `${i + 1} 0 obj\nnull\nendobj\n`));
  assert.deepEqual(scanPdf(objects, { ...PDF_SCAN_LIMITS, maxObjects: 50 }).kind, "too_complex");

  const giant = pdf([streamObject(1, "/Subtype /Image /Width 20000 /Height 20000 /Filter /DCTDecode", noise(16))]);
  const picture = scanPdf(giant);
  assert.equal(picture.kind === "too_complex" && picture.limit, "image_pixels");

  const slow = scanPdf(cleanInvoicePdf(), { ...PDF_SCAN_LIMITS, timeBudgetMs: -1 });
  assert.equal(slow.kind === "too_complex" && slow.limit, "time");
});

// ------------------------------------------------------------------ measured, not declared

test("size and hash are measured from the bytes; a false declaration is held", () => {
  const file = cleanInvoicePdf();
  const sha256 = createHash("sha256").update(file).digest("hex");
  const honest = inspectAttachment(att({ sizeBytes: file.byteLength, sha256 }), file);
  assert.equal(honest.ok, true);
  assert.deepEqual(honest.measured, { sizeBytes: file.byteLength, sha256 });

  const smaller = inspectAttachment(att({ sizeBytes: 1024 }), file);
  assert.equal(smaller.ok === false && smaller.reason, "FILE_DETAILS_MISMATCH");
  assert.equal(smaller.measured.sizeBytes, file.byteLength);
  const swapped = inspectAttachment(att({ sha256: "a".repeat(64) }), file);
  assert.equal(swapped.ok === false && swapped.reason, "FILE_DETAILS_MISMATCH");
});

test("a file declared as 1 KB that is really 30 MB is refused on its real size", async () => {
  const big = new Uint8Array(30 * 1024 * 1024);
  big.set(latin1("%PDF-1.7\n"));
  const result = screenAttachment(att({ sizeBytes: 1024 }), big, "clean");
  assert.equal(reasonOf(result), "FILE_TOO_LARGE");
  assert.equal(result.ok ? 0 : result.measured.sizeBytes, 30 * 1024 * 1024);

  const scanner = new MockVirusScanner();
  const { inbox, ocr } = setup(scanner);
  const received = await inbox.receive(upload(big, att({ sizeBytes: 1024 })));
  assert.equal(received.document.status, "quarantined");
  assert.equal(received.document.quarantineReason, "FILE_TOO_LARGE");
  assert.equal(received.document.attachment.sizeBytes, 30 * 1024 * 1024);
  assert.equal(scanner.callCount, 0);
  assert.equal(ocr.callCount, 0);
});

test("the stored hash is the measured one, so a forged hash cannot fake or dodge a duplicate", async () => {
  const { inbox } = setup();
  const file = cleanInvoicePdf();
  const first = await inbox.receive(upload(file));
  assert.equal(first.document.status, "draft_ready");
  assert.equal(first.document.attachment.sha256, createHash("sha256").update(file).digest("hex"));
  const again = await inbox.receive(upload(file, att({ id: "att-2", storageKey: "s3://inbox/doc-2" }), "k2"));
  assert.equal(again.duplicate, true);
});

// ------------------------------------------------------------------ the virus scanner

test("with no scan verdict a file is held, never passed", () => {
  const file = cleanInvoicePdf();
  for (const verdict of [undefined, "unscanned"] as const) {
    const result = screenAttachment(att(), file, verdict);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.outcome, "hold");
    assert.equal(reasonOf(result), "VIRUS_SCAN_PENDING");
  }
  assert.equal(reasonOf(screenAttachment(att(), file, "infected")), "MALWARE_SUSPECTED");
});

test("a scanner that cannot reach a verdict holds the document until it can", async () => {
  const scanner = new MockVirusScanner({ mode: "no_verdict" });
  const { inbox, ocr } = setup(scanner);
  const file = cleanInvoicePdf();
  const held = await inbox.receive(upload(file));
  assert.equal(held.document.status, "awaiting_scan");
  assert.match(held.document.statusMessage ?? "", /waiting for its virus check/);
  assert.equal(ocr.callCount, 0, "nothing reads a file the scanner has not cleared");

  scanner.setMode("healthy");
  const released = await inbox.rescan(held.document.id, file);
  assert.equal(released.document.status, "draft_ready");
  assert.equal(released.document.attempts, 2);
  assert.equal(ocr.callCount, 1);
});

test("a scanner outage holds the document, and a later rescan carries on", async () => {
  const scanner = new MockVirusScanner({ mode: "outage" });
  const { inbox, ocr } = setup(scanner);
  const file = cleanInvoicePdf();
  const held = await inbox.receive(upload(file));
  assert.equal(held.document.status, "awaiting_scan");
  assert.match(held.document.statusMessage ?? "", /not answering/);

  const stillDown = await inbox.rescan(held.document.id, file);
  assert.equal(stillDown.document.status, "awaiting_scan");
  assert.equal(ocr.callCount, 0);

  scanner.setMode("healthy");
  scanner.failNext(1);
  assert.equal((await inbox.rescan(held.document.id, file)).document.status, "awaiting_scan");
  const released = await inbox.rescan(held.document.id, file);
  assert.equal(released.document.status, "draft_ready");
  await assert.rejects(() => inbox.rescan(held.document.id, file), /waiting for its virus check/);
});

test("an adapter that crashes, or answers about other bytes, holds too", async () => {
  const crashing: VirusScanPort = { scan: async () => { throw new Error("socket hang up"); } };
  assert.equal((await setup(crashing).inbox.receive(upload(cleanInvoicePdf()))).document.status, "awaiting_scan");
  const confused = new MockVirusScanner({ mode: "wrong_file" });
  assert.equal((await setup(confused).inbox.receive(upload(cleanInvoicePdf()))).document.status, "awaiting_scan");
  const lying: VirusScanPort = { scan: async () => ({ verdict: "maybe" as never, scannedSha256: "", engine: "x", providerRequestId: "x" }) };
  assert.equal((await setup(lying).inbox.receive(upload(cleanInvoicePdf()))).document.status, "awaiting_scan");
});

test("a rescan with different bytes is quarantined rather than cleared", async () => {
  const scanner = new MockVirusScanner({ mode: "outage" });
  const { inbox } = setup(scanner);
  const held = await inbox.receive(upload(cleanInvoicePdf()));
  scanner.setMode("healthy");
  const swapped = await inbox.rescan(held.document.id, cleanInvoicePdf([], "/Swapped true"));
  assert.equal(swapped.document.status, "quarantined");
  assert.equal(swapped.document.quarantineReason, "FILE_DETAILS_MISMATCH");
});

test("a file the scanner flags is quarantined as malware", async () => {
  const { inbox, ocr } = setup();
  const infected = pdf(["1 0 obj\n<< /Type /Catalog >>\nendobj\n", streamObject(2, "", latin1(EICAR_TEST_STRING))]);
  const result = await inbox.receive(upload(infected));
  assert.equal(result.document.quarantineReason, "MALWARE_SUSPECTED");
  assert.equal(ocr.callCount, 0);
});

// ------------------------------------------------------------------ photos and JSON

test("photos and e-invoice JSON are not put through the PDF checks", () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), latin1("JFIF comment: /JavaScript /OpenAction /Encrypt "), noise(4096)]);
  assert.equal(reasonOf(screenAttachment(att({ fileName: "photo.jpg", declaredMimeType: "image/jpeg" }), jpeg, "clean")), "OK");
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), noise(4096, 7)]);
  assert.equal(reasonOf(screenAttachment(att({ fileName: "scan.png", declaredMimeType: "image/png" }), png, "clean")), "OK");
  const json = latin1(JSON.stringify({ DocDtls: { No: "A/1" }, Note: "/OpenAction /Encrypt" }));
  assert.equal(reasonOf(screenAttachment(att({ fileName: "e.json", declaredMimeType: "application/json" }), json, "clean")), "OK");
  // Photos and JSON still need a clean scan, like everything else.
  assert.equal(reasonOf(screenAttachment(att({ fileName: "photo.jpg", declaredMimeType: "image/jpeg" }), jpeg)), "VIRUS_SCAN_PENDING");
});

// ------------------------------------------------------------------ found in independent review

test("an object stream whose compression or predictor is named indirectly is quarantined", () => {
  const packed = deflateSync(latin1("5 0 << /Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>"));
  const indirectFilter = pdf([streamObject(1, "/Type /ObjStm /N 1 /First 4 /Filter 9 0 R", packed), "9 0 obj\n/FlateDecode\nendobj\n"]);
  assert.equal(reasonOf(screenAttachment(att(), indirectFilter, "clean")), "UNREADABLE");
  const refInArray = pdf([streamObject(1, "/Filter [9 0 R]", packed), "9 0 obj\n/FlateDecode\nendobj\n"]);
  assert.equal(reasonOf(screenAttachment(att(), refInArray, "clean")), "UNREADABLE");
  const indirectParms = pdf([streamObject(1, "/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /DecodeParms 9 0 R", packed), "9 0 obj\n<< /Predictor 12 /Columns 1 >>\nendobj\n"]);
  assert.equal(reasonOf(screenAttachment(att(), indirectParms, "clean")), "UNREADABLE");
  const indirectPredictor = pdf([streamObject(1, "/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /DecodeParms << /Predictor 9 0 R >>", packed), "9 0 obj\n12\nendobj\n"]);
  assert.equal(reasonOf(screenAttachment(att(), indirectPredictor, "clean")), "UNREADABLE");
  // Ordinary direct filters still pass.
  assert.equal(scanPdf(pdf([streamObject(1, "/Filter [ /FlateDecode ]", deflateSync(latin1("BT ET")))])).kind, "clean");
});

test("a document held for its safety cannot be released by assigning it to a company", async () => {
  const scanner = new MockVirusScanner({ mode: "outage" });
  const { inbox } = setup(scanner);
  const context = { companyId: "company-a", branchId: "company-a", actorId: "owner", permissions: new Set<string>(), sessionId: "s" } as never;
  const waiting = await inbox.receive(upload(cleanInvoicePdf()));
  assert.throws(() => inbox.assignCompany(context, waiting.document.id, "mine"), /may not be safe/);
  const scripted = pdf(["1 0 obj\n<< /OpenAction << /S /JavaScript >> >>\nendobj\n"]);
  const held = await inbox.receive(upload(scripted, att({ id: "att-9" }), "k9"));
  assert.equal(held.document.quarantineReason, "ACTIVE_CONTENT");
  assert.throws(() => inbox.assignCompany(context, held.document.id, "mine"), /may not be safe/);
});
