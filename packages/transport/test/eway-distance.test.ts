// Issue #240 — the e-way bill distance is worked out from the PIN codes by the portal: 0 is sent,
// the portal's answer is remembered, and a typed distance more than 10% over it is refused.
import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "@invoice/kernel";
import {
  describeValiditySum, distanceFromPortalAlert, longestAllowedDistance, planDistance,
} from "../src/distance.ts";
import { interStateMovement, lorry, makeEwayDesk, PUNE_BUYER } from "../src/fixtures.ts";

/** Bengaluru 560058 to Pune 411030 with nothing typed: the distance is the portal's to work out. */
const untyped = (over: Parameters<typeof interStateMovement>[0] = {}) => {
  const { approximateDistanceKm: _typed, ...movement } = interStateMovement({ vehicle: lorry(), ...over });
  return movement;
};

test("10% more than 840 km is 924 km, never rounded up past what the portal accepts", () => {
  assert.equal(longestAllowedDistance(840), 924);
  assert.equal(longestAllowedDistance(99), 108); // 108.9 is rounded down
});

test("the portal's distance is read from its alert, and nothing is read from an alert that does not say", () => {
  assert.equal(distanceFromPortalAlert(", Distance between these two pincodes is 840, "), 840);
  assert.equal(distanceFromPortalAlert("Distance between these two pincodes is 12"), 12);
  assert.equal(distanceFromPortalAlert("Some other warning"), undefined);
  assert.equal(distanceFromPortalAlert(undefined), undefined);
});

test("the days are written out as a sum nobody has to do in their head", () => {
  assert.equal(describeValiditySum(840, 200, 5), "840 ÷ 200 = 4.2, and part of a day counts as a whole day, so 5 days");
  assert.equal(describeValiditySum(400, 200, 2), "400 ÷ 200 = 2, so 2 days");
});

test("nothing typed and nothing known: 0 is sent and validity waits for the portal", () => {
  const plan = planDistance({ fromPincode: "560058", toPincode: "411026" });
  assert.equal(plan.sentKm, 0);
  assert.equal(plan.validityKm, undefined);
  assert.match(plan.message, /works it out from PIN 560058 to PIN 411026 when the e-way bill is raised/);
});

test("a typed distance over 10% more than the portal's is refused with the sum", () => {
  const plan = planDistance({ fromPincode: "560058", toPincode: "411026", typedKm: 925, knownKm: 840 });
  assert.equal(plan.refusal, "You typed 925 km, but the portal counts 840 km from PIN 560058 to PIN 411026. It accepts at most 10% more: 840 + 84 = 924 km. Type 924 km or less, or leave the distance empty and the portal will use 840 km.");
  assert.equal(planDistance({ fromPincode: "560058", toPincode: "411026", typedKm: 924, knownKm: 840 }).refusal, undefined);
  // Shorter than the portal's own distance is not refused: only more than 10% over is.
  assert.equal(planDistance({ fromPincode: "560058", toPincode: "411026", typedKm: 700, knownKm: 840 }).refusal, undefined);
});

test("raised with no distance: 0 goes to the portal, which works out 840 km, so valid 5 days", async () => {
  const desk = makeEwayDesk();
  const before = await desk.service.preview(desk.actor, untyped());
  assert.equal(before.ready, true);
  assert.equal(before.distance?.sentKm, 0);
  assert.equal(before.validityDays, undefined, "no distance is made up before the portal answers");

  const raised = await desk.service.generate(desk.actor, untyped());
  assert.equal(raised.status, "ACTIVE");
  assert.equal(raised.distanceKm, 0);
  assert.equal(raised.acknowledgement?.portalDistanceKm, 840);
  // Raised 21 Aug 2026 at 10:00 in India: 5 days, each ending at midnight, to the end of 26 Aug.
  assert.equal(raised.acknowledgement?.validUntil, "2026-08-26T18:30:00.000Z");
  assert.match(raised.message, /The portal worked out 840 km from PIN 560058 to PIN 411030: 840 ÷ 200 = 4\.2, and part of a day counts as a whole day, so 5 days\./);

  // The same two PIN codes again: the portal's 840 km is now known in advance.
  const next = untyped({ movementId: "mov-002", documents: interStateMovement().documents.map((document) => ({ ...document, documentId: "inv-002", documentNumber: "SAM/2026/0118" })) });
  const known = await desk.service.preview(desk.actor, next);
  assert.equal(known.distance?.knownKm, 840);
  assert.equal(known.validityDays, 5);
  assert.equal(known.validitySum, "840 ÷ 200 = 4.2, and part of a day counts as a whole day, so 5 days");

  // Typed at 925 km it is refused before anything is sent, on the check and on raising.
  const tooFar = await desk.service.preview(desk.actor, { ...next, approximateDistanceKm: 925 });
  assert.equal(tooFar.ready, false);
  assert.deepEqual(tooFar.problems.map((problem) => problem.field), ["transDistance"]);
  const sentBefore = desk.portal.numbers().length;
  await assert.rejects(
    () => desk.service.generate(desk.actor, { ...next, approximateDistanceKm: 925 }),
    (error: unknown) => error instanceof DomainError && error.code === "EWAY_DISTANCE_TOO_FAR" && /840 \+ 84 = 924 km/.test(error.message),
  );
  assert.equal(desk.portal.numbers().length, sentBefore, "nothing reached the portal");
});

test("a PIN pair the portal has no distance for: it asks for one, and the typed distance then goes through", async () => {
  const desk = makeEwayDesk();
  const elsewhere = untyped({ billTo: { ...PUNE_BUYER, pincode: "411001" } });
  const refused = await desk.service.generate(desk.actor, elsewhere);
  assert.equal(refused.status, "FAILED");
  assert.match(refused.message, /no road distance between PIN 560058 and PIN 411001/);

  // Corrected with a typed distance, the same consignment is looked at afresh, not answered from memory.
  const typed = await desk.service.generate(desk.actor, { ...elsewhere, approximateDistanceKm: 850 });
  assert.equal(typed.status, "ACTIVE");
  assert.equal(typed.distanceKm, 850);
  assert.match(typed.message, /The distance sent was 850 km: 850 ÷ 200 = 4\.25, and part of a day counts as a whole day, so 5 days\./);
});

test("the portal itself refuses a typed distance more than 10% over its own, when we did not know it yet", async () => {
  const desk = makeEwayDesk();
  const refused = await desk.service.generate(desk.actor, { ...untyped(), approximateDistanceKm: 1000 });
  assert.equal(refused.status, "FAILED");
  assert.match(refused.message, /too high/);
  const raised = await desk.service.generate(desk.actor, untyped());
  assert.equal(raised.status, "ACTIVE");
  assert.equal(raised.acknowledgement?.portalDistanceKm, 840);
});
