/**
 * Issue #366 — one contract suite for the master-data SERVICE, run against the in-memory stores
 * (masters-service-contract.test.ts) and against PostgreSQL (masters-service-contract.integration.test.ts).
 *
 * It states what a shopkeeper's records must do whichever storage is underneath: a customer saved is
 * found, a near-twin is not silently made, a retry makes nothing new, an edit keeps the old version
 * for the old bill, a merge needs an approver, and one company never sees another's.
 * Synthetic data only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Permission, RequestContext } from "../../platform/src/types.ts";
import { MasterDataError } from "../src/errors.ts";
import type { MasterDataService } from "../src/masters.ts";
import { syntheticGstin } from "../src/fixtures.ts";
import { quantity } from "../src/units.ts";

export interface Shop {
  readonly companyId: string;
  context(permissions?: readonly Permission[]): RequestContext;
}

export interface ServiceHarness {
  /** A service over the storage under test. On PostgreSQL every call is another process on one database. */
  service(): MasterDataService;
  /** Whether two services from `service()` see the same records (true on PostgreSQL, false in memory). */
  readonly shared: boolean;
  shop(): Promise<Shop>;
}

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
let sequence = 0;
const key = (label = "k") => `${label}-${crypto.randomUUID()}-${(sequence += 1)}`;
const APPROVER: readonly Permission[] = ["approval.decide", "access.review"];

export function mastersServiceContract(label: string, harness: () => ServiceHarness, skip: false | string = false): void {
  const party = (name: string, extra: Record<string, unknown> = {}) => ({ legalName: name, role: "supplier", gstRegistrationType: "regular", ...extra }) as never;

  test(`${label}: a customer is saved, found by id, by list and by a spoken name`, { skip }, async () => {
    const h = harness();
    const [svc, shop] = [h.service(), await h.shop()];
    const ctx = shop.context();
    const created = await svc.createParty(ctx, party("Synthetic Traders", { pan: "AABCS1234C", phones: ["98450 12345"] }), { idempotencyKey: key(), effectiveFrom: "2026-04-01" });
    assert.equal(created.record.companyId, shop.companyId);
    assert.deepEqual(created.record.phones, ["9845012345"]);
    assert.equal((await svc.party(ctx, created.record.id)).legalName, "Synthetic Traders");
    assert.deepEqual((await svc.parties(ctx)).map((p) => p.id), [created.record.id]);
    const heard = await svc.resolveParty(ctx, "synthetic traders");
    assert.equal(heard.status, "resolved");
    assert.equal(heard.status === "resolved" && heard.record.id, created.record.id);
    assert.equal((await svc.resolveParty(ctx, "Nobody Like This")).status, "not_found");
    await assert.rejects(svc.party(ctx, crypto.randomUUID()), code("NOT_FOUND"));
  });

  test(`${label}: a second business with the same GST number is refused, and a near-twin name waits for a yes`, { skip }, async () => {
    const h = harness();
    const [svc, shop] = [h.service(), await h.shop()];
    const ctx = shop.context();
    const first = await svc.createParty(ctx, party("ABC Traders", { pan: "AABCA1234C" }), { idempotencyKey: key(), effectiveFrom: "2026-04-01" });
    const gstin = syntheticGstin("29", "AABCA1234C");
    const address = { label: "Head office", line1: "14 Avenue Road", city: "Bengaluru", stateCode: "29", pincode: "560001", gstin, use: "both", isPrimary: true } as never;
    await svc.addAddress(ctx, { partyId: first.record.id, ...(address as object) } as never, { idempotencyKey: key() });

    const twin = await svc.createParty(ctx, party("A B C Trading Co"), { idempotencyKey: key() }).catch((error: unknown) => error);
    // A different-enough name is its own business; the GST number is what makes it the same one.
    const second = !(twin instanceof Error) ? (twin as Awaited<ReturnType<typeof svc.createParty>>) : (await svc.createParty(ctx, party("A B C Trading Co"), { idempotencyKey: key(), acknowledgeSimilar: true }));
    await assert.rejects(svc.addAddress(ctx, { partyId: second.record.id, ...(address as object) } as never, { idempotencyKey: key() }), (error: unknown) =>
      error instanceof MasterDataError && error.code === "DUPLICATE_BLOCKED" && error.problems[0]?.code === "GSTIN_ALREADY_USED");

    const blocked = await svc.createParty(ctx, party("ABC Trader"), { idempotencyKey: key() }).catch((error: unknown) => error);
    assert.ok(blocked instanceof MasterDataError && blocked.code === "DUPLICATE_BLOCKED" && blocked.candidates.length > 0);
    const allowed = await svc.createParty(ctx, party("ABC Trader"), { idempotencyKey: key(), acknowledgeSimilar: true });
    assert.equal(allowed.warnings[0]?.code, "SIMILAR_NAME_ACKNOWLEDGED");
  });

  test(`${label}: a wrong GST number, PIN code or PAN is explained and saves nothing`, { skip }, async () => {
    const h = harness();
    const [svc, shop] = [h.service(), await h.shop()];
    const ctx = shop.context();
    const konkan = await svc.createParty(ctx, party("Konkan Metals", { pan: "AAECS5678D" }), { idempotencyKey: key(), effectiveFrom: "2026-04-01" });
    const at = (extra: Record<string, unknown>) => svc.addAddress(ctx, { partyId: konkan.record.id, label: "Works", line1: "MIDC", city: "Pune", stateCode: "27", pincode: "411001", use: "both", isPrimary: true, ...extra } as never, { idempotencyKey: key() });
    await assert.rejects(at({ stateCode: "29", gstin: syntheticGstin("27", "AAECS5678D") }), (error: unknown) => error instanceof MasterDataError && error.problems[0]?.code === "PINCODE_STATE_MISMATCH" || error instanceof MasterDataError && error.problems[0]?.code === "GSTIN_STATE_MISMATCH");
    await assert.rejects(at({ gstin: syntheticGstin("27", "AABCA1234C") }), (error: unknown) => error instanceof MasterDataError && error.problems[0]?.code === "GSTIN_PAN_MISMATCH");
    await assert.rejects(at({ pincode: "110039" }), (error: unknown) => error instanceof MasterDataError && error.problems[0]?.code === "PINCODE_STATE_MISMATCH");
    assert.deepEqual(await svc.addressesOfParty(shop.companyId, konkan.record.id), [], "nothing half-saved");
    await assert.rejects(svc.createParty(ctx, party("Bad PAN Traders", { pan: "NOT-A-PAN" }), { idempotencyKey: key() }), code("VALIDATION_FAILED"));
    assert.equal((await svc.parties(ctx)).length, 1);
  });

  test(`${label}: retrying a create with the same reference returns the first record and makes no second version`, { skip }, async () => {
    const h = harness();
    const [svc, shop] = [h.service(), await h.shop()];
    const ctx = shop.context();
    const reference = key("retry");
    const first = await svc.createParty(ctx, party("Retry Traders"), { idempotencyKey: reference, effectiveFrom: "2026-04-01" });
    const again = await svc.createParty(ctx, party("Retry Traders"), { idempotencyKey: reference, effectiveFrom: "2026-04-01" });
    assert.equal(again.record.id, first.record.id);
    assert.equal(again.command.id, first.command.id);
    assert.equal((await svc.history(ctx, "party", first.record.id)).length, 1);
    assert.equal((await svc.parties(ctx)).length, 1);
    // The same reference for different input is a mistake, not a retry.
    await assert.rejects(svc.createParty(ctx, party("Another Name Entirely"), { idempotencyKey: reference, effectiveFrom: "2026-04-01" }), code("IDEMPOTENCY_CONFLICT"));
    if (h.shared) {
      // A retry that reaches another process (or the same one after a restart) is still a retry.
      const elsewhere = await h.service().createParty(ctx, party("Retry Traders"), { idempotencyKey: reference, effectiveFrom: "2026-04-01" });
      assert.equal(elsewhere.record.id, first.record.id);
      assert.equal((await h.service().history(ctx, "party", first.record.id)).length, 1);
    }
  });

  test(`${label}: an edit is a new version, and a document dated before it still sees the old facts`, { skip }, async () => {
    const h = harness();
    const [svc, shop] = [h.service(), await h.shop()];
    const ctx = shop.context();
    const created = await svc.createParty(ctx, party("ABC Traders"), { idempotencyKey: key(), effectiveFrom: "2026-04-01" });
    const id = created.record.id;
    const invoiceSnapshot = await svc.snapshot(ctx, "party", id, "2026-05-10");
    await svc.updateParty(ctx, id, { legalName: "ABC Traders and Sons" }, { idempotencyKey: key(), effectiveFrom: "2026-07-01", reason: "A partner joined" });
    assert.equal(invoiceSnapshot.facts.legalName, "ABC Traders");
    assert.equal((await svc.party(ctx, id, "2026-05-10")).legalName, "ABC Traders");
    assert.equal((await svc.party(ctx, id, "2026-08-01")).legalName, "ABC Traders and Sons");
    assert.equal((await svc.snapshot(ctx, "party", id, "2026-05-10")).facts.legalName, "ABC Traders", "a reprint is not rewritten by the later edit");
    const history = await svc.history(ctx, "party", id);
    assert.deepEqual(history.map((v) => [v.version, v.effectiveFrom, v.recordedBy]), [[1, "2026-04-01", ctx.actorId], [2, "2026-07-01", ctx.actorId]]);
    assert.equal(history[1]?.reason, "A partner joined");
    await assert.rejects(svc.snapshot(ctx, "party", id, "2026-03-01"), code("NOT_FOUND"));
  });

  test(`${label}: merging two businesses needs an approver, keeps the old id working and loses no number or alias`, { skip }, async () => {
    const h = harness();
    const [svc, shop] = [h.service(), await h.shop()];
    const maker = shop.context();
    const winner = await svc.createParty(maker, party("Shree Ram Steels", { phones: ["9845011111"] }), { idempotencyKey: key(), effectiveFrom: "2026-04-01" });
    const loser = await svc.createParty(maker, party("Sri Rama Steel Traders", { phones: ["9845022222"], aliases: ["SRS"] }), { idempotencyKey: key(), effectiveFrom: "2026-04-01", acknowledgeSimilar: true });
    await assert.rejects(svc.mergeParties(maker, winner.record.id, loser.record.id, { idempotencyKey: key() }), code("FORBIDDEN"));
    assert.equal((await svc.parties(maker)).length, 2, "a refused merge changes nothing");
    const merged = await svc.mergeParties(shop.context(APPROVER), winner.record.id, loser.record.id, { idempotencyKey: key(), reason: "same shop" });
    assert.deepEqual([...merged.winner.phones].sort(), ["9845011111", "9845022222"]);
    assert.ok(merged.winner.aliases.includes("SRS") && merged.winner.aliases.includes("Sri Rama Steel Traders"));
    assert.deepEqual((await svc.parties(maker)).map((p) => p.id), [winner.record.id]);
    assert.equal((await svc.party(maker, loser.record.id)).id, winner.record.id, "the old id still resolves");
    await assert.rejects(svc.mergeParties(shop.context(APPROVER), winner.record.id, winner.record.id, { idempotencyKey: key() }), code("CONFLICT"));
  });

  test(`${label}: one company never sees, resolves, merges or snapshots another company's records`, { skip }, async () => {
    const h = harness();
    const [svc, a, b] = [h.service(), await h.shop(), await h.shop()];
    const ca = a.context();
    const cb = b.context();
    const mine = await svc.createParty(ca, party("Only Company A Sells To Them"), { idempotencyKey: key(), effectiveFrom: "2026-04-01" });
    const item = await svc.createItem(ca, { name: "Company A Secret Widget", kind: "goods", hsnSac: "72142090", baseUnit: "KGS", trackBatches: false, trackSerials: false } as never, { idempotencyKey: key(), effectiveFrom: "2026-04-01" });
    const reads: (() => Promise<unknown>)[] = [
      () => svc.party(cb, mine.record.id), () => svc.item(cb, item.record.id),
      () => svc.snapshot(cb, "party", mine.record.id, "2026-05-01"),
      () => svc.updateParty(cb, mine.record.id, { legalName: "Taken Over" }, { idempotencyKey: key() }),
      () => svc.mergeParties(b.context(APPROVER), mine.record.id, mine.record.id, { idempotencyKey: key() }),
    ];
    for (const read of reads) await assert.rejects(Promise.resolve().then(read), (error: unknown) => ["NOT_FOUND", "TENANT_ISOLATION", "CONFLICT"].includes((error as { code?: string }).code ?? ""));
    assert.deepEqual(await svc.parties(cb), []);
    assert.deepEqual(await svc.items(cb), []);
    await assert.rejects(Promise.resolve().then(() => svc.history(cb, "party", mine.record.id)).then((rows) => { assert.deepEqual(rows, []); throw new MasterDataError("NOT_FOUND", "nothing"); }), (error: unknown) => ["NOT_FOUND", "TENANT_ISOLATION"].includes((error as { code?: string }).code ?? ""));
    assert.equal((await svc.resolveParty(cb, "Only Company A Sells To Them")).status, "not_found");
    assert.equal((await svc.resolveItem(cb, "Company A Secret Widget")).status, "not_found");
    assert.equal((await svc.party(ca, mine.record.id)).legalName, "Only Company A Sells To Them", "and company A is untouched");
  });

  test(`${label}: items — a hardware code is checked, a near-twin waits, units convert exactly, prices follow slabs, tax defaults say where they came from`, { skip }, async () => {
    const h = harness();
    const [svc, shop] = [h.service(), await h.shop()];
    const ctx = shop.context();
    const soap = await svc.createItem(ctx, { code: "SOAP", name: "Herbal Bath Soap 100g", kind: "goods", hsnSac: "34011190", baseUnit: "PCS", trackBatches: false, trackSerials: false } as never, { idempotencyKey: key(), effectiveFrom: "2026-04-01" });
    await assert.rejects(svc.createItem(ctx, { name: "Bad code", kind: "goods", hsnSac: "ABC", baseUnit: "PCS", trackBatches: false, trackSerials: false } as never, { idempotencyKey: key() }), code("VALIDATION_FAILED"));
    const twin = await svc.createItem(ctx, { name: "Herbal Bath Soap 100 g", kind: "goods", hsnSac: "34011190", baseUnit: "PCS", trackBatches: false, trackSerials: false } as never, { idempotencyKey: key() }).catch((error: unknown) => error);
    assert.ok(twin instanceof MasterDataError && twin.code === "DUPLICATE_BLOCKED");

    await svc.registerItemConversion(ctx, soap.record.id, "BOX", "PCS", 24n);
    assert.equal((await svc.unitsFor(shop.companyId).convertExact(quantity("10", "BOX"), "PCS", soap.record.id)).scaled, quantity("240", "PCS").scaled);
    await assert.rejects(Promise.resolve().then(() => svc.unitsFor(shop.companyId).convertExact(quantity("10", "BOX"), "PCS")), (error: unknown) => (error as { code?: string }).code === "NO_CONVERSION_PATH", "a pack size belongs to its item");
    const opening = await svc.setOpeningStock(ctx, { itemId: soap.record.id, warehouseId: crypto.randomUUID(), quantity: quantity("2", "BOX"), valuePaise: 0n, asOn: "2026-04-01" } as never, { idempotencyKey: key() });
    assert.equal(opening.record.quantity.scaled, quantity("48", "PCS").scaled, "stored in the item's base unit");

    const list = await svc.createPriceList(ctx, { name: "Retail", currency: "INR", isDefault: true } as never, { idempotencyKey: key(), effectiveFrom: "2026-04-01" });
    await svc.setPrice(ctx, { priceListId: list.record.id, itemId: soap.record.id, unit: "PCS", ratePaise: 3000n } as never, { idempotencyKey: key(), effectiveFrom: "2026-04-01" });
    await svc.setPrice(ctx, { priceListId: list.record.id, itemId: soap.record.id, unit: "PCS", ratePaise: 2700n, minimumQuantity: quantity("100", "PCS") } as never, { idempotencyKey: key(), effectiveFrom: "2026-04-01" });
    assert.equal((await svc.priceFor(ctx, list.record.id, soap.record.id, "PCS", quantity("10", "PCS")))?.ratePaise, 3000n);
    assert.equal((await svc.priceFor(ctx, list.record.id, soap.record.id, "PCS", quantity("300", "PCS")))?.ratePaise, 2700n);
    assert.equal(await svc.priceFor(ctx, list.record.id, crypto.randomUUID(), "PCS", quantity("1", "PCS")), null);

    await assert.rejects(svc.setTaxDefault(ctx, { hsnSac: "34011190", gstRateBasisPoints: 1800, reverseCharge: false, source: "  " } as never, { idempotencyKey: key() }), code("VALIDATION_FAILED"));
    await svc.setTaxDefault(ctx, { hsnSac: "34011190", gstRateBasisPoints: 1800, reverseCharge: false, source: "Synthetic basis: HSN level" } as never, { idempotencyKey: key(), effectiveFrom: "2026-04-01" });
    await svc.setTaxDefault(ctx, { itemId: soap.record.id, gstRateBasisPoints: 500, reverseCharge: false, source: "Synthetic basis: item level" } as never, { idempotencyKey: key(), effectiveFrom: "2026-04-01" });
    assert.equal((await svc.taxDefaultFor(ctx, soap.record.id))?.gstRateBasisPoints, 500, "an item default beats the code's");
    assert.equal((await svc.taxDefaultCandidates(ctx, { itemId: soap.record.id, hsnSac: "34011190" })).length, 2, "every candidate is shown, none chosen");
    assert.equal(await svc.taxDefaultFor(ctx, (await svc.createItem(ctx, { name: "Mystery", kind: "goods", hsnSac: "82055900", baseUnit: "NOS", trackBatches: false, trackSerials: false } as never, { idempotencyKey: key() })).record.id), null);
  });

  test(`${label}: godowns, vehicles, transporters and bank accounts are kept, and a repeated vehicle or serial is refused`, { skip }, async () => {
    const h = harness();
    const [svc, shop] = [h.service(), await h.shop()];
    const ctx = shop.context();
    await svc.createWarehouse(ctx, { code: "MAIN", name: "Main godown", addressLine: "Sayyaji Rao Road", city: "Mysuru", stateCode: "29", pincode: "570001" } as never, { idempotencyKey: key(), effectiveFrom: "2026-04-01" });
    await assert.rejects(svc.createWarehouse(ctx, { code: "HYD", name: "Hyderabad godown", addressLine: "x", city: "Hyderabad", stateCode: "36", pincode: "560058" } as never, { idempotencyKey: key() }), code("VALIDATION_FAILED"));
    assert.deepEqual((await svc.warehouses(ctx)).map((w) => w.code), ["MAIN"]);

    await svc.createVehicle(ctx, { registrationNumber: "KA01AB1234", vehicleType: "regular", bodyType: "closed" } as never, { idempotencyKey: key() });
    await assert.rejects(svc.createVehicle(ctx, { registrationNumber: "KA 01 AB 1234", vehicleType: "regular", bodyType: "closed" } as never, { idempotencyKey: key() }), code("DUPLICATE_BLOCKED"));
    assert.equal((await svc.vehicles(ctx)).length, 1);

    await svc.createTransporter(ctx, { name: "Synthetic Roadlines", transporterId: syntheticGstin("29", "AAACR1234A") } as never, { idempotencyKey: key() });
    assert.equal((await svc.transporters(ctx)).length, 1);

    await assert.rejects(svc.createBankAccount(ctx, { ownerType: "company", accountName: "Main", accountNumber: "001122334455", ifsc: "HDFC1001234", bankName: "HDFC Bank", accountType: "current" } as never, { idempotencyKey: key() }), code("VALIDATION_FAILED"));
    await svc.createBankAccount(ctx, { ownerType: "company", accountName: "Main", accountNumber: "0011 2233 4455", ifsc: "hdfc0001234", bankName: "HDFC Bank", accountType: "current" } as never, { idempotencyKey: key() });
    assert.deepEqual((await svc.bankAccounts(ctx)).map((a) => [a.ifsc, a.accountNumber]), [["HDFC0001234", "001122334455"]]);

    const tracked = await svc.createItem(ctx, { name: "Serial Gadget", kind: "goods", hsnSac: "85171300", baseUnit: "NOS", trackBatches: false, trackSerials: true } as never, { idempotencyKey: key() });
    await svc.createSerial(ctx, { itemId: tracked.record.id, serial: "SN-1" } as never, { idempotencyKey: key() });
    await assert.rejects(svc.createSerial(ctx, { itemId: tracked.record.id, serial: "SN-1" } as never, { idempotencyKey: key() }), code("DUPLICATE_BLOCKED"));
    await assert.rejects(svc.createBatch(ctx, { itemId: tracked.record.id, batchNumber: "B-1" } as never, { idempotencyKey: key() }), code("CONFLICT"));
  });
}
