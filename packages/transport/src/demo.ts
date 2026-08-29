/**
 * Issue #27 [E27] — the whole e-way bill lifecycle on a terminal, no database, no credential.
 *
 *   npm run demo:eway
 *
 * Sampoorna Traders of Bengaluru sends steel to Pune and soap to Mysuru. Every figure below comes
 * from the real services; the e-way bill portal is synthetic and sits behind #8's gateway.
 */
import { formatPaise } from "../../purchasing/src/money.ts";
import { decideEwayApplicability } from "./applicability.ts";
import { describeExpiry, describeTimeLeft, validityDays } from "./validity.ts";
import { toOfflineJson } from "./payload.ts";
import { DEFAULT_EWAY_BILL_POLICY } from "./types.ts";
import {
  interStateMovement, intraStateMovement, lorry, makeEwayDesk, soapLine, steelLine,
} from "./fixtures.ts";

const heading = (text: string): void => console.log(`\n${text}\n${"─".repeat(text.length)}`);

const showDecision = (label: string, decision: ReturnType<typeof decideEwayApplicability>): void => {
  console.log(label);
  console.log(`  → ${decision.outcome}`);
  console.log(`  ${decision.reason}`);
  console.log(`  Rule ${decision.ruleId}${decision.sourceRef === undefined ? "" : ` · ${decision.sourceRef}`}`);
  console.log("  Facts it used:");
  for (const fact of decision.appliedFacts) console.log(`    · ${fact.label}: ${fact.value}`);
};

heading("1. Do these goods even need an e-way bill?");
showDecision("₹94,400 of steel, Bengaluru → Pune (two states):", decideEwayApplicability(interStateMovement()));
console.log("");
showDecision("₹49,999 of soap, Bengaluru → Mysuru (inside Karnataka):", decideEwayApplicability(intraStateMovement()));
console.log("");
showDecision("The same soap, Bengaluru → Pune instead:", decideEwayApplicability(intraStateMovement({
  movementId: "mov-002b",
  billTo: interStateMovement().billTo,
})));

heading("2. The ₹1 lakh belief, and where it really comes from");
const insideMaharashtra = intraStateMovement({
  movementId: "mov-mh",
  consignor: { ...intraStateMovement().consignor, place: "Nashik", pincode: "422001", stateCode: "27" },
  billTo: { ...intraStateMovement().billTo, place: "Pune", pincode: "411030", stateCode: "27" },
  documents: [{
    documentId: "inv-mh", documentType: "TAX_INVOICE", documentNumber: "SAM/2026/0130",
    documentDate: "2026-08-21", lines: [soapLine({ taxableValuePaise: 70_000_00n, cgstPaise: 6_300_00n, sgstPaise: 6_300_00n })],
  }],
});
showDecision("₹82,600 of soap moving inside Maharashtra:", decideEwayApplicability(insideMaharashtra));
console.log("");
showDecision("The same ₹82,600 moving inside Karnataka:", decideEwayApplicability(intraStateMovement({
  movementId: "mov-ka",
  documents: [{
    documentId: "inv-ka", documentType: "TAX_INVOICE", documentNumber: "SAM/2026/0131",
    documentDate: "2026-08-21", lines: [soapLine({ taxableValuePaise: 70_000_00n, cgstPaise: 6_300_00n, sgstPaise: 6_300_00n })],
  }],
})));
console.log("\n  Same goods, same value, same day — two different answers, because ₹1 lakh is");
console.log("  Maharashtra's limit and not the country's, and neither of them is 'per day'.");

heading("3. The ₹50,000 boundary itself");
const at = (paise: bigint) => decideEwayApplicability(interStateMovement({
  documents: [{
    documentId: "b", documentType: "TAX_INVOICE", documentNumber: "SAM/2026/0140", documentDate: "2026-08-21",
    lines: [steelLine({ taxableValuePaise: paise, igstPaise: 0n })],
  }],
}));
for (const value of [49_999_00n, 50_000_00n, 50_000_01n]) {
  const decision = at(value);
  console.log(`  ${formatPaise(value)} → ${decision.outcome}`);
}
console.log("  The rule says 'exceeds ₹50,000', so exactly ₹50,000 needs nothing.");

const desk = makeEwayDesk();

heading("4. What will be sent, before anything is sent");
const preview = await desk.service.preview(desk.actor, interStateMovement());
console.log(preview.summary);
console.log(`Ready: ${preview.ready}   ·   vehicle entered: ${preview.vehicleReady}`);
console.log(`Consignment value: ${formatPaise(preview.consignmentValuePaise)}`);
console.log(`Validity once a vehicle goes on: ${preview.validityDays} day(s) for 840 km`);
console.log(`E-way bills at the portal so far: ${desk.portal.numbers().length}`);

heading("5. Part A first — and why the lorry still may not leave");
const partA = await desk.service.generate(desk.actor, interStateMovement());
console.log(`Status: ${partA.status}`);
console.log(partA.message);
console.log(`Validity running: ${partA.acknowledgement?.validUntil ?? "not started — no vehicle yet"}`);

heading("6. The transporter puts the lorry on it");
const active = await desk.service.updateVehicle(desk.actor, "mov-001", lorry());
console.log(`Status: ${active.status}`);
console.log(active.message);
console.log(`Valid until: ${describeExpiry(active.acknowledgement?.validUntil ?? "")}`);
console.log(describeTimeLeft(active.acknowledgement?.validUntil ?? "", desk.clock.now()));

heading("7. Pressing the button again");
const again = await desk.service.generate(desk.actor, interStateMovement());
console.log(again.message);
console.log(`Same record: ${again.id === partA.id}`);
console.log(`E-way bills at the portal: ${desk.portal.numbers().length}`);

heading("8. The lorry breaks down at Hubballi");
const swapped = await desk.service.updateVehicle(desk.actor, "mov-001", lorry({
  registrationNumber: "KA25CD5678", fromPlace: "Hubballi", reason: "BREAKDOWN",
  reasonNote: "Gearbox failure on NH48",
}));
console.log(swapped.message);
console.log(`Vehicles this consignment has been on: ${swapped.vehicleLegs.map((leg) => leg.registrationNumber).join(" → ")}`);
console.log(`Expiry unchanged: ${swapped.acknowledgement?.validUntil === active.acknowledgement?.validUntil}`);

heading("9. Midnight passes and the bill runs out");
desk.clock.travelTo("2026-08-27T04:30:00.000Z");
const expired = await desk.service.forMovement(desk.actor, "mov-001");
console.log(`Status: ${expired?.status}`);
console.log(expired?.message);

heading("10. When the portal is down, the goods still have to go out");
const outageDesk = makeEwayDesk();
outageDesk.portal.setMode("outage");
const failed = await outageDesk.service.generate(outageDesk.actor, interStateMovement());
console.log(`Status: ${failed.status}   ← not ACTIVE, because we do not know that it is`);
console.log(failed.message);
const offline = JSON.parse(toOfflineJson(interStateMovement()));
console.log(`\nPart A as a file: ${offline.billLists[0].docNo}, ${offline.billLists[0].fromPlace} → ${offline.billLists[0].toPlace}`);
console.log(`note: ${offline._karobar.note}`);

heading("11. Cancelling, inside the portal's window");
const second = makeEwayDesk();
await second.service.generate(second.actor, interStateMovement({ vehicle: lorry() }));
const cancelled = await second.service.cancel(second.actor, "mov-001", {
  reasonCode: "ORDER_CANCELLED",
  reason: "The customer called off the order before the lorry left",
});
console.log(`Status: ${cancelled.status}`);
console.log(cancelled.message);

heading("12. Over-dimensional cargo travels far more slowly");
console.log(`840 km, ordinary lorry: ${validityDays(840, "REGULAR", DEFAULT_EWAY_BILL_POLICY)} days (200 km a day)`);
console.log(`840 km, over-dimensional: ${validityDays(840, "ODC", DEFAULT_EWAY_BILL_POLICY)} days (20 km a day)`);
console.log("");
