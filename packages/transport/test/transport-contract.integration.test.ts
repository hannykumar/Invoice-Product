/**
 * Issue #366 — the transport lane's repositories on a real PostgreSQL, connected as the application
 * role so row-level security and the freeze rules of #368 are really in force.
 *
 *  - The same contract suite the in-memory stores pass (transport-contract.ts).
 *  - Every write refuses to run outside a unit of work.
 *  - Every lifecycle move the e-way bill service makes, through these repositories, on frozen rows.
 *  - The vehicle check and the vehicle-record services, through these repositories.
 *
 * The synthetic portal and the synthetic VAHAN answer in-process, so calling them inside a unit of
 * work here holds no real connection open. In the server, #340 must keep provider calls outside it.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";
import type { CompanyId } from "@invoice/kernel";
import { InMemoryAuditPort, type ActorContext } from "@invoice/ledger";
import type { TransactionalExecutor } from "../../platform/src/database.ts";
import { ConnectorGateway, StaticWebhookVerifier } from "../../platform/src/connectors.ts";
import { syntheticGstin } from "../../masters/src/fixtures.ts";
import { InMemoryEwayBillStore, SyntheticEwayBillPortal, SyntheticEwayVault, ewayBillAdapter } from "../src/adapters.ts";
import { EwayBillService } from "../src/service.ts";
import { VehicleSuitabilityService } from "../src/suitability-service.ts";
import { SyntheticPlateReader } from "../src/suitability-adapters.ts";
import { SYNTHETIC_VAHAN_ROWS, SyntheticVahanConnector, apiSetuVehicleAdapter } from "../src/vehicle-record-adapters.ts";
import { VehicleRecordService } from "../src/vehicle-record-service.ts";
import { ALL_EWAY_PERMISSIONS, ALL_VEHICLE_RECORD_PERMISSIONS, fiveTonneShipment, interStateMovement, lorry, movableClock, transportDetails } from "../src/fixtures.ts";
import { DEFAULT_EWAY_BILL_POLICY, type Movement } from "../src/types.ts";
import { DEFAULT_VEHICLE_SUITABILITY_POLICY } from "../src/suitability-types.ts";
import type * as Repositories from "../src/postgres-repositories.ts";
import { bill, transportContract, type TransportHarness } from "./transport-contract.ts";

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error("DATABASE_URL must be set in CI so the transport database tests run.");
const skip = url === undefined && "DATABASE_URL is not set";

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let repos: typeof Repositories;
const login = `invoice_app_test_${randomBytes(6).toString("hex")}`;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import("../../platform/src/database.ts");
  const { migrate } = await import("../../platform/src/migrations.ts");
  repos = await import("../src/postgres-repositories.ts");
  owner = createDatabase(url);
  await migrate(owner);
  // What a deployment does once: a login for the server, with nothing but membership of invoice_app.
  const password = randomBytes(18).toString("hex");
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  const appUrl = new URL(url);
  appUrl.username = login;
  appUrl.password = password;
  app = createDatabase(appUrl.toString());
});
after(async () => {
  await app?.close();
  if (owner !== undefined) { await owner.query(`DROP ROLE IF EXISTS ${login}`); await owner.close(); }
});

const company = async (): Promise<{ companyId: CompanyId; userId: string }> => {
  const companyId = crypto.randomUUID() as CompanyId;
  const userId = crypto.randomUUID();
  await app.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Transport Traders')", [companyId]);
  await app.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Synthetic dispatcher')", [userId, `transport-${userId}@example.invalid`]);
  return { companyId, userId };
};

const harness = (): TransportHarness => ({
  bills: new repos.PostgresEwayBillRepository(app),
  trips: new repos.PostgresConsolidatedTripRepository(app),
  checks: new repos.PostgresSuitabilityRepository(app),
  readings: new repos.PostgresVehicleRecordCache(app),
  consents: new repos.PostgresVehicleRecordConsents(app),
  ewayPolicies: new repos.PostgresEwayBillPolicies(app),
  suitabilityPolicies: new repos.PostgresVehicleSuitabilityPolicies(app),
  freshness: new repos.PostgresVehicleRecordFreshness(app),
  company,
  write: (companyId, work) => app.unitOfWork(companyId, () => work()),
});

transportContract("postgres as the application role", harness, skip);

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

test("a write outside the action's transaction is refused, not committed on its own", { skip }, async () => {
  const h = harness();
  const { companyId, userId } = await company();
  const record = bill(companyId, userId);
  const writes: (() => Promise<void>)[] = [
    () => h.bills.insert(record), () => h.bills.update(record),
    () => h.trips.insert({ id: crypto.randomUUID(), companyId, tripNumber: "T-1", vehicleNumber: "KA01AB1234", fromPlace: "Bengaluru", fromStateCode: "29", transportMode: "ROAD", ewayBillNumbers: [], createdBy: userId, createdAt: "2026-08-21T04:30:00.000Z", message: "m" }),
    () => h.checks.insert({ id: crypto.randomUUID(), companyId, movementId: crypto.randomUUID(), checkedAt: "2026-08-21T04:30:00.000Z", checkedBy: userId, outcome: "OK", summary: "s", transport: { mode: "ROAD", movementDate: "2026-08-21" }, shipment: {}, evidence: [], findings: [], overrides: [], clearedToMove: true, idempotencyKey: "k" }),
    () => h.readings.save({ companyId, registrationNumber: "KA01AB1234", provenance: { provider: "p", providerReference: "r", retrievedAt: "2026-08-21T04:30:00.000Z" }, notFound: true }),
    () => h.readings.forget(companyId, "KA01AB1234"),
    () => h.consents.save({ companyId, purpose: "TRANSPORT_SUITABILITY", fields: [], grantedBy: userId, grantedAt: "2026-08-21T04:30:00.000Z" }),
    () => h.ewayPolicies.set(companyId, DEFAULT_EWAY_BILL_POLICY, userId),
    () => h.suitabilityPolicies.set(companyId, DEFAULT_VEHICLE_SUITABILITY_POLICY, userId),
    () => h.freshness.set(companyId, { reuseWithinHours: 1, staleAfterDays: 1, effectiveFrom: "2026-04-01" }, userId),
  ];
  for (const write of writes) await assert.rejects(write(), code("NO_UNIT_OF_WORK"));
  assert.equal(await h.bills.findById(companyId, record.id), null);
});

test("readings, consent and policies written by a failed action are gone with it", { skip }, async () => {
  const h = harness();
  const { companyId, userId } = await company();
  await assert.rejects(app.unitOfWork(companyId, async () => {
    await h.readings.save({ companyId, registrationNumber: "KA01AB1234", provenance: { provider: "p", providerReference: "r", retrievedAt: "2026-08-21T04:30:00.000Z" }, notFound: true });
    await h.consents.save({ companyId, purpose: "TRANSPORT_SUITABILITY", fields: [], grantedBy: userId, grantedAt: "2026-08-21T04:30:00.000Z" });
    await h.ewayPolicies.set(companyId, { ...DEFAULT_EWAY_BILL_POLICY, kilometresPerDayRegular: 1 }, userId);
    throw new Error("abandoned");
  }), /abandoned/);
  assert.equal(await h.readings.find(companyId, "KA01AB1234"), null);
  assert.equal(await h.consents.current(companyId, "TRANSPORT_SUITABILITY"), null);
  assert.deepEqual(await h.ewayPolicies.policyFor(companyId, "2026-08-21"), DEFAULT_EWAY_BILL_POLICY);
});

test("every table of this lane is closed to other companies by the database itself", { skip }, async () => {
  const { rows } = await owner.query(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND (c.relname LIKE 'eway\\_%' OR c.relname LIKE 'vehicle\\_%')
        AND EXISTS (SELECT FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped)
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`,
  );
  assert.deepEqual(rows, []);
  // A query that forgot its company filter still sees only its own company's rows.
  const a = await company();
  const b = await company();
  const theirs = bill(a.companyId, a.userId);
  await app.unitOfWork(a.companyId, () => harness().bills.insert(theirs));
  const seen = await app.tenantTransaction(b.companyId, (sql) => sql.query("SELECT count(*)::int AS n FROM eway_bills"));
  assert.equal(seen.rows[0]?.n, 0);
  await assert.rejects(app.tenantTransaction(b.companyId, (sql) => sql.query(
    "INSERT INTO eway_bill_acknowledgements (company_id, eway_bill_id, acknowledgement) VALUES ($1, $2, '{}')", [a.companyId, theirs.id])), code("42501"));
});

test("the e-way bill service's whole lifecycle works through PostgreSQL, frozen rows included", { skip }, async () => {
  const { companyId, userId } = await company();
  const actor: ActorContext = { companyId, branchId: null, userId: userId as ActorContext["userId"], permissions: ALL_EWAY_PERMISSIONS };
  const clock = movableClock("2026-08-21T04:30:00.000Z");
  const audit = new InMemoryAuditPort();
  const bills = new repos.PostgresEwayBillRepository(app);
  const trips = new repos.PostgresConsolidatedTripRepository(app);
  const policies = new repos.PostgresEwayBillPolicies(app);
  const portal = new SyntheticEwayBillPortal(() => clock.now());
  const deskOn = (synthetic: SyntheticEwayBillPortal, records = bills as ConstructorParameters<typeof EwayBillService>[0]["records"]) => new EwayBillService({
    portal: ewayBillAdapter({ gateway: new ConnectorGateway([synthetic], new SyntheticEwayVault(), new StaticWebhookVerifier()), clock: () => clock.now() }),
    records, trips, audit, clock, policy: policies,
  });
  const desk = deskOn(portal);
  const act = <T>(work: () => Promise<T>): Promise<T> => app.unitOfWork(companyId, work);
  const movement = (doc: string, over: Partial<Movement> = {}): Movement => {
    const base = interStateMovement();
    return interStateMovement({ movementId: crypto.randomUUID(), documents: [{ ...(base.documents[0] as Movement["documents"][number]), documentNumber: doc }], ...over });
  };

  // Part A only, then the first vehicle, then a breakdown and a change of lorry: a frozen row taking the moves it may.
  const m1 = movement("SAM/2026/0201");
  assert.equal((await act(() => desk.generate(actor, m1))).status, "PART_A_ONLY");
  assert.equal((await act(() => desk.updateVehicle(actor, m1.movementId, lorry()))).status, "ACTIVE");
  const changed = await act(() => desk.updateVehicle(actor, m1.movementId, lorry({ registrationNumber: "KA05MN9012", reason: "BREAKDOWN", reasonNote: "Axle broke at Hubballi" })));
  assert.equal(changed.vehicleLegs.length, 2);
  await act(() => desk.assignTransporter(actor, m1.movementId, { name: "Deccan Roadlines", transporterId: syntheticGstin("29", "AAJCT9876Q") }));

  // A second lorry load, and both on one trip sheet.
  const m2 = movement("SAM/2026/0202", { vehicle: lorry() });
  assert.equal((await act(() => desk.generate(actor, m2))).status, "ACTIVE");
  const sheet = await act(() => desk.consolidate(actor, { vehicleNumber: "KA01AB1234", fromPlace: "Bengaluru", fromStateCode: "29", transportMode: "ROAD", movementIds: [m1.movementId, m2.movementId] }));
  assert.deepEqual(await trips.findByTripNumber(companyId, sheet.tripNumber), sheet);
  assert.equal((await bills.findByMovementId(companyId, m2.movementId))?.consolidatedTripNumber, sheet.tripNumber);

  // Cancelled by us, and rejected by the other party.
  const m3 = movement("SAM/2026/0203", { vehicle: lorry() });
  await act(() => desk.generate(actor, m3));
  assert.equal((await act(() => desk.cancel(actor, m3.movementId, { reasonCode: "ORDER_CANCELLED", reason: "The buyer cancelled the order." }))).status, "CANCELLED");
  const m4 = movement("SAM/2026/0204", { vehicle: lorry() });
  await act(() => desk.generate(actor, m4));
  assert.equal((await act(() => desk.reject(actor, m4.movementId, { reasonCode: "NOT_MY_CONSIGNMENT", reason: "We never ordered this." }))).status, "REJECTED");

  // The portal's duplicate reply: a second movement carrying m2's document keeps m2's number.
  const twin = movement("SAM/2026/0202", { vehicle: lorry() });
  const kept = await act(() => desk.generate(actor, twin));
  assert.equal(kept.acknowledgement?.ewayBillNumber, (await bills.findByMovementId(companyId, m2.movementId))?.acknowledgement?.ewayBillNumber);

  // A cancellation made elsewhere on the portal, found by a reconcile: CANCELLED with no reason of ours.
  const m6 = movement("SAM/2026/0206", { vehicle: lorry() });
  await act(() => desk.generate(actor, m6));
  const elsewhere = deskOn(portal, new InMemoryEwayBillStore());
  await elsewhere.generate(actor, m6);
  await elsewhere.cancel(actor, m6.movementId, { reasonCode: "DATA_ENTRY_MISTAKE", reason: "Cancelled on the portal's own screen." });
  const found = await act(() => desk.reconcile(actor, m6.movementId));
  assert.equal(found.status, "CANCELLED");
  assert.equal(found.cancelReason, undefined);

  // Near the end of its validity, the bill is extended.
  const until = (await bills.findByMovementId(companyId, m1.movementId))?.acknowledgement?.validUntil ?? "";
  clock.travelTo(new Date(new Date(until).getTime() - 2 * 3_600_000).toISOString());
  const extended = await act(() => desk.extendValidity(actor, m1.movementId, { currentPlace: "Hubballi", currentStateCode: "29", remainingDistanceKm: 400, reason: "The lorry broke down." }));
  assert.notEqual(extended.acknowledgement?.validUntil, until);

  // The portal disowns a live bill (#368's known limit): FAILED, then raised again on the same row.
  const forgetful = deskOn(new SyntheticEwayBillPortal(() => clock.now()));
  assert.equal((await act(() => forgetful.reconcile(actor, m2.movementId))).status, "FAILED");
  const again = await act(() => forgetful.generate(actor, m2));
  assert.equal(again.status, "ACTIVE");
  assert.equal(again.id, (await bills.findByMovementId(companyId, m2.movementId))?.id);

  // Everything read back is what the service last wrote.
  for (const m of [m1, m2, m3, m4, twin, m6]) {
    const stored = await bills.findByMovementId(companyId, m.movementId);
    assert.ok(stored !== null);
  }
  assert.deepEqual(await bills.findByMovementId(companyId, m1.movementId), extended);
  assert.deepEqual(await bills.findByMovementId(companyId, m2.movementId), again);
  // The portal's answers are a history: m1 has had five (Part A, two vehicles, transporter, extension).
  const history = await app.tenantTransaction(companyId, (sql) => sql.query(
    "SELECT count(*)::int AS n FROM eway_bill_acknowledgements a JOIN eway_bills b ON b.id = a.eway_bill_id WHERE a.company_id = $1 AND b.movement_id = $2", [companyId, m1.movementId]));
  assert.equal(history.rows[0]?.n, 5);

  // And what may never change, cannot: the number of a live bill, or a kept answer.
  const live = await bills.findByMovementId(companyId, m1.movementId);
  await assert.rejects(act(() => bills.update({ ...(live as NonNullable<typeof live>), consignmentValuePaise: 1n })), code("23001"));
  await assert.rejects(app.unitOfWork(companyId, ({ sql }) => sql.query("UPDATE eway_bill_acknowledgements SET acknowledgement = '{}' WHERE company_id = $1", [companyId])), code("23001"));
});

test("vehicle checks and vehicle-record lookups work through PostgreSQL", { skip }, async () => {
  const { companyId, userId } = await company();
  const actor: ActorContext = { companyId, branchId: null, userId: userId as ActorContext["userId"], permissions: ALL_VEHICLE_RECORD_PERMISSIONS };
  const clock = movableClock("2026-08-21T04:30:00.000Z");
  const audit = new InMemoryAuditPort();
  const cache = new repos.PostgresVehicleRecordCache(app);
  const vahan = new SyntheticVahanConnector(SYNTHETIC_VAHAN_ROWS);
  const records = new VehicleRecordService({
    provider: apiSetuVehicleAdapter({ gateway: new ConnectorGateway([vahan], new SyntheticEwayVault(), new StaticWebhookVerifier()), clock: () => clock.now() }),
    cache, consent: new repos.PostgresVehicleRecordConsents(app), audit, clock, freshness: new repos.PostgresVehicleRecordFreshness(app),
  });
  const checks = new repos.PostgresSuitabilityRepository(app);
  const service = new VehicleSuitabilityService({
    records: checks, audit, clock, vehicleRecords: records.portFor(actor), plateOcr: new SyntheticPlateReader(),
    policy: new repos.PostgresVehicleSuitabilityPolicies(app),
  });
  const act = <T>(work: () => Promise<T>): Promise<T> => app.unitOfWork(companyId, work);

  await act(() => records.grantConsent(actor, { credentialReference: `vault://vehicle/${companyId}` }));
  const reading = await act(() => records.verify(actor, "KA02GV3344"));
  assert.equal(reading.kind, "FOUND");
  const again = await act(() => records.verify(actor, "KA02GV3344"));
  assert.equal(again.kind === "FOUND" && again.fromCache, true, "the stored reading is reused");
  assert.equal(vahan.calls, 1);

  const movementId = crypto.randomUUID();
  const request = { movementId, transport: transportDetails({ vehicleNumber: "KA02GV3344" }), shipment: fiveTonneShipment() };
  const checked = await act(() => service.assess(actor, request));
  assert.equal(checked.clearedToMove, false);
  assert.equal((await act(() => service.assess(actor, request))).id, checked.id, "the same facts give the same check");
  assert.deepEqual(await checks.listBlocked(companyId), [checked]);
  const overridden = await act(() => service.override(actor, checked.id, {
    findingCodes: ["VEHICLE.CAPACITY.EXCEEDED"], reason: "Weighbridge slip shows 1,180 kg; the load has been reweighed.",
  }));
  assert.deepEqual(await checks.findById(companyId, checked.id), overridden);
  assert.deepEqual(overridden.evidence, checked.evidence);
  assert.deepEqual(await checks.listBlocked(companyId), overridden.clearedToMove ? [] : [overridden]);
  // Checked on another lorry, then on the first one again: a new check, and the newest is shown.
  await act(() => service.assess(actor, { ...request, transport: transportDetails({ vehicleNumber: "KA01AB1234" }) }));
  const back = await act(() => service.assess(actor, request));
  assert.notEqual(back.id, checked.id);
  assert.equal((await checks.findLatestForMovement(companyId, movementId))?.id, back.id);

  // Withdrawing consent forgets every reading; the facts are gone from the row itself.
  await act(() => records.revokeConsent(actor, "We stopped using this service."));
  assert.deepEqual(await cache.list(companyId), []);
  const row = await app.tenantTransaction(companyId, (sql) => sql.query(
    "SELECT provider_reference, vehicle_class, registered_owner_masked, forgotten_at FROM vehicle_records WHERE company_id = $1", [companyId]));
  assert.ok(row.rows.length > 0);
  for (const r of row.rows) assert.deepEqual([r.provider_reference, r.vehicle_class, r.registered_owner_masked, r.forgotten_at !== null], ["", null, null, true]);
});
