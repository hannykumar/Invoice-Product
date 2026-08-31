/**
 * Issue #29 [E29] — asking the registering authority about a lorry.
 *
 *   npm run demo:vehicle-record
 *
 * Sampoorna Traders of Bengaluru type a number plate at the dispatch desk. Every line below comes
 * from the real service, the real consent check, the real caching and the real audit trail; only
 * the government service at the far end is synthetic, so nothing here needs a credential or a
 * network.
 */
import { ALTERNATE_PROVIDER_KEYS, alternateProviderRows } from "./vehicle-record-adapters.ts";
import { ALL_VEHICLE_PERMISSIONS, actorWith, makeVehicleRecordDesk } from "./fixtures.ts";
import { VEHICLE_RECORD_CONNECT_PERMISSION } from "./vehicle-record-service.ts";
import { PERMITTED_VEHICLE_FIELDS } from "./vehicle-record-types.ts";
import type { VehicleRecordVerification } from "./vehicle-record-types.ts";

const heading = (text: string): void => console.log(`\n${text}\n${"─".repeat(text.length)}`);

const show = (number: string, result: VehicleRecordVerification): void => {
  console.log(`  ${number} → ${result.kind}`);
  console.log(`  ${result.summary}`);
  if (result.kind === "FOUND") {
    const evidence = result.evidence;
    console.log(`     Read from ${result.provenance.provider}, their reference ${result.provenance.providerReference}`);
    console.log(`     Asked at ${result.provenance.retrievedAt} · ${result.freshness === "STALE" ? "older than this business treats as current" : "current"}${result.fromCache ? " · reused what we already had" : ""}`);
    console.log(`     Class ${evidence.vehicleClass ?? "not stated"} · body ${evidence.bodyType ?? "not stated"} · permit ${evidence.permitType ?? "not stated"}`);
    console.log(`     Gross ${evidence.grossVehicleWeightKg ?? "—"} kg · empty ${evidence.unladenWeightKg ?? "—"} kg · may carry ${evidence.ratedPayloadKg ?? "—"} kg`);
    console.log(`     Fitness to ${evidence.fitnessValidUpto ?? "not stated"} · insurance to ${evidence.insuranceValidUpto ?? "not stated"} · status ${evidence.registrationStatus ?? "not stated"}`);
    console.log(`     Registered to ${evidence.registeredOwnerName ?? "not read"} (masked before it was stored)`);
  }
  if (result.kind === "UNAVAILABLE" && result.lastKnown !== undefined) {
    console.log(`     We do hold an older reading: ${result.lastKnown.evidence.vehicleClass ?? "class not stated"}, read at ${result.lastKnown.provenance.retrievedAt} (${result.lastKnown.freshness}).`);
  }
};

const desk = makeVehicleRecordDesk({ grantConsent: false, now: "2026-08-21T04:30:00.000Z" });
const owner = actorWith([...ALL_VEHICLE_PERMISSIONS, VEHICLE_RECORD_CONNECT_PERMISSION]);
const clerk = desk.actor;

heading("1. Before anyone switches the service on");
show("KA01AB1234", await desk.service.verify(clerk, "KA01AB1234"));
console.log(`     The provider has been asked ${desk.authority.calls} times. A vehicle number does not leave the building without consent.`);

heading("2. The owner switches it on, and says what may be read");
const consent = await desk.service.grantConsent(owner, { expiresOn: "2027-03-31", credentialReference: "vault://vehicle/sampoorna" });
console.log(`  Purpose: ${consent.purpose}`);
console.log(`  Fields agreed: ${consent.fields.join(", ")}`);
console.log(`  In force until ${consent.expiresOn}. The credential itself is in the vault; this record holds only its name.`);
console.log(`  Fields the product may ever ask for, whatever a provider offers: ${PERMITTED_VEHICLE_FIELDS.length}.`);

heading("3. A lorry the authority holds");
show("KA01AB1234", await desk.service.verify(clerk, "KA01AB1234"));

heading("4. A scooter, and a goods vehicle whose capacity has to be worked out");
show("KA05MN9012", await desk.service.verify(clerk, "KA05MN9012"));
show("KA04SC7788", await desk.service.verify(clerk, "KA04SC7788"));

heading("5. A vehicle the authority has never heard of");
show("KA99ZZ0000", await desk.service.verify(clerk, "KA99ZZ0000"));
console.log("  This is the authority answering. It is not proof the number is wrong, and it is not the same as the service being down.");

heading("6. Something that is not a number plate");
show("9880012345", await desk.service.verify(clerk, "9880012345"));
console.log(`  Nothing was sent. The provider has been asked ${desk.authority.calls} times in all.`);

heading("7. Asking again four hours later");
desk.clock.travelTo("2026-08-21T08:30:00.000Z");
show("KA01AB1234", await desk.service.verify(clerk, "KA01AB1234"));
console.log(`  Still ${desk.authority.calls} calls to the provider: a registration class does not change between breakfast and lunch.`);

heading("8. A fortnight later, with the service down");
desk.authority.goDown();
desk.clock.travelTo("2026-09-04T04:30:00.000Z");
show("KA01AB1234", await desk.service.verify(clerk, "KA01AB1234"));
console.log("  The old reading is shown with its age. The lorry still counts as unchecked today, which is what issue #28 turns into a question for a person.");

heading("9. Replacing the provider");
desk.authority.comeBack();
const replacement = makeVehicleRecordDesk({
  now: "2026-09-04T04:30:00.000Z",
  provider: "karnataka-transport-feed",
  rows: alternateProviderRows(),
  keys: ALTERNATE_PROVIDER_KEYS,
});
show("KA01AB1234", await replacement.service.verify(replacement.actor, "KA01AB1234"));
console.log("  A different service, different field names, the same facts. Only the adapter changed.");

heading("10. What is written down about all of this");
for (const event of desk.audit.events) {
  console.log(`  ${event.at} · ${event.action} · ${event.subjectId}`);
  console.log(`     ${event.summary}`);
}
console.log("\n  No credential, no chassis number, no engine number and no address appears anywhere above.");

heading("11. Withdrawing consent");
await desk.service.revokeConsent(owner, "We have stopped using the government service.");
console.log(`  Readings still held: ${(await desk.service.held(clerk)).length}.`);
show("KA01AB1234", await desk.service.verify(clerk, "KA01AB1234"));
