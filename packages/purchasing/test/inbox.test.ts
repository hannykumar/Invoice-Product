import assert from "node:assert/strict";
import test from "node:test";
import { AuditLog, PlatformCommandService } from "../../platform/src/index.ts";
import { syntheticGstin } from "../../masters/src/index.ts";
import { MockOcrAdapter, PurchaseInboxService, pageFromLines, parseInvoiceDate, parsePaise, readEInvoiceJson, readInvoiceFromOcr, routeDocument, screenAttachment } from "../src/index.ts";
import type { Attachment, CompanyRoutingProfile, InboundSender } from "../src/index.ts";

const BUYER_GSTIN = syntheticGstin("29", "AAACB1234M");
const OTHER_BUYER_GSTIN = syntheticGstin("27", "AAACZ9999Q");
const SUPPLIER_GSTIN = syntheticGstin("27", "AAECS5678D");

const COMPANIES: readonly CompanyRoutingProfile[] = [
  { companyId: "company-a", legalName: "Sampoorna Traders", gstins: [BUYER_GSTIN], emailAliases: ["bills-sampoorna@invoices.example"], whatsappNumbers: ["+91 98450 12345"] },
  { companyId: "company-b", legalName: "Konkan Metals", gstins: [OTHER_BUYER_GSTIN], emailAliases: ["bills-konkan@invoices.example"], whatsappNumbers: ["+91 98220 11122"] },
];

const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "latin1"));
const PDF_HEAD = bytes("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n");

let counter = 0;
const attachment = (overrides: Partial<Attachment> = {}): Attachment => ({
  id: `att-${(counter += 1)}`,
  fileName: "invoice.pdf",
  declaredMimeType: "application/pdf",
  sizeBytes: 240_000,
  sha256: `hash-${counter}`,
  storageKey: `s3://inbox/doc-${counter}`,
  ...overrides,
});

const whatsapp = (overrides: Partial<InboundSender> = {}): InboundSender => ({ channel: "whatsapp", address: "+919822011122", displayName: "Shree Ram Steels", ...overrides });

const INVOICE_PAGE = (buyer = BUYER_GSTIN) => pageFromLines(1, [
  "SHREE RAM STEELS PRIVATE LIMITED",
  "Plot 8, MIDC Bhosari, Pune 411001",
  `GSTIN: ${SUPPLIER_GSTIN}`,
  "TAX INVOICE",
  "Invoice No: SRS/2026/0042",
  "Invoice Date: 21/07/2026",
  "Bill To: Sampoorna Traders, Bengaluru",
  `GSTIN: ${buyer}`,
  "TMT Steel Bar 12mm   HSN 72142090   500 KGS   64.00",
  "Taxable Value: 32,000.00",
  "IGST 18%: 5,760.00",
  "Grand Total: 37,760.00",
]);

function setup(pages = { "s3://inbox/doc-1": [INVOICE_PAGE()] } as Record<string, ReturnType<typeof pageFromLines>[]>, mode: "healthy" | "outage" = "healthy") {
  const audit = new AuditLog();
  const commands = new PlatformCommandService(audit, []);
  const ocr = new MockOcrAdapter(pages, mode);
  return { audit, ocr, inbox: new PurchaseInboxService(commands, audit, ocr, COMPANIES) };
}

test("money on an Indian invoice is read as exact paise", () => {
  assert.equal(parsePaise("₹ 1,23,456.78"), 12_345_678n);
  assert.equal(parsePaise("37,760.00"), 3_776_000n);
  assert.equal(parsePaise("Rs. 100"), 10_000n);
  assert.equal(parsePaise("twelve"), null);
});

test("dates are read day-first and say so when they could be read either way", () => {
  assert.deepEqual(parseInvoiceDate("21/07/2026"), { iso: "2026-07-21", ambiguous: false });
  assert.deepEqual(parseInvoiceDate("05/07/2026"), { iso: "2026-07-05", ambiguous: true });
  assert.equal(parseInvoiceDate("31/02/2026"), null);
});

test("attachment screening holds files that are not safe to read", () => {
  assert.equal(screenAttachment(attachment(), PDF_HEAD).ok, true);
  const disguised = screenAttachment(attachment({ fileName: "invoice.pdf.exe" }), PDF_HEAD);
  assert.equal(disguised.ok === false && disguised.reason, "UNSUPPORTED_FILE_TYPE");
  const mismatch = screenAttachment(attachment({ declaredMimeType: "image/png" }), PDF_HEAD);
  assert.equal(mismatch.ok === false && mismatch.reason, "FILE_TYPE_MISMATCH");
  const locked = screenAttachment(attachment(), bytes("%PDF-1.7\n/Encrypt 5 0 R\n"));
  assert.equal(locked.ok === false && locked.reason, "PASSWORD_PROTECTED");
  const scripted = screenAttachment(attachment(), bytes("%PDF-1.7\n/OpenAction << /JavaScript (app.alert) >>\n"));
  assert.equal(scripted.ok === false && scripted.reason, "ACTIVE_CONTENT");
  const huge = screenAttachment(attachment({ sizeBytes: 40 * 1024 * 1024 }), PDF_HEAD);
  assert.equal(huge.ok === false && huge.reason, "FILE_TOO_LARGE");
  const infected = screenAttachment(attachment(), PDF_HEAD, "infected");
  assert.equal(infected.ok === false && infected.reason, "MALWARE_SUSPECTED");
});

test("a document addressed to another business is never routed into this one", () => {
  const wrongCompany = routeDocument({ companies: COMPANIES, sender: whatsapp(), deliveredTo: "+91 98450 12345", buyerGstin: OTHER_BUYER_GSTIN, explicitCompanyId: "company-a" });
  assert.equal(wrongCompany.ok, false);
  assert.equal(wrongCompany.ok === false && wrongCompany.reason, "COMPANY_MISMATCH");
  assert.match(wrongCompany.ok === false ? wrongCompany.message : "", /Konkan Metals/);

  const stranger = routeDocument({ companies: COMPANIES, sender: whatsapp(), buyerGstin: syntheticGstin("07", "AAACX1111J") });
  assert.equal(stranger.ok === false && stranger.reason, "COMPANY_MISMATCH");
});

test("routing prefers the GST number printed on the page, then the channel it arrived on", () => {
  const byGstin = routeDocument({ companies: COMPANIES, sender: whatsapp(), buyerGstin: BUYER_GSTIN });
  assert.equal(byGstin.ok && byGstin.companyId, "company-a");
  assert.equal(byGstin.ok && byGstin.decision.basis, "buyer_gstin");

  const byChannel = routeDocument({ companies: COMPANIES, sender: whatsapp(), deliveredTo: "bills-konkan@invoices.example" });
  assert.equal(byChannel.ok && byChannel.companyId, "company-b");
  // A channel guess is not proof, so it carries a lower confidence for #16 to act on.
  assert.ok(byChannel.ok && byChannel.decision.confidence < 1);

  const unknown = routeDocument({ companies: COMPANIES, sender: whatsapp({ address: "+919000000000" }) });
  assert.equal(unknown.ok === false && unknown.reason, "COMPANY_NOT_IDENTIFIED");
});

test("an e-invoice JSON file is read exactly, with every value citing its source", () => {
  const json = JSON.stringify({
    Version: "1.1",
    Irn: "a".repeat(64),
    DocDtls: { Typ: "INV", No: "SRS/2026/0042", Dt: "21/07/2026" },
    SellerDtls: { Gstin: SUPPLIER_GSTIN, LglNm: "Shree Ram Steels Private Limited" },
    BuyerDtls: { Gstin: BUYER_GSTIN, LglNm: "Sampoorna Traders" },
    ItemList: [{ SlNo: "1", PrdDesc: "TMT Steel Bar 12mm", HsnCd: "72142090", Qty: 500, Unit: "KGS", UnitPrice: 64, AssAmt: 32000, GstRt: 18 }],
    ValDtls: { AssVal: 32000, IgstVal: 5760, TotInvVal: 37760 },
  });
  const read = readEInvoiceJson(json);
  assert.equal(read.ok, true);
  assert.equal(read.invoiceNumber?.value, "SRS/2026/0042");
  assert.equal(read.invoiceDate?.value, "2026-07-21");
  assert.equal(read.invoiceTotalPaise?.value, 3_776_000n);
  assert.equal(read.totalTaxPaise?.value, 576_000n);
  assert.equal(read.taxableValuePaise?.value, 3_200_000n);
  // Structured data is not guessed, so confidence is 1 and the path is quoted.
  assert.equal(read.invoiceNumber?.confidence, 1);
  assert.equal(read.invoiceNumber?.evidence.jsonPath, "DocDtls.No");
  assert.equal(read.lines[0]?.gstRateBasisPoints?.value, 1800);
});

test("an e-invoice with an impossible GST number is reported rather than accepted", () => {
  const json = JSON.stringify({ DocDtls: { No: "X-1", Dt: "21/07/2026" }, SellerDtls: { Gstin: "29AABCA1234C1ZZ" }, ValDtls: { TotInvVal: 100 } });
  const read = readEInvoiceJson(json);
  assert.equal(read.ok, false);
  assert.match(read.problems.join(" "), /not a valid GST number/);
});

test("OCR values carry the page, the text and the box they were read from", () => {
  const read = readInvoiceFromOcr([INVOICE_PAGE()], { companyGstins: [BUYER_GSTIN] });
  assert.equal(read.invoiceNumber?.value, "SRS/2026/0042");
  assert.equal(read.invoiceDate?.value, "2026-07-21");
  assert.equal(read.supplierGstin?.value, SUPPLIER_GSTIN);
  assert.equal(read.buyerGstin?.value, BUYER_GSTIN);
  assert.equal(read.invoiceTotalPaise?.value, 3_776_000n);
  assert.equal(read.taxableValuePaise?.value, 3_200_000n);
  assert.equal(read.totalTaxPaise?.value, 576_000n);
  assert.equal(read.invoiceNumber?.evidence.page, 1);
  assert.ok((read.invoiceNumber?.evidence.box?.height ?? 0) > 0);
  assert.match(read.invoiceNumber?.evidence.text ?? "", /SRS\/2026\/0042/);
});

test("a mis-scanned GST number is flagged instead of being trusted", () => {
  const page = pageFromLines(1, ["TAX INVOICE", "GSTIN: 29AABCA1234C1ZZ", "Invoice No: X-1", "Grand Total: 100.00"]);
  const read = readInvoiceFromOcr([page]);
  assert.match(read.problems.join(" "), /fails its own check digit/);
  assert.ok((read.supplierGstin?.confidence ?? 1) < 0.5);
});

test("an unreadable page is reported, and a document with no readable page is not invented", () => {
  const blurred = pageFromLines(2, ["...."], { readable: false });
  const partial = readInvoiceFromOcr([INVOICE_PAGE(), blurred], { companyGstins: [BUYER_GSTIN] });
  assert.equal(partial.unreadable, false);
  assert.match(partial.problems.join(" "), /Page 2 could not be read/);

  const nothing = readInvoiceFromOcr([blurred]);
  assert.equal(nothing.unreadable, true);
  assert.equal(nothing.invoiceNumber, undefined);
});

test("a rotated multi-page scan still reads, because the provider corrected the rotation", () => {
  const page1 = pageFromLines(1, ["SHREE RAM STEELS PRIVATE LIMITED", `GSTIN: ${SUPPLIER_GSTIN}`, "Invoice No: SRS/2026/0043", "Invoice Date: 22/07/2026"], { rotationDegrees: 270 });
  const page2 = pageFromLines(2, [`GSTIN: ${BUYER_GSTIN}`, "Taxable Value: 10,000.00", "CGST 9%: 900.00", "SGST 9%: 900.00", "Grand Total: 11,800.00"], { rotationDegrees: 270 });
  const read = readInvoiceFromOcr([page1, page2], { companyGstins: [BUYER_GSTIN] });
  assert.equal(read.invoiceNumber?.value, "SRS/2026/0043");
  assert.equal(read.totalTaxPaise?.value, 180_000n);
  assert.equal(read.invoiceTotalPaise?.evidence.page, 2);
});

test("a received document becomes a draft and nothing is posted", async () => {
  const { inbox, audit } = setup();
  const result = await inbox.receive({
    channel: "whatsapp", sender: whatsapp({ providerMessageId: "wamid.1" }), attachment: attachment({ sha256: "hash-A", storageKey: "s3://inbox/doc-1" }),
    head: PDF_HEAD, deliveredTo: "+91 98450 12345", idempotencyKey: "wamid.1",
  });
  assert.equal(result.document.status, "draft_ready");
  assert.equal(result.document.companyId, "company-a");
  assert.equal(result.draft?.source, "ocr");
  assert.equal(result.draft?.invoiceNumber?.value, "SRS/2026/0042");
  assert.match(result.document.statusMessage ?? "", /nothing has been posted/i);
  // The only commands raised are inbox commands: no posting, no payable, no stock.
  assert.deepEqual([...new Set(audit.forCompany({ companyId: "company-a" } as never).map((event) => event.action))].sort(), ["purchase.inbox.draft_prepared.created", "purchase.inbox.draft_ready"]);
});

test("the same file arriving twice is not added twice", async () => {
  const { inbox } = setup({ "s3://inbox/doc-1": [INVOICE_PAGE()], "s3://inbox/doc-2": [INVOICE_PAGE()] });
  const first = await inbox.receive({ channel: "whatsapp", sender: whatsapp({ providerMessageId: "wamid.1" }), attachment: attachment({ sha256: "same-file", storageKey: "s3://inbox/doc-1" }), head: PDF_HEAD, deliveredTo: "+91 98450 12345", idempotencyKey: "k1" });
  const again = await inbox.receive({ channel: "email", sender: { channel: "email", address: "accounts@shreeram.example", providerMessageId: "mail.9" }, attachment: attachment({ sha256: "same-file", storageKey: "s3://inbox/doc-2" }), head: PDF_HEAD, deliveredTo: "bills-sampoorna@invoices.example", idempotencyKey: "k2" });
  assert.equal(first.document.status, "draft_ready");
  assert.equal(again.duplicate, true);
  assert.equal(again.document.status, "discarded");
  assert.equal(again.document.duplicateOfId, first.document.id);
});

test("a channel redelivering the same message returns the original document", async () => {
  const { inbox, ocr } = setup();
  const sender = whatsapp({ providerMessageId: "wamid.retry" });
  const first = await inbox.receive({ channel: "whatsapp", sender, attachment: attachment({ sha256: "hash-B", storageKey: "s3://inbox/doc-1" }), head: PDF_HEAD, deliveredTo: "+91 98450 12345", idempotencyKey: "k1" });
  const redelivered = await inbox.receive({ channel: "whatsapp", sender, attachment: attachment({ sha256: "hash-B", storageKey: "s3://inbox/doc-1" }), head: PDF_HEAD, deliveredTo: "+91 98450 12345", idempotencyKey: "k1" });
  assert.equal(redelivered.document.id, first.document.id);
  assert.equal(redelivered.duplicate, true);
  // The provider was not asked to read the same document a second time.
  assert.equal(ocr.callCount, 1);
});

test("an invoice addressed to another company is held, not filed", async () => {
  const { inbox } = setup({ "s3://inbox/doc-1": [INVOICE_PAGE(OTHER_BUYER_GSTIN)] });
  const result = await inbox.receive({
    channel: "whatsapp", sender: whatsapp(), attachment: attachment({ sha256: "hash-C", storageKey: "s3://inbox/doc-1" }),
    head: PDF_HEAD, deliveredTo: "+91 98450 12345", idempotencyKey: "k1",
  });
  assert.equal(result.document.status, "quarantined");
  assert.equal(result.document.quarantineReason, "COMPANY_MISMATCH");
  assert.match(result.document.statusMessage ?? "", /Konkan Metals/);
});

test("one company cannot read another company's inbox", async () => {
  const { inbox } = setup();
  const result = await inbox.receive({ channel: "whatsapp", sender: whatsapp(), attachment: attachment({ sha256: "hash-D", storageKey: "s3://inbox/doc-1" }), head: PDF_HEAD, deliveredTo: "+91 98450 12345", idempotencyKey: "k1" });
  const otherCompany = { companyId: "company-b", branchId: "branch-b", actorId: "owner-b", permissions: new Set(), sessionId: "s" } as never;
  assert.throws(() => inbox.document(otherCompany, result.document.id), /another company/);
  assert.equal(inbox.inbox(otherCompany).length, 0);
});

test("an outage marks the document for retry and the retry does not re-read what was already read", async () => {
  const { inbox, ocr } = setup({ "s3://inbox/doc-1": [INVOICE_PAGE()] });
  ocr.failNext(1);
  const failed = await inbox.receive({ channel: "email", sender: { channel: "email", address: "accounts@shreeram.example" }, attachment: attachment({ sha256: "hash-E", storageKey: "s3://inbox/doc-1" }), head: PDF_HEAD, deliveredTo: "bills-sampoorna@invoices.example", idempotencyKey: "k1" });
  assert.equal(failed.document.status, "failed");
  assert.match(failed.document.statusMessage ?? "", /tried again/);

  const retried = await inbox.retry(failed.document.id);
  assert.equal(retried.document.status, "draft_ready");
  assert.equal(retried.document.attempts, 2);
  assert.equal(retried.draft?.invoiceNumber?.value, "SRS/2026/0042");
});

test("a document too uncertain to be worth reviewing is quarantined instead of drafted", async () => {
  const smudged = pageFromLines(1, [{ text: "TAX INVOICE", confidence: 0.3 }, { text: "Total: 100.00", confidence: 0.25 }]);
  const { inbox } = setup({ "s3://inbox/doc-1": [smudged] });
  const result = await inbox.receive({ channel: "camera", sender: { channel: "camera", address: "owner@sampoorna.example" }, attachment: attachment({ sha256: "hash-F", storageKey: "s3://inbox/doc-1", declaredMimeType: "image/jpeg", fileName: "photo.jpg" }), head: bytes("\xff\xd8\xff\xe0JFIF"), explicitCompanyId: "company-a", idempotencyKey: "k1" });
  assert.equal(result.document.status, "quarantined");
  assert.equal(result.document.quarantineReason, "EXTRACTION_TOO_UNCERTAIN");
});

test("values read with low confidence are listed for review rather than accepted quietly", async () => {
  const shaky = pageFromLines(1, [
    "SHREE RAM STEELS PRIVATE LIMITED", `GSTIN: ${SUPPLIER_GSTIN}`, `GSTIN: ${BUYER_GSTIN}`,
    "Invoice No: SRS/2026/0044", { text: "Invoice Date: 05/07/2026", confidence: 0.9 },
    "Taxable Value: 1,000.00", "IGST 18%: 180.00", "Grand Total: 1,180.00",
  ]);
  const { inbox } = setup({ "s3://inbox/doc-1": [shaky] });
  const result = await inbox.receive({ channel: "manual_upload", sender: { channel: "manual_upload", address: "owner@sampoorna.example" }, attachment: attachment({ sha256: "hash-G", storageKey: "s3://inbox/doc-1" }), head: PDF_HEAD, explicitCompanyId: "company-a", idempotencyKey: "k1" });
  assert.equal(result.document.status, "draft_ready");
  assert.ok(result.draft?.fieldsNeedingReview.includes("invoiceDate"));
  assert.match(result.draft?.invoiceDate?.warning ?? "", /day\/month or month\/day/);
});

test("an invoice whose own arithmetic does not add up says so", async () => {
  const wrong = pageFromLines(1, [
    "SHREE RAM STEELS PRIVATE LIMITED", `GSTIN: ${SUPPLIER_GSTIN}`, `GSTIN: ${BUYER_GSTIN}`,
    "Invoice No: SRS/2026/0045", "Invoice Date: 21/07/2026",
    "Taxable Value: 32,000.00", "IGST 18%: 5,760.00", "Grand Total: 37,000.00",
  ]);
  const { inbox } = setup({ "s3://inbox/doc-1": [wrong] });
  const result = await inbox.receive({ channel: "manual_upload", sender: { channel: "manual_upload", address: "owner@sampoorna.example" }, attachment: attachment({ sha256: "hash-H", storageKey: "s3://inbox/doc-1" }), head: PDF_HEAD, explicitCompanyId: "company-a", idempotencyKey: "k1" });
  assert.match(result.draft?.arithmeticProblems.join(" ") ?? "", /does not equal the invoice total/);
});

test("an e-invoice JSON arriving on WhatsApp routes by its own buyer GST number", async () => {
  const { inbox } = setup();
  const json = JSON.stringify({ DocDtls: { No: "SRS/2026/0050", Dt: "21/07/2026" }, SellerDtls: { Gstin: SUPPLIER_GSTIN, LglNm: "Shree Ram Steels" }, BuyerDtls: { Gstin: BUYER_GSTIN }, ValDtls: { AssVal: 1000, IgstVal: 180, TotInvVal: 1180 } });
  const result = await inbox.receive({
    channel: "whatsapp", sender: whatsapp(), attachment: attachment({ fileName: "einvoice.json", declaredMimeType: "application/json", sha256: "hash-J", storageKey: "s3://inbox/doc-json" }),
    head: bytes(json.slice(0, 512)), jsonBody: json, deliveredTo: "+91 98220 11122", idempotencyKey: "k1",
  });
  // Delivered to Konkan's number, but the invoice says Sampoorna, and the document wins.
  assert.equal(result.document.companyId, "company-a");
  assert.equal(result.document.routing?.basis, "buyer_gstin");
  assert.equal(result.draft?.source, "einvoice_json");
  assert.equal(result.draft?.fieldsNeedingReview.length, 0);
});
