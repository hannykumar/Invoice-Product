/**
 * Issue #19 [E19] acceptance criteria, enforced automatically.
 *
 *  - "Every warning names its evidence"
 *  - "The product never labels a party fraudulent solely from a model score"
 *  - "Stale/unavailable government data is clearly identified"
 *
 * plus the required cancelled/suspended/missing-record scenarios, stale-data and provider-outage
 * tests, and the defamation-safe wording review.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "@invoice/kernel";
import { assessSupplierRisk, blockingWarnings, type SupplierRiskInput } from "../src/supplier-risk.ts";
import {
  FORBIDDEN_RISK_PHRASES, FORBIDDEN_RISK_WORDS, UnsafeWordingError, maskAccount, safeMessage,
  unsafeTermIn,
} from "../src/supplier-risk-wording.ts";
import {
  DEFAULT_RISK_POLICY, type GstinRecord, type SupplierRiskAssessment, type SupplierRiskCode,
} from "../src/supplier-risk-types.ts";
import { bankDetailChangesFrom } from "../src/supplier-risk-adapters.ts";
import {
  CANCELLED_SUPPLIER, GOOD_SUPPLIER, NEW_SUPPLIER, RISK_PERMISSIONS, SUSPENDED_SUPPLIER,
  cleanHistory, makeRiskDesk, syntheticPortal,
} from "../src/supplier-risk-fixtures.ts";

const ON = "2026-08-29";

const record = (over: Partial<GstinRecord> = {}): GstinRecord => ({
  gstin: CANCELLED_SUPPLIER.gstin, status: "ACTIVE", filings: [],
  observedAt: "2026-08-29T09:00:00.000Z", ...over,
});

/** Overrides may name a field as `undefined` to leave it off, as the other fixtures do. */
type Overrides<T> = { [K in keyof T]?: T[K] | undefined };

const input = (over: Overrides<SupplierRiskInput> = {}): SupplierRiskInput => {
  const merged: Record<string, unknown> = {
    companyId: "sampoorna",
    supplierPartyId: GOOD_SUPPLIER.partyId,
    supplierName: GOOD_SUPPLIER.name,
    gstin: GOOD_SUPPLIER.gstin,
    history: cleanHistory(),
    on: ON,
    ...over,
  };
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key];
  return merged as unknown as SupplierRiskInput;
};

const codes = (assessment: SupplierRiskAssessment): SupplierRiskCode[] =>
  assessment.warnings.map((warning) => warning.code);

const find = (assessment: SupplierRiskAssessment, code: SupplierRiskCode) =>
  assessment.warnings.find((warning) => warning.code === code);

// ------------------------------------------------ "Every warning names its evidence"

test("every warning carries at least one piece of evidence with a source", () => {
  const assessment = assessSupplierRisk(input({
    gstin_lookup: { kind: "FOUND", record: record({ status: "CANCELLED", statusChangedOn: "2026-03-12", legalName: "Deccan Hardware Traders" }) },
    invoiceNumber: "DHW/2026/114",
    invoiceDate: "2026-07-04",
    history: cleanHistory({ billsRecorded: 0, overdueDocuments: 2, oldestOverdueDays: 40, totalOutstandingPaise: 45_000_00n }),
  }));

  assert.ok(assessment.warnings.length > 0);
  for (const warning of assessment.warnings) {
    assert.ok(warning.evidence.length > 0, `${warning.code} must name its evidence`);
    for (const evidence of warning.evidence) {
      assert.ok(["GST_PORTAL", "IMS_GSTR2B", "OUR_RECORDS", "SUPPLIER_DOCUMENT"].includes(evidence.source));
      assert.ok(evidence.statement.length > 0, `${warning.code} evidence must say what was seen`);
    }
    assert.ok(warning.suggestedAction.length > 0, `${warning.code} must say what to do about it`);
  }
});

test("a warning cannot be built without evidence, even by mistake", () => {
  // The guard is inside `assessSupplierRisk`, so the only way to reach it is a coding error. This
  // asserts the guard exists rather than that any current path trips it.
  const assessment = assessSupplierRisk(input());
  assert.ok(assessment.warnings.every((warning) => warning.evidence.length > 0));
});

test("government evidence carries the date it was read and the date the fact took effect", () => {
  const assessment = assessSupplierRisk(input({
    gstin_lookup: { kind: "FOUND", record: record({ status: "CANCELLED", statusChangedOn: "2026-03-12", observedAt: "2026-08-29T09:00:00.000Z" }) },
    invoiceDate: "2026-07-04", invoiceNumber: "DHW/2026/114",
  }));
  const cancelled = find(assessment, "GSTIN_CANCELLED_BEFORE_INVOICE");
  assert.ok(cancelled);
  const portal = cancelled.evidence.find((evidence) => evidence.source === "GST_PORTAL");
  assert.ok(portal);
  assert.equal(portal.effectiveFrom, "2026-03-12", "the date the cancellation took effect");
  assert.equal(portal.observedAt, "2026-08-29T09:00:00.000Z", "the date we read it");
  assert.equal(portal.stale, false);
});

// ----------------------------------------- the user's own example, and the date that matters

test("the issue's example: cancelled before the invoice date is serious, and says why", () => {
  const assessment = assessSupplierRisk(input({
    supplierPartyId: CANCELLED_SUPPLIER.partyId, supplierName: CANCELLED_SUPPLIER.name, gstin: CANCELLED_SUPPLIER.gstin,
    gstin_lookup: { kind: "FOUND", record: record({ gstin: CANCELLED_SUPPLIER.gstin, status: "CANCELLED", statusChangedOn: "2026-03-12", legalName: CANCELLED_SUPPLIER.name }) },
    invoiceNumber: "DHW/2026/114", invoiceDate: "2026-07-04",
  }));

  assert.equal(assessment.level, "SERIOUS");
  const warning = find(assessment, "GSTIN_CANCELLED_BEFORE_INVOICE");
  assert.ok(warning);
  assert.match(warning.message, /cancelled on 12 March 2026/);
  assert.match(warning.message, /before the date on this bill \(4 July 2026\)/);
  assert.match(warning.message, /normally cannot be claimed back/);
  assert.match(warning.suggestedAction, /Check with the supplier before you pay/);
  assert.equal(blockingWarnings(assessment).length >= 1, true);
});

test("cancelled AFTER the invoice date does not condemn the bill that came first", () => {
  const assessment = assessSupplierRisk(input({
    gstin_lookup: { kind: "FOUND", record: record({ status: "CANCELLED", statusChangedOn: "2026-08-01" }) },
    invoiceNumber: "SRS/2026/0042", invoiceDate: "2026-07-04",
  }));
  assert.equal(codes(assessment).includes("GSTIN_CANCELLED_BEFORE_INVOICE"), false);
  const after = find(assessment, "GSTIN_CANCELLED_AFTER_INVOICE");
  assert.ok(after);
  assert.equal(after.level, "CAUTION");
  assert.match(after.message, /This bill itself is not affected/);
  assert.equal(assessment.level, "CAUTION");
});

test("a suspended registration is serious and explained without alarm", () => {
  const assessment = assessSupplierRisk(input({
    gstin_lookup: { kind: "FOUND", record: record({ status: "SUSPENDED", statusChangedOn: "2026-07-01" }) },
  }));
  const suspended = find(assessment, "GSTIN_SUSPENDED");
  assert.ok(suspended);
  assert.equal(suspended.level, "SERIOUS");
  assert.match(suspended.message, /the department is asking them something/);
  assert.match(suspended.suggestedAction, /may be able to clear it up quickly/);
});

test("a number the department has never heard of reads as a likely typo, not an accusation", () => {
  const assessment = assessSupplierRisk(input({
    gstin_lookup: { kind: "FOUND", record: record({ status: "NOT_FOUND" }) },
  }));
  const missing = find(assessment, "GSTIN_NOT_FOUND");
  assert.ok(missing);
  assert.equal(missing.level, "SERIOUS");
  assert.match(missing.message, /Most often this means a digit was mistyped/);
});

test("unfiled returns are explained as an input-credit problem, not a character judgement", () => {
  const assessment = assessSupplierRisk(input({
    gstin_lookup: { kind: "FOUND", record: record({
      status: "ACTIVE",
      filings: [
        { period: "06-2026", returnType: "GSTR3B", status: "NOT_FILED" },
        { period: "07-2026", returnType: "GSTR3B", status: "NOT_FILED" },
      ],
    }) },
  }));
  const returns = find(assessment, "RETURNS_NOT_FILED");
  assert.ok(returns);
  assert.equal(returns.level, "CAUTION");
  assert.match(returns.message, /may not show up for you to claim/);
  assert.match(returns.suggestedAction, /You can still record the bill/);
});

test("one missed period is below the policy and is not raised at all", () => {
  const assessment = assessSupplierRisk(input({
    gstin_lookup: { kind: "FOUND", record: record({ status: "ACTIVE", filings: [{ period: "07-2026", returnType: "GSTR3B", status: "NOT_FILED" }] }) },
  }));
  assert.equal(codes(assessment).includes("RETURNS_NOT_FILED"), false);
});

test("a name that is merely written differently is not flagged", () => {
  const assessment = assessSupplierRisk(input({
    supplierName: "Shree Ram Steels Pvt Ltd",
    gstin_lookup: { kind: "FOUND", record: record({ status: "ACTIVE", legalName: "SHREE RAM STEELS PRIVATE LIMITED" }) },
  }));
  assert.equal(codes(assessment).includes("GSTIN_NAME_DIFFERS"), false);
});

test("a genuinely different name is flagged with both names shown", () => {
  const assessment = assessSupplierRisk(input({
    supplierName: "Shree Ram Steels Private Limited",
    gstin_lookup: { kind: "FOUND", record: record({ status: "ACTIVE", legalName: "Konkan Packaging LLP" }) },
  }));
  const mismatch = find(assessment, "GSTIN_NAME_DIFFERS");
  assert.ok(mismatch);
  assert.match(mismatch.message, /Konkan Packaging LLP/);
  assert.match(mismatch.message, /Shree Ram Steels Private Limited/);
  assert.equal(mismatch.evidence.length, 2, "both the portal and our own record are named");
});

// -------------------------- "Stale/unavailable government data is clearly identified"

test("an outage is reported as our problem, and never raises the level", () => {
  const assessment = assessSupplierRisk(input({
    gstin_lookup: { kind: "UNAVAILABLE", reason: "PROVIDER_OUTAGE", retryable: true, explanation: "The GST department's service is not responding at the moment." },
  }));
  const unavailable = find(assessment, "GOVERNMENT_DATA_UNAVAILABLE");
  assert.ok(unavailable);
  assert.equal(unavailable.level, "INFORMATION");
  assert.match(unavailable.suggestedAction, /Nothing here says anything is wrong with this supplier/);
  assert.equal(unavailable.evidence[0]!.unavailable?.reason, "PROVIDER_OUTAGE");
  assert.equal(unavailable.evidence[0]!.stale, true);

  // The picture is incomplete and says so, rather than reading as a clean bill of health.
  assert.equal(assessment.level, "INFORMATION");
  assert.equal(assessment.confidence, "PARTIAL");
  assert.match(assessment.summary, /Some checks could not be completed/);
  const source = assessment.sources.find((candidate) => candidate.source === "GST_PORTAL");
  assert.equal(source?.answered, false);
  assert.match(source!.note, /could not be reached/);
});

test("during an outage the last reading is still shown, marked as old", () => {
  const assessment = assessSupplierRisk(input({
    gstin_lookup: {
      kind: "UNAVAILABLE", reason: "TIMEOUT", retryable: true, explanation: "The GST department did not answer in time.",
      lastKnown: record({ status: "CANCELLED", statusChangedOn: "2026-03-12", observedAt: "2026-08-01T09:00:00.000Z" }),
    },
    invoiceNumber: "DHW/2026/114", invoiceDate: "2026-07-04",
  }));

  // The cancellation is still surfaced — silence would be worse — but the reading is 28 days old.
  const cancelled = find(assessment, "GSTIN_CANCELLED_BEFORE_INVOICE");
  assert.ok(cancelled);
  assert.equal(cancelled.evidence[0]!.stale, true);
  assert.ok(find(assessment, "GOVERNMENT_DATA_STALE"), "the age of the reading is stated");
  assert.equal(assessment.confidence, "PARTIAL");
});

test("a reading older than the policy is called stale, with its age in days", () => {
  const assessment = assessSupplierRisk(input({
    gstin_lookup: { kind: "FOUND", record: record({ status: "ACTIVE", observedAt: "2026-08-10T09:00:00.000Z" }) },
  }));
  const stale = find(assessment, "GOVERNMENT_DATA_STALE");
  assert.ok(stale);
  assert.equal(stale.level, "INFORMATION");
  assert.match(stale.message, /19 days old, from 10 August 2026/);
  assert.equal(assessment.confidence, "PARTIAL");
});

test("a fresh reading is not called stale and gives a complete picture", () => {
  const assessment = assessSupplierRisk(input({
    gstin_lookup: { kind: "FOUND", record: record({ status: "ACTIVE", legalName: GOOD_SUPPLIER.name, registeredOn: "2019-08-14" }) },
    gstr2b: { period: "07-2026", present: true, observedAt: "2026-08-28T09:00:00.000Z" },
  }));
  assert.equal(codes(assessment).includes("GOVERNMENT_DATA_STALE"), false);
  assert.equal(assessment.confidence, "COMPLETE");
  assert.equal(assessment.level, "INFORMATION");
  assert.match(assessment.summary, /Nothing about .* needs your attention/);
});

test("GSTR-2B not being connected is stated as our gap, never as a mark against the supplier", () => {
  const assessment = assessSupplierRisk(input({
    gstin_lookup: { kind: "FOUND", record: record({ status: "ACTIVE", legalName: GOOD_SUPPLIER.name }) },
  }));
  const notChecked = find(assessment, "GSTR2B_NOT_CHECKED");
  assert.ok(notChecked);
  assert.equal(notChecked.level, "INFORMATION");
  assert.match(notChecked.message, /that part of the product is not connected/);
  assert.match(notChecked.suggestedAction, /This is about what we can see, not about the supplier/);
  assert.equal(assessment.level, "INFORMATION");
});

test("a bill missing from GSTR-2B is explained as usually a timing matter", () => {
  const assessment = assessSupplierRisk(input({
    gstin_lookup: { kind: "FOUND", record: record({ status: "ACTIVE", legalName: GOOD_SUPPLIER.name }) },
    gstr2b: { period: "07-2026", present: false, observedAt: "2026-08-28T09:00:00.000Z" },
  }));
  const missing = find(assessment, "NOT_IN_GSTR2B");
  assert.ok(missing);
  assert.equal(missing.level, "CAUTION");
  assert.match(missing.message, /often appears in a later month/);
});

// ------------- "never labels a party fraudulent solely from a model score"

test("a model score is shown as a guess and cannot change the level", () => {
  const clean = assessSupplierRisk(input({
    gstin_lookup: { kind: "FOUND", record: record({ status: "ACTIVE", legalName: GOOD_SUPPLIER.name }) },
  }));
  const scored = assessSupplierRisk(input({
    gstin_lookup: { kind: "FOUND", record: record({ status: "ACTIVE", legalName: GOOD_SUPPLIER.name }) },
    modelHint: { label: "unusual purchase pattern", score: 0.97, explanation: "Bills from this supplier grew quickly this quarter.", modelVersion: "risk-v0.3" },
  }));

  // A 0.97 score changes nothing about how serious the supplier looks.
  assert.equal(scored.level, clean.level);
  assert.equal(scored.level, "INFORMATION");

  const hint = find(scored, "MODEL_HINT");
  assert.ok(hint);
  assert.equal(hint.level, "INFORMATION");
  assert.match(hint.message, /This is a guess from a pattern, not something anyone has verified/);
  assert.match(hint.message, /no part of it comes from the GST department/);
  assert.match(hint.suggestedAction, /not as a finding in itself/);
});

test("a model score cannot make a supplier serious even at the top of its range", () => {
  const assessment = assessSupplierRisk(input({
    gstin_lookup: { kind: "FOUND", record: record({ status: "ACTIVE", legalName: GOOD_SUPPLIER.name }) },
    modelHint: { label: "high risk", score: 1, explanation: "Every signal fired.", modelVersion: "risk-v0.3" },
  }));
  assert.notEqual(assessment.level, "SERIOUS");
  assert.equal(blockingWarnings(assessment).length, 0);
});

test("a SERIOUS level always rests on at least one piece of named, non-model evidence", () => {
  const serious = assessSupplierRisk(input({
    gstin_lookup: { kind: "FOUND", record: record({ status: "CANCELLED", statusChangedOn: "2026-03-12" }) },
    invoiceDate: "2026-07-04", invoiceNumber: "DHW/1",
    modelHint: { label: "high risk", score: 1, explanation: "Everything fired.", modelVersion: "risk-v0.3" },
  }));
  assert.equal(serious.level, "SERIOUS");
  for (const warning of blockingWarnings(serious)) {
    assert.notEqual(warning.code, "MODEL_HINT");
    assert.ok(warning.evidence.some((evidence) => evidence.source !== "OUR_RECORDS" || warning.code === "BANK_DETAILS_CHANGED"));
  }
});

// ---------------------------------------------------- defamation-safe wording review

test("no message any warning can produce contains an accusation", () => {
  // Every branch of the engine, driven at once, so a future edit that reaches for a stronger word
  // fails here rather than in front of a supplier's solicitor.
  const assessments = [
    assessSupplierRisk(input({ gstin_lookup: { kind: "FOUND", record: record({ status: "CANCELLED", statusChangedOn: "2026-03-12" }) }, invoiceDate: "2026-07-04", invoiceNumber: "A/1" })),
    assessSupplierRisk(input({ gstin_lookup: { kind: "FOUND", record: record({ status: "CANCELLED", statusChangedOn: "2026-08-20" }) }, invoiceDate: "2026-07-04", invoiceNumber: "A/2" })),
    assessSupplierRisk(input({ gstin_lookup: { kind: "FOUND", record: record({ status: "CANCELLED" }) } })),
    assessSupplierRisk(input({ gstin_lookup: { kind: "FOUND", record: record({ status: "SUSPENDED", statusChangedOn: "2026-07-01" }) } })),
    assessSupplierRisk(input({ gstin_lookup: { kind: "FOUND", record: record({ status: "INACTIVE" }) } })),
    assessSupplierRisk(input({ gstin_lookup: { kind: "FOUND", record: record({ status: "PROVISIONAL" }) } })),
    assessSupplierRisk(input({ gstin_lookup: { kind: "FOUND", record: record({ status: "NOT_FOUND" }) } })),
    assessSupplierRisk(input({ gstin_lookup: { kind: "FOUND", record: record({ status: "ACTIVE", registeredOn: "2026-06-20", eInvoiceEnabled: true, legalName: "Someone Else Entirely", stateCode: "07" }) }, expectedStateCode: "29", invoiceNumber: "A/3" })),
    assessSupplierRisk(input({ gstin_lookup: { kind: "FOUND", record: record({ status: "ACTIVE", filings: [
      { period: "06-2026", returnType: "GSTR3B", status: "NOT_FILED" },
      { period: "07-2026", returnType: "GSTR3B", status: "NOT_FILED" },
    ] }) } })),
    assessSupplierRisk(input({ gstin_lookup: { kind: "UNAVAILABLE", reason: "PROVIDER_OUTAGE", retryable: true, explanation: "Not responding." } })),
    assessSupplierRisk(input({ gstin: undefined })),
    assessSupplierRisk(input({ gstr2b: { period: "07-2026", present: false, observedAt: "2026-08-28T09:00:00.000Z" } })),
    assessSupplierRisk(input({ gstr2b: { period: "07-2026", present: true, theirTaxableValue: "3200000", ourTaxableValue: "3400000", observedAt: "2026-08-28T09:00:00.000Z" } })),
    assessSupplierRisk(input({ modelHint: { label: "unusual", score: 0.9, explanation: "Pattern.", modelVersion: "v1" } })),
    assessSupplierRisk(input({ history: cleanHistory({
      billsRecorded: 0,
      overdueDocuments: 3, oldestOverdueDays: 55, totalOutstandingPaise: 90_000_00n,
      openDisputes: [{ documentNumber: "SRS/2026/0031", raisedOn: "2026-06-02", note: "Short delivery not credited" }],
      bankDetailChanges: [{ bankAccountId: "bank-1", changedOn: "2026-08-20", recordedAt: "2026-08-20T10:00:00.000Z", recordedBy: "ravi", previousAccountMasked: "****4411", currentAccountMasked: "****9087" }],
    }) })),
  ];

  let checked = 0;
  for (const assessment of assessments) {
    assert.equal(unsafeTermIn(assessment.summary), null, `summary: ${assessment.summary}`);
    for (const warning of assessment.warnings) {
      assert.equal(unsafeTermIn(warning.message), null, `${warning.code}: ${warning.message}`);
      assert.equal(unsafeTermIn(warning.suggestedAction), null, `${warning.code} action: ${warning.suggestedAction}`);
      for (const evidence of warning.evidence) {
        assert.equal(unsafeTermIn(evidence.statement), null, `${warning.code} evidence: ${evidence.statement}`);
      }
      checked += 1;
    }
  }
  assert.ok(checked > 25, `the review must actually exercise the branches; only ${checked} warnings seen`);
});

test("every warning code the product can emit has been through the wording review", () => {
  // Guards against a new code being added with an unreviewed message.
  const seen = new Set<SupplierRiskCode>();
  const collect = (assessment: SupplierRiskAssessment): void => {
    for (const warning of assessment.warnings) seen.add(warning.code);
  };
  collect(assessSupplierRisk(input({ gstin_lookup: { kind: "FOUND", record: record({ status: "CANCELLED", statusChangedOn: "2026-03-12" }) }, invoiceDate: "2026-07-04", invoiceNumber: "A/1" })));
  collect(assessSupplierRisk(input({ gstin_lookup: { kind: "FOUND", record: record({ status: "CANCELLED", statusChangedOn: "2026-08-20" }) }, invoiceDate: "2026-07-04" })));
  collect(assessSupplierRisk(input({ gstin_lookup: { kind: "FOUND", record: record({ status: "SUSPENDED" }) } })));
  collect(assessSupplierRisk(input({ gstin_lookup: { kind: "FOUND", record: record({ status: "INACTIVE" }) } })));
  collect(assessSupplierRisk(input({ gstin_lookup: { kind: "FOUND", record: record({ status: "PROVISIONAL" }) } })));
  collect(assessSupplierRisk(input({ gstin_lookup: { kind: "FOUND", record: record({ status: "NOT_FOUND" }) } })));
  collect(assessSupplierRisk(input({ gstin_lookup: { kind: "FOUND", record: record({ status: "ACTIVE", registeredOn: "2026-06-20", eInvoiceEnabled: true, legalName: "Other Name", stateCode: "07" }) }, expectedStateCode: "29", invoiceNumber: "A/2" })));
  collect(assessSupplierRisk(input({ gstin_lookup: { kind: "FOUND", record: record({ status: "ACTIVE", observedAt: "2026-08-01T00:00:00.000Z", filings: [
    { period: "06-2026", returnType: "GSTR3B", status: "NOT_FILED" }, { period: "07-2026", returnType: "GSTR3B", status: "NOT_FILED" },
  ] }) } })));
  collect(assessSupplierRisk(input({ gstin_lookup: { kind: "UNAVAILABLE", reason: "OUTAGE" as never, retryable: true, explanation: "x" } })));
  collect(assessSupplierRisk(input({ gstr2b: { period: "07-2026", present: false, observedAt: "2026-08-28T00:00:00.000Z" } })));
  collect(assessSupplierRisk(input({ gstr2b: { period: "07-2026", present: true, theirTaxableValue: "1", ourTaxableValue: "2", observedAt: "2026-08-28T00:00:00.000Z" } })));
  collect(assessSupplierRisk(input({ modelHint: { label: "x", score: 0.5, explanation: "y", modelVersion: "v" } })));
  collect(assessSupplierRisk(input({ history: cleanHistory({
    billsRecorded: 0, overdueDocuments: 1, oldestOverdueDays: 3, totalOutstandingPaise: 100n,
    openDisputes: [{ documentNumber: "A/9", raisedOn: "2026-06-02", note: "n" }],
    bankDetailChanges: [{ bankAccountId: "b", changedOn: "2026-08-20", recordedAt: "2026-08-20T00:00:00.000Z", recordedBy: "r", previousAccountMasked: "****1", currentAccountMasked: "****2" }],
  }) })));

  const every: SupplierRiskCode[] = [
    "GSTIN_CANCELLED_BEFORE_INVOICE", "GSTIN_CANCELLED_AFTER_INVOICE", "GSTIN_SUSPENDED", "GSTIN_INACTIVE",
    "GSTIN_NOT_FOUND", "GSTIN_PROVISIONAL", "GSTIN_REGISTERED_RECENTLY", "GSTIN_NAME_DIFFERS",
    "GSTIN_STATE_DIFFERS", "RETURNS_NOT_FILED", "EINVOICE_EXPECTED_BUT_ABSENT", "NOT_IN_GSTR2B",
    "GSTR2B_VALUE_DIFFERS", "BANK_DETAILS_CHANGED", "OVERDUE_TO_SUPPLIER", "OPEN_DISPUTE",
    "FIRST_TIME_SUPPLIER", "GOVERNMENT_DATA_STALE", "GOVERNMENT_DATA_UNAVAILABLE",
    "GSTR2B_NOT_CHECKED", "MODEL_HINT",
  ];
  for (const code of every) assert.ok(seen.has(code), `${code} was never produced, so its wording is unreviewed`);
});

test("the wording guard rejects an accusation outright", () => {
  assert.throws(() => safeMessage("This supplier is a fraud."), UnsafeWordingError);
  assert.throws(() => safeMessage("The business appears to be a fake company."), UnsafeWordingError);
  assert.throws(() => safeMessage("We recommend you stop dealing with them."), UnsafeWordingError);
  assert.throws(() => safeMessage("This party has been blacklisted."), UnsafeWordingError);
  // A factual statement about the same situation passes.
  assert.equal(
    safeMessage("The GST portal shows this number was cancelled on 12 March 2026."),
    "The GST portal shows this number was cancelled on 12 March 2026.",
  );
});

test("the guard matches whole words, so ordinary language is not blocked", () => {
  assert.equal(unsafeTermIn("The registration was cancelled."), null);
  assert.equal(unsafeTermIn("Their filing is late."), null);
  assert.ok(FORBIDDEN_RISK_WORDS.includes("fraud"));
  assert.ok(FORBIDDEN_RISK_PHRASES.includes("do not deal"));
});

// ----------------------------------------------------- internal signals and bank changes

test("a recent bank-account change is serious and tells the buyer to ring a known number", () => {
  const assessment = assessSupplierRisk(input({
    gstin_lookup: { kind: "FOUND", record: record({ status: "ACTIVE", legalName: GOOD_SUPPLIER.name }) },
    history: cleanHistory({ bankDetailChanges: [{
      bankAccountId: "bank-1", changedOn: "2026-08-20", recordedAt: "2026-08-20T10:00:00.000Z",
      recordedBy: "ravi", previousAccountMasked: "****4411", currentAccountMasked: "****9087",
    }] }),
  }));
  const change = find(assessment, "BANK_DETAILS_CHANGED");
  assert.ok(change);
  assert.equal(change.level, "SERIOUS");
  assert.match(change.message, /\*\*\*\*4411 to \*\*\*\*9087/);
  assert.match(change.suggestedAction, /not one from the email or bill asking for the change/);
});

test("an old bank change is only worth a mention", () => {
  const assessment = assessSupplierRisk(input({
    gstin_lookup: { kind: "FOUND", record: record({ status: "ACTIVE", legalName: GOOD_SUPPLIER.name }) },
    history: cleanHistory({ bankDetailChanges: [{
      bankAccountId: "bank-1", changedOn: "2025-01-04", recordedAt: "2025-01-04T10:00:00.000Z",
      recordedBy: "ravi", previousAccountMasked: "****4411", currentAccountMasked: "****9087",
    }] }),
  }));
  assert.equal(find(assessment, "BANK_DETAILS_CHANGED")?.level, "CAUTION");
});

test("bank changes are read from the master version history, and account numbers are masked", () => {
  const changes = bankDetailChangesFrom([
    { recordId: "bank-1", effectiveFrom: "2024-02-01", recordedAt: "2024-02-01T00:00:00.000Z", recordedBy: "ravi", data: { accountNumber: "50100234114411", ifsc: "HDFC0001234", partyId: "party-srs" } },
    { recordId: "bank-1", effectiveFrom: "2026-08-20", recordedAt: "2026-08-20T00:00:00.000Z", recordedBy: "ravi", reason: "Supplier emailed new details", data: { accountNumber: "50100234119087", ifsc: "ICIC0000456", partyId: "party-srs" } },
    // Another party's account must not appear in this supplier's history.
    { recordId: "bank-2", effectiveFrom: "2026-08-21", recordedAt: "2026-08-21T00:00:00.000Z", recordedBy: "ravi", data: { accountNumber: "11112222333344", ifsc: "SBIN0000111", partyId: "party-other" } },
  ], "party-srs");

  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.previousAccountMasked, "****4411");
  assert.equal(changes[0]!.currentAccountMasked, "****9087");
  assert.equal(changes[0]!.previousIfsc, "HDFC0001234");
  assert.equal(changes[0]!.reason, "Supplier emailed new details");
  // The full account number never appears anywhere in the output.
  assert.equal(JSON.stringify(changes).includes("50100234114411"), false);
});

test("a renamed branch is not treated as the money moving", () => {
  const changes = bankDetailChangesFrom([
    { recordId: "bank-1", effectiveFrom: "2024-02-01", recordedAt: "2024-02-01T00:00:00.000Z", recordedBy: "r", data: { accountNumber: "50100234114411", ifsc: "HDFC0001234", partyId: "p" } },
    { recordId: "bank-1", effectiveFrom: "2026-01-01", recordedAt: "2026-01-01T00:00:00.000Z", recordedBy: "r", data: { accountNumber: "50100234114411", ifsc: "HDFC0001234", partyId: "p" } },
  ], "p");
  assert.equal(changes.length, 0);
});

test("masking never reveals more than the last four digits", () => {
  assert.equal(maskAccount("50100234114411"), "****4411");
  assert.equal(maskAccount("123"), "****");
});

test("money we owe them is framed as our own position, not their failing", () => {
  const assessment = assessSupplierRisk(input({
    gstin_lookup: { kind: "FOUND", record: record({ status: "ACTIVE", legalName: GOOD_SUPPLIER.name }) },
    history: cleanHistory({ overdueDocuments: 2, oldestOverdueDays: 40, totalOutstandingPaise: 45_000_00n }),
  }));
  const overdue = find(assessment, "OVERDUE_TO_SUPPLIER");
  assert.ok(overdue);
  assert.equal(overdue.level, "INFORMATION");
  assert.match(overdue.message, /₹45,000\.00 is owed to them/);
  assert.match(overdue.suggestedAction, /Nothing here is a problem with the supplier/);
});

// --------------------------------------------------- the service: outages, permissions, audit

test("the service reads the real GST connector through the gateway", async () => {
  const desk = makeRiskDesk();
  const assessment = await desk.service.assess(desk.actor, {
    supplierPartyId: CANCELLED_SUPPLIER.partyId, supplierName: CANCELLED_SUPPLIER.name,
    gstin: CANCELLED_SUPPLIER.gstin, invoiceNumber: "DHW/2026/114", invoiceDate: "2026-07-04", on: ON,
  });
  assert.equal(assessment.level, "SERIOUS");
  assert.ok(codes(assessment).includes("GSTIN_CANCELLED_BEFORE_INVOICE"));
});

test("a provider outage still returns a usable assessment rather than an error", async () => {
  const desk = makeRiskDesk({ connector: syntheticPortal() });
  desk.connector.setMode("outage");
  const assessment = await desk.service.assess(desk.actor, {
    supplierPartyId: GOOD_SUPPLIER.partyId, supplierName: GOOD_SUPPLIER.name, gstin: GOOD_SUPPLIER.gstin, on: ON,
  });
  assert.equal(assessment.confidence, "PARTIAL");
  assert.equal(assessment.level, "INFORMATION");
  assert.ok(codes(assessment).includes("GOVERNMENT_DATA_UNAVAILABLE"));
});

test("after an outage the previously cached reading is shown, marked stale", async () => {
  const desk = makeRiskDesk();
  // A first, healthy read fills the cache.
  await desk.service.assess(desk.actor, {
    supplierPartyId: SUSPENDED_SUPPLIER.partyId, supplierName: SUSPENDED_SUPPLIER.name, gstin: SUSPENDED_SUPPLIER.gstin, on: ON,
  });
  desk.connector.setMode("timeout");
  const assessment = await desk.service.assess(desk.actor, {
    supplierPartyId: SUSPENDED_SUPPLIER.partyId, supplierName: SUSPENDED_SUPPLIER.name,
    gstin: SUSPENDED_SUPPLIER.gstin, on: ON, refresh: true,
  });
  assert.ok(codes(assessment).includes("GSTIN_SUSPENDED"), "the last known suspension is still shown");
  assert.ok(codes(assessment).includes("GOVERNMENT_DATA_UNAVAILABLE"), "and it is clear we could not re-check");
  assert.equal(assessment.confidence, "PARTIAL");
});

test("the same facts on the same day record one assessment, not one per refresh", async () => {
  const desk = makeRiskDesk();
  const first = await desk.service.assess(desk.actor, { supplierPartyId: GOOD_SUPPLIER.partyId, supplierName: GOOD_SUPPLIER.name, gstin: GOOD_SUPPLIER.gstin, on: ON });
  const again = await desk.service.assess(desk.actor, { supplierPartyId: GOOD_SUPPLIER.partyId, supplierName: GOOD_SUPPLIER.name, gstin: GOOD_SUPPLIER.gstin, on: ON });
  assert.equal(again.fingerprint, first.fingerprint);
  assert.equal((await desk.service.assessmentsFor(desk.actor, GOOD_SUPPLIER.partyId)).length, 1);
});

test("a serious warning holds until someone accepts it, with a reason", async () => {
  const desk = makeRiskDesk();
  const assessment = await desk.service.assess(desk.actor, {
    supplierPartyId: CANCELLED_SUPPLIER.partyId, supplierName: CANCELLED_SUPPLIER.name,
    gstin: CANCELLED_SUPPLIER.gstin, invoiceNumber: "DHW/2026/114", invoiceDate: "2026-07-04", on: ON,
  });
  assert.equal((await desk.service.isClearedToProceed(desk.actor, assessment)).cleared, false);

  await assert.rejects(
    () => desk.service.acknowledge(desk.actor, assessment, "  "),
    (error: DomainError) => error.code === "SUPPLIER_RISK_REASON_REQUIRED",
  );

  const acknowledgement = await desk.service.acknowledge(desk.actor, assessment, "Spoke to the owner; they are re-registering and will re-issue the bill");
  assert.ok(acknowledgement.accepted.includes("GSTIN_CANCELLED_BEFORE_INVOICE"));
  const cleared = await desk.service.isClearedToProceed(desk.actor, assessment);
  assert.equal(cleared.cleared, true);
  assert.match(cleared.reason, /re-registering/);
});

test("accepting one set of warnings does not cover a different set later", async () => {
  const desk = makeRiskDesk();
  const assessment = await desk.service.assess(desk.actor, {
    supplierPartyId: CANCELLED_SUPPLIER.partyId, supplierName: CANCELLED_SUPPLIER.name,
    gstin: CANCELLED_SUPPLIER.gstin, invoiceNumber: "DHW/1", invoiceDate: "2026-07-04", on: ON,
  });
  await desk.service.acknowledge(desk.actor, assessment, "Checked with them");

  // A different bill from the same supplier is a different set of facts.
  const later = await desk.service.assess(desk.actor, {
    supplierPartyId: CANCELLED_SUPPLIER.partyId, supplierName: CANCELLED_SUPPLIER.name,
    gstin: CANCELLED_SUPPLIER.gstin, invoiceNumber: "DHW/2", invoiceDate: "2026-08-04", on: ON,
  });
  assert.notEqual(later.fingerprint, assessment.fingerprint);
  assert.equal((await desk.service.isClearedToProceed(desk.actor, later)).cleared, false);
});

test("there is nothing to accept when nothing is wrong", async () => {
  const desk = makeRiskDesk();
  const assessment = await desk.service.assess(desk.actor, {
    supplierPartyId: GOOD_SUPPLIER.partyId, supplierName: GOOD_SUPPLIER.name, gstin: GOOD_SUPPLIER.gstin, on: ON,
  });
  assert.equal(assessment.level, "INFORMATION");
  await assert.rejects(
    () => desk.service.acknowledge(desk.actor, assessment, "just in case"),
    (error: DomainError) => error.code === "SUPPLIER_RISK_NOTHING_TO_ACCEPT",
  );
});

test("seeing a supplier's government record needs permission", async () => {
  const desk = makeRiskDesk({ permissions: ["dashboard.read"] });
  await assert.rejects(
    () => desk.service.assess(desk.actor, { supplierPartyId: GOOD_SUPPLIER.partyId, supplierName: GOOD_SUPPLIER.name, gstin: GOOD_SUPPLIER.gstin, on: ON }),
    (error: DomainError) => error.kind === "FORBIDDEN",
  );
});

test("accepting a warning needs its own permission, beyond being able to see it", async () => {
  const desk = makeRiskDesk({ permissions: ["supplier.risk.view"] });
  const assessment = await desk.service.assess(desk.actor, {
    supplierPartyId: CANCELLED_SUPPLIER.partyId, supplierName: CANCELLED_SUPPLIER.name,
    gstin: CANCELLED_SUPPLIER.gstin, invoiceNumber: "DHW/1", invoiceDate: "2026-07-04", on: ON,
  });
  await assert.rejects(
    () => desk.service.acknowledge(desk.actor, assessment, "fine"),
    (error: DomainError) => error.kind === "FORBIDDEN",
  );
});

test("another company's assessment cannot be accepted", async () => {
  const desk = makeRiskDesk();
  const assessment = await desk.service.assess(desk.actor, {
    supplierPartyId: CANCELLED_SUPPLIER.partyId, supplierName: CANCELLED_SUPPLIER.name,
    gstin: CANCELLED_SUPPLIER.gstin, invoiceNumber: "DHW/1", invoiceDate: "2026-07-04", on: ON,
  });
  const outsider = { ...desk.actor, companyId: "konkan" as never };
  await assert.rejects(
    () => desk.service.acknowledge(outsider, assessment, "not mine"),
    (error: DomainError) => error.code === "SUPPLIER_RISK_UNKNOWN",
  );
});

test("assessments and acceptances are on the audit trail, and no secret is written to it", async () => {
  const desk = makeRiskDesk();
  const assessment = await desk.service.assess(desk.actor, {
    supplierPartyId: CANCELLED_SUPPLIER.partyId, supplierName: CANCELLED_SUPPLIER.name,
    gstin: CANCELLED_SUPPLIER.gstin, invoiceNumber: "DHW/1", invoiceDate: "2026-07-04", on: ON,
  });
  await desk.service.acknowledge(desk.actor, assessment, "Spoke to the owner");

  const actions = desk.audit.events.map((event) => event.action);
  assert.ok(actions.includes("supplier.risk_assessed"));
  assert.ok(actions.includes("supplier.risk_acknowledged"));
  const acknowledged = desk.audit.events.find((event) => event.action === "supplier.risk_acknowledged");
  assert.equal(acknowledged?.overrideReason, "Spoke to the owner");

  const written = JSON.stringify(desk.audit.events);
  assert.equal(written.includes("vault://"), false, "no credential reference reaches the audit trail");
  assert.equal(/\b\d{11,}\b/.test(written), false, "no full account number reaches the audit trail");
});

test("a supplier with no GST number saved is not treated as a problem", () => {
  const assessment = assessSupplierRisk(input({ gstin: undefined }));
  assert.equal(assessment.level, "INFORMATION");
  const none = find(assessment, "GOVERNMENT_DATA_UNAVAILABLE");
  assert.ok(none);
  assert.match(none.message, /We have no GST number on record/);
  assert.match(none.suggestedAction, /If they are registered, add their GST number/);
});

test("a brand new supplier with a new registration reads as new, not as risky", () => {
  const assessment = assessSupplierRisk(input({
    supplierPartyId: NEW_SUPPLIER.partyId, supplierName: NEW_SUPPLIER.name, gstin: NEW_SUPPLIER.gstin,
    gstin_lookup: { kind: "FOUND", record: record({ gstin: NEW_SUPPLIER.gstin, status: "ACTIVE", legalName: NEW_SUPPLIER.name, registeredOn: "2026-06-20" }) },
    history: cleanHistory({ billsRecorded: 0 }),
  }));
  assert.equal(assessment.level, "INFORMATION");
  assert.ok(codes(assessment).includes("GSTIN_REGISTERED_RECENTLY"));
  assert.ok(codes(assessment).includes("FIRST_TIME_SUPPLIER"));
  assert.match(find(assessment, "GSTIN_REGISTERED_RECENTLY")!.message, /New businesses are new, and that is all this means/);
});

test("the policy in force is recorded on the assessment, so it can be explained later", () => {
  const assessment = assessSupplierRisk(input(), { ...DEFAULT_RISK_POLICY, governmentDataStaleAfterDays: 30, effectiveFrom: "2026-04-01" });
  assert.equal(assessment.policy.governmentDataStaleAfterDays, 30);
  assert.equal(assessment.policy.effectiveFrom, "2026-04-01");
});

test("warnings come back worst first, so the screen leads with what matters", () => {
  const assessment = assessSupplierRisk(input({
    gstin_lookup: { kind: "FOUND", record: record({ status: "CANCELLED", statusChangedOn: "2026-03-12", legalName: "Someone Else" }) },
    invoiceNumber: "A/1", invoiceDate: "2026-07-04",
    history: cleanHistory({ billsRecorded: 0 }),
  }));
  const levels = assessment.warnings.map((warning) => warning.level);
  const rank = { SERIOUS: 0, CAUTION: 1, INFORMATION: 2 } as const;
  for (let index = 1; index < levels.length; index += 1) {
    assert.ok(rank[levels[index - 1]!] <= rank[levels[index]!], "warnings must be ordered worst first");
  }
});

test("the permissions this module needs are the ones it checks", () => {
  assert.deepEqual([...RISK_PERMISSIONS].sort(), ["supplier.risk.acknowledge", "supplier.risk.view"]);
});
