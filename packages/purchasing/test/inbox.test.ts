import assert from "node:assert/strict";
import test from "node:test";
import { AuditLog, PlatformCommandService } from "../../platform/src/index.ts";
import { syntheticGstin } from "../../masters/src/index.ts";
import { generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { computeIrn } from "../../gst/src/irn.ts";
import { Rs256IrpSignatureVerifier } from "../../gst/src/irp-signature.ts";
import type { RequestContext } from "../../platform/src/types.ts";
import { MockOcrAdapter, PurchaseInboxService, REVIEW_CONFIDENCE, UNSIGNED_JSON_CONFIDENCE, pageFromLines, parseInvoiceDate, parsePaise, readEInvoiceJson, readInvoiceFromOcr, routeDocument, screenAttachment } from "../src/index.ts";
import type { Attachment, CompanyRoutingProfile, InboundSender } from "../src/index.ts";

const BUYER_GSTIN = syntheticGstin("29", "AAACB1234M");
const OTHER_BUYER_GSTIN = syntheticGstin("27", "AAACZ9999Q");
const SUPPLIER_GSTIN = syntheticGstin("27", "AAECS5678D");

const COMPANIES: readonly CompanyRoutingProfile[] = [
  { companyId: "company-a", legalName: "Sampoorna Traders", gstins: [BUYER_GSTIN], emailAliases: ["bills-sampoorna@invoices.example", "shared-desk@invoices.example"], whatsappNumbers: ["+91 98450 12345"] },
  { companyId: "company-b", legalName: "Konkan Metals", gstins: [OTHER_BUYER_GSTIN], emailAliases: ["bills-konkan@invoices.example", "shared-desk@invoices.example"], whatsappNumbers: ["+91 98220 11122"] },
  // The stranger in #400's scenario: a tenant of their own, with their own alias.
  { companyId: "company-x", legalName: "Stranger Trading", gstins: [syntheticGstin("07", "AAACX1111J")], emailAliases: ["bills-stranger@invoices.example"], whatsappNumbers: ["+91 99999 00000"] },
];

const contextFor = (companyId: string): RequestContext => ({ companyId, branchId: `${companyId}-main`, actorId: `owner-${companyId}`, permissions: new Set(), sessionId: `session-${companyId}` });

// A key pair standing in for the IRP's (no government key is needed to test), and a forger's.
const IRP_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 });
const FORGER = generateKeyPairSync("rsa", { modulusLength: 2048 });
const IRP_VERIFIER = new Rs256IrpSignatureVerifier([{ keyId: "irp-test", pem: IRP_KEY.publicKey.export({ type: "spki", format: "pem" }).toString() }]);
const irnFor = (number: string): string => computeIrn({ supplierGstin: SUPPLIER_GSTIN, documentNumber: number, documentDate: "2026-07-21", documentType: "INVOICE" });

const einvoiceObject = (options: { readonly buyer?: string; readonly number?: string; readonly total?: number } = {}) => ({
  Version: "1.1",
  DocDtls: { Typ: "INV", No: options.number ?? "SRS/2026/0042", Dt: "21/07/2026" },
  SellerDtls: { Gstin: SUPPLIER_GSTIN, LglNm: "Shree Ram Steels Private Limited" },
  BuyerDtls: { Gstin: options.buyer ?? BUYER_GSTIN, LglNm: "Buyer" },
  ItemList: [{ SlNo: "1", PrdDesc: "TMT Steel Bar 12mm", HsnCd: "72142090", Qty: 500, Unit: "KGS", UnitPrice: 64, AssAmt: 32000, GstRt: 18 }],
  ValDtls: { AssVal: 32000, IgstVal: 5760, TotInvVal: options.total ?? 37760 },
});
const einvoiceJson = (options: Parameters<typeof einvoiceObject>[0] = {}): string => JSON.stringify(einvoiceObject(options));

/** An IRP-shaped reply: the invoice signed as `SignedInvoice`, as the portal returns it. */
const signedEinvoice = (options: Parameters<typeof einvoiceObject>[0] & { readonly key?: KeyObject } = {}): string => {
  const number = options.number ?? "SRS/2026/0042";
  const data = { ...einvoiceObject(options), Irn: irnFor(number), AckNo: 112010000000001, AckDt: "2026-07-21 10:00:00" };
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${b64({ alg: "RS256", kid: "irp-test", typ: "JWT" })}.${b64({ data: JSON.stringify(data), iss: "NIC" })}`;
  const signature = sign("sha256", Buffer.from(input), options.key ?? IRP_KEY.privateKey).toString("base64url");
  return JSON.stringify({ Irn: data.Irn, AckNo: data.AckNo, SignedInvoice: `${input}.${signature}` });
};

const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "latin1"));
const PDF_HEAD = bytes("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n");

let counter = 0;
const jsonAttachment = (sha256: string): Attachment => attachment({ fileName: "einvoice.json", declaredMimeType: "application/json", sha256, storageKey: `s3://inbox/${sha256}` });
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
  return { audit, ocr, inbox: new PurchaseInboxService(commands, audit, ocr, COMPANIES, { irpSignatures: IRP_VERIFIER }) };
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

test("routing uses only the uploader's session or the delivery address, never the file (#400)", () => {
  const upload = routeDocument({ companies: COMPANIES, channel: "manual_upload", sender: whatsapp(), uploader: contextFor("company-a") });
  assert.equal(upload.ok && upload.companyId, "company-a");
  assert.equal(upload.ok && upload.decision.basis, "explicit_company");

  const byChannel = routeDocument({ companies: COMPANIES, channel: "email", sender: whatsapp(), deliveredTo: "bills-konkan@invoices.example" });
  assert.equal(byChannel.ok && byChannel.companyId, "company-b");
  assert.equal(byChannel.ok && byChannel.decision.basis, "channel_binding");

  // An email alias proves nothing when the same text arrives as a WhatsApp recipient.
  const wrongChannel = routeDocument({ companies: COMPANIES, channel: "whatsapp", sender: whatsapp(), deliveredTo: "bills-konkan@invoices.example" });
  assert.equal(wrongChannel.ok === false && wrongChannel.reason, "COMPANY_NOT_IDENTIFIED");

  const unknown = routeDocument({ companies: COMPANIES, channel: "whatsapp", sender: whatsapp({ address: "+919000000000" }), deliveredTo: "+91 90000 00000" });
  assert.equal(unknown.ok === false && unknown.reason, "COMPANY_NOT_IDENTIFIED");
  assert.deepEqual(unknown.ok === false && unknown.channelOwners, []);
});

test("an unsigned e-invoice JSON file is read exactly, but at review confidence (#400)", () => {
  const read = readEInvoiceJson(einvoiceJson());
  assert.equal(read.ok, true);
  assert.equal(read.signature, "unsigned");
  assert.equal(read.invoiceNumber?.value, "SRS/2026/0042");
  assert.equal(read.invoiceDate?.value, "2026-07-21");
  assert.equal(read.invoiceTotalPaise?.value, 3_776_000n);
  assert.equal(read.totalTaxPaise?.value, 576_000n);
  assert.equal(read.taxableValuePaise?.value, 3_200_000n);
  assert.equal(read.invoiceNumber?.evidence.jsonPath, "DocDtls.No");
  assert.equal(read.lines[0]?.gstRateBasisPoints?.value, 1800);
  // Nobody vouches for a typed file, so it gets no special confidence.
  assert.equal(read.invoiceNumber?.confidence, UNSIGNED_JSON_CONFIDENCE);
  assert.ok(UNSIGNED_JSON_CONFIDENCE < REVIEW_CONFIDENCE);
  assert.match(read.invoiceNumber?.warning ?? "", /not signed/);
});

test("a signed e-invoice is read from inside the signature, at confidence 1", () => {
  const read = readEInvoiceJson(signedEinvoice(), { signatures: IRP_VERIFIER });
  assert.equal(read.ok, true, read.problems.join(" "));
  assert.equal(read.signature, "verified");
  assert.equal(read.invoiceNumber?.confidence, 1);
  assert.equal(read.irn?.value, irnFor("SRS/2026/0042"));
});

test("a readable copy beside a genuine signature is ignored: only the signed values count", () => {
  const genuine = JSON.parse(signedEinvoice()) as Record<string, unknown>;
  const doctored = JSON.stringify({ ...genuine, ...JSON.parse(einvoiceJson({ buyer: OTHER_BUYER_GSTIN, total: 99_999 })) });
  const read = readEInvoiceJson(doctored, { signatures: IRP_VERIFIER });
  assert.equal(read.signature, "verified");
  assert.equal(read.buyerGstin?.value, BUYER_GSTIN);
  assert.equal(read.invoiceTotalPaise?.value, 3_776_000n);
});

test("a signature that does not match, or comes from another key, is reported as invalid", () => {
  assert.equal(readEInvoiceJson(signedEinvoice({ key: FORGER.privateKey }), { signatures: IRP_VERIFIER }).signature, "invalid");
  // Without the government's key configured, a signature is unverified, never trusted.
  const unverified = readEInvoiceJson(signedEinvoice());
  assert.equal(unverified.signature, "unverified");
  assert.equal(unverified.invoiceNumber?.confidence, UNSIGNED_JSON_CONFIDENCE);
});

test("an IRN that is not the hash of this supplier, number and date is reported", () => {
  const read = readEInvoiceJson(JSON.stringify({ ...einvoiceObject(), Irn: "a".repeat(64) }));
  assert.match(read.problems.join(" "), /does not belong to this supplier/);
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
  assert.match(result.document.statusMessage ?? "", /does not name Sampoorna Traders/);
  // The other business is never named: that would tell one tenant who else uses the product.
  assert.doesNotMatch(result.document.statusMessage ?? "", /Konkan/);
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

  const retried = await inbox.retry(contextFor("company-a"), failed.document.id);
  assert.equal(retried.document.status, "draft_ready");
  assert.equal(retried.document.attempts, 2);
  assert.equal(retried.draft?.invoiceNumber?.value, "SRS/2026/0042");
});

test("a document too uncertain to be worth reviewing is quarantined instead of drafted", async () => {
  const smudged = pageFromLines(1, [{ text: "TAX INVOICE", confidence: 0.3 }, { text: "Total: 100.00", confidence: 0.25 }]);
  const { inbox } = setup({ "s3://inbox/doc-1": [smudged] });
  const result = await inbox.receive({ channel: "camera", sender: { channel: "camera", address: "owner@sampoorna.example" }, attachment: attachment({ sha256: "hash-F", storageKey: "s3://inbox/doc-1", declaredMimeType: "image/jpeg", fileName: "photo.jpg" }), head: bytes("\xff\xd8\xff\xe0JFIF"), uploader: contextFor("company-a"), idempotencyKey: "k1" });
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
  const result = await inbox.receive({ channel: "manual_upload", sender: { channel: "manual_upload", address: "owner@sampoorna.example" }, attachment: attachment({ sha256: "hash-G", storageKey: "s3://inbox/doc-1" }), head: PDF_HEAD, uploader: contextFor("company-a"), idempotencyKey: "k1" });
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
  const result = await inbox.receive({ channel: "manual_upload", sender: { channel: "manual_upload", address: "owner@sampoorna.example" }, attachment: attachment({ sha256: "hash-H", storageKey: "s3://inbox/doc-1" }), head: PDF_HEAD, uploader: contextFor("company-a"), idempotencyKey: "k1" });
  assert.match(result.draft?.arithmeticProblems.join(" ") ?? "", /does not equal the invoice total/);
});

test("#400: a forged JSON naming a victim's GST number never reaches the victim's books", async () => {
  const { inbox } = setup();
  const forged = einvoiceJson({ number: "FAKE/1", buyer: BUYER_GSTIN });
  const send = (deliveredTo: string, sha: string) => inbox.receive({
    channel: "email", sender: { channel: "email", address: "attacker@evil.example" }, attachment: jsonAttachment(sha),
    head: bytes(forged.slice(0, 512)), jsonBody: forged, deliveredTo, idempotencyKey: sha,
  });

  // Sent to the stranger's own alias: it stays in the stranger's company, held, with no draft.
  const own = await send("bills-stranger@invoices.example", "forged-1");
  assert.equal(own.document.companyId, "company-x");
  assert.equal(own.document.quarantineReason, "COMPANY_MISMATCH");
  assert.equal(own.draft, undefined);
  // And the message does not reveal who owns that GST number.
  assert.doesNotMatch(own.document.statusMessage ?? "", /Sampoorna/);

  // Sent to an address nobody owns: held unrouted, and nobody can claim it.
  const nowhere = await send("random@invoices.example", "forged-2");
  assert.equal(nowhere.document.status, "quarantined");
  assert.equal(nowhere.document.quarantineReason, "COMPANY_NOT_IDENTIFIED");
  assert.throws(() => inbox.assignCompany(contextFor("company-a"), nowhere.document.id, "it names our GST number"), /not found/);
  assert.throws(() => inbox.assignCompany(contextFor("company-x"), nowhere.document.id, "mine"), /not found/);

  assert.equal(inbox.inbox(contextFor("company-a")).length, 0);
});

test("#400: an unsigned JSON sent to the right address is drafted, but every value needs a person's eye", async () => {
  const { inbox } = setup();
  const json = einvoiceJson({ number: "SRS/2026/0050" });
  const result = await inbox.receive({
    channel: "whatsapp", sender: whatsapp(), attachment: jsonAttachment("unsigned-ok"),
    head: bytes(json.slice(0, 512)), jsonBody: json, deliveredTo: "+91 98450 12345", idempotencyKey: "k1",
  });
  assert.equal(result.document.companyId, "company-a");
  assert.equal(result.document.routing?.basis, "channel_binding");
  assert.equal(result.draft?.signature, "unsigned");
  assert.ok(result.draft?.fieldsNeedingReview.includes("invoiceNumber"));
  assert.ok(result.draft?.fieldsNeedingReview.includes("buyerGstin"));
  assert.match(result.draft?.arithmeticProblems.join(" ") ?? "", /no government signature/);
});

test("#400: a verified signed e-invoice is drafted at full confidence; a forged signature is held", async () => {
  const { inbox } = setup();
  const signed = signedEinvoice({ number: "SRS/2026/0051" });
  const good = await inbox.receive({
    channel: "email", sender: { channel: "email", address: "accounts@shreeram.example" }, attachment: jsonAttachment("signed-ok"),
    head: bytes(signed.slice(0, 512)), jsonBody: signed, deliveredTo: "bills-sampoorna@invoices.example", idempotencyKey: "k1",
  });
  assert.equal(good.document.status, "draft_ready");
  assert.equal(good.draft?.signature, "verified");
  assert.deepEqual(good.draft?.fieldsNeedingReview, []);

  const forged = signedEinvoice({ number: "SRS/2026/0052", key: FORGER.privateKey });
  const bad = await inbox.receive({
    channel: "email", sender: { channel: "email", address: "attacker@evil.example" }, attachment: jsonAttachment("signed-bad"),
    head: bytes(forged.slice(0, 512)), jsonBody: forged, deliveredTo: "bills-sampoorna@invoices.example", idempotencyKey: "k2",
  });
  assert.equal(bad.document.quarantineReason, "SIGNATURE_INVALID");
  assert.equal(bad.draft, undefined);
});

test("#400: a genuinely signed invoice for one business, sent to another's address, is held there, not moved", async () => {
  const { inbox } = setup();
  const signed = signedEinvoice({ number: "SRS/2026/0053", buyer: BUYER_GSTIN });
  const result = await inbox.receive({
    channel: "whatsapp", sender: whatsapp(), attachment: jsonAttachment("signed-wrong-door"),
    head: bytes(signed.slice(0, 512)), jsonBody: signed, deliveredTo: "+91 98220 11122", idempotencyKey: "k1",
  });
  assert.equal(result.document.companyId, "company-b");
  assert.equal(result.document.quarantineReason, "COMPANY_MISMATCH");
  assert.equal(inbox.inbox(contextFor("company-a")).length, 0);
});

test("#400: an upload takes its company from the session, and a printed buyer of another business holds it", async () => {
  const { inbox } = setup();
  const json = einvoiceJson({ buyer: OTHER_BUYER_GSTIN, number: "SRS/2026/0060" });
  const result = await inbox.receive({
    channel: "manual_upload", sender: { channel: "manual_upload", address: "owner-company-a" }, attachment: jsonAttachment("upload-wrong-buyer"),
    head: bytes(json.slice(0, 512)), jsonBody: json, uploader: contextFor("company-a"), idempotencyKey: "k1",
  });
  assert.equal(result.document.companyId, "company-a");
  assert.equal(result.document.quarantineReason, "COMPANY_MISMATCH");
  assert.doesNotMatch(result.document.statusMessage ?? "", /Konkan/);
});

test("#400: another company cannot assign a document held in this company", async () => {
  const { inbox } = setup({ "s3://inbox/doc-1": [INVOICE_PAGE(OTHER_BUYER_GSTIN)] });
  const held = await inbox.receive({ channel: "whatsapp", sender: whatsapp(), attachment: attachment({ sha256: "held-a", storageKey: "s3://inbox/doc-1" }), head: PDF_HEAD, deliveredTo: "+91 98450 12345", idempotencyKey: "k1" });
  assert.equal(held.document.companyId, "company-a");
  assert.equal(held.document.quarantineReason, "COMPANY_MISMATCH");
  assert.throws(() => inbox.assignCompany(contextFor("company-b"), held.document.id, "the GST number is ours"), /another company/);
  assert.equal(inbox.document(contextFor("company-a"), held.document.id).companyId, "company-a");
  // Its own company may confirm it.
  const confirmed = inbox.assignCompany(contextFor("company-a"), held.document.id, "a branch we bought for");
  assert.equal(confirmed.companyId, "company-a");
  assert.match(confirmed.routing?.evidence ?? "", /owner-company-a/);
});

test("#400: a document on a shared address can be claimed only by a business that owns that address", async () => {
  const { inbox } = setup();
  const result = await inbox.receive({ channel: "email", sender: { channel: "email", address: "accounts@shreeram.example" }, attachment: attachment({ sha256: "shared-1", storageKey: "s3://inbox/doc-1" }), head: PDF_HEAD, deliveredTo: "shared-desk@invoices.example", idempotencyKey: "k1" });
  assert.equal(result.document.quarantineReason, "COMPANY_NOT_IDENTIFIED");
  assert.deepEqual(inbox.awaitingAssignment(contextFor("company-a")).map((item) => item.id), [result.document.id]);
  assert.deepEqual(inbox.awaitingAssignment(contextFor("company-x")), []);
  assert.throws(() => inbox.assignCompany(contextFor("company-x"), result.document.id, "mine"), /not found/);
  assert.throws(() => inbox.assignCompany(contextFor("company-a"), result.document.id, "   "), /say why/);

  const claimed = inbox.assignCompany(contextFor("company-a"), result.document.id, "our supplier");
  assert.equal(claimed.companyId, "company-a");
  // Once claimed, the other owner of the address cannot take it.
  assert.throws(() => inbox.assignCompany(contextFor("company-b"), result.document.id, "ours"), /another company/);
});

test("#400: assigning cannot clear a hold that was not about the company", async () => {
  const { inbox } = setup();
  const infected = await inbox.receive({ channel: "email", sender: { channel: "email", address: "a@b.example" }, attachment: attachment({ sha256: "bad-1" }), head: PDF_HEAD, scanVerdict: "infected", deliveredTo: "bills-sampoorna@invoices.example", idempotencyKey: "k1" });
  assert.equal(infected.document.quarantineReason, "MALWARE_SUSPECTED");
  // Screened out before routing, so it belongs to nobody and nobody can claim it.
  assert.throws(() => inbox.assignCompany(contextFor("company-a"), infected.document.id, "looks fine"), /not found/);

  const tampered = signedEinvoice({ number: "SRS/2026/0070", key: FORGER.privateKey });
  const held = await inbox.receive({ channel: "email", sender: { channel: "email", address: "a@b.example" }, attachment: jsonAttachment("tampered-1"), head: bytes(tampered.slice(0, 512)), jsonBody: tampered, deliveredTo: "bills-sampoorna@invoices.example", idempotencyKey: "k2" });
  assert.equal(held.document.companyId, "company-a");
  assert.equal(held.document.quarantineReason, "SIGNATURE_INVALID");
  assert.throws(() => inbox.assignCompany(contextFor("company-a"), held.document.id, "looks fine"), /cannot be cleared/);
});

test("#400: another company cannot retry this company's document", async () => {
  const { inbox, ocr } = setup({ "s3://inbox/doc-1": [INVOICE_PAGE()] });
  ocr.failNext(1);
  const failed = await inbox.receive({ channel: "email", sender: { channel: "email", address: "accounts@shreeram.example" }, attachment: attachment({ sha256: "retry-x", storageKey: "s3://inbox/doc-1" }), head: PDF_HEAD, deliveredTo: "bills-sampoorna@invoices.example", idempotencyKey: "k1" });
  assert.equal(failed.document.status, "failed");
  const calls = ocr.callCount;
  await assert.rejects(() => inbox.retry(contextFor("company-b"), failed.document.id), /another company/);
  assert.equal(ocr.callCount, calls);
  assert.equal(inbox.document(contextFor("company-a"), failed.document.id).status, "failed");
});

test("#400: a retry goes through the same company cross-check as the first read", async () => {
  const { inbox, ocr } = setup({ "s3://inbox/doc-1": [INVOICE_PAGE(OTHER_BUYER_GSTIN)] });
  ocr.failNext(1);
  const failed = await inbox.receive({ channel: "whatsapp", sender: whatsapp(), attachment: attachment({ sha256: "retry-y", storageKey: "s3://inbox/doc-1" }), head: PDF_HEAD, deliveredTo: "+91 98450 12345", idempotencyKey: "k1" });
  assert.equal(failed.document.status, "failed");
  const retried = await inbox.retry(contextFor("company-a"), failed.document.id);
  assert.equal(retried.document.quarantineReason, "COMPANY_MISMATCH");
  assert.equal(retried.draft, undefined);
});
