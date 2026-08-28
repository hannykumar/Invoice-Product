// A runnable walkthrough of issue #15: `npm run demo:inbox`.
//
// Five documents arrive through four channels. Watch where each one ends up and why.
// Nothing here posts anything: the furthest any document travels is a reviewable draft.

import { AuditLog, PlatformCommandService } from "../../platform/src/index.ts";
import { syntheticGstin } from "../../masters/src/index.ts";
import { MockOcrAdapter, PurchaseInboxService, pageFromLines } from "./index.ts";
import { formatPaise } from "./money.ts";
import type { CompanyRoutingProfile } from "./routing.ts";

const OURS = syntheticGstin("29", "AAACB1234M");
const THEIRS = syntheticGstin("27", "AAACZ9999Q");
const SUPPLIER = syntheticGstin("27", "AAECS5678D");

const companies: readonly CompanyRoutingProfile[] = [
  { companyId: "sampoorna", legalName: "Sampoorna Traders", gstins: [OURS], emailAliases: ["bills-sampoorna@invoices.example"], whatsappNumbers: ["+91 98450 12345"] },
  { companyId: "konkan", legalName: "Konkan Metals", gstins: [THEIRS], emailAliases: ["bills-konkan@invoices.example"], whatsappNumbers: ["+91 98220 11122"] },
];

const invoicePage = (buyer: string, number: string, total: string) => pageFromLines(1, [
  "SHREE RAM STEELS PRIVATE LIMITED", "Plot 8, MIDC Bhosari, Pune 411001", `GSTIN: ${SUPPLIER}`,
  "TAX INVOICE", `Invoice No: ${number}`, "Invoice Date: 21/07/2026",
  `GSTIN: ${buyer}`, "TMT Steel Bar 12mm   HSN 72142090   500 KGS   64.00",
  "Taxable Value: 32,000.00", "IGST 18%: 5,760.00", `Grand Total: ${total}`,
]);

const pdfHead = new Uint8Array(Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n", "latin1"));
const line = (text = "") => console.log(text);

export async function runDemo(): Promise<void> {
  const audit = new AuditLog();
  const ocr = new MockOcrAdapter({
    "s3://a": [invoicePage(OURS, "SRS/2026/0042", "37,760.00")],
    "s3://b": [invoicePage(OURS, "SRS/2026/0042", "37,760.00")],
    "s3://c": [invoicePage(THEIRS, "SRS/2026/0099", "37,760.00")],
    "s3://d": [pageFromLines(1, [{ text: "TAX INVOICE", confidence: 0.3 }, { text: "Total 100.00", confidence: 0.22 }])],
  });
  const inbox = new PurchaseInboxService(new PlatformCommandService(audit, []), audit, ocr, companies);
  const attachment = (sha: string, key: string, fileName = "invoice.pdf", mime = "application/pdf") => ({ id: sha, fileName, declaredMimeType: mime, sizeBytes: 240_000, sha256: sha, storageKey: key });

  const show = (label: string, result: Awaited<ReturnType<typeof inbox.receive>>) => {
    line();
    line(`${label}`);
    line(`  status      : ${result.document.status}${result.document.quarantineReason ? ` (${result.document.quarantineReason})` : ""}`);
    line(`  company     : ${companies.find((company) => company.companyId === result.document.companyId)?.legalName ?? "not decided"}`);
    if (result.document.routing) line(`  routed by   : ${result.document.routing.basis} — ${result.document.routing.evidence}`);
    if (result.document.statusMessage) line(`  message     : ${result.document.statusMessage}`);
    if (result.draft) {
      line(`  invoice     : ${result.draft.invoiceNumber?.value ?? "?"} dated ${result.draft.invoiceDate?.value ?? "?"}`);
      line(`  total       : ${result.draft.invoiceTotalPaise ? formatPaise(result.draft.invoiceTotalPaise.value) : "?"} (taxable ${result.draft.taxableValuePaise ? formatPaise(result.draft.taxableValuePaise.value) : "?"} + tax ${result.draft.totalTaxPaise ? formatPaise(result.draft.totalTaxPaise.value) : "?"})`);
      line(`  evidence    : invoice number read from page ${result.draft.invoiceNumber?.evidence.page} — "${result.draft.invoiceNumber?.evidence.text}" (confidence ${result.draft.invoiceNumber?.confidence})`);
      line(`  needs review: ${result.draft.fieldsNeedingReview.length === 0 ? "nothing" : result.draft.fieldsNeedingReview.join(", ")}`);
      if (result.draft.arithmeticProblems.length > 0) line(`  arithmetic  : ${result.draft.arithmeticProblems.join(" ")}`);
    }
  };

  line("Purchase inbox — five documents, four channels. Nothing is posted anywhere.");

  show("1. A supplier's PDF on WhatsApp", await inbox.receive({
    channel: "whatsapp", sender: { channel: "whatsapp", address: "+919822011122", displayName: "Shree Ram Steels", providerMessageId: "wamid.1" },
    attachment: attachment("sha-a", "s3://a"), head: pdfHead, deliveredTo: "+91 98450 12345", idempotencyKey: "wamid.1",
  }));

  show("2. The same invoice emailed as well (same file)", await inbox.receive({
    channel: "email", sender: { channel: "email", address: "accounts@shreeram.example", providerMessageId: "mail.7" },
    attachment: attachment("sha-a", "s3://b"), head: pdfHead, deliveredTo: "bills-sampoorna@invoices.example", idempotencyKey: "mail.7",
  }));

  show("3. An invoice addressed to a different business", await inbox.receive({
    channel: "whatsapp", sender: { channel: "whatsapp", address: "+919822011122", providerMessageId: "wamid.2" },
    attachment: attachment("sha-c", "s3://c"), head: pdfHead, deliveredTo: "+91 98450 12345", idempotencyKey: "wamid.2",
  }));

  show("4. A blurred photo of a bill", await inbox.receive({
    channel: "camera", sender: { channel: "camera", address: "owner@sampoorna.example", providerMessageId: "cam.1" },
    attachment: attachment("sha-d", "s3://d", "photo.jpg", "image/jpeg"), head: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), explicitCompanyId: "sampoorna", idempotencyKey: "cam.1",
  }));

  const eInvoice = JSON.stringify({
    DocDtls: { Typ: "INV", No: "SRS/2026/0051", Dt: "22/07/2026" },
    SellerDtls: { Gstin: SUPPLIER, LglNm: "Shree Ram Steels Private Limited" },
    BuyerDtls: { Gstin: OURS, LglNm: "Sampoorna Traders" },
    ItemList: [{ SlNo: "1", PrdDesc: "OPC Cement 53 Grade", HsnCd: "25232930", Qty: 100, Unit: "BAG", UnitPrice: 380, AssAmt: 38000, GstRt: 28 }],
    ValDtls: { AssVal: 38000, IgstVal: 10640, TotInvVal: 48640 },
  });
  show("5. A signed e-invoice JSON, delivered to the wrong number", await inbox.receive({
    channel: "whatsapp", sender: { channel: "whatsapp", address: "+919822011122", providerMessageId: "wamid.3" },
    attachment: attachment("sha-e", "s3://e", "einvoice.json", "application/json"),
    head: new Uint8Array(Buffer.from(eInvoice.slice(0, 512), "latin1")), jsonBody: eInvoice, deliveredTo: "+91 98220 11122", idempotencyKey: "wamid.3",
  }));

  line();
  line(`Audit: ${audit.forCompany({ companyId: "sampoorna" } as never).length} events for Sampoorna Traders, ${audit.forCompany({ companyId: "konkan" } as never).length} for Konkan Metals.`);
  line();
}

if (process.argv[1]?.endsWith("demo.ts")) await runDemo();
