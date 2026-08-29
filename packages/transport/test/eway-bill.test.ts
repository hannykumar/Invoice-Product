/**
 * Issue #27 [E27] acceptance criteria, enforced automatically.
 *
 *  - "Every decision lists applied facts and source"
 *  - "₹1 lakh/day is not treated as a universal rule"
 *  - "Incorrect government submissions are cancelled/recreated according to allowed lifecycle"
 *
 * plus the required ₹50,000 boundary and state-rule cases, multiple invoice/vehicle and
 * bill-to/ship-to cases, and validity, cancellation and provider-outage tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "@invoice/kernel";
import { consignmentValueOf, decideEwayApplicability } from "../src/applicability.ts";
import { INTRA_STATE_RULES, intraStateRuleFor } from "../src/rules.ts";
import { buildPartA, buildPartB, toOfflineJson, toRupees } from "../src/payload.ts";
import {
  canExtendNow, describeTimeLeft, readPortalTimestamp, validUntilFrom, validityDays,
  writePortalTimestamp,
} from "../src/validity.ts";
import { DEFAULT_EWAY_BILL_POLICY } from "../src/types.ts";
import {
  ALL_EWAY_PERMISSIONS, actorWith, billToShipToMovement, interStateMovement, intraStateMovement,
  lorry, makeEwayDesk, soapLine, steelLine,
} from "../src/fixtures.ts";
import type { ConsignmentDocument } from "../src/types.ts";

/** One invoice carrying one line worth exactly this much, tax included. */
const worth = (paise: bigint, over: Partial<ConsignmentDocument> = {}): ConsignmentDocument => ({
  documentId: "doc-x",
  documentType: "TAX_INVOICE",
  documentNumber: "SAM/2026/0200",
  documentDate: "2026-08-21",
  lines: [steelLine({ taxableValuePaise: paise, igstPaise: 0n })],
  ...over,
});

// ------------------------------------------- the ₹50,000 boundary, and the ₹1 lakh belief

test("the inter-state limit is ₹50,000 and it is a strict 'exceeds'", () => {
  const at = (paise: bigint) => decideEwayApplicability(interStateMovement({ documents: [worth(paise)] })).outcome;
  assert.equal(at(49_999_00n), "NOT_REQUIRED");
  assert.equal(at(50_000_00n), "NOT_REQUIRED", "exactly ₹50,000 does not exceed ₹50,000");
  assert.equal(at(50_000_01n), "REQUIRED");
});

test("₹1 lakh is a state's limit, not the country's, and never a daily one", () => {
  const inMaharashtra = (paise: bigint) => decideEwayApplicability(intraStateMovement({
    consignor: { ...intraStateMovement().consignor, place: "Nashik", pincode: "422001", stateCode: "27" },
    billTo: { ...intraStateMovement().billTo, place: "Pune", pincode: "411030", stateCode: "27" },
    documents: [worth(paise)],
  }));
  const inKarnataka = (paise: bigint) => decideEwayApplicability(intraStateMovement({ documents: [worth(paise)] }));

  // The very number the uncle's rule of thumb uses, and it lands differently in two states.
  assert.equal(inMaharashtra(82_600_00n).outcome, "NOT_REQUIRED");
  assert.equal(inKarnataka(82_600_00n).outcome, "REQUIRED");
  assert.match(inMaharashtra(82_600_00n).reason, /it is that state's limit, not a national one/);
  assert.equal(inMaharashtra(82_600_00n).thresholdApplied?.thresholdPaise, 1_00_000_00n);
  assert.equal(inKarnataka(82_600_00n).thresholdApplied?.thresholdPaise, 50_000_00n);
  // And crossing a border at the same value is the national ₹50,000 rule again.
  assert.equal(decideEwayApplicability(interStateMovement({ documents: [worth(82_600_00n)] })).outcome, "REQUIRED");
});

test("a state's own order only applies from the day it came into force", () => {
  const before = intraStateRuleFor("27", "2018-05-01");
  const after = intraStateRuleFor("27", "2018-08-01");
  assert.equal(before.thresholdPaise, 50_000_00n);
  assert.equal(before.ruleId, "EWB.THRESHOLD.INTRA_STATE.NATIONAL_FALLBACK");
  assert.equal(after.thresholdPaise, 1_00_000_00n);
});

test("a state we hold no order for says so rather than claiming the state set ₹50,000", () => {
  const rule = intraStateRuleFor("23", "2026-08-21");
  assert.equal(rule.thresholdPaise, 50_000_00n);
  assert.match(rule.note ?? "", /We hold no separate order for this state/);
});

test("every state rule carries the order it came from", () => {
  for (const [code, rule] of Object.entries(INTRA_STATE_RULES)) {
    assert.equal(rule.scope, code);
    assert.notEqual(rule.sourceRef.trim(), "", `state ${code} has no source`);
    assert.match(rule.effectiveFrom, /^\d{4}-\d{2}-\d{2}$/);
  }
});

// ------------------------------------------- every decision lists its facts and its source

test("a decision lists the facts it applied and the rule behind it", () => {
  const decision = decideEwayApplicability(interStateMovement());
  assert.equal(decision.outcome, "REQUIRED");
  assert.match(decision.sourceRef ?? "", /Rule 138\(1\)/);
  const labels = decision.appliedFacts.map((fact) => fact.label);
  assert.ok(labels.includes("From") && labels.includes("To"));
  assert.ok(labels.includes("Consignment value, tax included"));
  const value = decision.appliedFacts.find((fact) => fact.label === "Consignment value, tax included");
  assert.equal(value?.value, "₹94,400.00");
  assert.equal(decision.consignmentValuePaise, 94_400_00n);
});

test("consignment value includes the tax and leaves out exempt lines", () => {
  const value = consignmentValueOf([{
    documentId: "d", documentType: "TAX_INVOICE", documentNumber: "SAM/1", documentDate: "2026-08-21",
    lines: [
      steelLine({ taxableValuePaise: 40_000_00n, igstPaise: 7_200_00n }),
      soapLine({ description: "Fresh milk", hsnCode: "0401", taxableValuePaise: 30_000_00n, cgstPaise: 0n, sgstPaise: 0n, isExemptSupply: true }),
    ],
  }]);
  // ₹40,000 + ₹7,200 of tax, and the exempt milk stays out of it entirely.
  assert.equal(value.valuePaise, 47_200_00n);
  assert.equal(value.excludedPaise, 30_000_00n);
  assert.match(value.excludedReasons[0] ?? "", /exempt or nil-rated supply/);
});

test("goods the annexure exempts need no e-way bill at any value", () => {
  const decision = decideEwayApplicability(interStateMovement({
    documents: [worth(5_00_000_00n, { lines: [steelLine({ description: "Gold chains", hsnCode: "7113", taxableValuePaise: 5_00_000_00n, igstPaise: 0n })] })],
  }));
  assert.equal(decision.outcome, "NOT_REQUIRED");
  assert.equal(decision.ruleId, "EWB.EXEMPT.GOODS");
  assert.match(decision.reason, /jewellery/);
});

test("a hand cart is exempt however much it is carrying", () => {
  const decision = decideEwayApplicability(interStateMovement({ transportMode: "NON_MOTORISED" }));
  assert.equal(decision.outcome, "NOT_REQUIRED");
  assert.equal(decision.ruleId, "EWB.EXEMPT.NON_MOTORISED");
});

test("goods under a customs bond and the customs clearance leg are both exempt", () => {
  assert.equal(decideEwayApplicability(interStateMovement({ underCustomsBond: true })).ruleId, "EWB.EXEMPT.CUSTOMS_BOND");
  assert.equal(decideEwayApplicability(interStateMovement({ customsClearanceLeg: true })).ruleId, "EWB.EXEMPT.CUSTOMS_CLEARANCE_LEG");
});

test("goods sent to another state for job work need a bill at any value", () => {
  const decision = decideEwayApplicability(interStateMovement({ reason: "JOB_WORK", documents: [worth(2_000_00n)] }));
  assert.equal(decision.outcome, "REQUIRED");
  assert.equal(decision.ruleId, "EWB.ANY_VALUE.INTER_STATE_JOB_WORK");
  assert.match(decision.reason, /however little they are worth/);
  // The same job work inside one state is back under that state's money limit.
  assert.equal(decideEwayApplicability(intraStateMovement({ reason: "JOB_WORK", documents: [worth(2_000_00n)] })).outcome, "NOT_REQUIRED");
});

test("handicrafts moved by an unregistered person need a bill at any value", () => {
  const decision = decideEwayApplicability(intraStateMovement({ handicraftsByExemptPerson: true, documents: [worth(3_000_00n)] }));
  assert.equal(decision.outcome, "REQUIRED");
  assert.equal(decision.ruleId, "EWB.ANY_VALUE.HANDICRAFTS");
});

// ------------------------------------------- facts we were not given are questions

test("an unknown state is a question, not a guess in either direction", () => {
  const decision = decideEwayApplicability(interStateMovement({
    billTo: { ...interStateMovement().billTo, stateCode: "" },
  }));
  assert.equal(decision.outcome, "CANNOT_DECIDE");
  assert.deepEqual(decision.missingFacts, ["shipTo.stateCode"]);
});

test("a state whose rule turns on staying inside one city asks rather than assumes", () => {
  const inGujarat = (over: { withinSameCity?: boolean } = {}) => decideEwayApplicability(intraStateMovement({
    consignor: { ...intraStateMovement().consignor, place: "Surat", pincode: "395003", stateCode: "24" },
    billTo: { ...intraStateMovement().billTo, place: "Surat", pincode: "395006", stateCode: "24" },
    documents: [worth(80_000_00n)],
    // Left off entirely, so the rules meet the question rather than a default.
    ...(over.withinSameCity === undefined ? {} : { withinSameCity: over.withinSameCity }),
  }));
  const asked = inGujarat();
  assert.equal(asked.outcome, "CANNOT_DECIDE");
  assert.deepEqual(asked.missingFacts, ["withinSameCity"]);

  const inside = inGujarat({ withinSameCity: true });
  assert.equal(inside.outcome, "NOT_REQUIRED");
  assert.match(inside.reason, /inside/);

  const outside = inGujarat({ withinSameCity: false });
  assert.equal(outside.outcome, "REQUIRED");
});

// ------------------------------------------- bill-to and ship-to are not the same question

test("the movement follows the goods, not the bill", () => {
  const movement = billToShipToMovement();
  const decision = decideEwayApplicability(movement);
  const to = decision.appliedFacts.find((fact) => fact.label === "To");
  // Billed to Maharashtra, delivered to Telangana: the route is the one the lorry takes.
  assert.match(to?.value ?? "", /Hyderabad \(state 36\)/);
  assert.equal(decision.outcome, "REQUIRED");

  const partA = buildPartA(movement);
  assert.ok(partA.ok);
  if (partA.ok) {
    assert.equal(partA.payload.toStateCode, "27", "the bill still goes to Maharashtra");
    assert.equal(partA.payload.actToStateCode, "36", "the goods still go to Telangana");
    assert.equal(partA.payload.transactionType, 2, "bill-to/ship-to is the portal's type 2");
  }
});

// ------------------------------------------- Part A and Part B

test("Part A refuses to guess at a missing pin code or a bad vehicle number", () => {
  const built = buildPartA(interStateMovement({
    billTo: { ...interStateMovement().billTo, pincode: "" },
  }));
  assert.equal(built.ok, false);
  if (!built.ok) {
    assert.equal(built.problems[0]?.field, "toPincode");
    assert.match(built.problems[0]?.message ?? "", /pin code/);
  }

  const vehicle = buildPartB("100000000010", lorry({ registrationNumber: "LORRY ONE" }), "ROAD");
  assert.equal(vehicle.ok, false);
  if (!vehicle.ok) assert.match(vehicle.problems[0]?.message ?? "", /KA01AB1234/);
});

test("a transporter ID has to be a GST number or the portal's 15-character id", () => {
  const built = buildPartA(interStateMovement({ transporter: { name: "Kaveri Roadlines", transporterId: "KAVERI" } }));
  assert.equal(built.ok, false);
  if (!built.ok) assert.equal(built.problems[0]?.field, "transporterId");
});

test("rupees are converted exactly, and the offline file says it is not a permit", () => {
  assert.equal(toRupees(94_400_00n), 94400);
  assert.equal(toRupees(1n), 0.01);
  const offline = JSON.parse(toOfflineJson(interStateMovement()));
  assert.equal(offline.billLists[0].docNo, "SAM/2026/0117");
  assert.match(offline._karobar.note, /This file is not an e-way bill/);
});

// ------------------------------------------- validity, distance and expiry

test("validity is a day for every 200 km or part of it, and 20 km for oversized loads", () => {
  assert.equal(validityDays(1, "REGULAR", DEFAULT_EWAY_BILL_POLICY), 1);
  assert.equal(validityDays(200, "REGULAR", DEFAULT_EWAY_BILL_POLICY), 1);
  assert.equal(validityDays(201, "REGULAR", DEFAULT_EWAY_BILL_POLICY), 2);
  assert.equal(validityDays(840, "REGULAR", DEFAULT_EWAY_BILL_POLICY), 5);
  assert.equal(validityDays(840, "ODC", DEFAULT_EWAY_BILL_POLICY), 42);
});

test("a day ends at midnight Indian time, not 24 hours after the bill was made", () => {
  // 21 August, 11:30 p.m. Indian time. One day of validity ends at midnight the *next* night.
  const lateEvening = new Date("2026-08-21T18:00:00.000Z");
  const expiry = validUntilFrom(lateEvening, 150, "REGULAR", DEFAULT_EWAY_BILL_POLICY);
  assert.equal(writePortalTimestamp(expiry), "23/08/2026 00:00:00");
  // Barely 24 and a half hours, from a bill that says "one day".
  assert.ok(expiry.getTime() - lateEvening.getTime() < 25 * 3_600_000);

  const earlyMorning = new Date("2026-08-21T01:00:00.000Z");
  assert.equal(writePortalTimestamp(validUntilFrom(earlyMorning, 150, "REGULAR", DEFAULT_EWAY_BILL_POLICY)), "23/08/2026 00:00:00");
});

test("portal timestamps are read as Indian time rather than hopefully", () => {
  assert.equal(readPortalTimestamp("21/08/2026 10:00:00").toISOString(), "2026-08-21T04:30:00.000Z");
  assert.equal(writePortalTimestamp(new Date("2026-08-21T04:30:00.000Z")), "21/08/2026 10:00:00");
});

test("an extension is only allowed in the eight hours either side of expiry", () => {
  const validUntil = "2026-08-26T18:30:00.000Z";
  const tooEarly = canExtendNow(validUntil, new Date("2026-08-26T06:00:00.000Z"), DEFAULT_EWAY_BILL_POLICY);
  assert.equal(tooEarly.ok, false);
  assert.match(tooEarly.explanation, /too early/);

  assert.equal(canExtendNow(validUntil, new Date("2026-08-26T14:00:00.000Z"), DEFAULT_EWAY_BILL_POLICY).ok, true);
  assert.equal(canExtendNow(validUntil, new Date("2026-08-27T01:00:00.000Z"), DEFAULT_EWAY_BILL_POLICY).ok, true);

  const tooLate = canExtendNow(validUntil, new Date("2026-08-27T06:00:00.000Z"), DEFAULT_EWAY_BILL_POLICY);
  assert.equal(tooLate.ok, false);
  assert.match(tooLate.explanation, /A fresh e-way bill has to be raised/);
});

test("time left is said in words a driver can act on", () => {
  assert.match(describeTimeLeft("2026-08-21T12:00:00.000Z", new Date("2026-08-21T10:30:00.000Z")), /1 hour left/);
  assert.match(describeTimeLeft("2026-08-21T10:00:00.000Z", new Date("2026-08-21T11:00:00.000Z")), /already run out/);
});

// ------------------------------------------- the lifecycle

test("a preview writes nothing and sends nothing", async () => {
  const desk = makeEwayDesk();
  const preview = await desk.service.preview(desk.actor, interStateMovement());
  assert.equal(preview.applicability.outcome, "REQUIRED");
  assert.equal(preview.ready, true);
  assert.equal(preview.vehicleReady, false);
  assert.equal(preview.validityDays, 5);
  assert.equal(desk.portal.numbers().length, 0);
  assert.equal(await desk.service.forMovement(desk.actor, "mov-001"), null);
});

test("Part A alone is never shown as a permit to move", async () => {
  const desk = makeEwayDesk();
  const record = await desk.service.generate(desk.actor, interStateMovement());
  assert.equal(record.status, "PART_A_ONLY");
  assert.equal(record.acknowledgement?.validUntil, undefined, "validity does not start without a vehicle");
  assert.match(record.message, /may not move until the vehicle number is added/);
});

test("validity starts when the vehicle goes on, and does not restart when it changes", async () => {
  const desk = makeEwayDesk();
  await desk.service.generate(desk.actor, interStateMovement());
  const active = await desk.service.updateVehicle(desk.actor, "mov-001", lorry());
  assert.equal(active.status, "ACTIVE");
  assert.ok(active.acknowledgement?.validUntil !== undefined);

  desk.clock.travelTo("2026-08-22T10:00:00.000Z");
  const swapped = await desk.service.updateVehicle(desk.actor, "mov-001", lorry({
    registrationNumber: "KA25CD5678", fromPlace: "Hubballi", reason: "BREAKDOWN", reasonNote: "Gearbox failure",
  }));
  assert.equal(swapped.acknowledgement?.validUntil, active.acknowledgement?.validUntil, "a breakdown does not buy more days");
  assert.deepEqual(swapped.vehicleLegs.map((leg) => leg.registrationNumber), ["KA01AB1234", "KA25CD5678"]);
  assert.equal(swapped.vehicleLegs[1]?.reason, "BREAKDOWN");
  assert.match(swapped.message, /validity has not restarted/);
});

test("raising the same movement twice cannot produce two e-way bills", async () => {
  const desk = makeEwayDesk();
  const first = await desk.service.generate(desk.actor, interStateMovement({ vehicle: lorry() }));
  const second = await desk.service.generate(desk.actor, interStateMovement({ vehicle: lorry() }));
  assert.equal(first.id, second.id);
  assert.equal(first.acknowledgement?.ewayBillNumber, second.acknowledgement?.ewayBillNumber);
  assert.equal(desk.portal.numbers().length, 1);
});

test("the portal's own duplicate reply is treated as success and its number kept", async () => {
  const desk = makeEwayDesk();
  const first = await desk.service.generate(desk.actor, interStateMovement({ vehicle: lorry() }));

  // A second movement carrying the same document: the portal answers 604 with the number it holds.
  const twin = interStateMovement({ movementId: "mov-001-again", vehicle: lorry() });
  const again = await desk.service.generate(desk.actor, twin);
  assert.equal(again.acknowledgement?.ewayBillNumber, first.acknowledgement?.ewayBillNumber);
  assert.match(again.message, /already had an e-way bill/);
  assert.equal(desk.portal.numbers().length, 1);
});

test("a movement that needs no e-way bill is refused rather than obliged", async () => {
  const desk = makeEwayDesk();
  await assert.rejects(
    () => desk.service.generate(desk.actor, intraStateMovement()),
    (error: unknown) => error instanceof DomainError && error.code === "EWAY_NOT_REQUIRED",
  );
  assert.equal(desk.portal.numbers().length, 0);
});

test("a movement we cannot decide is held back with the question, not sent", async () => {
  const desk = makeEwayDesk();
  await assert.rejects(
    () => desk.service.generate(desk.actor, interStateMovement({ billTo: { ...interStateMovement().billTo, stateCode: "" } })),
    (error: unknown) => error instanceof DomainError && error.code === "EWAY_CANNOT_DECIDE",
  );
});

test("a portal outage leaves a record saying we do not know, never ACTIVE", async () => {
  const desk = makeEwayDesk();
  desk.portal.setMode("outage");
  const failed = await desk.service.generate(desk.actor, interStateMovement({ vehicle: lorry() }));
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.failure?.retryable, true);
  assert.match(failed.message, /must not leave yet/);

  // And asking the portal afterwards is how the doubt is settled.
  desk.portal.setMode("healthy");
  const retried = await desk.service.generate(desk.actor, interStateMovement({ vehicle: lorry() }));
  assert.equal(retried.status, "ACTIVE");
  assert.equal(desk.portal.numbers().length, 1);
});

test("reconciling after a timeout tells us what the portal actually holds", async () => {
  const desk = makeEwayDesk();
  const raised = await desk.service.generate(desk.actor, interStateMovement({ vehicle: lorry() }));
  const reconciled = await desk.service.reconcile(desk.actor, "mov-001");
  assert.equal(reconciled.status, "ACTIVE");
  assert.equal(reconciled.acknowledgement?.ewayBillNumber, raised.acknowledgement?.ewayBillNumber);
});

test("an expired bill reads as expired the moment it is looked at", async () => {
  const desk = makeEwayDesk();
  await desk.service.generate(desk.actor, interStateMovement({ vehicle: lorry() }));
  desk.clock.travelTo("2026-09-02T10:00:00.000Z");
  const expired = await desk.service.forMovement(desk.actor, "mov-001");
  assert.equal(expired?.status, "EXPIRED");
  assert.match(expired?.message ?? "", /Goods must not move on it/);
  await assert.rejects(
    () => desk.service.updateVehicle(desk.actor, "mov-001", lorry({ registrationNumber: "KA25CD5678" })),
    (error: unknown) => error instanceof DomainError && error.code === "EWAY_EXPIRED",
  );
});

test("validity can be extended in the portal's window and not outside it", async () => {
  const desk = makeEwayDesk();
  const active = await desk.service.generate(desk.actor, interStateMovement({ vehicle: lorry() }));
  const expiry = new Date(active.acknowledgement?.validUntil ?? "");

  desk.clock.travelTo(new Date(expiry.getTime() - 20 * 3_600_000).toISOString());
  await assert.rejects(
    () => desk.service.extendValidity(desk.actor, "mov-001", { currentPlace: "Solapur", currentStateCode: "27", remainingDistanceKm: 120, reason: "Held up at a check post" }),
    (error: unknown) => error instanceof DomainError && error.code === "EWAY_EXTENSION_WINDOW",
  );

  desk.clock.travelTo(new Date(expiry.getTime() - 2 * 3_600_000).toISOString());
  const extended = await desk.service.extendValidity(desk.actor, "mov-001", {
    currentPlace: "Solapur", currentStateCode: "27", remainingDistanceKm: 120, reason: "Held up at a check post",
  });
  assert.equal(extended.status, "ACTIVE");
  assert.ok(new Date(extended.acknowledgement?.validUntil ?? "").getTime() > expiry.getTime());
  assert.match(extended.message, /Held up at a check post/);
});

test("cancellation is refused after the portal's 24 hours, in words a person can act on", async () => {
  const desk = makeEwayDesk();
  await desk.service.generate(desk.actor, interStateMovement({ vehicle: lorry() }));
  desk.clock.travelTo("2026-08-22T12:00:00.000Z");
  await assert.rejects(
    () => desk.service.cancel(desk.actor, "mov-001", { reasonCode: "ORDER_CANCELLED", reason: "Customer called it off" }),
    (error: unknown) => error instanceof DomainError && error.code === "EWAY_WINDOW_CLOSED",
  );
});

test("the portal is the authority: its refusal is honoured even when our own window is open", async () => {
  const desk = makeEwayDesk();
  // A company policy that thinks it has two days. The portal still allows only one.
  desk.policies.set(desk.actor.companyId, { ...DEFAULT_EWAY_BILL_POLICY, cancellationWindowHours: 48, effectiveFrom: "2026-04-01" });
  await desk.service.generate(desk.actor, interStateMovement({ vehicle: lorry() }));
  desk.clock.travelTo("2026-08-22T12:00:00.000Z");
  await assert.rejects(
    () => desk.service.cancel(desk.actor, "mov-001", { reasonCode: "ORDER_CANCELLED", reason: "Customer called it off" }),
    (error: unknown) => error instanceof DomainError && error.code === "EWAY_CANCEL_REFUSED",
  );
});

test("a consignment an officer has checked on the road can never be cancelled", async () => {
  const desk = makeEwayDesk();
  const active = await desk.service.generate(desk.actor, interStateMovement({ vehicle: lorry() }));
  desk.portal.markVerifiedInTransit(active.acknowledgement?.ewayBillNumber ?? "");
  await assert.rejects(
    () => desk.service.cancel(desk.actor, "mov-001", { reasonCode: "DATA_ENTRY_MISTAKE", reason: "Wrong buyer" }),
    (error: unknown) => error instanceof DomainError && error.code === "EWAY_CANCEL_REFUSED",
  );
});

test("cancelling needs a reason, and a wrong bill is cancelled and raised again", async () => {
  const desk = makeEwayDesk();
  const wrong = await desk.service.generate(desk.actor, interStateMovement({ vehicle: lorry() }));
  await assert.rejects(
    () => desk.service.cancel(desk.actor, "mov-001", { reasonCode: "DATA_ENTRY_MISTAKE", reason: "  " }),
    (error: unknown) => error instanceof DomainError && error.code === "EWAY_CANCEL_REASON_REQUIRED",
  );

  const cancelled = await desk.service.cancel(desk.actor, "mov-001", {
    reasonCode: "DATA_ENTRY_MISTAKE", reason: "The buyer's GST number was typed wrong",
  });
  assert.equal(cancelled.status, "CANCELLED");
  assert.match(cancelled.message, /must not move on it/);

  // The corrected consignment is a new movement with a new document, and gets its own number.
  const corrected = await desk.service.generate(desk.actor, interStateMovement({
    movementId: "mov-001-fixed",
    documents: [worth(80_000_00n, { documentNumber: "SAM/2026/0117-A" })],
    vehicle: lorry(),
  }));
  assert.equal(corrected.status, "ACTIVE");
  assert.notEqual(corrected.acknowledgement?.ewayBillNumber, wrong.acknowledgement?.ewayBillNumber);
  assert.equal(desk.portal.numbers().length, 2);
});

test("the other party can reject a consignment inside 72 hours and not after", async () => {
  const desk = makeEwayDesk();
  await desk.service.generate(desk.actor, interStateMovement({ vehicle: lorry() }));
  desk.clock.travelTo("2026-08-22T10:00:00.000Z");
  const rejected = await desk.service.reject(desk.actor, "mov-001", {
    reasonCode: "NOT_MY_CONSIGNMENT", reason: "We never ordered this steel",
  });
  assert.equal(rejected.status, "REJECTED");
  assert.match(rejected.message, /not your consignment/);

  const late = makeEwayDesk();
  await late.service.generate(late.actor, interStateMovement({ vehicle: lorry() }));
  late.clock.travelTo("2026-08-26T10:00:00.000Z");
  await assert.rejects(
    () => late.service.reject(late.actor, "mov-001", { reasonCode: "NOT_MY_CONSIGNMENT", reason: "Not ours" }),
    (error: unknown) => error instanceof DomainError && error.code === "EWAY_REJECT_WINDOW_CLOSED",
  );
});

test("several consignments on one lorry get one trip sheet, and keep their own bills", async () => {
  const desk = makeEwayDesk();
  const first = await desk.service.generate(desk.actor, interStateMovement({ vehicle: lorry() }));
  const second = await desk.service.generate(desk.actor, interStateMovement({
    movementId: "mov-004",
    documents: [worth(90_000_00n, { documentNumber: "SAM/2026/0120" })],
    vehicle: lorry(),
  }));

  const trip = await desk.service.consolidate(desk.actor, {
    vehicleNumber: "KA01AB1234", fromPlace: "Bengaluru", fromStateCode: "29",
    transportMode: "ROAD", movementIds: ["mov-001", "mov-004"],
  });
  assert.equal(trip.ewayBillNumbers.length, 2);
  assert.match(trip.message, /keeps its own e-way bill and its own expiry/);

  const after = await desk.service.forMovement(desk.actor, "mov-001");
  assert.equal(after?.consolidatedTripNumber, trip.tripNumber);
  assert.equal(after?.acknowledgement?.ewayBillNumber, first.acknowledgement?.ewayBillNumber);
  assert.notEqual(first.acknowledgement?.ewayBillNumber, second.acknowledgement?.ewayBillNumber);
});

test("a trip sheet will not carry a consignment whose bill is not live", async () => {
  const desk = makeEwayDesk();
  await desk.service.generate(desk.actor, interStateMovement({ vehicle: lorry() }));
  await desk.service.generate(desk.actor, interStateMovement({
    movementId: "mov-004", documents: [worth(90_000_00n, { documentNumber: "SAM/2026/0120" })], vehicle: lorry(),
  }));
  await desk.service.cancel(desk.actor, "mov-004", { reasonCode: "DUPLICATE", reason: "Raised twice by mistake" });

  await assert.rejects(
    () => desk.service.consolidate(desk.actor, {
      vehicleNumber: "KA01AB1234", fromPlace: "Bengaluru", fromStateCode: "29",
      transportMode: "ROAD", movementIds: ["mov-001", "mov-004"],
    }),
    (error: unknown) => error instanceof DomainError && error.code === "EWAY_CONSOLIDATION_NOT_LIVE",
  );
});

// ------------------------------------------- permissions, tenancy and the audit trail

test("raising, changing and cancelling are three separate permissions", async () => {
  const readOnly = makeEwayDesk({ permissions: ["eway.view"] });
  await assert.rejects(
    () => readOnly.service.generate(readOnly.actor, interStateMovement({ vehicle: lorry() })),
    (error: unknown) => error instanceof DomainError && error.code === "PERMISSION_DENIED",
  );

  const desk = makeEwayDesk();
  await desk.service.generate(desk.actor, interStateMovement({ vehicle: lorry() }));
  const noCancel = actorWith(["eway.view", "eway.generate", "eway.update"]);
  await assert.rejects(
    () => desk.service.cancel(noCancel, "mov-001", { reasonCode: "OTHERS", reason: "Changed my mind" }),
    (error: unknown) => error instanceof DomainError && error.code === "PERMISSION_DENIED",
  );
});

test("one company cannot see another company's e-way bills", async () => {
  const desk = makeEwayDesk();
  await desk.service.generate(desk.actor, interStateMovement({ vehicle: lorry() }));
  const stranger = actorWith(ALL_EWAY_PERMISSIONS, "someone-else" as typeof desk.actor.companyId);
  assert.equal(await desk.service.forMovement(stranger, "mov-001"), null);
  assert.deepEqual(await desk.service.list(stranger), []);
});

test("every material act is on the audit trail, with the reason where one was given", async () => {
  const desk = makeEwayDesk();
  await desk.service.generate(desk.actor, interStateMovement({ vehicle: lorry() }));
  await desk.service.cancel(desk.actor, "mov-001", { reasonCode: "ORDER_CANCELLED", reason: "Customer called it off" });
  const events = desk.audit.events;
  const actions = events.map((event) => event.action);
  assert.ok(actions.includes("eway.generated"));
  assert.ok(actions.includes("eway.cancelled"));
  const cancelled = events.find((event) => event.action === "eway.cancelled");
  assert.equal(cancelled?.overrideReason, "Customer called it off");
  // The signed reply and the reason belong on the record; nothing secret does.
  assert.equal(JSON.stringify(events).includes("vault://"), false);
});

test("what is on the road, and what runs out soon", async () => {
  const desk = makeEwayDesk();
  await desk.service.generate(desk.actor, interStateMovement({ vehicle: lorry() }));
  const road = await desk.service.onTheRoad(desk.actor);
  assert.equal(road.length, 1);
  assert.match(road[0]?.timeLeft ?? "", /left\./);

  const soon = await desk.service.expiringWithin(desk.actor, 24 * 7);
  assert.equal(soon.length, 1);
  assert.equal((await desk.service.expiringWithin(desk.actor, 1)).length, 0);
});
