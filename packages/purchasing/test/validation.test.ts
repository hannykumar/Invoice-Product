import assert from "node:assert/strict";
import test from "node:test";
import { syntheticGstin } from "../../masters/src/index.ts";
import type { Party, PartyAddress } from "../../masters/src/types.ts";
import {
  DEFAULT_TOLERANCE,
  assessDuplicates,
  contentFingerprint,
  divideRoundHalfUp,
  fingerprintOfDraft,
  lineTaxableValue,
  recomputeTotals,
  rulesEngineTaxSplit,
  taxOn,
  validatePurchase,
  withinTolerance,
} from "../src/index.ts";
import type { ExistingPurchase, ExtractedLine, ExtractionDraft } from "../src/index.ts";

const SUPPLIER_GSTIN = syntheticGstin("27", "AAECS5678D");
const BUYER_GSTIN = syntheticGstin("29", "AAACB1234M");
const TODAY = "2026-08-29";

const field = <T,>(value: T, confidence = 1, text = String(value)) => ({
  value,
  confidence,
  evidence: { page: 1, text, box: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 } },
});

/** One line: 10 units at ₹100.00 = ₹1,000.00 taxable, 18% GST = ₹180.00. */
const line = (overrides: Partial<ExtractedLine> = {}): ExtractedLine => ({
  description: field("Sunflower oil 1L"),
  hsnSac: field("15121110"),
  quantity: field("10"),
  unit: field("PCS"),
  ratePaise: field(10_000n),
  taxableValuePaise: field(100_000n),
  gstRateBasisPoints: field(1800),
  ...overrides,
});

const draftOf = (overrides: Partial<ExtractionDraft> = {}): ExtractionDraft => ({
  id: "draft-1",
  companyId: "company-a",
  documentId: "doc-1",
  source: "einvoice_json",
  supplierGstin: field(SUPPLIER_GSTIN),
  supplierName: field("Shree Ram Supplies"),
  buyerGstin: field(BUYER_GSTIN),
  invoiceNumber: field("SRS/2026/0051"),
  invoiceDate: field("2026-07-22"),
  taxableValuePaise: field(100_000n),
  totalTaxPaise: field(18_000n),
  invoiceTotalPaise: field(118_000n),
  lines: [line()],
  fieldsNeedingReview: [],
  arithmeticProblems: [],
  createdAt: "2026-07-23T04:00:00.000Z",
  ...overrides,
});

const existingOf = (draft: ExtractionDraft, overrides: Partial<ExistingPurchase> = {}): ExistingPurchase => ({
  id: "purchase-1",
  companyId: "company-a",
  supplierGstin: SUPPLIER_GSTIN,
  invoiceNumber: "SRS/2026/0051",
  invoiceDate: "2026-07-22",
  invoiceTotalPaise: 118_000n,
  enteredOn: "2026-07-23",
  contentFingerprint: fingerprintOfDraft(draft),
  ...overrides,
});

const KNOWN_SUPPLIER: Party = {
  id: "party-1", companyId: "company-a", legalName: "Shree Ram Supplies", role: "supplier",
  gstRegistrationType: "regular", phones: [], emails: [], aliases: [], active: true,
};

const KNOWN_ADDRESS: PartyAddress = {
  id: "addr-1", companyId: "company-a", partyId: "party-1", label: "Head office", line1: "1 Market Road",
  city: "Pune", stateCode: "27", pincode: "411001", gstin: SUPPLIER_GSTIN, use: "both", isPrimary: true, active: true,
};

const validate = (draft: ExtractionDraft, extra: Partial<Parameters<typeof validatePurchase>[0]> = {}) =>
  validatePurchase({ draft, today: TODAY, supplier: KNOWN_SUPPLIER, supplierAddress: KNOWN_ADDRESS, ...extra });

// ---- arithmetic ---------------------------------------------------------------------

test("money arithmetic rounds half-up and never uses a float", () => {
  assert.equal(divideRoundHalfUp(5n, 2n), 3n);
  assert.equal(divideRoundHalfUp(-5n, 2n), -3n);
  assert.equal(divideRoundHalfUp(4n, 2n), 2n);
  assert.equal(lineTaxableValue(10_000_000n, 10_000n), 100_000n);
  assert.equal(taxOn(100_000n, 1800), 18_000n);
  // 2.5 units at ₹33.33 is ₹83.325, which must land on ₹83.33 not ₹83.32.
  assert.equal(lineTaxableValue(2_500_000n, 3_333n), 8_333n);
});

test("totals are recomputed from the lines rather than read off the document", () => {
  const totals = recomputeTotals([line(), line({ quantity: field("5"), taxableValuePaise: field(50_000n) })], DEFAULT_TOLERANCE);
  assert.equal(totals.taxableValuePaise, 150_000n);
  assert.equal(totals.totalTaxPaise, 27_000n);
  assert.equal(totals.invoiceTotalPaise, 177_000n);
  assert.deepEqual(totals.lineProblems, []);
  assert.ok(totals.complete);
});

test("a line whose quantity times rate contradicts its printed amount is reported", () => {
  const totals = recomputeTotals([line({ taxableValuePaise: field(999_999n) })], DEFAULT_TOLERANCE);
  assert.equal(totals.lineProblems.length, 1);
  assert.match(totals.lineProblems[0] ?? "", /quantity and rate work out to 100000 paise/);
  // The computed figure wins over the printed one.
  assert.equal(totals.taxableValuePaise, 100_000n);
});

test("rounding inside tolerance is not a finding", () => {
  assert.ok(withinTolerance(118_001n, 118_000n, DEFAULT_TOLERANCE.totalAbsolutePaise, 10));
  assert.ok(!withinTolerance(120_000n, 118_000n, DEFAULT_TOLERANCE.totalAbsolutePaise, 10));
  const verdict = validate(draftOf({ invoiceTotalPaise: field(118_050n) }));
  assert.equal(verdict.status, "POSTABLE");
  // A ₹0.50 rounding difference raises nothing that holds the bill up.
  assert.deepEqual(verdict.findings.filter((f) => f.severity !== "MINOR"), []);
  assert.ok(!verdict.findings.some((f) => f.code === "TOTAL_MISMATCH"));
});

// ---- the happy path -----------------------------------------------------------------

test("a clean bill from a known supplier is postable", () => {
  const verdict = validate(draftOf());
  assert.equal(verdict.status, "POSTABLE");
  assert.equal(verdict.duplicate.verdict, "NONE");
  assert.equal(verdict.recomputed.invoiceTotalPaise, 118_000n);
  assert.match(verdict.summary, /ready to be entered/);
});

test("the same inputs always produce the same verdict, so a retry is idempotent", () => {
  assert.equal(validate(draftOf()).fingerprint, validate(draftOf()).fingerprint);
});

// ---- material discrepancies cannot post ---------------------------------------------

test("a total that does not match the lines blocks posting", () => {
  const verdict = validate(draftOf({ invoiceTotalPaise: field(150_000n) }));
  assert.equal(verdict.status, "BLOCKED");
  const finding = verdict.findings.find((f) => f.code === "TOTAL_MISMATCH");
  assert.ok(finding);
  assert.equal(finding?.severity, "MATERIAL");
  assert.equal(finding?.documentSays, "150000");
  assert.equal(finding?.weCalculated, "118000");
  // The correction carries the evidence a reviewer needs to check the pixels.
  const correction = verdict.corrections.find((c) => c.clears === "TOTAL_MISMATCH");
  assert.equal(correction?.suggestedValue, "118000");
  assert.equal(correction?.evidence?.page, 1);
  assert.ok(correction?.evidence?.box);
});

test("a mistyped GST number blocks posting and is explained without jargon", () => {
  const verdict = validate(draftOf({ supplierGstin: field("27AAECS5678D1Z9") }));
  assert.equal(verdict.status, "BLOCKED");
  const finding = verdict.findings.find((f) => f.code === "SUPPLIER_GSTIN_INVALID");
  assert.equal(finding?.severity, "MATERIAL");
  assert.ok(!/checksum|validation failed/i.test(finding?.message ?? ""));
});

test("a bill dated in the future cannot post", () => {
  const verdict = validate(draftOf({ invoiceDate: field("2026-12-01") }));
  assert.equal(verdict.status, "BLOCKED");
  assert.ok(verdict.findings.some((f) => f.code === "INVOICE_DATE_IN_FUTURE"));
});

test("a missing bill number cannot post", () => {
  const draft = draftOf();
  const { invoiceNumber, ...withoutNumber } = draft;
  const verdict = validate(withoutNumber as ExtractionDraft);
  assert.equal(verdict.status, "BLOCKED");
  assert.ok(verdict.findings.some((f) => f.code === "INVOICE_NUMBER_MISSING"));
});

test("a GST number that does not match the supplier on file blocks and suggests the right one", () => {
  const other = syntheticGstin("27", "AAECX1111Z");
  const verdict = validate(draftOf({ supplierGstin: field(other) }));
  assert.equal(verdict.status, "BLOCKED");
  assert.equal(verdict.corrections.find((c) => c.clears === "SUPPLIER_GSTIN_MISMATCH")?.suggestedValue, SUPPLIER_GSTIN);
});

// ---- missing fields ------------------------------------------------------------------

test("a line with no GST rate needs review rather than a guessed rate", () => {
  const { gstRateBasisPoints, ...noRate } = line();
  const verdict = validate(draftOf({ lines: [noRate as ExtractedLine] }));
  assert.equal(verdict.status, "NEEDS_REVIEW");
  assert.ok(verdict.findings.some((f) => f.code === "GST_RATE_MISSING"));
  // Nothing invented a rate.
  assert.equal(verdict.recomputed.totalTaxPaise, 0n);
});

test("an invalid HSN code needs review", () => {
  const verdict = validate(draftOf({ lines: [line({ hsnSac: field("123") })] }));
  assert.ok(verdict.findings.some((f) => f.code === "HSN_INVALID"));
});

// ---- duplicates ----------------------------------------------------------------------

test("the same supplier, number, date and total submitted twice is a confirmed duplicate", () => {
  const draft = draftOf();
  const verdict = validate(draft, { existing: [existingOf(draft)] });
  assert.equal(verdict.duplicate.verdict, "CONFIRMED");
  assert.equal(verdict.status, "BLOCKED");
  const match = verdict.duplicate.matches[0];
  assert.equal(match?.confidence, 1);
  assert.deepEqual([...(match?.agreed ?? [])].sort(), ["invoiceDate", "invoiceNumber", "invoiceTotal", "supplierGstin"]);
  assert.ok(match?.matchedBy.includes("LOGICAL_KEY"));
  assert.match(verdict.duplicate.message, /already been entered/);
});

test("a retyped re-send with different punctuation is caught by the content fingerprint", () => {
  const original = draftOf();
  const retyped = draftOf({ invoiceNumber: field("SRS-2026-0051") });
  const verdict = validate(retyped, { existing: [existingOf(original, { invoiceNumber: "SRS/2026/0051" })] });
  assert.equal(verdict.duplicate.verdict, "CONFIRMED");
  assert.ok(verdict.duplicate.matches[0]?.matchedBy.includes("CONTENT_FINGERPRINT"));
});

test("an amended invoice is not treated as a duplicate", () => {
  const original = draftOf();
  const amended = draftOf({
    invoiceDate: field("2026-07-25"),
    taxableValuePaise: field(120_000n),
    totalTaxPaise: field(21_600n),
    invoiceTotalPaise: field(141_600n),
    lines: [line({ quantity: field("12"), taxableValuePaise: field(120_000n) })],
  });
  const verdict = validate(amended, { existing: [existingOf(original)] });
  assert.equal(verdict.duplicate.verdict, "AMENDMENT");
  // Legitimate, but a person confirms it — the earlier bill may already have been paid.
  assert.equal(verdict.status, "NEEDS_REVIEW");
  assert.ok(verdict.findings.some((f) => f.code === "INVOICE_AMENDMENT"));
  assert.match(verdict.duplicate.message, /corrected copy/);
});

test("a different bill from the same supplier is not a duplicate", () => {
  const original = draftOf();
  const other = draftOf({
    invoiceNumber: field("SRS/2026/0052"),
    invoiceDate: field("2026-08-02"),
    taxableValuePaise: field(250_000n),
    totalTaxPaise: field(45_000n),
    invoiceTotalPaise: field(295_000n),
    lines: [line({ quantity: field("25"), taxableValuePaise: field(250_000n) })],
  });
  const verdict = validate(other, { existing: [existingOf(original)] });
  assert.equal(verdict.duplicate.verdict, "NONE");
  assert.equal(verdict.status, "POSTABLE");
});

test("two different suppliers using the same bill number are not a duplicate", () => {
  const draft = draftOf();
  const elsewhere = existingOf(draft, {
    id: "purchase-9",
    supplierGstin: syntheticGstin("29", "AAECY2222K"),
    contentFingerprint: "unrelated",
  });
  const verdict = validate(draft, { existing: [elsewhere] });
  assert.notEqual(verdict.duplicate.verdict, "CONFIRMED");
  assert.notEqual(verdict.status, "BLOCKED");
});

test("another company's identical bill is never seen", () => {
  const draft = draftOf();
  const verdict = validate(draft, { existing: [existingOf(draft, { id: "purchase-x", companyId: "company-b" })] });
  assert.equal(verdict.duplicate.verdict, "NONE");
});

test("the content fingerprint ignores punctuation and line order but not amounts", () => {
  const a = contentFingerprint({ supplierGstin: SUPPLIER_GSTIN, invoiceNumber: "INV/1", invoiceDate: "2026-07-22", invoiceTotalPaise: 100n });
  const b = contentFingerprint({ supplierGstin: SUPPLIER_GSTIN, invoiceNumber: "inv-1", invoiceDate: "2026-07-22", invoiceTotalPaise: 100n });
  const c = contentFingerprint({ supplierGstin: SUPPLIER_GSTIN, invoiceNumber: "INV/1", invoiceDate: "2026-07-22", invoiceTotalPaise: 101n });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("a near-duplicate with a different total is surfaced but does not block", () => {
  const original = draftOf();
  const near = draftOf({ invoiceTotalPaise: field(118_500n), taxableValuePaise: field(100_400n), lines: [line({ quantity: field("10.04"), taxableValuePaise: field(100_400n) })] });
  const verdict = validate(near, { existing: [existingOf(original, { contentFingerprint: "different" })] });
  assert.ok(["LIKELY", "POSSIBLE", "AMENDMENT"].includes(verdict.duplicate.verdict));
  assert.notEqual(verdict.status, "BLOCKED");
});

// ---- the rules engine seam ------------------------------------------------------------

test("a production engine refuses to decide on draft rules, and tax falls back to self-consistency", () => {
  const verdict = validate(draftOf(), { taxSplit: rulesEngineTaxSplit({ mode: "production" }), buyerStateCode: "29" });
  assert.equal(verdict.taxCheck.basis, "SELF_CONSISTENCY_ONLY");
  assert.equal(verdict.status, "NEEDS_REVIEW");
  assert.ok(verdict.findings.some((f) => f.code === "TAX_SPLIT_UNDECIDED" || f.code === "PLACE_OF_SUPPLY_UNKNOWN"));
});

test("in development the engine answers, and an inter-state purchase is recognised", () => {
  const verdict = validate(draftOf(), { taxSplit: rulesEngineTaxSplit({ mode: "development" }), buyerStateCode: "29" });
  assert.equal(verdict.taxCheck.basis, "RULES_ENGINE");
  assert.equal(verdict.taxCheck.intraState, false); // supplier 27, buyer 29
  assert.equal(verdict.taxCheck.ruleId, "gst.tax_split");
  assert.equal(verdict.status, "POSTABLE");
});

test("no tax rate is ever invented when the engine cannot decide", () => {
  const verdict = validate(draftOf(), { taxSplit: rulesEngineTaxSplit({ mode: "production" }), buyerStateCode: "29" });
  assert.equal(verdict.taxCheck.intraState, undefined);
});

// ---- the issue's own example ----------------------------------------------------------

test("the issue's example: same GSTIN, number and date submitted twice is blocked", () => {
  const draft = draftOf();
  const first = validate(draft);
  assert.equal(first.status, "POSTABLE");
  const second = validate(draft, { existing: [existingOf(draft)] });
  assert.equal(second.status, "BLOCKED");
  assert.ok(second.findings.some((f) => f.code === "DUPLICATE_CONFIRMED" && f.severity === "MATERIAL"));
});

test("duplicate assessment always reports a fingerprint, even when nothing matched", () => {
  const assessment = assessDuplicates(draftOf(), []);
  assert.equal(assessment.verdict, "NONE");
  assert.match(assessment.fingerprint, /^[0-9a-f]{64}$/);
});
