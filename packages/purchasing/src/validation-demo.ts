// A runnable walkthrough of issue #16: `npm run demo:validate`.
//
// Six supplier bills arrive at Sampoorna Traders, already read by #15. Watch which ones are
// allowed through, which need a person, and which are stopped outright — and why in each case.
// Nothing here posts anything either; #17 does that, and only for a bill marked POSTABLE.

import { syntheticGstin } from "../../masters/src/index.ts";
import type { Party, PartyAddress } from "../../masters/src/types.ts";
import { formatPaise } from "./money.ts";
import { fingerprintOfDraft, rulesEngineTaxSplit, validatePurchase } from "./index.ts";
import type { ExistingPurchase, ExtractedLine, ExtractionDraft } from "./index.ts";

const SUPPLIER = syntheticGstin("27", "AAECS5678D");
const TODAY = "2026-08-29";

const field = <T,>(value: T, confidence = 1, text = String(value)) => ({
  value, confidence, evidence: { page: 1, text, box: { x: 0.62, y: 0.81, width: 0.2, height: 0.03 } },
});

const supplier: Party = {
  id: "party-shree-ram", companyId: "sampoorna", legalName: "Shree Ram Steels Private Limited",
  role: "supplier", gstRegistrationType: "regular", phones: [], emails: [], aliases: ["Shree Ram Steels"], active: true,
};

const address: PartyAddress = {
  id: "addr-1", companyId: "sampoorna", partyId: "party-shree-ram", label: "Works", line1: "Plot 8, MIDC Bhosari",
  city: "Pune", stateCode: "27", pincode: "411001", gstin: SUPPLIER, use: "both", isPrimary: true, active: true,
};

/** 500 kg of TMT bar at ₹64.00 = ₹32,000.00 taxable, 18% IGST = ₹5,760.00. */
const steelLine = (overrides: Partial<ExtractedLine> = {}): ExtractedLine => ({
  description: field("TMT Steel Bar 12mm"),
  hsnSac: field("72142090"),
  quantity: field("500"),
  unit: field("KGS"),
  ratePaise: field(6_400n),
  taxableValuePaise: field(3_200_000n),
  gstRateBasisPoints: field(1800),
  ...overrides,
});

const bill = (id: string, overrides: Partial<ExtractionDraft> = {}): ExtractionDraft => ({
  id, companyId: "sampoorna", documentId: `doc-${id}`, source: "ocr",
  supplierGstin: field(SUPPLIER),
  supplierName: field("Shree Ram Steels Private Limited"),
  invoiceNumber: field("SRS/2026/0051"),
  invoiceDate: field("2026-07-21"),
  taxableValuePaise: field(3_200_000n),
  totalTaxPaise: field(576_000n),
  invoiceTotalPaise: field(3_776_000n),
  lines: [steelLine()],
  fieldsNeedingReview: [],
  arithmeticProblems: [],
  createdAt: "2026-07-22T04:00:00.000Z",
  ...overrides,
});

const onRecord = (draft: ExtractionDraft): ExistingPurchase => ({
  id: "purchase-0051", companyId: "sampoorna", supplierGstin: SUPPLIER,
  invoiceNumber: "SRS/2026/0051", invoiceDate: "2026-07-21", invoiceTotalPaise: 3_776_000n,
  enteredOn: "2026-07-22", contentFingerprint: fingerprintOfDraft(draft),
});

const log = (text = "") => console.log(text);
const heading = (text: string) => { log(); log(text); log("-".repeat(text.length)); };

const show = (label: string, draft: ExtractionDraft, existing: readonly ExistingPurchase[] = []) => {
  const verdict = validatePurchase({
    draft, supplier, supplierAddress: address, buyerStateCode: "29",
    existing, today: TODAY, taxSplit: rulesEngineTaxSplit({ mode: "development" }),
  });
  log();
  log(`${label}`);
  log(`  status      : ${verdict.status}`);
  log(`  summary     : ${verdict.summary}`);
  log(`  we worked out: ${formatPaise(verdict.recomputed.invoiceTotalPaise)} (bill says ${formatPaise(draft.invoiceTotalPaise?.value ?? 0n)})`);
  log(`  duplicate   : ${verdict.duplicate.verdict}`);
  for (const finding of verdict.findings) {
    log(`  ${finding.severity.padEnd(11)} ${finding.message}`);
  }
  for (const correction of verdict.corrections) {
    log(`  suggested   : set ${correction.field} to ${correction.suggestedValue} — ${correction.reason}`);
    if (correction.evidence) log(`                read from page ${correction.evidence.page}, "${correction.evidence.text}"`);
  }
};

heading("Issue #16 — checking supplier bills before they can touch the books");
log("Sampoorna Traders (Karnataka, state 29) buying from Shree Ram Steels (Maharashtra, state 27).");
log("Nothing below is posted. A bill only reaches #17 if it comes back POSTABLE.");

heading("1. An ordinary bill that adds up");
show("SRS/2026/0051 — 500 kg TMT bar", bill("draft-1"));

heading("2. The same bill sent again a week later");
const original = bill("draft-1");
show("SRS/2026/0051 again", bill("draft-2"), [onRecord(original)]);

heading("3. A corrected copy of that bill, for 600 kg");
show("SRS/2026/0051 revised", bill("draft-3", {
  invoiceDate: field("2026-07-25"),
  taxableValuePaise: field(3_840_000n),
  totalTaxPaise: field(691_200n),
  invoiceTotalPaise: field(4_531_200n),
  lines: [steelLine({ quantity: field("600"), taxableValuePaise: field(3_840_000n) })],
}), [onRecord(original)]);

heading("4. A bill whose total does not match its own lines");
show("SRS/2026/0060", bill("draft-4", { invoiceNumber: field("SRS/2026/0060"), invoiceTotalPaise: field(4_000_000n) }));

heading("5. A bill with a mistyped GST number");
show("SRS/2026/0061", bill("draft-5", { invoiceNumber: field("SRS/2026/0061"), supplierGstin: field("27AAECS5678D1Z9") }));

heading("6. A bill where the tax rate could not be read");
const { gstRateBasisPoints, ...noRate } = steelLine();
show("SRS/2026/0062", bill("draft-6", {
  invoiceNumber: field("SRS/2026/0062"),
  lines: [noRate as ExtractedLine],
  totalTaxPaise: field(576_000n),
}));

log();
log("Nothing above was posted. Bills 2, 4 and 5 cannot be, until the document or the record changes.");
