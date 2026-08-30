/**
 * Issue #28 [E28] acceptance criteria, enforced automatically.
 *
 *  - "Obvious class/capacity mismatch is detected"
 *  - "Unavailable government data is distinguished from a valid result"
 *  - "Override never edits source evidence"
 *
 * plus the required scooter, private car and goods vehicle scenarios, the capacity boundary,
 * missing-data cases and the number-plate photograph comparison.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "@invoice/kernel";
import { checkVehicleSuitability, payloadCapacityOf } from "../src/suitability.ts";
import { comparePlateReading } from "../src/plate.ts";
import { DEFAULT_VEHICLE_SUITABILITY_POLICY } from "../src/suitability-types.ts";
import { outstandingOf } from "../src/suitability-service.ts";
import { platePhoto } from "../src/suitability-adapters.ts";
import {
  ALL_VEHICLE_PERMISSIONS, actorWith, fiveTonneShipment, makeVehicleDesk, transportDetails,
} from "../src/fixtures.ts";
import type { VehicleEvidence } from "../src/suitability-types.ts";

const government = (over: Partial<VehicleEvidence>): VehicleEvidence => ({
  registrationNumber: "KA01AB1234",
  source: "GOVERNMENT_RECORD",
  retrievedAt: "2026-08-21T04:30:00.000Z",
  ...over,
});

const codes = (result: { readonly findings: readonly { readonly code: string }[] }): string[] =>
  result.findings.map((finding) => finding.code);

// ------------------------------------------------------------ class: the scooter and the car

test("five tonnes on a scooter is blocked, and the block cannot be overridden", () => {
  const result = checkVehicleSuitability({
    transport: transportDetails({ vehicleNumber: "KA05MN9012" }),
    shipment: fiveTonneShipment(),
    record: { kind: "FOUND", evidence: government({ registrationNumber: "KA05MN9012", vehicleClass: "TWO_WHEELER", bodyType: "two_wheeler" }) },
  });

  assert.equal(result.outcome, "BLOCK");
  const finding = result.findings.find((row) => row.code === "VEHICLE.CLASS.NOT_GOODS_CARRYING");
  assert.ok(finding, "a two-wheeler carrying a consignment must be found");
  assert.equal(finding?.overridable, false, "no authorisation makes a scooter able to carry five tonnes");
  // The facts that decided it travel with the decision.
  assert.deepEqual(finding?.appliedFacts.map((fact) => fact.label), ["Vehicle class", "Where that came from", "Weight being loaded"]);
});

test("a private car is not a small goods vehicle", () => {
  const result = checkVehicleSuitability({
    transport: transportDetails({ vehicleNumber: "KA03MC4455" }),
    shipment: { grossWeightKg: 120 },
    record: { kind: "FOUND", evidence: government({ registrationNumber: "KA03MC4455", vehicleClass: "MOTOR_CAR", bodyType: "closed" }) },
  });

  assert.equal(result.outcome, "BLOCK");
  assert.ok(codes(result).includes("VEHICLE.CLASS.NOT_GOODS_CARRYING"));
  // Even a light load: the point is the class, not the weight.
  assert.ok(result.summary.includes("cannot go out as it stands"));
});

test("a goods vehicle carrying what it is rated for passes with nothing found", () => {
  const result = checkVehicleSuitability({
    transport: transportDetails(),
    shipment: { grossWeightKg: 5_000 },
    record: { kind: "FOUND", evidence: government({ vehicleClass: "HEAVY_GOODS_VEHICLE", bodyType: "open", ratedPayloadKg: 16_400, permitType: "NATIONAL", permitValidUpto: "2028-03-31", fitnessValidUpto: "2027-11-30", insuranceValidUpto: "2027-07-31", registrationStatus: "ACTIVE" }) },
  });

  assert.equal(result.outcome, "OK", result.findings.map((finding) => `${finding.code}: ${finding.reason}`).join("\n"));
});

// --------------------------------------------------------------- capacity, and its boundary

test("a small goods vehicle above its recorded capacity is caught, and can be overridden", () => {
  const result = checkVehicleSuitability({
    transport: transportDetails({ vehicleNumber: "KA02GV3344", interState: false }),
    shipment: fiveTonneShipment(),
    record: { kind: "FOUND", evidence: government({ registrationNumber: "KA02GV3344", vehicleClass: "LIGHT_GOODS_VEHICLE", bodyType: "closed", ratedPayloadKg: 1_250 }) },
  });

  const finding = result.findings.find((row) => row.code === "VEHICLE.CAPACITY.EXCEEDED");
  assert.equal(result.outcome, "BLOCK");
  assert.ok(finding?.reason.includes("3,750 kg"), `the shortfall should be spelled out: ${finding?.reason}`);
  assert.equal(finding?.overridable, true, "a recorded capacity can be out of date, so a person may answer for it");
  assert.equal(finding?.evidenceSource, "GOVERNMENT_RECORD");
});

test("exactly at capacity is not over capacity, and one kilogram more is", () => {
  const at = (grossWeightKg: number) => checkVehicleSuitability({
    transport: transportDetails({ vehicleNumber: "KA02GV3344" }),
    shipment: { grossWeightKg },
    record: { kind: "FOUND", evidence: government({ registrationNumber: "KA02GV3344", vehicleClass: "LIGHT_GOODS_VEHICLE", ratedPayloadKg: 1_250, permitType: "NATIONAL" }) },
  });

  assert.ok(!codes(at(1_250)).includes("VEHICLE.CAPACITY.EXCEEDED"), "1,250 kg in a 1,250 kg lorry is what it is rated for");
  assert.ok(codes(at(1_251)).includes("VEHICLE.CAPACITY.EXCEEDED"));
  // The last stretch before the limit is a warning, never a block.
  const near = at(1_200);
  assert.equal(near.outcome, "WARN");
  assert.ok(codes(near).includes("VEHICLE.CAPACITY.NEAR_LIMIT"));
});

test("capacity is worked out from gross minus unladen weight, and says so", () => {
  const capacity = payloadCapacityOf([government({ grossVehicleWeightKg: 2_590, unladenWeightKg: 1_340 })]);
  assert.equal(capacity?.capacityKg, 1_250);
  assert.match(capacity?.basis ?? "", /gross vehicle weight/);
});

test("the government's capacity is preferred over the company's own note", () => {
  const capacity = payloadCapacityOf([
    { registrationNumber: "KA01AB1234", source: "COMPANY_MASTER", retrievedAt: "2026-08-01T00:00:00.000Z", ratedPayloadKg: 9_000 },
    government({ ratedPayloadKg: 1_250 }),
  ]);
  assert.equal(capacity?.capacityKg, 1_250);
  assert.equal(capacity?.source, "GOVERNMENT_RECORD");
});

test("a load too heavy for the whole class is blocked even with no capacity on record", () => {
  const result = checkVehicleSuitability({
    transport: transportDetails({ vehicleNumber: "KA02GV3344" }),
    shipment: fiveTonneShipment({ grossWeightKg: 9_000 }),
    record: { kind: "FOUND", evidence: government({ registrationNumber: "KA02GV3344", vehicleClass: "LIGHT_GOODS_VEHICLE" }) },
  });

  const finding = result.findings.find((row) => row.code === "VEHICLE.CLASS.OVER_CEILING");
  assert.equal(result.outcome, "BLOCK");
  assert.ok(finding?.reason.includes("7,500 kg"), "the class ceiling that decided it must be shown");
  // And the "we do not know this vehicle's capacity" note is not repeated on top of it.
  assert.ok(!codes(result).includes("VEHICLE.CAPACITY.UNKNOWN"));
});

// ------------------------------------------------------------------------- missing facts

test("a load with no weight is not a pass", () => {
  const result = checkVehicleSuitability({
    transport: transportDetails(),
    shipment: {},
    record: { kind: "FOUND", evidence: government({ vehicleClass: "HEAVY_GOODS_VEHICLE", ratedPayloadKg: 16_400, permitType: "NATIONAL" }) },
  });

  assert.equal(result.outcome, "CANNOT_DECIDE");
  assert.ok(codes(result).includes("SHIPMENT.WEIGHT.MISSING"));
  assert.ok(result.summary.includes("This is not a pass"));
});

test("a vehicle with no capacity anywhere is undecided, not fine", () => {
  const result = checkVehicleSuitability({
    transport: transportDetails({ vehicleNumber: "KA09ZZ7777" }),
    shipment: { grossWeightKg: 900 },
    record: { kind: "FOUND", evidence: government({ registrationNumber: "KA09ZZ7777", vehicleClass: "LIGHT_GOODS_VEHICLE", permitType: "NATIONAL" }) },
  });

  assert.equal(result.outcome, "CANNOT_DECIDE");
  assert.ok(codes(result).includes("VEHICLE.CAPACITY.UNKNOWN"));
});

test("an unreachable authority is told apart from a vehicle it does not hold", () => {
  const down = checkVehicleSuitability({
    transport: transportDetails(),
    shipment: { grossWeightKg: 900 },
    record: { kind: "UNAVAILABLE", code: "OUTAGE", message: "The vehicle record service is not responding at the moment.", retryable: true, checkedAt: "2026-08-21T04:30:00.000Z" },
  });
  const absent = checkVehicleSuitability({
    transport: transportDetails(),
    shipment: { grossWeightKg: 900 },
    record: { kind: "NOT_FOUND", checkedAt: "2026-08-21T04:30:00.000Z", message: "no such vehicle" },
  });

  assert.equal(down.outcome, "CANNOT_DECIDE");
  const outage = down.findings.find((row) => row.code === "VEHICLE.RECORD.UNAVAILABLE");
  assert.equal(outage?.severity, "CANNOT_DECIDE");
  assert.ok(outage?.reason.includes("not the same as the vehicle being fine"));

  const missing = absent.findings.find((row) => row.code === "VEHICLE.RECORD.NOT_FOUND");
  assert.equal(missing?.severity, "WARN", "the authority answered; this is a fact about the lorry");
  assert.equal(missing?.evidenceSource, "GOVERNMENT_RECORD");
  assert.ok(!codes(absent).includes("VEHICLE.RECORD.UNAVAILABLE"));
});

// --------------------------------------------------------- transport details on the movement

test("a vehicle number the portal would refuse is blocked before anything is sent", () => {
  const result = checkVehicleSuitability({ transport: transportDetails({ vehicleNumber: "KA-1234" }), shipment: { grossWeightKg: 100 } });
  const finding = result.findings.find((row) => row.code === "TRANSPORT.VEHICLE_NUMBER.FORMAT");
  assert.equal(finding?.severity, "BLOCK");
  assert.equal(finding?.overridable, false);
});

test("a transporter ID that is neither a GSTIN nor a 15-character ID is refused", () => {
  const result = checkVehicleSuitability({ transport: transportDetails({ transporterId: "DECCAN" }), shipment: { grossWeightKg: 100 } });
  assert.ok(codes(result).includes("TRANSPORT.TRANSPORTER_ID.FORMAT"));
});

test("a distance outside the portal's range is caught, and a half-entered goods receipt warns", () => {
  // A goods receipt with a number and no date: half a document, which is worth saying.
  const { transportDocumentDate: _noDate, ...withoutDate } = transportDetails({ distanceKm: 5_000 });
  const result = checkVehicleSuitability({ transport: withoutDate, shipment: { grossWeightKg: 100 } });
  assert.ok(codes(result).includes("TRANSPORT.DISTANCE.RANGE"));
  assert.ok(codes(result).includes("TRANSPORT.DOCUMENT.INCOMPLETE"));
});

test("no vehicle yet is a question, not a mismatch", () => {
  const result = checkVehicleSuitability({ transport: transportDetails({ vehicleNumber: "" }), shipment: { grossWeightKg: 100 } });
  const finding = result.findings.find((row) => row.code === "TRANSPORT.VEHICLE_NUMBER.MISSING");
  assert.equal(finding?.severity, "CANNOT_DECIDE");
});

// ------------------------------------------------------------------- papers and body type

test("a state permit does not cross a state border", () => {
  const result = checkVehicleSuitability({
    transport: transportDetails({ vehicleNumber: "KA02GV3344", interState: true }),
    shipment: { grossWeightKg: 800 },
    record: { kind: "FOUND", evidence: government({ registrationNumber: "KA02GV3344", vehicleClass: "LIGHT_GOODS_VEHICLE", ratedPayloadKg: 1_250, permitType: "STATE", permitValidUpto: "2027-03-31" }) },
  });
  const finding = result.findings.find((row) => row.code === "VEHICLE.PERMIT.WRONG_KIND");
  assert.equal(finding?.severity, "WARN");
  assert.ok(finding?.reason.includes("national permit"));
});

test("an expired fitness certificate is read as at the day the goods move", () => {
  const evidence = government({ vehicleClass: "HEAVY_GOODS_VEHICLE", ratedPayloadKg: 16_400, permitType: "NATIONAL", fitnessValidUpto: "2026-08-20" });
  const after = checkVehicleSuitability({ transport: transportDetails({ movementDate: "2026-08-21" }), shipment: { grossWeightKg: 900 }, record: { kind: "FOUND", evidence } });
  const before = checkVehicleSuitability({ transport: transportDetails({ movementDate: "2026-08-19" }), shipment: { grossWeightKg: 900 }, record: { kind: "FOUND", evidence } });

  assert.ok(codes(after).includes("VEHICLE.FITNESS.EXPIRED"));
  assert.ok(!codes(before).includes("VEHICLE.FITNESS.EXPIRED"), "a movement before the expiry is judged by that day");
});

test("goods that must stay cold are blocked off a vehicle with no fridge", () => {
  const result = checkVehicleSuitability({
    transport: transportDetails(),
    shipment: { grossWeightKg: 900, requiresColdChain: true },
    record: { kind: "FOUND", evidence: government({ vehicleClass: "HEAVY_GOODS_VEHICLE", bodyType: "open", ratedPayloadKg: 16_400, permitType: "NATIONAL" }) },
  });
  assert.ok(codes(result).includes("VEHICLE.BODY.NOT_REFRIGERATED"));
});

test("a registration that is not live blocks, whatever else is right", () => {
  const result = checkVehicleSuitability({
    transport: transportDetails(),
    shipment: { grossWeightKg: 900 },
    record: { kind: "FOUND", evidence: government({ vehicleClass: "HEAVY_GOODS_VEHICLE", ratedPayloadKg: 16_400, permitType: "NATIONAL", registrationStatus: "SCRAPPED" }) },
  });
  const finding = result.findings.find((row) => row.code === "VEHICLE.REGISTRATION.NOT_ACTIVE");
  assert.equal(finding?.severity, "BLOCK");
  assert.equal(finding?.overridable, false);
});

// -------------------------------------------------------------- the number-plate photograph

test("a plate photograph that reads as a different lorry is a mismatch", () => {
  const comparison = comparePlateReading({ text: "KA02GV3344", confidence: 0.93 }, "KA01AB1234", 0.6);
  assert.equal(comparison.verdict, "MISMATCH");
});

test("a difference only in look-alike characters is a second look, not a mismatch", () => {
  const comparison = comparePlateReading({ text: "KAO1AB1Z34", confidence: 0.88 }, "KA01AB1234", 0.6);
  assert.equal(comparison.verdict, "LOOKALIKE_DIFFERENCE", comparison.explanation);
});

test("a blurred photograph is unreadable, which is neither a pass nor a mismatch", () => {
  const low = comparePlateReading({ text: "KA01AB1234", confidence: 0.4 }, "KA01AB1234", 0.6);
  assert.equal(low.verdict, "CANNOT_READ");
  assert.ok(low.explanation.includes("40%"));
});

test("a plate that matches says so plainly", () => {
  assert.equal(comparePlateReading({ text: "ka 01 ab 1234", confidence: 0.97 }, "KA01AB1234", 0.6).verdict, "MATCH");
});

// ------------------------------------------------------------------- the service end to end

test("the desk checks a movement, keeps the evidence, and a retry returns the same check", async () => {
  const desk = makeVehicleDesk();
  const request = {
    movementId: "mov-001",
    transport: transportDetails({ vehicleNumber: "KA02GV3344" }),
    shipment: fiveTonneShipment(),
  };

  const first = await desk.service.assess(desk.actor, request);
  const again = await desk.service.assess(desk.actor, request);

  assert.equal(first.outcome, "BLOCK");
  assert.equal(again.id, first.id, "pressing the button twice must not make a second row in the queue");
  assert.equal((await desk.records.list(desk.actor.companyId)).length, 1);
  // The government's reading is kept exactly as it came, with its source on it.
  assert.equal(first.evidence[0]?.source, "GOVERNMENT_RECORD");
  assert.equal(first.evidence[0]?.ratedPayloadKg, 1_250);
  assert.equal(first.clearedToMove, false);
});

test("an override records who, when and why, and leaves the evidence exactly as it was", async () => {
  const desk = makeVehicleDesk();
  const checked = await desk.service.assess(desk.actor, {
    movementId: "mov-002",
    transport: transportDetails({ vehicleNumber: "KA02GV3344" }),
    shipment: fiveTonneShipment(),
  });

  const after = await desk.service.override(desk.actor, checked.id, {
    findingCodes: ["VEHICLE.CAPACITY.EXCEEDED"],
    reason: "Weighbridge slip shows 1,180 kg; the five tonnes was a data entry error and the load has been reweighed.",
  });

  // The evidence, the findings and the capacity are untouched by the override.
  assert.deepEqual(after.evidence, checked.evidence);
  assert.deepEqual(after.findings, checked.findings);
  assert.deepEqual(after.capacity, checked.capacity);
  assert.equal(after.outcome, "BLOCK", "the check still says what it found; the override sits beside it");
  assert.equal(after.clearedToMove, true);
  assert.equal(after.overrides.length, 1);
  assert.equal(after.overrides[0]?.byUserId, desk.actor.userId);
  assert.match(after.overrides[0]?.reason ?? "", /weighbridge/i);

  // And the audit trail carries the reason, the actor and the moment.
  const entry = desk.audit.events.find((event) => event.action === "transport.vehicle.overridden");
  assert.equal(entry?.overrideReason, after.overrides[0]?.reason);
  assert.equal(entry?.actorId, desk.actor.userId);
  assert.equal(entry?.details?.vehicle, "KA02GV3344");
});

test("what cannot be overridden cannot be overridden", async () => {
  const desk = makeVehicleDesk();
  const checked = await desk.service.assess(desk.actor, {
    movementId: "mov-003",
    transport: transportDetails({ vehicleNumber: "KA05MN9012" }),
    shipment: fiveTonneShipment(),
  });

  await assert.rejects(
    () => desk.service.override(desk.actor, checked.id, { findingCodes: ["VEHICLE.CLASS.NOT_GOODS_CARRYING"], reason: "The manager says it is fine to send it." }),
    (error: unknown) => error instanceof DomainError && error.code === "VEHICLE_OVERRIDE_NOT_ALLOWED",
  );
});

test("an override needs a real reason and named findings", async () => {
  const desk = makeVehicleDesk();
  const checked = await desk.service.assess(desk.actor, {
    movementId: "mov-004",
    transport: transportDetails({ vehicleNumber: "KA02GV3344" }),
    shipment: fiveTonneShipment(),
  });

  await assert.rejects(
    () => desk.service.override(desk.actor, checked.id, { findingCodes: ["VEHICLE.CAPACITY.EXCEEDED"], reason: "ok" }),
    (error: unknown) => error instanceof DomainError && error.code === "VEHICLE_OVERRIDE_REASON",
  );
  await assert.rejects(
    () => desk.service.override(desk.actor, checked.id, { findingCodes: [], reason: "Everything about this is fine, honestly." }),
    (error: unknown) => error instanceof DomainError && error.code === "VEHICLE_OVERRIDE_EMPTY",
  );
  await assert.rejects(
    () => desk.service.override(desk.actor, checked.id, { findingCodes: ["VEHICLE.PERMIT.EXPIRED"], reason: "The permit was renewed last week and the record is stale." }),
    (error: unknown) => error instanceof DomainError && error.code === "VEHICLE_OVERRIDE_UNKNOWN",
  );
});

test("checking and overriding are different permissions, and neither is implied", async () => {
  const desk = makeVehicleDesk({ permissions: ["transport.vehicle.check"] });
  const checked = await desk.service.assess(desk.actor, {
    movementId: "mov-005",
    transport: transportDetails({ vehicleNumber: "KA02GV3344" }),
    shipment: fiveTonneShipment(),
  });

  await assert.rejects(
    () => desk.service.override(desk.actor, checked.id, { findingCodes: ["VEHICLE.CAPACITY.EXCEEDED"], reason: "The load has been reweighed at 1,100 kg on our own weighbridge." }),
    (error: unknown) => error instanceof DomainError && error.kind === "FORBIDDEN",
  );
  // And somebody with neither permission cannot even run the check.
  await assert.rejects(
    () => desk.service.assess(actorWith([]), { movementId: "mov-006", transport: transportDetails(), shipment: fiveTonneShipment() }),
    (error: unknown) => error instanceof DomainError && error.kind === "FORBIDDEN",
  );
});

test("one company can never read another's vehicle checks", async () => {
  const desk = makeVehicleDesk();
  const checked = await desk.service.assess(desk.actor, {
    movementId: "mov-007",
    transport: transportDetails({ vehicleNumber: "KA02GV3344" }),
    shipment: fiveTonneShipment(),
  });

  const stranger = actorWith(ALL_VEHICLE_PERMISSIONS, "another-shop" as typeof desk.actor.companyId);
  assert.equal(await desk.service.latestForMovement(stranger, "mov-007"), null);
  await assert.rejects(
    () => desk.service.override(stranger, checked.id, { findingCodes: ["VEHICLE.CAPACITY.EXCEEDED"], reason: "Nothing about this movement belongs to us." }),
    (error: unknown) => error instanceof DomainError && error.kind === "NOT_FOUND",
  );
});

test("the authority being down puts the movement in the queue rather than passing it", async () => {
  const desk = makeVehicleDesk();
  desk.authority.goDown();

  const checked = await desk.service.assess(desk.actor, {
    movementId: "mov-008",
    transport: transportDetails(),
    shipment: { grossWeightKg: 900 },
  });

  assert.equal(checked.outcome, "CANNOT_DECIDE");
  assert.equal(checked.clearedToMove, false);
  assert.equal((await desk.service.blocked(desk.actor)).length, 1);
  assert.deepEqual(outstandingOf(checked.findings, checked.overrides).map((finding) => finding.code).sort(), ["VEHICLE.CAPACITY.UNKNOWN", "VEHICLE.RECORD.UNAVAILABLE"]);
});

test("a photograph of the wrong lorry blocks the movement", async () => {
  const desk = makeVehicleDesk();
  const checked = await desk.service.assess(desk.actor, {
    movementId: "mov-009",
    transport: transportDetails(),
    shipment: { grossWeightKg: 900 },
    platePhoto: platePhoto("plate:KA02GV3344@0.94", "2026-08-21T04:25:00.000Z"),
  });

  assert.equal(checked.plate?.verdict, "MISMATCH");
  assert.equal(checked.outcome, "BLOCK");
  assert.equal(checked.plate?.photoId, "plate:KA02GV3344@0.94");
  assert.ok(codes(checked).includes("VEHICLE.PLATE.MISMATCH"));
});

test("a plate reader that is down is not a mismatch", async () => {
  const desk = makeVehicleDesk();
  desk.plateReader.willReturn({ kind: "UNAVAILABLE", code: "OUTAGE", message: "The plate reader is not responding.", retryable: true });

  const checked = await desk.service.assess(desk.actor, {
    movementId: "mov-010",
    transport: transportDetails(),
    shipment: { grossWeightKg: 900 },
    platePhoto: platePhoto("plate:KA01AB1234@0.99", "2026-08-21T04:25:00.000Z"),
  });

  assert.equal(checked.plate?.verdict, "CANNOT_READ");
  assert.equal(checked.outcome, "CANNOT_DECIDE");
  assert.ok(codes(checked).includes("VEHICLE.PLATE.UNREADABLE"));
});

test("the company's own vehicle list is used where the authority holds nothing, and is labelled as such", async () => {
  const desk = makeVehicleDesk({
    vehicles: [{
      id: "veh-1", companyId: "sampoorna", registrationNumber: "KA09OW5566", vehicleType: "regular",
      bodyType: "closed", ratedCapacityKg: 1_500, active: true,
    }],
  });

  const checked = await desk.service.assess(desk.actor, {
    movementId: "mov-011",
    transport: transportDetails({ vehicleNumber: "KA09OW5566" }),
    shipment: { grossWeightKg: 2_000 },
  });

  const finding = checked.findings.find((row) => row.code === "VEHICLE.CAPACITY.EXCEEDED");
  assert.equal(finding?.evidenceSource, "COMPANY_MASTER");
  assert.ok(finding?.reason.includes("1,500 kg"));
  // And the authority not holding the vehicle is still said, separately, as its own warning.
  assert.ok(codes(checked).includes("VEHICLE.RECORD.NOT_FOUND"));
});

test("a business may soften the overload rule, and the change is in policy rather than in code", async () => {
  const desk = makeVehicleDesk();
  desk.policies.set(desk.actor.companyId, { ...DEFAULT_VEHICLE_SUITABILITY_POLICY, overloadSeverity: "WARN", effectiveFrom: "2026-04-01" });

  const checked = await desk.service.assess(desk.actor, {
    movementId: "mov-012",
    transport: transportDetails({ vehicleNumber: "KA02GV3344", interState: false }),
    shipment: { grossWeightKg: 2_000 },
  });

  assert.equal(checked.findings.find((row) => row.code === "VEHICLE.CAPACITY.EXCEEDED")?.severity, "WARN");
  assert.equal(checked.outcome, "WARN");
  assert.equal(checked.clearedToMove, true);
});
