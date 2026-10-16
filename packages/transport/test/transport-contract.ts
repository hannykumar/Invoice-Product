/**
 * Issue #366 — one contract suite for this lane's stores, run against the in-memory classes
 * (transport-contract.test.ts) and against PostgreSQL (transport-contract.integration.test.ts).
 *
 * Everything is synthetic: random company ids, invented vehicle numbers, and no GST number at all.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CompanyId } from "@invoice/kernel";
import type { ConsolidatedTripRepository, EwayBillPolicyPort, EwayBillRepository, Page } from "../src/ports.ts";
import type { SuitabilityRepository, VehicleSuitabilityPolicyPort } from "../src/suitability-ports.ts";
import type { VehicleRecordCacheRepository, VehicleRecordConsentPort, VehicleRecordFreshnessPort } from "../src/vehicle-record-ports.ts";
import { DEFAULT_EWAY_BILL_POLICY, type ConsolidatedTripRecord, type EwayBillPolicy, type EwayBillRecord } from "../src/types.ts";
import { DEFAULT_VEHICLE_SUITABILITY_POLICY, type VehicleSuitabilityAssessment, type VehicleSuitabilityPolicy } from "../src/suitability-types.ts";
import { DEFAULT_VEHICLE_RECORD_FRESHNESS, type VehicleRecordFreshnessPolicy, type VehicleRecordSnapshot } from "../src/vehicle-record-types.ts";

export interface TransportHarness {
  bills: EwayBillRepository;
  trips: ConsolidatedTripRepository;
  checks: SuitabilityRepository;
  readings: VehicleRecordCacheRepository;
  consents: VehicleRecordConsentPort;
  ewayPolicies: EwayBillPolicyPort & { set(companyId: CompanyId, policy: EwayBillPolicy, by: string): Promise<void> };
  suitabilityPolicies: VehicleSuitabilityPolicyPort & { set(companyId: CompanyId, policy: VehicleSuitabilityPolicy, by: string): Promise<void> };
  freshness: VehicleRecordFreshnessPort & { set(companyId: CompanyId, policy: VehicleRecordFreshnessPolicy, by: string): Promise<void> };
  /** A company and a person in it, wherever the implementation keeps them. */
  company(): Promise<{ companyId: CompanyId; userId: string }>;
  /** One business action: everything `work` writes is kept together, or nothing is when it throws. */
  write<T>(companyId: CompanyId, work: () => Promise<T>): Promise<T>;
}

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
const ids = <T extends { id: string }>(rows: readonly T[]) => rows.map((row) => row.id);

/** Walks a list page by page and returns every row it was given. */
const walk = async <T>(fetch: (page: Page) => Promise<readonly T[]>, keyOf: (row: T) => string, limit = 2): Promise<T[]> => {
  const seen: T[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await fetch(after === undefined ? { limit } : { limit, after });
    assert.ok(page.length <= limit);
    if (page.length === 0) return seen;
    seen.push(...page);
    after = keyOf(page[page.length - 1] as T);
  }
};

export const bill = (companyId: string, userId: string, over: Partial<EwayBillRecord> = {}): EwayBillRecord => ({
  id: crypto.randomUUID(), companyId, movementId: crypto.randomUUID(), documentNumber: "SAM/2026/0117", documentDate: "2026-08-21",
  status: "ACTIVE",
  applicability: {
    outcome: "REQUIRED", reason: "Inter-state, over ₹50,000.", ruleId: "IN-INTER", ruleSetVersion: "2026.1", appliedFacts: [{ label: "Value", value: "₹5,90,000" }],
    consignmentValuePaise: 59_000_001n,
    thresholdApplied: { scope: "IN", thresholdPaise: 5_000_000n, effectiveFrom: "2018-04-01", sourceRef: "Rule 138", ruleId: "IN-INTER" },
  },
  consignmentValuePaise: 59_000_001n, fromStateCode: "29", toStateCode: "27", distanceKm: 840, fromPincode: "560001", toPincode: "411030",
  acknowledgement: {
    ewayBillNumber: String(100_000_000_000 + Math.floor(Math.random() * 899_999_999_999)), generatedAt: "21/08/2026 10:00:00",
    validUntil: "2026-08-26T18:29:59.000Z", providerRequestId: "synthetic-ewb-1", receivedAt: "2026-08-21T04:30:00.000Z", portalDistanceKm: 838,
  },
  vehicleLegs: [{ registrationNumber: "KA01AB1234", vehicleType: "REGULAR", fromPlace: "Bengaluru", fromStateCode: "29", mode: "ROAD", reason: "FIRST_TIME", recordedAt: "2026-08-21T04:30:00.000Z", recordedBy: userId }],
  message: "E-way bill ready.", cancellableUntil: "2026-08-22T04:30:00.000Z",
  createdBy: userId, createdAt: "2026-08-21T04:30:00.000Z", updatedAt: "2026-08-21T04:30:00.000Z", idempotencyKey: `eway:generate:${crypto.randomUUID()}`,
  ...over,
});

const trip = (companyId: string, userId: string, over: Partial<ConsolidatedTripRecord> = {}): ConsolidatedTripRecord => ({
  id: crypto.randomUUID(), companyId, tripNumber: `TRIP-${crypto.randomUUID().slice(0, 8)}`, vehicleNumber: "KA01AB1234", fromPlace: "Bengaluru",
  fromStateCode: "29", transportMode: "ROAD", ewayBillNumbers: ["331001234567", "331001234568"], createdBy: userId,
  createdAt: "2026-08-21T05:00:00.000Z", message: "Trip sheet made.", ...over,
});

const check = (companyId: string, userId: string, over: Partial<VehicleSuitabilityAssessment> = {}): VehicleSuitabilityAssessment => ({
  id: crypto.randomUUID(), companyId, movementId: crypto.randomUUID(), checkedAt: "2026-08-21T04:30:00.000Z", checkedBy: userId,
  outcome: "BLOCK", summary: "This lorry is too small for the load.",
  transport: { mode: "ROAD", vehicleNumber: "KA01AB1234", movementDate: "2026-08-21", distanceKm: 840 },
  shipment: { grossWeightKg: 5_000, volumeCubicMetres: 3.2 },
  evidence: [{ registrationNumber: "KA01AB1234", source: "GOVERNMENT_RECORD", retrievedAt: "2026-08-21T04:30:00.000Z", ratedPayloadKg: 4_000 }],
  capacity: { capacityKg: 4_000, basis: "rated payload", source: "GOVERNMENT_RECORD" },
  findings: [{ code: "OVERLOAD", severity: "BLOCK", title: "Overloaded", reason: "5,000 kg on a 4,000 kg lorry.", ruleId: "R1", ruleSetVersion: "1", appliedFacts: [], overridable: true }],
  overrides: [], clearedToMove: false, idempotencyKey: `check:${crypto.randomUUID()}`, ...over,
});

const reading = (companyId: string, registrationNumber: string, over: Partial<VehicleRecordSnapshot> = {}): VehicleRecordSnapshot => {
  const provenance = { provider: "api-setu-vahan", providerReference: `VAHAN/${registrationNumber}/1`, retrievedAt: "2026-08-21T04:30:00.000Z" };
  return {
    companyId, registrationNumber, provenance, notFound: false,
    evidence: {
      registrationNumber, source: "GOVERNMENT_RECORD", retrievedAt: provenance.retrievedAt, vehicleClass: "HEAVY_GOODS_VEHICLE", bodyType: "closed",
      grossVehicleWeightKg: 25_000, unladenWeightKg: 8_600, ratedPayloadKg: 16_400, permitType: "NATIONAL", permitValidUpto: "2027-03-31",
      fitnessValidUpto: "2027-01-15", insuranceValidUpto: "2026-12-31", registeredOwnerName: "S******** T******", registrationStatus: "ACTIVE",
      reference: provenance.providerReference,
    },
    ...over,
  };
};

export function transportContract(label: string, harness: () => TransportHarness, skip: false | string = false): void {
  const shop = async () => {
    const h = harness();
    return { h, ...(await h.company()) };
  };

  test(`${label}: an e-way bill comes back exactly as saved, and is found by id, movement and number`, { skip }, async () => {
    const { h, companyId, userId } = await shop();
    const saved = bill(companyId, userId);
    const partA = bill(companyId, userId, { status: "PART_A_ONLY", distanceKm: 0, vehicleLegs: [], transporter: { name: "Deccan Roadlines", transporterId: "29AAJCT9876Q1Z5" } });
    const { acknowledgement: _none, cancellableUntil: _c, fromPincode: _f, ...bare } = bill(companyId, userId, { status: "PENDING" });
    await h.write(companyId, async () => { await h.bills.insert(saved); await h.bills.insert(partA); await h.bills.insert(bare); });
    assert.deepEqual(await h.bills.findById(companyId, saved.id), saved, "bigint inside jsonb, dates, times and the acknowledgement round-trip");
    assert.deepEqual(await h.bills.findByMovementId(companyId, partA.movementId), partA);
    assert.deepEqual(await h.bills.findByNumber(companyId, saved.acknowledgement?.ewayBillNumber ?? ""), saved);
    assert.deepEqual(await h.bills.findById(companyId, bare.id), bare, "absent fields stay absent");
    assert.equal(await h.bills.findById(companyId, crypto.randomUUID()), null);
    assert.equal(await h.bills.findByMovementId(companyId, crypto.randomUUID()), null);
    assert.equal(await h.bills.findByNumber(companyId, "999999999999"), null);
  });

  test(`${label}: an e-way bill follows its lifecycle, and the portal's latest answer is the one kept`, { skip }, async () => {
    const { h, companyId, userId } = await shop();
    const pending = bill(companyId, userId, { status: "PENDING" });
    const { acknowledgement: _a, ...unsent } = pending;
    await h.write(companyId, () => h.bills.insert(unsent));
    await h.write(companyId, () => h.bills.update(pending));
    const changed: EwayBillRecord = {
      ...pending,
      acknowledgement: { ...(pending.acknowledgement as NonNullable<EwayBillRecord["acknowledgement"]>), validUntil: "2026-08-27T18:29:59.000Z", receivedAt: "2026-08-22T04:30:00.000Z", providerRequestId: "synthetic-ewb-2" },
      vehicleLegs: [...pending.vehicleLegs, { ...(pending.vehicleLegs[0] as EwayBillRecord["vehicleLegs"][number]), registrationNumber: "KA05MN9012", reason: "BREAKDOWN", reasonNote: "Axle broke at Hubballi" }],
      consolidatedTripNumber: "TRIP-1", updatedAt: "2026-08-22T04:30:00.000Z", message: "Moved to another lorry.",
    };
    await h.write(companyId, () => h.bills.update(changed));
    assert.deepEqual(await h.bills.findById(companyId, pending.id), changed);
    const cancelled: EwayBillRecord = { ...changed, status: "CANCELLED", cancelledAt: "2026-08-22T05:00:00.000Z", cancelReasonCode: "ORDER_CANCELLED", cancelReason: "Buyer cancelled", updatedAt: "2026-08-22T05:00:00.000Z" };
    await h.write(companyId, () => h.bills.update(cancelled));
    assert.deepEqual(await h.bills.findById(companyId, pending.id), cancelled);
    // A record that is not there is left alone, as before.
    await h.write(companyId, () => h.bills.update(bill(companyId, userId)));
    assert.equal((await h.bills.list(companyId)).length, 1);
  });

  test(`${label}: one e-way bill record per movement; a second is refused`, { skip }, async () => {
    const { h, companyId, userId } = await shop();
    const first = bill(companyId, userId);
    await h.write(companyId, () => h.bills.insert(first));
    await assert.rejects(h.write(companyId, () => h.bills.insert(bill(companyId, userId, { movementId: first.movementId }))), code("EWAY_DUPLICATE"));
    await assert.rejects(h.write(companyId, () => h.bills.insert({ ...first })), code("EWAY_DUPLICATE"));
    // Two movements may share a number: the portal answers a repeat consignment with the bill it already holds.
    const twin = bill(companyId, userId, { acknowledgement: first.acknowledgement as NonNullable<EwayBillRecord["acknowledgement"]> });
    await h.write(companyId, () => h.bills.insert(twin));
    assert.equal((await h.bills.findByNumber(companyId, first.acknowledgement?.ewayBillNumber ?? ""))?.id, first.id, "the first holder answers");
  });

  test(`${label}: e-way bill lists page through every bill exactly once, and filter as before`, { skip }, async () => {
    const { h, companyId, userId } = await shop();
    const rows = [
      bill(companyId, userId), bill(companyId, userId, { status: "PART_A_ONLY" }), bill(companyId, userId, { status: "CANCELLED", cancelReasonCode: "OTHERS", cancelReason: "x" }),
      bill(companyId, userId, { acknowledgement: { ...(bill(companyId, userId).acknowledgement as NonNullable<EwayBillRecord["acknowledgement"]>), validUntil: "2026-09-30T18:29:59.000Z" } }),
      bill(companyId, userId),
    ];
    await h.write(companyId, async () => { for (const row of rows) await h.bills.insert(row); });
    assert.deepEqual(ids(await h.bills.list(companyId)), ids(rows));
    assert.deepEqual(ids(await walk((page) => h.bills.list(companyId, page), (row) => row.id)), ids(rows));
    const active = [rows[0], rows[1], rows[3], rows[4]] as EwayBillRecord[];
    assert.deepEqual(ids(await h.bills.listActive(companyId)), ids(active));
    assert.deepEqual(ids(await walk((page) => h.bills.listActive(companyId, page), (row) => row.id, 3)), ids(active));
    const expiring = [rows[0], rows[4]] as EwayBillRecord[];
    assert.deepEqual(ids(await h.bills.listExpiringBefore(companyId, "2026-08-27T00:00:00.000Z")), ids(expiring));
    assert.deepEqual(ids(await walk((page) => h.bills.listExpiringBefore(companyId, "2026-08-27T00:00:00.000Z", page), (row) => row.id, 1)), ids(expiring));
    assert.deepEqual(await h.bills.list(companyId, { limit: 5, after: crypto.randomUUID() }), [], "an unknown key ends the list");
  });

  test(`${label}: trip sheets are kept once, found by number, and paged`, { skip }, async () => {
    const { h, companyId, userId } = await shop();
    const rows = [trip(companyId, userId), trip(companyId, userId), trip(companyId, userId)];
    await h.write(companyId, async () => { for (const row of rows) await h.trips.insert(row); });
    assert.deepEqual(await h.trips.findByTripNumber(companyId, rows[1]?.tripNumber ?? ""), rows[1]);
    assert.equal(await h.trips.findByTripNumber(companyId, "TRIP-NONE"), null);
    assert.deepEqual(await h.trips.list(companyId), rows);
    assert.deepEqual(ids(await walk((page) => h.trips.list(companyId, page), (row) => row.id)), ids(rows));
    await assert.rejects(h.write(companyId, () => h.trips.insert(trip(companyId, userId, { tripNumber: rows[0]?.tripNumber ?? "" }))), code("EWAY_TRIP_DUPLICATE"));
  });

  test(`${label}: a vehicle check keeps its evidence, takes overrides in order, and refuses a stale save`, { skip }, async () => {
    const { h, companyId, userId } = await shop();
    const first = check(companyId, userId);
    const plain = check(companyId, userId, { outcome: "OK", findings: [], clearedToMove: true });
    const { capacity: _c, ...noCapacity } = plain;
    await h.write(companyId, async () => { await h.checks.insert(first); await h.checks.insert(noCapacity); });
    assert.deepEqual(await h.checks.findById(companyId, first.id), first);
    assert.deepEqual(await h.checks.findById(companyId, noCapacity.id), noCapacity);
    assert.equal(await h.checks.findById(companyId, crypto.randomUUID()), null);
    await assert.rejects(h.write(companyId, () => h.checks.insert({ ...first })), code("VEHICLE_CHECK_DUPLICATE"));

    const answered: VehicleSuitabilityAssessment = {
      ...first, summary: `${first.summary} Answered.`, clearedToMove: true,
      overrides: [{ findingCodes: ["OVERLOAD"], reason: "Weighed again at the gate: 3,900 kg.", byUserId: userId, at: "2026-08-21T05:00:00.000Z" }],
    };
    await h.write(companyId, () => h.checks.update(answered));
    assert.deepEqual(await h.checks.findById(companyId, first.id), answered);
    // A second person working from the copy before the override: refused, not silently overwritten.
    const stale = { ...first, overrides: [{ findingCodes: ["OVERLOAD"], reason: "Someone else's reason entirely.", byUserId: userId, at: "2026-08-21T05:01:00.000Z" }] };
    await assert.rejects(h.write(companyId, () => h.checks.update(stale)), code("VEHICLE_CHECK_CHANGED"));
    assert.deepEqual(await h.checks.findById(companyId, first.id), answered);
  });

  test(`${label}: the newest check of a movement is the one shown, and the same facts may be checked again later`, { skip }, async () => {
    const { h, companyId, userId } = await shop();
    const movementId = crypto.randomUUID();
    const onX = check(companyId, userId, { movementId, idempotencyKey: "same-facts" });
    const onY = check(companyId, userId, { movementId, idempotencyKey: "other-lorry" });
    const backOnX = check(companyId, userId, { movementId, idempotencyKey: "same-facts" });
    await h.write(companyId, async () => { await h.checks.insert(onX); await h.checks.insert(onY); await h.checks.insert(backOnX); });
    assert.equal((await h.checks.findLatestForMovement(companyId, movementId))?.id, backOnX.id);
    assert.equal(await h.checks.findLatestForMovement(companyId, crypto.randomUUID()), null);
  });

  test(`${label}: vehicle-check lists and the blocked queue page through every check exactly once`, { skip }, async () => {
    const { h, companyId, userId } = await shop();
    const rows = [check(companyId, userId), check(companyId, userId, { outcome: "OK", findings: [], clearedToMove: true }), check(companyId, userId), check(companyId, userId)];
    await h.write(companyId, async () => { for (const row of rows) await h.checks.insert(row); });
    assert.deepEqual(ids(await h.checks.list(companyId)), ids(rows));
    assert.deepEqual(ids(await walk((page) => h.checks.list(companyId, page), (row) => row.id, 3)), ids(rows));
    const blocked = [rows[0], rows[2], rows[3]] as VehicleSuitabilityAssessment[];
    assert.deepEqual(ids(await h.checks.listBlocked(companyId)), ids(blocked));
    assert.deepEqual(ids(await walk((page) => h.checks.listBlocked(companyId, page), (row) => row.id)), ids(blocked));
  });

  test(`${label}: a vehicle reading round-trips, is replaced by a newer one, is paged, and can be forgotten`, { skip }, async () => {
    const { h, companyId } = await shop();
    const numbers = ["DL01AB1234", "KA01AB1234", "KA05MN9012", "MH12XY0001"];
    const notFound: VehicleRecordSnapshot = { companyId, registrationNumber: "TN09ZZ9999", provenance: { provider: "api-setu-vahan", providerReference: "VAHAN/TN09ZZ9999/1", retrievedAt: "2026-08-21T04:31:00.000Z" }, notFound: true };
    await h.write(companyId, async () => { for (const number of numbers) await h.readings.save(reading(companyId, number)); await h.readings.save(notFound); });
    assert.deepEqual(await h.readings.find(companyId, "KA01AB1234"), reading(companyId, "KA01AB1234"));
    assert.deepEqual(await h.readings.find(companyId, "ka-01-ab-1234"), reading(companyId, "KA01AB1234"), "found by the number however it is typed");
    assert.deepEqual(await h.readings.find(companyId, "TN09ZZ9999"), notFound);
    assert.equal(await h.readings.find(companyId, "AP09CC0001"), null);
    const newer = reading(companyId, "KA01AB1234", { provenance: { provider: "api-setu-vahan", providerReference: "VAHAN/KA01AB1234/2", retrievedAt: "2026-08-22T04:30:00.000Z" } });
    const newerEvidence = { ...(newer.evidence as NonNullable<VehicleRecordSnapshot["evidence"]>), retrievedAt: "2026-08-22T04:30:00.000Z", reference: "VAHAN/KA01AB1234/2", registrationStatus: "SUSPENDED" };
    await h.write(companyId, () => h.readings.save({ ...newer, evidence: newerEvidence }));
    assert.deepEqual(await h.readings.find(companyId, "KA01AB1234"), { ...newer, evidence: newerEvidence });
    assert.deepEqual((await walk((page) => h.readings.list(companyId, page), (row) => row.registrationNumber)).map((row) => row.registrationNumber), [...numbers, "TN09ZZ9999"]);
    assert.equal((await h.readings.list(companyId)).length, 5);
    await h.write(companyId, () => h.readings.forget(companyId, "KA05MN9012"));
    await h.write(companyId, () => h.readings.forget(companyId, "AP09CC0001"));
    assert.equal(await h.readings.find(companyId, "KA05MN9012"), null);
    assert.deepEqual((await h.readings.list(companyId)).map((row) => row.registrationNumber).sort(), ["DL01AB1234", "KA01AB1234", "MH12XY0001", "TN09ZZ9999"]);
    // Read again after forgetting: a fresh reading is held as before.
    await h.write(companyId, () => h.readings.save(reading(companyId, "KA05MN9012")));
    assert.deepEqual(await h.readings.find(companyId, "KA05MN9012"), reading(companyId, "KA05MN9012"));
  });

  test(`${label}: consent is one per company and purpose, and its withdrawal is kept`, { skip }, async () => {
    const { h, companyId, userId } = await shop();
    assert.equal(await h.consents.current(companyId, "TRANSPORT_SUITABILITY"), null);
    const granted = { companyId, purpose: "TRANSPORT_SUITABILITY" as const, fields: ["registrationNumber", "vehicleClass"] as const, grantedBy: userId, grantedAt: "2026-08-21T04:30:00.000Z", expiresOn: "2027-08-20", credentialReference: `vault://vehicle/${companyId}` };
    await h.write(companyId, () => h.consents.save({ ...granted, fields: [...granted.fields] }));
    assert.deepEqual(await h.consents.current(companyId, "TRANSPORT_SUITABILITY"), { ...granted, fields: [...granted.fields] });
    const { expiresOn: _e, credentialReference: _r, ...plain } = granted;
    const withdrawn = { ...plain, fields: [...granted.fields], revokedAt: "2026-08-25T04:30:00.000Z" };
    await h.write(companyId, () => h.consents.save(withdrawn));
    assert.deepEqual(await h.consents.current(companyId, "TRANSPORT_SUITABILITY"), withdrawn);
  });

  test(`${label}: each policy is effective-dated, replaced on the same day, and falls back to the default`, { skip }, async () => {
    const { h, companyId, userId } = await shop();
    assert.deepEqual(await h.ewayPolicies.policyFor(companyId, "2026-08-21"), DEFAULT_EWAY_BILL_POLICY);
    assert.deepEqual(await h.suitabilityPolicies.policyFor(companyId, "2026-08-21"), DEFAULT_VEHICLE_SUITABILITY_POLICY);
    assert.deepEqual(await h.freshness.policyFor(companyId, "2026-08-21"), DEFAULT_VEHICLE_RECORD_FRESHNESS);
    const eway = { ...DEFAULT_EWAY_BILL_POLICY, kilometresPerDayRegular: 250, effectiveFrom: "2026-09-01" };
    const suitability = { ...DEFAULT_VEHICLE_SUITABILITY_POLICY, warnFromLoadFactor: 0.85, minimumPlateConfidence: 0.725, wrongPermitSeverity: "BLOCK" as const, effectiveFrom: "2026-09-01" };
    const freshness = { reuseWithinHours: 2, staleAfterDays: 3, effectiveFrom: "2026-09-01" };
    await h.write(companyId, async () => {
      await h.ewayPolicies.set(companyId, { ...eway, kilometresPerDayRegular: 1 }, userId);
      await h.ewayPolicies.set(companyId, eway, userId);
      await h.suitabilityPolicies.set(companyId, suitability, userId);
      await h.freshness.set(companyId, freshness, userId);
    });
    assert.deepEqual(await h.ewayPolicies.policyFor(companyId, "2026-08-31"), DEFAULT_EWAY_BILL_POLICY, "a rule is not applied before its day");
    assert.deepEqual(await h.ewayPolicies.policyFor(companyId, "2026-09-01"), eway);
    assert.deepEqual(await h.suitabilityPolicies.policyFor(companyId, "2026-10-01"), suitability);
    assert.deepEqual(await h.freshness.policyFor(companyId, "2026-10-01"), freshness);
  });

  test(`${label}: one company cannot read or change another company's records`, { skip }, async () => {
    const a = await shop();
    const b = await shop();
    const theirs = bill(a.companyId, a.userId);
    const theirTrip = trip(a.companyId, a.userId);
    const theirCheck = check(a.companyId, a.userId);
    await a.h.write(a.companyId, async () => {
      await a.h.bills.insert(theirs); await a.h.trips.insert(theirTrip); await a.h.checks.insert(theirCheck);
      await a.h.readings.save(reading(a.companyId, "KA01AB1234"));
    });
    assert.equal(await b.h.bills.findById(b.companyId, theirs.id), null);
    assert.equal(await b.h.bills.findByMovementId(b.companyId, theirs.movementId), null);
    assert.equal(await b.h.bills.findByNumber(b.companyId, theirs.acknowledgement?.ewayBillNumber ?? ""), null);
    assert.deepEqual(await b.h.bills.list(b.companyId), []);
    assert.equal(await b.h.trips.findByTripNumber(b.companyId, theirTrip.tripNumber), null);
    assert.equal(await b.h.checks.findById(b.companyId, theirCheck.id), null);
    assert.equal(await b.h.readings.find(b.companyId, "KA01AB1234"), null);
    // Writing under company B with A's ids changes nothing of A's.
    await b.h.write(b.companyId, async () => {
      await b.h.bills.update({ ...theirs, companyId: b.companyId, message: "changed by B" });
      await b.h.checks.update({ ...theirCheck, companyId: b.companyId, summary: "changed by B" });
      await b.h.readings.forget(b.companyId, "KA01AB1234");
    });
    assert.deepEqual(await a.h.bills.findById(a.companyId, theirs.id), theirs);
    assert.deepEqual(await a.h.checks.findById(a.companyId, theirCheck.id), theirCheck);
    assert.deepEqual(await a.h.readings.find(a.companyId, "KA01AB1234"), reading(a.companyId, "KA01AB1234"));
  });

  test(`${label}: an action that fails leaves none of its writes behind`, { skip }, async () => {
    const { h, companyId, userId } = await shop();
    const lost = bill(companyId, userId);
    const lostTrip = trip(companyId, userId);
    const lostCheck = check(companyId, userId);
    await assert.rejects(h.write(companyId, async () => {
      await h.bills.insert(lost); await h.trips.insert(lostTrip); await h.checks.insert(lostCheck);
      throw new Error("the lorry left without its paperwork");
    }), /without its paperwork/);
    assert.equal(await h.bills.findById(companyId, lost.id), null);
    assert.equal(await h.trips.findByTripNumber(companyId, lostTrip.tripNumber), null);
    assert.equal(await h.checks.findById(companyId, lostCheck.id), null);
  });
}
