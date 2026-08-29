/**
 * Issue #19 [E19] — four suppliers, four stories, on a terminal with no database.
 *
 *   npm run demo:risk
 *
 * Every GST number is invented by `syntheticGstin`; the GST department is a synthetic connector
 * behind #8's real gateway. No production credential is needed to run any of this.
 */
import { assessSupplierRisk } from "./supplier-risk.ts";
import type { SupplierRiskAssessment } from "./supplier-risk-types.ts";
import {
  CANCELLED_SUPPLIER, GOOD_SUPPLIER, NEW_SUPPLIER, SUSPENDED_SUPPLIER, cleanHistory, makeRiskDesk,
} from "./supplier-risk-fixtures.ts";

const heading = (text: string): void => console.log(`\n${text}\n${"─".repeat(text.length)}`);

const show = (assessment: SupplierRiskAssessment): void => {
  console.log(`Level: ${assessment.level}   ·   How complete: ${assessment.confidence}`);
  console.log(assessment.summary);
  console.log("");
  for (const warning of assessment.warnings) {
    console.log(`  [${warning.level.padEnd(11)}] ${warning.code}`);
    console.log(`     ${warning.message}`);
    console.log(`     What to do: ${warning.suggestedAction}`);
    for (const evidence of warning.evidence) {
      const age = evidence.ageInDays === undefined ? "" : ` (${evidence.ageInDays} days old)`;
      const stale = evidence.stale ? "  ← this reading may be out of date" : "";
      console.log(`     Evidence · ${evidence.source}: ${evidence.statement}${age}${stale}`);
    }
    console.log("");
  }
  console.log("  Where the answers came from:");
  for (const source of assessment.sources) console.log(`    ${source.source.padEnd(17)} ${source.note}`);
};

const desk = makeRiskDesk();

heading("1. Shree Ram Steels — we have bought from them for years");
show(await desk.service.assess(desk.actor, {
  supplierPartyId: GOOD_SUPPLIER.partyId, supplierName: GOOD_SUPPLIER.name,
  gstin: GOOD_SUPPLIER.gstin, expectedStateCode: GOOD_SUPPLIER.stateCode,
  invoiceNumber: "SRS/2026/0042", invoiceDate: "2026-07-21", on: "2026-08-29",
}));

heading("2. Deccan Hardware — the issue's own example: cancelled before the bill was raised");
const cancelled = await desk.service.assess(desk.actor, {
  supplierPartyId: CANCELLED_SUPPLIER.partyId, supplierName: CANCELLED_SUPPLIER.name,
  gstin: CANCELLED_SUPPLIER.gstin, expectedStateCode: CANCELLED_SUPPLIER.stateCode,
  invoiceNumber: "DHW/2026/114", invoiceDate: "2026-07-04", on: "2026-08-29",
});
show(cancelled);
const before = await desk.service.isClearedToProceed(desk.actor, cancelled);
console.log(`\n  Can this bill go ahead? ${before.cleared ? "yes" : "no — it is waiting for a person"}`);
await desk.service.acknowledge(desk.actor, cancelled, "Spoke to the owner; they are re-registering and will re-issue the bill");
const after = await desk.service.isClearedToProceed(desk.actor, cancelled);
console.log(`  After the owner accepts it: ${after.cleared ? "yes" : "no"}`);
console.log(`  ${after.reason}`);

heading("3. Konkan Packaging — suspended, and behind on their returns");
show(await desk.service.assess(desk.actor, {
  supplierPartyId: SUSPENDED_SUPPLIER.partyId, supplierName: SUSPENDED_SUPPLIER.name,
  gstin: SUSPENDED_SUPPLIER.gstin, expectedStateCode: SUSPENDED_SUPPLIER.stateCode,
  invoiceNumber: "KPK/2026/77", invoiceDate: "2026-08-12", on: "2026-08-29",
}));

heading("4. Nilgiri Chemicals — new to us, new registration, and the bank account just changed");
show(assessSupplierRisk({
  companyId: desk.companyId,
  supplierPartyId: NEW_SUPPLIER.partyId,
  supplierName: NEW_SUPPLIER.name,
  gstin: NEW_SUPPLIER.gstin,
  expectedStateCode: NEW_SUPPLIER.stateCode,
  invoiceNumber: "NLG/2026/6",
  invoiceDate: "2026-08-25",
  gstin_lookup: {
    kind: "FOUND",
    record: {
      gstin: NEW_SUPPLIER.gstin, status: "ACTIVE", legalName: NEW_SUPPLIER.name, stateCode: "33",
      registeredOn: "2026-06-20", eInvoiceEnabled: true, filings: [],
      observedAt: "2026-08-29T09:00:00.000Z",
    },
  },
  history: cleanHistory({
    billsRecorded: 0,
    bankDetailChanges: [{
      bankAccountId: "bank-nlg", changedOn: "2026-08-20", recordedAt: "2026-08-20T11:00:00.000Z",
      recordedBy: "ravi", previousAccountMasked: "****4411", currentAccountMasked: "****9087",
      reason: "Supplier emailed new details",
    }],
  }),
  on: "2026-08-29",
}));

heading("5. The GST department goes down mid-afternoon");
desk.connector.setMode("outage");
show(await desk.service.assess(desk.actor, {
  supplierPartyId: GOOD_SUPPLIER.partyId, supplierName: GOOD_SUPPLIER.name,
  gstin: GOOD_SUPPLIER.gstin, invoiceNumber: "SRS/2026/0051", invoiceDate: "2026-08-28",
  on: "2026-08-29", refresh: true,
}));
console.log("");
