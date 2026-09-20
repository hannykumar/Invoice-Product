/**
 * Issue #210 part 3 — the two rules a shopkeeper feels: the bill is issued whatever the government
 * is doing, and a bill that could not be reported is a task rather than a failure.
 *
 * The turnover band tests belong here too, because the automatic path has no form to type a figure
 * into and the product must not invent one.
 *
 * Every name, GST number and figure below is synthetic and belongs to nobody.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decideApplicability } from "../src/applicability.ts";
import {
  ALL_EINVOICE_PERMISSIONS, aboveThreshold, actorWith, invoiceDocument, makeEInvoiceDesk,
} from "../src/einvoice-fixtures.ts";

const FIVE_CRORE = 5_00_00_000_00n;

test("the business's own yes to the ₹5 crore question decides the bill, with no figure invented", () => {
  const facts = aboveThreshold();
  const banded = {
    ...facts,
    supplier: {
      gstin: facts.supplier.gstin,
      declaredTurnoverBand: { thresholdPaise: FIVE_CRORE, above: true },
    },
  };

  const decision = decideApplicability(banded);

  assert.equal(decision.outcome, "APPLICABLE");
  assert.match(decision.reason, /above ₹5,00,00,000\.00/);
  assert.equal(decision.thresholdApplied?.ruleId, "EINV.THRESHOLD.5CR");
});

test("a no against the same question settles it the other way", () => {
  const facts = aboveThreshold();

  const decision = decideApplicability({
    ...facts,
    supplier: { gstin: facts.supplier.gstin, declaredTurnoverBand: { thresholdPaise: FIVE_CRORE, above: false } },
  });

  assert.equal(decision.outcome, "NOT_APPLICABLE");
  assert.match(decision.reason, /ordinary GST bill/);
});

test("a band that does not reach the limit in force is a question, not a guess either way", () => {
  const facts = aboveThreshold();

  // "Under ₹5 crore" says nothing about a bill judged under the ₹20 crore limit of April 2022.
  const decision = decideApplicability({
    ...facts,
    documentDate: "2022-05-01",
    supplier: { gstin: facts.supplier.gstin, declaredTurnoverBand: { thresholdPaise: FIVE_CRORE, above: true } },
  });

  assert.equal(decision.outcome, "CANNOT_DECIDE");
  assert.deepEqual(decision.missingFacts, ["supplier.aggregateTurnoverPaise"]);
});

test("the government being down leaves the bill alone and the report as a task", async () => {
  const desk = makeEInvoiceDesk();
  desk.portal.setMode("outage");

  const record = await desk.service.register(desk.actor, { document: invoiceDocument(), applicability: aboveThreshold() });

  assert.equal(record.status, "FAILED");
  assert.equal(record.failure?.retryable, true);
  // The sentence a shopkeeper reads. The bill is theirs, valid, and in their books.
  assert.match(record.message, /valid GST bill and is safe in your books/);
  assert.match(record.message, /We will try again/);
  assert.equal(record.acknowledgement, undefined);
});

test("once the portal is back, the same bill goes through and keeps one IRN", async () => {
  const desk = makeEInvoiceDesk();
  const document = invoiceDocument();
  desk.portal.setMode("outage");
  const failed = await desk.service.register(desk.actor, { document, applicability: aboveThreshold() });
  assert.equal(failed.status, "FAILED");

  // What the scheduled retry does: the same call, unchanged, on the same document.
  desk.portal.setMode("healthy");
  const first = await desk.service.register(desk.actor, { document, applicability: aboveThreshold() });
  const second = await desk.service.register(desk.actor, { document, applicability: aboveThreshold() });

  assert.equal(first.status, "REGISTERED");
  assert.match(first.acknowledgement?.irn ?? "", /^[0-9a-f]{64}$/);
  assert.equal(second.acknowledgement?.irn, first.acknowledgement?.irn);
  assert.ok((first.acknowledgement?.signedQrCode ?? "").length > 0, "the signed QR is kept as received");
});

test("a bill the government refused is not retried, because the same call gets the same answer", async () => {
  const desk = makeEInvoiceDesk();
  desk.portal.rejectNext("2172", "Duplicate SI number is not allowed in the same financial year");

  const record = await desk.service.register(
    actorWith(ALL_EINVOICE_PERMISSIONS),
    { document: invoiceDocument(), applicability: aboveThreshold() },
  );

  assert.equal(record.status, "FAILED");
  assert.equal(record.failure?.retryable, false);
  assert.match(record.message, /needs correcting first/);
});
