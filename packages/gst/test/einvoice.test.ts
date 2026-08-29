/**
 * Issue #26 [E26] acceptance criteria, enforced automatically.
 *
 *  - "Normal invoice and registered e-invoice states are never confused"
 *  - "Submission is idempotent"
 *  - "Government response is stored and verified before marking registered"
 *
 * plus the required applicable/non-applicable cases, duplicate/retry/cancellation-deadline tests,
 * and provider sandbox contract tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DomainError, fixedClock } from "@invoice/kernel";
import { decideApplicability, thresholdOn, TURNOVER_THRESHOLDS } from "../src/applicability.ts";
import { buildEInvoicePayload, toOfflineJson, toRupees } from "../src/payload.ts";
import { checkAcknowledgement, computeIrn, financialYearOf, readAckDate } from "../src/irn.ts";
import { DEFAULT_EINVOICE_POLICY } from "../src/einvoice-types.ts";
import { EInvoiceService } from "../src/einvoice-service.ts";
import { SyntheticIrp, irpAdapter } from "../src/einvoice-adapters.ts";
import {
  ALL_EINVOICE_PERMISSIONS, BUYER, BUYER_GSTIN, SELLER, SUPPLIER_GSTIN, aboveThreshold,
  actorWith, belowThreshold, cementLine, invoiceDocument, makeEInvoiceDesk,
} from "../src/einvoice-fixtures.ts";

// -------------------------------------- applicability: the non-goal is the point

test("an ordinary small trader is told plainly that no e-invoice number is needed", () => {
  const decision = decideApplicability(belowThreshold());
  assert.equal(decision.outcome, "NOT_APPLICABLE");
  assert.match(decision.reason, /below the ₹5,00,00,000\.00 limit/);
  assert.match(decision.reason, /It is an ordinary GST bill/);
  assert.equal(decision.thresholdApplied?.ruleId, "EINV.THRESHOLD.5CR");
  assert.match(decision.sourceRef ?? "", /Notification 10\/2023/);
});

test("a business above the limit must report, and is told which limit and why", () => {
  const decision = decideApplicability(aboveThreshold());
  assert.equal(decision.outcome, "APPLICABLE");
  assert.match(decision.reason, /₹8,00,00,000\.00 is at or above the ₹5,00,00,000\.00 limit/);
  assert.equal(decision.ruleId, "EINV.THRESHOLD.5CR");
});

test("turnover we were never told is a question, not a guess in either direction", () => {
  const decision = decideApplicability(aboveThreshold({ supplier: { gstin: SUPPLIER_GSTIN } }));
  assert.equal(decision.outcome, "CANNOT_DECIDE");
  assert.deepEqual(decision.missingFacts, ["supplier.aggregateTurnoverPaise"]);
  assert.match(decision.reason, /we have not been told it/);
});

test("a sale to a consumer never carries an IRN, however large", () => {
  const decision = decideApplicability(aboveThreshold({
    recipientKind: "B2C", recipientGstin: undefined,
    supplier: { gstin: SUPPLIER_GSTIN, aggregateTurnoverPaise: 900_00_00_000_00n },
  }));
  assert.equal(decision.outcome, "NOT_APPLICABLE");
  assert.equal(decision.ruleId, "EINV.RECIPIENT.B2C");
  assert.match(decision.reason, /however large the bill/);
});

test("an exempt business is exempt whatever its turnover", () => {
  const decision = decideApplicability(aboveThreshold({
    supplier: { gstin: SUPPLIER_GSTIN, aggregateTurnoverPaise: 900_00_00_000_00n, exemptCategories: ["BANKING_OR_NBFC"] },
  }));
  assert.equal(decision.outcome, "NOT_APPLICABLE");
  assert.match(decision.reason, /a bank or a non-banking finance company/);
});

test("a bill of supply is never reported", () => {
  const decision = decideApplicability(aboveThreshold({ isBillOfSupply: true }));
  assert.equal(decision.outcome, "NOT_APPLICABLE");
  assert.equal(decision.ruleId, "EINV.DOC.BILL_OF_SUPPLY");
});

test("a back-dated bill is judged under the limit in force on its own date", () => {
  // ₹8 crore was below the ₹20 crore limit in April 2022, and above the ₹5 crore one in 2026.
  const then = decideApplicability(aboveThreshold({ documentDate: "2022-05-10" }));
  assert.equal(then.outcome, "NOT_APPLICABLE");
  assert.equal(then.thresholdApplied?.ruleId, "EINV.THRESHOLD.20CR");

  const now = decideApplicability(aboveThreshold({ documentDate: "2026-05-10" }));
  assert.equal(now.outcome, "APPLICABLE");
  assert.equal(now.thresholdApplied?.ruleId, "EINV.THRESHOLD.5CR");
});

test("before e-invoicing existed nothing was reportable", () => {
  const decision = decideApplicability(aboveThreshold({ documentDate: "2019-06-01" }));
  assert.equal(decision.outcome, "NOT_APPLICABLE");
  assert.equal(decision.ruleId, "EINV.NOT_YET_IN_FORCE");
  assert.equal(thresholdOn("2019-06-01"), null);
});

test("a B2B sale with no buyer GST number is a question, not an assumption", () => {
  const decision = decideApplicability(aboveThreshold({ recipientGstin: "" }));
  assert.equal(decision.outcome, "CANNOT_DECIDE");
  assert.deepEqual(decision.missingFacts, ["recipientGstin"]);
});

test("exports and SEZ supplies are reportable, and carry their own supply type", () => {
  for (const kind of ["EXPORT_WITH_PAYMENT", "SEZ_WITHOUT_PAYMENT", "DEEMED_EXPORT"] as const) {
    assert.equal(decideApplicability(aboveThreshold({ recipientKind: kind })).outcome, "APPLICABLE", kind);
  }
  const built = buildEInvoicePayload(invoiceDocument({ recipientKind: "SEZ_WITHOUT_PAYMENT" }));
  assert.ok(built.ok);
  assert.equal((built.payload.TranDtls as Record<string, unknown>).SupTyp, "SEZWOP");
});

test("every threshold names the notification it came from", () => {
  for (const threshold of TURNOVER_THRESHOLDS) {
    assert.match(threshold.sourceRef, /Notification \d+\/\d{4}/);
    assert.match(threshold.ruleId, /^EINV\.THRESHOLD\./);
  }
});

// ----------------------------------------------------- the IRN, and verifying the reply

test("the financial year is worked out the Indian way, not the calendar way", () => {
  assert.equal(financialYearOf("2026-08-21"), "2026-27");
  assert.equal(financialYearOf("2026-02-15"), "2025-26");
  assert.equal(financialYearOf("2026-04-01"), "2026-27");
  assert.equal(financialYearOf("2026-03-31"), "2025-26");
});

test("the IRN is the published hash, and is stable for the same document", () => {
  const parts = { supplierGstin: SUPPLIER_GSTIN, documentNumber: "SAM/2026/0117", documentDate: "2026-08-21", documentType: "INVOICE" as const };
  const irn = computeIrn(parts);
  assert.match(irn, /^[0-9a-f]{64}$/);
  assert.equal(computeIrn(parts), irn, "the same document always hashes the same");
  // A different document number, or a different year, is a different IRN.
  assert.notEqual(computeIrn({ ...parts, documentNumber: "SAM/2026/0118" }), irn);
  assert.notEqual(computeIrn({ ...parts, documentDate: "2026-02-21" }), irn);
  assert.notEqual(computeIrn({ ...parts, documentType: "CREDIT_NOTE" }), irn);
});

test("a reply belonging to another document is caught before anything is believed", () => {
  const parts = { supplierGstin: SUPPLIER_GSTIN, documentNumber: "SAM/2026/0117", documentDate: "2026-08-21", documentType: "INVOICE" as const };
  const wrong = computeIrn({ ...parts, documentNumber: "SAM/2026/0999" });
  const check = checkAcknowledgement(
    { irn: wrong, ackNumber: "112420000001", ackDate: "21/08/2026 10:00:00", signedQrCode: "eyJ.abc.def" },
    parts,
    { verifyIrnHash: true },
  );
  assert.equal(check.ok, false);
  assert.ok(check.problems.includes("IRN_MISMATCH"));
  assert.match(check.explanation, /does not belong to this bill/);
});

test("a reply without the signed QR code is not a registration we will record", () => {
  const parts = { supplierGstin: SUPPLIER_GSTIN, documentNumber: "SAM/2026/0117", documentDate: "2026-08-21", documentType: "INVOICE" as const };
  const check = checkAcknowledgement(
    { irn: computeIrn(parts), ackNumber: "112420000001", ackDate: "21/08/2026 10:00:00", signedQrCode: "" },
    parts, { verifyIrnHash: true },
  );
  assert.equal(check.ok, false);
  assert.ok(check.problems.includes("SIGNED_QR_MISSING"));
  assert.match(check.explanation, /the customer's copy must carry/);
});

test("structural checks still run when the hash check is switched off", () => {
  const parts = { supplierGstin: SUPPLIER_GSTIN, documentNumber: "SAM/2026/0117", documentDate: "2026-08-21", documentType: "INVOICE" as const };
  const check = checkAcknowledgement({ irn: "not-a-hash", ackNumber: "1", ackDate: "21/08/2026 10:00:00", signedQrCode: "q" }, parts, { verifyIrnHash: false });
  assert.equal(check.ok, false);
  assert.ok(check.problems.includes("IRN_MALFORMED"));
});

test("the portal's Indian-format acknowledgement date is read correctly", () => {
  const parsed = readAckDate("21/08/2026 14:35:09");
  assert.equal(parsed.toISOString(), "2026-08-21T14:35:09.000Z");
});

// --------------------------------------------------------------------- the payload

test("the payload carries the government's field names and rupee amounts", () => {
  const built = buildEInvoicePayload(invoiceDocument());
  assert.ok(built.ok);
  const payload = built.payload as Record<string, any>;
  assert.equal(payload.Version, "1.1");
  assert.equal(payload.TranDtls.SupTyp, "B2B");
  assert.equal(payload.DocDtls.Typ, "INV");
  assert.equal(payload.DocDtls.No, "SAM/2026/0117");
  assert.equal(payload.DocDtls.Dt, "21/08/2026", "the portal wants DD/MM/YYYY");
  assert.equal(payload.SellerDtls.Gstin, SUPPLIER_GSTIN);
  assert.equal(payload.BuyerDtls.Pos, "27");
  assert.equal(payload.ItemList[0].HsnCd, "25232930");
  assert.equal(payload.ItemList[0].GstRt, 28);
  assert.equal(payload.ValDtls.AssVal, 82000);
  assert.equal(payload.ValDtls.IgstVal, 22960);
  assert.equal(payload.ValDtls.TotInvVal, 104960);
});

test("paise become rupees exactly, with no float anywhere near them", () => {
  assert.equal(toRupees(104_960_00n), 104960);
  assert.equal(toRupees(1n), 0.01);
  assert.equal(toRupees(99n), 0.99);
  assert.equal(toRupees(-250n), -2.5);
});

test("a missing field is reported in words a shopkeeper can act on, all at once", () => {
  const built = buildEInvoicePayload(invoiceDocument({
    recipient: { ...BUYER, pincode: "", legalName: "" },
    lines: [cementLine({ hsnOrSac: "" })],
  }));
  assert.equal(built.ok, false);
  if (built.ok) return;
  const fields = built.problems.map((problem) => problem.field);
  assert.ok(fields.includes("BuyerDtls.Pin"));
  assert.ok(fields.includes("BuyerDtls.LglNm"));
  assert.ok(fields.includes("ItemList[0].HsnCd"));
  assert.ok(built.problems.every((problem) => /[a-z]/.test(problem.message) && problem.message.endsWith(".")));
  assert.match(built.problems.find((problem) => problem.field === "ItemList[0].HsnCd")!.message, /has no HSN code/);
});

test("a bill number the portal would reject is caught before it is sent", () => {
  const built = buildEInvoicePayload(invoiceDocument({ documentNumber: "SAM#2026#117" }));
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.match(built.problems[0]!.message, /only contain letters, numbers, a slash and a dash/);
});

test("the offline file says inside itself that it is not yet an e-invoice", () => {
  const file = JSON.parse(toOfflineJson(invoiceDocument()));
  assert.equal(file.Version, "1.1");
  assert.equal(file.InvoiceList.length, 1);
  assert.equal(file.InvoiceList[0].DocDtls.No, "SAM/2026/0117");
  assert.match(file._karobar.note, /not an e-invoice until the government returns an IRN/);
  assert.equal(file._karobar.financialYear, "2026-27");
});

// ------------------------------ "invoice and registered e-invoice are never confused"

test("a document that has not come back from the government is never shown as registered", async () => {
  const desk = makeEInvoiceDesk();
  desk.portal.setMode("timeout");
  const record = await desk.service.register(desk.actor, { document: invoiceDocument(), applicability: aboveThreshold() });

  assert.equal(record.status, "FAILED");
  assert.equal(record.acknowledgement, undefined, "no acknowledgement means no registration");
  assert.match(record.message, /safe in your books/);
  assert.match(record.message, /only the government's e-invoice number that is still to come/);
  assert.equal(record.failure?.retryable, true);
});

test("a rejected document says plainly that sending it again unchanged will not help", async () => {
  const desk = makeEInvoiceDesk();
  desk.portal.rejectNext("2172", "Duplicate invoice number for the financial year.");
  const record = await desk.service.register(desk.actor, { document: invoiceDocument(), applicability: aboveThreshold() });
  assert.equal(record.status, "FAILED");
  assert.equal(record.failure?.retryable, false);
  assert.match(record.message, /Sending it again unchanged will get the same answer/);
});

test("a bill that needs no e-invoice number is refused rather than obliged", async () => {
  const desk = makeEInvoiceDesk();
  await assert.rejects(
    () => desk.service.register(desk.actor, { document: invoiceDocument(), applicability: belowThreshold() }),
    (error: DomainError) => {
      assert.equal(error.code, "EINVOICE_NOT_APPLICABLE");
      assert.match(error.message, /does not need an e-invoice number/);
      return true;
    },
  );
  assert.equal(desk.portal.registeredIrns().length, 0, "nothing may reach the government");
});

test("a bill whose applicability cannot be decided is never sent", async () => {
  const desk = makeEInvoiceDesk();
  await assert.rejects(
    () => desk.service.register(desk.actor, {
      document: invoiceDocument(),
      applicability: aboveThreshold({ supplier: { gstin: SUPPLIER_GSTIN } }),
    }),
    (error: DomainError) => error.code === "EINVOICE_CANNOT_DECIDE",
  );
  assert.equal(desk.portal.registeredIrns().length, 0);
});

// ------------------------------------------------- "submission is idempotent"

test("the issue's example: submitted once, and a retry cannot make a second IRN", async () => {
  const desk = makeEInvoiceDesk();
  const first = await desk.service.register(desk.actor, { document: invoiceDocument(), applicability: aboveThreshold() });
  assert.equal(first.status, "REGISTERED");
  assert.ok(first.acknowledgement);
  assert.match(first.acknowledgement.irn, /^[0-9a-f]{64}$/);
  assert.ok(first.acknowledgement.signedQrCode.length > 0, "the signed QR is kept");

  const again = await desk.service.register(desk.actor, { document: invoiceDocument(), applicability: aboveThreshold() });
  assert.equal(again.id, first.id);
  assert.equal(again.acknowledgement?.irn, first.acknowledgement.irn);
  assert.equal(desk.portal.registeredIrns().length, 1, "exactly one IRN exists at the government");
});

test("a retry after a timeout ends with the right IRN, not a second one", async () => {
  // The honest shape of the problem: the portal registered the document, but our side never saw
  // the reply, so our record says FAILED while the government's says registered.
  const desk = makeEInvoiceDesk();
  const document = invoiceDocument();
  await desk.portal.execute({
    tenantId: "sampoorna", operation: "einvoice.generate", idempotencyKey: "lost-in-transit", correlationId: "c",
    payload: (buildEInvoicePayload(document) as { payload: Record<string, unknown> }).payload,
  });
  const registeredIrn = desk.portal.registeredIrns()[0];

  desk.portal.setMode("timeout");
  const failed = await desk.service.register(desk.actor, { document, applicability: aboveThreshold() });
  assert.equal(failed.status, "FAILED");

  // Pressing the button again once the portal is back must land on the IRN that already exists.
  desk.portal.setMode("healthy");
  const retried = await desk.service.register(desk.actor, { document, applicability: aboveThreshold() });
  assert.equal(retried.status, "REGISTERED");
  assert.equal(retried.acknowledgement?.irn, registeredIrn);
  assert.equal(desk.portal.registeredIrns().length, 1, "still exactly one IRN at the government");
});

test("the government's duplicate reply is treated as success and its IRN is kept", async () => {
  const desk = makeEInvoiceDesk();
  const document = invoiceDocument();
  // Something else registered this document first — another till, an earlier attempt we lost.
  await desk.portal.execute({
    tenantId: "sampoorna", operation: "einvoice.generate", idempotencyKey: "elsewhere", correlationId: "c1",
    payload: (buildEInvoicePayload(document) as { payload: Record<string, unknown> }).payload,
  });
  const beforeIrn = desk.portal.registeredIrns()[0];

  const record = await desk.service.register(desk.actor, { document, applicability: aboveThreshold() });
  assert.equal(record.status, "REGISTERED");
  assert.equal(record.acknowledgement?.irn, beforeIrn);
  assert.match(record.message, /already registered/);
  assert.match(record.message, /Nothing has been registered twice/);
  assert.equal(desk.portal.registeredIrns().length, 1);

  const trail = desk.audit.events.map((event) => event.action);
  assert.ok(trail.includes("einvoice.duplicate_reconciled"));
});

// ------------------ "response is stored and verified before marking registered"

test("the acknowledgement is stored exactly as it arrived", async () => {
  const desk = makeEInvoiceDesk();
  const record = await desk.service.register(desk.actor, { document: invoiceDocument(), applicability: aboveThreshold() });
  const ack = record.acknowledgement!;
  assert.match(ack.ackDate, /^\d{2}\/\d{2}\/\d{4}/, "kept in the portal's own format");
  assert.ok(ack.ackNumber.length > 0);
  assert.ok(ack.providerRequestId.length > 0, "the provider's request id is kept for a dispute");
  assert.ok(ack.receivedAt.length > 0);
  // And it is the IRN this document must have.
  assert.equal(ack.irn, computeIrn({
    supplierGstin: SELLER.gstin, documentNumber: "SAM/2026/0117",
    documentDate: "2026-08-21", documentType: "INVOICE",
  }));
});

test("preview shows the IRN the bill will get, before anything is sent", async () => {
  const desk = makeEInvoiceDesk();
  const preview = await desk.service.preview(desk.actor, { document: invoiceDocument(), applicability: aboveThreshold() });
  assert.equal(preview.applicability.outcome, "APPLICABLE");
  assert.equal(preview.ready, true);
  assert.equal(preview.reportableUntil, "2026-09-20", "30 days from the bill date");
  assert.equal(desk.portal.registeredIrns().length, 0, "a preview sends nothing");

  const record = await desk.service.register(desk.actor, { document: invoiceDocument(), applicability: aboveThreshold() });
  assert.equal(record.acknowledgement?.irn, preview.expectedIrn, "what we predicted is what came back");
});

test("preview lists what is missing without sending anything", async () => {
  const desk = makeEInvoiceDesk();
  const preview = await desk.service.preview(desk.actor, {
    document: invoiceDocument({ lines: [cementLine({ hsnOrSac: "" })] }),
    applicability: aboveThreshold(),
  });
  assert.equal(preview.ready, false);
  assert.ok(preview.problems.length > 0);
  assert.match(preview.summary, /missing first/);
});

// ------------------------------------------- cancellation, deadlines, reconciliation

test("an e-invoice can be cancelled inside the government's window, with a reason", async () => {
  const desk = makeEInvoiceDesk();
  const record = await desk.service.register(desk.actor, { document: invoiceDocument(), applicability: aboveThreshold() });
  assert.ok(record.cancellableUntil);

  const cancelled = await desk.service.cancel(desk.actor, "inv-001", {
    reasonCode: "DATA_ENTRY_MISTAKE", reason: "The buyer's GST number was typed wrong",
  });
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(cancelled.cancelReasonCode, "DATA_ENTRY_MISTAKE");
  assert.match(cancelled.message, /The bill in your books is unchanged/);

  const trail = desk.audit.events.find((event) => event.action === "einvoice.cancelled");
  assert.equal(trail?.overrideReason, "The buyer's GST number was typed wrong");
});

test("after the window closes, cancellation is refused and a credit note is suggested", async () => {
  const desk = makeEInvoiceDesk({ now: "2026-08-21T10:00:00.000Z" });
  await desk.service.register(desk.actor, { document: invoiceDocument(), applicability: aboveThreshold() });

  // The same records and the same portal, two days later.
  const twoDaysOn = fixedClock("2026-08-23T10:00:00.000Z");
  const later = new EInvoiceService({
    irp: irpAdapter({ gateway: desk.gateway, clock: () => twoDaysOn.now() }),
    records: desk.records, audit: desk.audit, clock: twoDaysOn, policy: desk.policies,
  });

  await assert.rejects(
    () => later.cancel(desk.actor, "inv-001", { reasonCode: "OTHER", reason: "changed our mind" }),
    (error: DomainError) => {
      assert.equal(error.code, "EINVOICE_WINDOW_CLOSED");
      assert.match(error.message, /within 24 hours/);
      assert.match(error.message, /raise a credit note against it instead/);
      return true;
    },
  );
  // And the record is untouched: a refusal changes nothing.
  assert.equal((await desk.service.forDocument(desk.actor, "inv-001"))!.status, "REGISTERED");
});

test("cancelling without a reason is refused", async () => {
  const desk = makeEInvoiceDesk();
  await desk.service.register(desk.actor, { document: invoiceDocument(), applicability: aboveThreshold() });
  await assert.rejects(
    () => desk.service.cancel(desk.actor, "inv-001", { reasonCode: "OTHER", reason: "   " }),
    (error: DomainError) => error.code === "EINVOICE_CANCEL_REASON_REQUIRED",
  );
});

test("a bill with no e-invoice has nothing to cancel", async () => {
  const desk = makeEInvoiceDesk();
  desk.portal.setMode("outage");
  await desk.service.register(desk.actor, { document: invoiceDocument(), applicability: aboveThreshold() });
  await assert.rejects(
    () => desk.service.cancel(desk.actor, "inv-001", { reasonCode: "OTHER", reason: "no" }),
    (error: DomainError) => error.code === "EINVOICE_NOT_REGISTERED",
  );
});

test("reconciling answers 'did it actually go through?' by asking the government", async () => {
  const desk = makeEInvoiceDesk();
  const document = invoiceDocument();
  // The portal registered it, but our side never saw the reply.
  await desk.portal.execute({
    tenantId: "sampoorna", operation: "einvoice.generate", idempotencyKey: "lost", correlationId: "c",
    payload: (buildEInvoicePayload(document) as { payload: Record<string, unknown> }).payload,
  });
  desk.portal.setMode("timeout");
  const failed = await desk.service.register(desk.actor, { document, applicability: aboveThreshold() });
  assert.equal(failed.status, "FAILED");

  desk.portal.setMode("healthy");
  const reconciled = await desk.service.reconcile(desk.actor, "inv-001");
  assert.equal(reconciled.status, "REGISTERED");
  assert.equal(reconciled.acknowledgement?.irn, desk.portal.registeredIrns()[0]);
  assert.match(reconciled.message, /the government's record shows this bill is registered/i);
});

test("documents still to be reported are listed, so a deadline is never missed silently", async () => {
  const desk = makeEInvoiceDesk();
  desk.portal.setMode("outage");
  await desk.service.register(desk.actor, { document: invoiceDocument(), applicability: aboveThreshold() });
  const waiting = await desk.service.awaitingReport(desk.actor, "2026-08-25");
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0]!.reportableUntil, "2026-09-20");
});

// ------------------------------------------------- permissions, tenancy, audit

test("reporting to the government needs its own permission", async () => {
  const desk = makeEInvoiceDesk({ permissions: ["einvoice.view"] });
  await assert.rejects(
    () => desk.service.register(desk.actor, { document: invoiceDocument(), applicability: aboveThreshold() }),
    (error: DomainError) => error.kind === "FORBIDDEN",
  );
});

test("cancelling needs a permission of its own, beyond being able to report", async () => {
  const desk = makeEInvoiceDesk({ permissions: ["einvoice.view", "einvoice.generate"] });
  await desk.service.register(desk.actor, { document: invoiceDocument(), applicability: aboveThreshold() });
  await assert.rejects(
    () => desk.service.cancel(desk.actor, "inv-001", { reasonCode: "OTHER", reason: "x" }),
    (error: DomainError) => error.kind === "FORBIDDEN",
  );
});

test("another company's e-invoice is simply not there", async () => {
  const desk = makeEInvoiceDesk();
  await desk.service.register(desk.actor, { document: invoiceDocument(), applicability: aboveThreshold() });
  const outsider = actorWith(ALL_EINVOICE_PERMISSIONS, "konkan" as never);
  assert.equal(await desk.service.forDocument(outsider, "inv-001"), null);
  await assert.rejects(
    () => desk.service.cancel(outsider, "inv-001", { reasonCode: "OTHER", reason: "x" }),
    (error: DomainError) => error.code === "EINVOICE_UNKNOWN",
  );
});

test("the audit trail records the IRN but not the signed QR blob or any credential", async () => {
  const desk = makeEInvoiceDesk();
  const record = await desk.service.register(desk.actor, { document: invoiceDocument(), applicability: aboveThreshold() });
  const registered = desk.audit.events.find((event) => event.action === "einvoice.registered");
  assert.ok(registered);
  assert.equal(registered.details.irn, record.acknowledgement!.irn);
  assert.equal(registered.details.signedQr, "present");

  const written = JSON.stringify(desk.audit.events);
  assert.equal(written.includes(record.acknowledgement!.signedQrCode), false, "the QR blob is not copied into the trail");
  assert.equal(written.includes("vault://"), false, "no credential reference reaches the trail");
});

test("the policy in force is used, and a company may set its own", async () => {
  const desk = makeEInvoiceDesk();
  desk.policies.set("sampoorna" as never, { ...DEFAULT_EINVOICE_POLICY, reportingWindowDays: 7 });
  const preview = await desk.service.preview(desk.actor, { document: invoiceDocument(), applicability: aboveThreshold() });
  assert.equal(preview.reportableUntil, "2026-08-28", "seven days, not thirty");
});

test("the offline export refuses for a bill that needs no e-invoice at all", async () => {
  const desk = makeEInvoiceDesk();
  await assert.rejects(
    () => desk.service.offlineJson(desk.actor, { document: invoiceDocument(), applicability: belowThreshold() }),
    (error: DomainError) => error.code === "EINVOICE_NOT_APPLICABLE",
  );
});

// --------------------------------------------------- provider sandbox contract

test("the synthetic portal honours the connector contract on a repeated key", async () => {
  const desk = makeEInvoiceDesk();
  const payload = (buildEInvoicePayload(invoiceDocument()) as { payload: Record<string, unknown> }).payload;
  const request = { tenantId: "sampoorna", operation: "einvoice.generate", payload, idempotencyKey: "same-key", correlationId: "c1" };
  const first = await desk.portal.execute(request);
  const second = await desk.portal.execute(request);
  assert.deepEqual(second.payload, first.payload, "the same key gives the same answer");
  assert.equal(second.providerRequestId, first.providerRequestId);
});

test("the synthetic portal normalises outages the way the contract requires", async () => {
  const desk = makeEInvoiceDesk();
  desk.portal.setMode("outage");
  assert.equal(await desk.portal.health(), "unavailable");
  await assert.rejects(() => desk.portal.execute({
    tenantId: "sampoorna", operation: "einvoice.generate", payload: {}, idempotencyKey: "k", correlationId: "c",
  }));
});

test("the synthetic portal refuses a cancellation outside twenty-four hours, like the real one", async () => {
  // A portal whose own clock moves, so the window is exercised rather than described.
  let now = new Date("2026-08-21T10:00:00.000Z");
  const portal = new SyntheticIrp(() => now);
  const payload = (buildEInvoicePayload(invoiceDocument()) as { payload: Record<string, unknown> }).payload;
  const registered = await portal.execute({
    tenantId: "sampoorna", operation: "einvoice.generate", payload, idempotencyKey: "gen", correlationId: "c",
  });
  const irn = String(registered.payload.Irn);

  // Twenty-three hours later it is still allowed.
  now = new Date("2026-08-22T09:00:00.000Z");
  const inTime = await portal.execute({
    tenantId: "sampoorna", operation: "einvoice.cancel", correlationId: "c",
    idempotencyKey: "cancel-in-time", payload: { Irn: irn, CnlRsn: "4", CnlRem: "in time" },
  });
  assert.equal(inTime.payload.ErrorCode, undefined, "inside the window the portal accepts it");

  // A different document, cancelled four days on, is refused with the government's own code.
  const second = await portal.execute({
    tenantId: "sampoorna", operation: "einvoice.generate", correlationId: "c", idempotencyKey: "gen-2",
    payload: { ...payload, DocDtls: { ...(payload.DocDtls as Record<string, unknown>), No: "SAM/2026/0118" } },
  });
  now = new Date("2026-08-26T10:00:00.000Z");
  const tooLate = await portal.execute({
    tenantId: "sampoorna", operation: "einvoice.cancel", correlationId: "c",
    idempotencyKey: "cancel-late", payload: { Irn: String(second.payload.Irn), CnlRsn: "4", CnlRem: "late" },
  });
  assert.equal(tooLate.payload.ErrorCode, "4002");
  assert.match(String(tooLate.payload.ErrorMessage), /time limit for cancelling/);
});
