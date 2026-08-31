/**
 * Issue #29 [E29] acceptance criteria, enforced automatically.
 *
 *  - "Only authorised fields are requested/stored"
 *  - "Provider response and retrieval date are traceable"
 *  - "No result is not interpreted as an invalid vehicle"
 *
 * plus the testing the issue asks for: sandbox/fixture contract tests, masked, missing and stale
 * responses, and a provider replacement that changes nothing above the adapter.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DomainError, asId } from "@invoice/kernel";
import {
  ALTERNATE_PROVIDER_KEYS, InMemoryVehicleRecordCache,
  SYNTHETIC_VAHAN_ROWS, alternateProviderRows,
} from "../src/vehicle-record-adapters.ts";
import {
  PERMITTED_VEHICLE_FIELDS, maskOwnerName, looksLikeRegistrationNumber,
} from "../src/vehicle-record-types.ts";
import { normaliseVehicleRecord, readRecordDate, readVehicleClass, readWeightKg } from "../src/vehicle-record.ts";
import { VEHICLE_RECORD_CONNECT_PERMISSION } from "../src/vehicle-record-service.ts";
import {
  ALL_VEHICLE_PERMISSIONS, ALL_VEHICLE_RECORD_PERMISSIONS, COMPANY, actorWith, makeVehicleRecordDesk,
} from "../src/fixtures.ts";
import type { VehicleRecordVerification } from "../src/vehicle-record-types.ts";

const found = (result: VehicleRecordVerification) => {
  assert.equal(result.kind, "FOUND", `expected a reading, got ${result.kind}`);
  return result as Extract<VehicleRecordVerification, { kind: "FOUND" }>;
};

// ------------------------------------------------- only authorised fields are asked for and kept

test("nothing outside the allow-list is ever stored, however much the provider volunteers", async () => {
  // The synthetic scooter row carries a chassis number, an engine number and an address, because a
  // real provider does. None of them may survive the adapter.
  const desk = makeVehicleRecordDesk();
  const reading = found(await desk.service.verify(desk.actor, "KA05MN9012"));

  const kept = Object.keys(reading.evidence);
  const allowed = new Set<string>([...PERMITTED_VEHICLE_FIELDS, "source", "retrievedAt", "reference"]);
  assert.deepEqual(kept.filter((key) => !allowed.has(key)), [], `these were kept and should not have been: ${kept}`);
  assert.equal(JSON.stringify(reading.evidence).includes("MD2A11CZ8KWJ"), false, "the chassis number must never reach storage");
  assert.equal(JSON.stringify(reading.evidence).includes("Bengaluru"), false, "the owner's address must never reach storage");
});

test("a business that agreed to less gets less: the owner's name is not read at all", async () => {
  const desk = makeVehicleRecordDesk({ fields: PERMITTED_VEHICLE_FIELDS.filter((field) => field !== "registeredOwnerName") });
  const reading = found(await desk.service.verify(desk.actor, "KA01AB1234"));

  assert.equal(reading.evidence.registeredOwnerName, undefined);
  // What it did agree to is still there: this is narrowing, not breaking.
  assert.equal(reading.evidence.vehicleClass, "HEAVY_GOODS_VEHICLE");
  assert.equal(reading.evidence.ratedPayloadKg, 16_400);
});

test("the owner's name is masked, so a gate check works and a leaked table says nothing", async () => {
  const desk = makeVehicleRecordDesk();
  const reading = found(await desk.service.verify(desk.actor, "KA01AB1234"));

  assert.equal(reading.evidence.registeredOwnerName, "S******** T****** P****** L******");
  assert.equal(maskOwnerName("Priya Nair"), "P**** N***");
});

// -------------------------------------------------------- the reading can be traced to a source

test("every reading says which provider answered, with their reference and the moment we asked", async () => {
  const desk = makeVehicleRecordDesk({ now: "2026-08-21T04:30:00.000Z" });
  const reading = found(await desk.service.verify(desk.actor, "KA02GV3344"));

  assert.equal(reading.provenance.provider, "api-setu-vahan");
  assert.ok(reading.provenance.providerReference.startsWith("VAHAN/"), reading.provenance.providerReference);
  assert.equal(reading.provenance.retrievedAt, "2026-08-21T04:30:00.000Z");
  assert.equal(reading.evidence.retrievedAt, "2026-08-21T04:30:00.000Z");
  // And a person reading the screen is told the same thing in words.
  assert.match(reading.summary, /Read from api-setu-vahan/);
  assert.match(reading.summary, /21 August 2026/);

  const entry = desk.audit.events.find((event) => event.action === "transport.vehicle_record.looked_up");
  assert.ok(entry, "a lookup must leave an audit entry");
  assert.equal(entry?.details.provider, "api-setu-vahan");
  assert.equal(entry?.details.providerReference, reading.provenance.providerReference);
  assert.equal(entry?.details.purpose, "TRANSPORT_SUITABILITY");
  assert.equal(JSON.stringify(entry).includes("vault://"), false, "a credential reference is not a lookup detail");
});

// ------------------------------------------- "no result" is never "this vehicle does not exist"

test("a vehicle the authority does not hold, and a provider we could not reach, are different answers", async () => {
  const desk = makeVehicleRecordDesk();

  const absent = await desk.service.verify(desk.actor, "KA99ZZ0000");
  assert.equal(absent.kind, "NOT_FOUND");
  assert.match(absent.kind === "NOT_FOUND" ? absent.summary : "", /not the same as the number being wrong/);

  desk.authority.goDown();
  const down = await desk.service.verify(desk.actor, "KA01AB1234");
  assert.equal(down.kind, "UNAVAILABLE");
  assert.equal(down.kind === "UNAVAILABLE" ? down.code : "", "OUTAGE");
  assert.equal(down.kind === "UNAVAILABLE" ? down.retryable : false, true);
});

test("no consent is 'we could not ask', not 'nothing is wrong' — and nothing is sent", async () => {
  const desk = makeVehicleRecordDesk({ grantConsent: false });
  const result = await desk.service.verify(desk.actor, "KA01AB1234");

  assert.equal(result.kind, "UNAVAILABLE");
  assert.equal(result.kind === "UNAVAILABLE" ? result.code : "", "NOT_CONNECTED");
  assert.equal(result.kind === "UNAVAILABLE" ? result.retryable : true, false);
  assert.equal(desk.authority.calls, 0, "a vehicle number must not leave the building without consent");
});

test("a number that is not a number plate is caught here, not paid for there", async () => {
  const desk = makeVehicleRecordDesk();
  const result = await desk.service.verify(desk.actor, "9880012345");

  assert.equal(result.kind, "UNAVAILABLE");
  assert.equal(result.kind === "UNAVAILABLE" ? result.code : "", "INVALID_NUMBER");
  assert.equal(desk.authority.calls, 0);
  assert.equal(looksLikeRegistrationNumber("KA 01 AB 1234"), true);
  assert.equal(looksLikeRegistrationNumber("KA-05-MN-9012"), true);
  assert.equal(looksLikeRegistrationNumber("HELLO"), false);
});

test("credentials the provider will not accept are not a vehicle problem", async () => {
  const desk = makeVehicleRecordDesk();
  desk.authority.refuseCredentials();
  const result = await desk.service.verify(desk.actor, "KA01AB1234");

  assert.equal(result.kind, "UNAVAILABLE");
  assert.equal(result.kind === "UNAVAILABLE" ? result.code : "", "UNAUTHORIZED");
  assert.equal(result.kind === "UNAVAILABLE" ? result.retryable : true, false, "retrying will not fix a credential");
});

test("a scrapped lorry is on the record, and saying so is not the same as not finding it", async () => {
  const desk = makeVehicleRecordDesk();
  const reading = found(await desk.service.verify(desk.actor, "KA04SC7788"));

  assert.equal(reading.evidence.registrationStatus, "SCRAPPED");
  // Its class is not written on the record in so many words, so it is worked out from the weight.
  assert.equal(reading.evidence.vehicleClass, "LIGHT_GOODS_VEHICLE");
  assert.equal(reading.evidence.ratedPayloadKg, undefined);
  assert.equal(reading.evidence.grossVehicleWeightKg, 7_490);
});

// ------------------------------------------------------------ caching, freshness and staleness

test("asking twice in an afternoon is one call to the provider", async () => {
  const desk = makeVehicleRecordDesk({ now: "2026-08-21T04:30:00.000Z" });

  const first = found(await desk.service.verify(desk.actor, "KA01AB1234"));
  desk.clock.travelTo("2026-08-21T08:30:00.000Z");
  const second = found(await desk.service.verify(desk.actor, "KA01AB1234"));

  assert.equal(desk.authority.calls, 1, "four hours later is still the same registration record");
  assert.equal(second.fromCache, true);
  assert.equal(first.fromCache, false);
  // The date shown is when we asked, not when we looked at it again.
  assert.equal(second.provenance.retrievedAt, "2026-08-21T04:30:00.000Z");
  assert.equal(second.freshness, "CURRENT");
});

test("past the reuse window the provider is asked again", async () => {
  const desk = makeVehicleRecordDesk({ now: "2026-08-21T04:30:00.000Z" });
  await desk.service.verify(desk.actor, "KA01AB1234");
  desk.clock.travelTo("2026-08-21T18:30:00.000Z");
  const again = found(await desk.service.verify(desk.actor, "KA01AB1234"));

  assert.equal(desk.authority.calls, 2);
  assert.equal(again.provenance.retrievedAt, "2026-08-21T18:30:00.000Z");
});

test("a week-old reading is shown as old, in words, and never as today's fact", async () => {
  const desk = makeVehicleRecordDesk({ now: "2026-08-21T04:30:00.000Z" });
  await desk.service.verify(desk.actor, "KA01AB1234");
  // The provider goes away, and a fortnight passes.
  desk.authority.goDown();
  desk.clock.travelTo("2026-09-04T04:30:00.000Z");

  const result = await desk.service.verify(desk.actor, "KA01AB1234");
  assert.equal(result.kind, "UNAVAILABLE", "an old reading does not make today's lookup a success");
  const unavailable = result as Extract<VehicleRecordVerification, { kind: "UNAVAILABLE" }>;
  assert.equal(unavailable.lastKnown?.freshness, "STALE");
  assert.equal(unavailable.lastKnown?.evidence.vehicleClass, "HEAVY_GOODS_VEHICLE");
  assert.match(unavailable.summary, /14 days ago/);
  assert.match(unavailable.summary, /counts as unchecked/);
});

test("a stale reading the provider can confirm is shown with what to do about it", async () => {
  const desk = makeVehicleRecordDesk({ now: "2026-08-21T04:30:00.000Z" });
  await desk.service.verify(desk.actor, "KA01AB1234");
  desk.clock.travelTo("2026-09-04T04:30:00.000Z");
  desk.freshness.set(COMPANY, { reuseWithinHours: 24 * 30, staleAfterDays: 7, effectiveFrom: "2026-04-01" });

  // Inside the (very long) reuse window, so no second call — and openly old.
  const reading = found(await desk.service.verify(desk.actor, "KA01AB1234"));
  assert.equal(desk.authority.calls, 1);
  assert.equal(reading.freshness, "STALE");
  assert.match(reading.summary, /older than this business treats as current/);
});

// ------------------------------------------------------------------------- issue #28's port

test("through issue #28's port, the three answers stay three answers", async () => {
  const desk = makeVehicleRecordDesk();
  const port = desk.service.portFor(desk.actor);

  assert.equal((await port.lookup(COMPANY, "KA01AB1234")).kind, "FOUND");
  assert.equal((await port.lookup(COMPANY, "KA99ZZ0000")).kind, "NOT_FOUND");
  desk.authority.goDown();
  const down = await port.lookup(COMPANY, "KA07RF8899");
  assert.equal(down.kind, "UNAVAILABLE");
  assert.equal(down.kind === "UNAVAILABLE" ? down.retryable : false, true);
});

test("one company's lookups are not another company's", async () => {
  const desk = makeVehicleRecordDesk();
  await desk.service.verify(desk.actor, "KA01AB1234");

  const other = actorWith(ALL_VEHICLE_RECORD_PERMISSIONS, asId<"Company">("chamundi"));
  assert.equal((await desk.service.held(other)).length, 0, "a cached reading belongs to the business that asked for it");
  // And #28's port refuses to be pointed at a company its actor does not belong to.
  await assert.rejects(() => desk.service.portFor(desk.actor).lookup(asId<"Company">("chamundi"), "KA01AB1234"), DomainError);
});

test("looking a vehicle up and switching the service on are different permissions", async () => {
  const desk = makeVehicleRecordDesk({ grantConsent: false });
  const clerk = actorWith(ALL_VEHICLE_PERMISSIONS);

  await assert.rejects(() => desk.service.grantConsent(clerk), DomainError);
  const owner = actorWith([...ALL_VEHICLE_PERMISSIONS, VEHICLE_RECORD_CONNECT_PERMISSION]);
  const consent = await desk.service.grantConsent(owner, { credentialReference: "vault://vehicle/sampoorna" });
  assert.equal(consent.purpose, "TRANSPORT_SUITABILITY");
  assert.equal(consent.fields.length, PERMITTED_VEHICLE_FIELDS.length);

  const granted = desk.audit.events.find((event) => event.action === "transport.vehicle_record.consent_granted");
  assert.equal(granted?.details.credential, "vault://vehicle/sampoorna");
  // A clerk may still use it once the owner has switched it on.
  assert.equal((await desk.service.verify(clerk, "KA01AB1234")).kind, "FOUND");
});

test("withdrawing consent stops the lookups and deletes what was read", async () => {
  const desk = makeVehicleRecordDesk();
  await desk.service.verify(desk.actor, "KA01AB1234");
  assert.equal((await desk.service.held(desk.actor)).length, 1);

  const owner = actorWith([...ALL_VEHICLE_PERMISSIONS, VEHICLE_RECORD_CONNECT_PERMISSION]);
  await desk.service.revokeConsent(owner, "We are not using the government service any more.");

  assert.equal((await desk.service.held(desk.actor)).length, 0, "readings must go when the permission does");
  const after = await desk.service.verify(desk.actor, "KA01AB1234");
  assert.equal(after.kind, "UNAVAILABLE");
  assert.equal(after.kind === "UNAVAILABLE" ? after.code : "", "CONSENT_EXPIRED");
});

test("consent with an end date stops being consent on the day after it", async () => {
  const desk = makeVehicleRecordDesk({ grantConsent: false, now: "2026-08-21T04:30:00.000Z" });
  const owner = actorWith([...ALL_VEHICLE_PERMISSIONS, VEHICLE_RECORD_CONNECT_PERMISSION]);
  await desk.service.grantConsent(owner, { expiresOn: "2026-08-31" });

  assert.equal((await desk.service.verify(desk.actor, "KA01AB1234")).kind, "FOUND");
  desk.clock.travelTo("2026-09-01T04:30:00.000Z");
  const after = await desk.service.verify(desk.actor, "KA07RF8899");
  assert.equal(after.kind === "UNAVAILABLE" ? after.code : "", "CONSENT_EXPIRED");
});

// -------------------------------------------------------------------- what the record left out

test("a class nobody recognises comes back unknown, with a sentence saying so", async () => {
  const desk = makeVehicleRecordDesk();
  const reading = found(await desk.service.verify(desk.actor, "KA11XX0007"));

  assert.equal(reading.evidence.vehicleClass, undefined, "a crane is not quietly turned into a lorry");
  assert.match(reading.summary, /whose kind the record does not state/);
  const entry = desk.audit.events.find((event) => event.action === "transport.vehicle_record.looked_up");
  assert.match(entry?.details.gaps ?? "", /SPECIAL PURPOSE VEHICLE \(CRANE\)/);
});

test("dates arrive in three formats and a weight arrives with its unit", () => {
  assert.equal(readRecordDate("31-Mar-2029"), "2029-03-31");
  assert.equal(readRecordDate("31/01/2027"), "2027-01-31");
  assert.equal(readRecordDate("2030-06-30"), "2030-06-30");
  assert.equal(readRecordDate("someday"), null, "an unreadable date is missing, never today");
  assert.equal(readRecordDate(""), null);
  assert.equal(readWeightKg("2590 KG"), 2_590);
  assert.equal(readWeightKg("1,250 KG"), 1_250);
  assert.equal(readWeightKg(16_400), 16_400);
  assert.equal(readWeightKg("not stated"), undefined);
});

test("a goods vehicle with no size on the record is sorted by its registered weight, and says so", () => {
  assert.equal(readVehicleClass("GOODS CARRIER", 7_490)?.vehicleClass, "LIGHT_GOODS_VEHICLE");
  assert.equal(readVehicleClass("GOODS CARRIER", 11_000)?.vehicleClass, "MEDIUM_GOODS_VEHICLE");
  assert.equal(readVehicleClass("GOODS CARRIER", 25_000)?.vehicleClass, "HEAVY_GOODS_VEHICLE");
  assert.match(readVehicleClass("GOODS CARRIER", 7_490)?.basis ?? "", /registered gross weight of 7490 kg/);
  // And with no weight to sort it by, it stays unknown rather than becoming the smallest.
  assert.equal(readVehicleClass("GOODS CARRIER", undefined), null);
});

test("an empty record is gaps, not zeroes", () => {
  const normalised = normaliseVehicleRecord({ rc_regn_no: "KA10ZZ1111" }, {
    registrationNumber: "KA10ZZ1111",
    retrievedAt: "2026-08-21T04:30:00.000Z",
  });

  assert.equal(normalised.evidence.vehicleClass, undefined);
  assert.equal(normalised.evidence.grossVehicleWeightKg, undefined);
  assert.equal(normalised.evidence.source, "GOVERNMENT_RECORD");
  assert.deepEqual(normalised.gaps.length > 0, true);
  assert.match(normalised.gaps.join(" "), /does not say what kind of vehicle this is/);
});

// ---------------------------------------------------------------------- replacing the provider

test("a different provider, with different field names, produces exactly the same facts", async () => {
  const first = makeVehicleRecordDesk({ now: "2026-08-21T04:30:00.000Z" });
  const second = makeVehicleRecordDesk({
    now: "2026-08-21T04:30:00.000Z",
    provider: "karnataka-transport-feed",
    rows: alternateProviderRows(),
    keys: ALTERNATE_PROVIDER_KEYS,
  });

  for (const number of ["KA01AB1234", "KA02GV3344", "KA05MN9012", "KA04SC7788", "KA11XX0007"]) {
    const fromVahan = found(await first.service.verify(first.actor, number));
    const fromOther = found(await second.service.verify(second.actor, number));
    assert.deepEqual(
      { ...fromOther.evidence, reference: undefined },
      { ...fromVahan.evidence, reference: undefined },
      `${number} must read the same whoever answered`,
    );
    assert.equal(fromOther.provenance.provider, "karnataka-transport-feed");
  }

  // And the vehicle it does not hold is still "not found", not an error.
  assert.equal((await second.service.verify(second.actor, "KA99ZZ0000")).kind, "NOT_FOUND");
});

test("the cache is per company and per vehicle, and forgetting one leaves the rest", async () => {
  const cache = new InMemoryVehicleRecordCache();
  const snapshot = {
    companyId: COMPANY,
    registrationNumber: "KA01AB1234",
    provenance: { provider: "api-setu-vahan", providerReference: "VAHAN/1", retrievedAt: "2026-08-21T04:30:00.000Z" },
    notFound: true,
  };
  await cache.save(snapshot);
  await cache.save({ ...snapshot, registrationNumber: "KA02GV3344" });

  assert.equal((await cache.list(COMPANY)).length, 2);
  await cache.forget(COMPANY, "ka01 ab 1234");
  assert.equal((await cache.list(COMPANY)).length, 1, "a number typed with spaces is the same number");
});

test("the sandbox rows are the shapes the real service returns", () => {
  // A contract test in the plainest sense: if a row here stops looking like a VAHAN answer, the
  // normalising code is being tested against a fiction.
  for (const row of SYNTHETIC_VAHAN_ROWS) {
    assert.equal(typeof row.rc_regn_no, "string");
    assert.equal(looksLikeRegistrationNumber(String(row.rc_regn_no)), true, String(row.rc_regn_no));
    assert.equal(typeof row.rc_vh_class_desc, "string");
    assert.ok(readRecordDate(row.rc_fit_upto) !== null, `fitness date unreadable on ${row.rc_regn_no}`);
  }
});
