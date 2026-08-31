/**
 * Issue #28 [E28] — the load, the lorry and everything that can be wrong between them.
 *
 *   npm run demo:vehicle
 *
 * Sampoorna Traders of Bengaluru is sending five tonnes of steel out. Every line below comes from
 * the real rules and the real service; the registering authority and the number-plate reader are
 * synthetic stand-ins, so nothing here needs a credential or a network.
 */
import { platePhoto } from "./suitability-adapters.ts";
import { outstandingOf } from "./suitability-service.ts";
import { fiveTonneShipment, makeVehicleDesk, transportDetails } from "./fixtures.ts";
import type { VehicleSuitabilityAssessment } from "./suitability-types.ts";

const heading = (text: string): void => console.log(`\n${text}\n${"─".repeat(text.length)}`);

const show = (assessment: VehicleSuitabilityAssessment): void => {
  console.log(`  → ${assessment.outcome}${assessment.clearedToMove ? " · may go" : " · held back"}`);
  console.log(`  ${assessment.summary}`);
  for (const finding of assessment.findings) {
    console.log(`  [${finding.severity}] ${finding.title}`);
    console.log(`     ${finding.reason}`);
    console.log(`     Rule ${finding.ruleId}${finding.sourceRef === undefined ? "" : ` · ${finding.sourceRef}`}`);
    for (const fact of finding.appliedFacts) console.log(`       · ${fact.label}: ${fact.value}`);
    console.log(`     ${finding.overridable ? "A person with the right permission may send it out anyway, with a reason." : "This one cannot be overridden."}`);
  }
};

const desk = makeVehicleDesk();
const steel = fiveTonneShipment();

heading("1. Five tonnes of steel on a scooter");
show(await desk.service.assess(desk.actor, {
  movementId: "demo-scooter",
  transport: transportDetails({ vehicleNumber: "KA05MN9012" }),
  shipment: steel,
}));

heading("2. The same five tonnes on a private car");
show(await desk.service.assess(desk.actor, {
  movementId: "demo-car",
  transport: transportDetails({ vehicleNumber: "KA03MC4455" }),
  shipment: steel,
}));

heading("3. A real goods vehicle, above its own recorded capacity");
const small = await desk.service.assess(desk.actor, {
  movementId: "demo-small-lorry",
  transport: transportDetails({ vehicleNumber: "KA02GV3344" }),
  shipment: steel,
});
show(small);

heading("4. Somebody who knows the lorry answers for it");
const overridden = await desk.service.override(desk.actor, small.id, {
  findingCodes: ["VEHICLE.CAPACITY.EXCEEDED", "VEHICLE.PERMIT.WRONG_KIND"],
  reason: "Reweighed at our own weighbridge at 1,180 kg, and the national permit renewed on 12 August is with the driver.",
});
console.log(`  → ${overridden.outcome} · ${overridden.clearedToMove ? "may go" : "still held back"}`);
console.log(`  ${overridden.summary}`);
console.log(`  Override by ${overridden.overrides[0]?.byUserId} at ${overridden.overrides[0]?.at}`);
console.log(`  Reason: ${overridden.overrides[0]?.reason}`);
console.log("\n  What the override did not do — the evidence is exactly as it was:");
console.log(`    Capacity on record: ${overridden.capacity?.capacityKg} kg, from ${overridden.capacity?.source}`);
console.log(`    Findings still on the record: ${overridden.findings.length}, unchanged`);
console.log(`    Still outstanding: ${outstandingOf(overridden.findings, overridden.overrides).length}`);

heading("5. The right lorry for the job");
show(await desk.service.assess(desk.actor, {
  movementId: "demo-right-lorry",
  transport: transportDetails({ vehicleNumber: "KA01AB1234" }),
  shipment: steel,
}));

heading("6. A photograph of the number plate that does not match");
show(await desk.service.assess(desk.actor, {
  movementId: "demo-plate",
  transport: transportDetails({ vehicleNumber: "KA01AB1234" }),
  shipment: steel,
  platePhoto: platePhoto("plate:KA02GV3344@0.94", "2026-08-21T04:25:00.000Z"),
}));

heading("7. No camera in the yard: somebody reads the plate instead");
show(await desk.service.assess(desk.actor, {
  movementId: "demo-plate-typed",
  transport: transportDetails({ vehicleNumber: "KA01AB1234" }),
  shipment: steel,
  plateReadByHand: "KA02GV3344",
}));

heading("8. A vehicle nobody holds, with its facts typed in");
show(await desk.service.assess(desk.actor, {
  movementId: "demo-typed-facts",
  transport: transportDetails({ vehicleNumber: "KA88XX0001", interState: false }),
  shipment: { grossWeightKg: 2_000 },
  declared: { vehicleClass: "LIGHT_GOODS_VEHICLE", ratedPayloadKg: 1_200 },
}));

heading("9. The vehicle record service is down");
desk.authority.goDown();
show(await desk.service.assess(desk.actor, {
  movementId: "demo-outage",
  transport: transportDetails({ vehicleNumber: "KA01AB1234" }),
  shipment: steel,
}));
desk.authority.comeBack();

console.log("\n  The last two are the ones to look at together. A photograph of a different lorry is a");
console.log("  finding about the movement. A service we could not reach is a finding about us — the");
console.log("  vehicle was never checked at all — and it is never shown as 'nothing found'.");

heading("What is waiting at the dispatch desk");
for (const held of await desk.service.blocked(desk.actor)) {
  console.log(`  ${held.movementId}: ${outstandingOf(held.findings, held.overrides).map((finding) => finding.title).join("; ")}`);
}
