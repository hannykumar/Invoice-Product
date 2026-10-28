import assert from "node:assert/strict";
import test from "node:test";
import { AccessControl, AuditLog, PlatformCommandService } from "../../platform/src/index.ts";
import type { Permission, RequestContext } from "../../platform/src/types.ts";
import { MASTER_APPROVAL_POLICIES, MasterDataError, MasterDataService, quantity, syntheticGstin, toMicro } from "../src/index.ts";

const ALL: ReadonlySet<Permission> = new Set(["approval.decide", "access.review"] as const);
const NONE: ReadonlySet<Permission> = new Set([] as Permission[]);

function setup(permissions: ReadonlySet<Permission> = ALL) {
  const access = new AccessControl();
  access.grant({ companyId: "company-a", userId: "owner-a", branchIds: new Set(["branch-a"]), active: true, permissions });
  access.grant({ companyId: "company-b", userId: "owner-b", branchIds: new Set(["branch-b"]), active: true, permissions });
  const audit = new AuditLog();
  const commands = new PlatformCommandService(audit, MASTER_APPROVAL_POLICIES);
  const masters = new MasterDataService(commands, audit);
  const a = access.context("company-a", "branch-a", "owner-a", "session-a");
  const b = access.context("company-b", "branch-b", "owner-b", "session-b");
  return { masters, audit, a, b };
}

let sequence = 0;
const key = () => `test-${(sequence += 1)}`;

/** assert.throws does not hand back the error, and these tests check error codes. */
async function caught(work: () => unknown): Promise<MasterDataError> {
  try { await work(); } catch (error) { return error as MasterDataError; }
  throw new Error("Expected this to be refused, but it was accepted.");
}

async function newParty(masters: MasterDataService, context: RequestContext, legalName: string, extra: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  return masters.createParty(context, { legalName, role: "supplier", gstRegistrationType: "regular", ...extra } as never, { idempotencyKey: key(), ...options } as never);
}

test("a transaction can reference a stable master id that survives edits", async () => {
  const { masters, a } = setup();
  const created = await newParty(masters, a, "ABC Traders", { code: "ABC" }, { effectiveFrom: "2026-01-01" });
  await masters.updateParty(a, created.record.id, { legalName: "ABC Traders and Sons" }, { idempotencyKey: key(), effectiveFrom: "2026-04-01" });
  assert.equal((await masters.party(a, created.record.id, "2026-04-05")).id, created.record.id);
  assert.equal((await masters.party(a, created.record.id, "2026-04-05")).legalName, "ABC Traders and Sons");
});

test("master edits do not rewrite the facts an older document captured", async () => {
  const { masters, a } = setup();
  const created = await newParty(masters, a, "Shree Ram Steels", { pan: "AAECS5678D" }, { effectiveFrom: "2026-01-01" });
  const invoiceSnapshot = await masters.snapshot(a, "party", created.record.id, "2026-02-15");
  await masters.updateParty(a, created.record.id, { legalName: "Shree Ram Steels Private Limited" }, { idempotencyKey: key(), effectiveFrom: "2026-06-01", reason: "Converted to a private limited company" });

  assert.equal(invoiceSnapshot.facts.legalName, "Shree Ram Steels");
  assert.equal((await masters.party(a, created.record.id, "2026-06-02")).legalName, "Shree Ram Steels Private Limited");
  // A document raised before the change still reads the old name.
  assert.equal((await masters.party(a, created.record.id, "2026-02-15")).legalName, "Shree Ram Steels");
  assert.equal((await masters.history(a, "party", created.record.id)).length, 2);
});

test("one company cannot read another company's master records", async () => {
  const { masters, a, b } = setup();
  const created = await newParty(masters, a, "ABC Traders");
  await assert.rejects(async () => masters.party(b, created.record.id), (error: unknown) => error instanceof Error && /another company|not found/i.test(error.message));
  assert.equal((await masters.parties(b)).length, 0);
});

test("retrying the same create with the same idempotency key does not create a second record", async () => {
  const { masters, a } = setup();
  const options = { idempotencyKey: "party-create-1" };
  const id = "11111111-1111-4111-8111-111111111111";
  const first = await masters.createParty(a, { id, legalName: "Kaveri Hardware", role: "supplier", gstRegistrationType: "regular" } as never, options);
  const retry = await masters.createParty(a, { id, legalName: "Kaveri Hardware", role: "supplier", gstRegistrationType: "regular" } as never, options);
  assert.equal(first.record.id, retry.record.id);
  assert.equal((await masters.history(a, "party", id)).length, 1);
  assert.equal((await masters.parties(a)).length, 1);
});

test("a second party with the same GSTIN is refused", async () => {
  const { masters, a } = setup();
  const gstin = syntheticGstin("29", "AABCA1234C");
  const first = await newParty(masters, a, "ABC Traders", { pan: "AABCA1234C" });
  await masters.addAddress(a, { partyId: first.record.id, label: "Head office", line1: "14 Avenue Road", city: "Bengaluru", stateCode: "29", pincode: "560001", gstin, use: "both", isPrimary: true }, { idempotencyKey: key() });

  const second = await newParty(masters, a, "A B C Trading Co");
  const error = await caught(async () => await masters.addAddress(a, { partyId: second.record.id, label: "Office", line1: "9 MG Road", city: "Bengaluru", stateCode: "29", pincode: "560001", gstin, use: "both", isPrimary: true }, { idempotencyKey: key() }));
  assert.equal(error.code, "DUPLICATE_BLOCKED");
  assert.equal(error.problems[0]?.code, "GSTIN_ALREADY_USED");
  assert.match(error.message, /ABC Traders/);
});

test("a nearly identical name is refused until the user confirms the businesses differ", async () => {
  const { masters, a } = setup();
  await newParty(masters, a, "ABC Traders");
  const blocked = await caught(async () => await newParty(masters, a, "ABC Trader"));
  assert.equal(blocked.code, "DUPLICATE_BLOCKED");
  assert.ok(blocked.candidates.length > 0);
  const allowed = await newParty(masters, a, "ABC Trader", {}, { acknowledgeSimilar: true });
  assert.equal(allowed.warnings[0]?.code, "SIMILAR_NAME_ACKNOWLEDGED");
});

test("a GSTIN whose state or PAN contradicts the record is explained, not accepted", async () => {
  const { masters, a } = setup();
  const party = await newParty(masters, a, "Konkan Metals", { pan: "AAECS5678D" });
  const wrongState = await caught(async () => await masters.addAddress(a, { partyId: party.record.id, label: "Works", line1: "MIDC", city: "Pune", stateCode: "29", pincode: "560001", gstin: syntheticGstin("27", "AAECS5678D"), use: "both", isPrimary: true }, { idempotencyKey: key() }));
  assert.equal(wrongState.problems[0]?.code, "GSTIN_STATE_MISMATCH");

  const wrongPan = await caught(async () => await masters.addAddress(a, { partyId: party.record.id, label: "Works", line1: "MIDC", city: "Pune", stateCode: "27", pincode: "411001", gstin: syntheticGstin("27", "AABCA1234C"), use: "both", isPrimary: true }, { idempotencyKey: key() }));
  assert.equal(wrongPan.problems[0]?.code, "GSTIN_PAN_MISMATCH");
});

test("spoken names resolve to one party or ask, and never pick the wrong one", async () => {
  const { masters, a } = setup();
  await newParty(masters, a, "ABC Traders", { code: "ABC" });
  await newParty(masters, a, "Ravi Traders", { code: "RVT" }, { acknowledgeSimilar: true });
  assert.equal((await masters.resolveParty(a, "ABC Traders")).status, "resolved");
  assert.notEqual((await masters.resolveParty(a, "Traders")).status, "resolved");
  assert.equal((await masters.resolveParty(a, "Zenith Polymers")).status, "not_found");
});

test("opening stock is stored in the item's base unit and refuses to round", async () => {
  const { masters, a } = setup();
  const item = await masters.createItem(a, { name: "Sona Masoori Rice", kind: "goods", hsnSac: "10063020", baseUnit: "KGS", trackBatches: false, trackSerials: false }, { idempotencyKey: key() });
  const warehouse = await masters.createWarehouse(a, { code: "BLR", name: "Bengaluru Main", addressLine: "14 Avenue Road", city: "Bengaluru", stateCode: "29", pincode: "560001" }, { idempotencyKey: key() });
  const opening = await masters.setOpeningStock(a, { itemId: item.record.id, warehouseId: warehouse.record.id, asOn: "2026-04-01", quantity: quantity("2", "QTL"), valuePaise: 1_200_000n }, { idempotencyKey: key() });
  assert.equal(opening.record.quantity.unit, "KGS");
  assert.equal(opening.record.quantity.scaled, toMicro("200"));
});

test("prices follow slabs and convert to the unit the customer is buying in", async () => {
  const { masters, a } = setup();
  const item = await masters.createItem(a, { name: "Herbal Bath Soap 100g", kind: "goods", hsnSac: "34011190", baseUnit: "PCS", trackBatches: true, trackSerials: false }, { idempotencyKey: key() });
  await masters.registerItemConversion(a, item.record.id, "BOX", "PCS", 24n);
  const list = await masters.createPriceList(a, { name: "Retail 2026", ratesIncludeTax: false }, { idempotencyKey: key() });
  await masters.setPrice(a, { priceListId: list.record.id, itemId: item.record.id, unit: "PCS", ratePaise: 3000n }, { idempotencyKey: key() });
  await masters.setPrice(a, { priceListId: list.record.id, itemId: item.record.id, unit: "PCS", ratePaise: 2700n, minimumQuantity: quantity("240", "PCS") }, { idempotencyKey: key() });

  assert.equal((await masters.priceFor(a, list.record.id, item.record.id, "PCS", quantity("10", "PCS")))?.ratePaise, 3000n);
  assert.equal((await masters.priceFor(a, list.record.id, item.record.id, "PCS", quantity("300", "PCS")))?.ratePaise, 2700n);
  // Ten boxes is 240 pieces, so the slab applies and the box rate is 24 x 2700.
  assert.equal((await masters.priceFor(a, list.record.id, item.record.id, "BOX", quantity("10", "BOX")))?.ratePaise, 64800n);
  assert.equal(await masters.priceFor(a, list.record.id, "unknown-item", "PCS", quantity("1", "PCS")), null);
});

test("an item tax default beats an HSN default and an unknown item returns nothing", async () => {
  const { masters, a } = setup();
  const item = await masters.createItem(a, { name: "TMT Steel Bar 12mm", kind: "goods", hsnSac: "72142090", baseUnit: "KGS", trackBatches: false, trackSerials: false }, { idempotencyKey: key() });
  await masters.setTaxDefault(a, { hsnSac: "72142090", gstRateBasisPoints: 1800, reverseCharge: false, source: "Notification 1/2017-CTR Schedule III" }, { idempotencyKey: key() });
  assert.equal((await masters.taxDefaultFor(a, item.record.id))?.gstRateBasisPoints, 1800);

  await masters.setTaxDefault(a, { itemId: item.record.id, gstRateBasisPoints: 500, reverseCharge: false, source: "Concessional rate approved by the owner" }, { idempotencyKey: key() });
  assert.equal((await masters.taxDefaultFor(a, item.record.id))?.gstRateBasisPoints, 500);

  const other = await masters.createItem(a, { name: "Outward Freight", kind: "service", hsnSac: "996511", baseUnit: "NOS", trackBatches: false, trackSerials: false }, { idempotencyKey: key() });
  assert.equal(await masters.taxDefaultFor(a, other.record.id), null);
});

test("a tax default without a stated source is refused", async () => {
  const { masters, a } = setup();
  await assert.rejects(async () => masters.setTaxDefault(a, { hsnSac: "72142090", gstRateBasisPoints: 1800, reverseCharge: false, source: "  " }, { idempotencyKey: key() }), /where this rate comes from/);
});

test("merging two parties needs an approver and keeps the old id working", async () => {
  const withoutApproval = setup(NONE);
  const loserA = await newParty(withoutApproval.masters, withoutApproval.a, "ABC Traders");
  const winnerA = await newParty(withoutApproval.masters, withoutApproval.a, "Kaveri Hardware");
  await assert.rejects(async () => withoutApproval.masters.mergeParties(withoutApproval.a, winnerA.record.id, loserA.record.id, { idempotencyKey: key() }), /permission to approve/);

  const { masters, a } = setup();
  const loser = await newParty(masters, a, "ABC Traders");
  const winner = await newParty(masters, a, "Kaveri Hardware");
  const merged = await masters.mergeParties(a, winner.record.id, loser.record.id, { idempotencyKey: key(), reason: "Same shop, entered twice" });
  assert.equal(merged.command.status, "finalised");
  assert.equal((await masters.party(a, loser.record.id)).id, winner.record.id);
  assert.ok((await masters.party(a, winner.record.id)).aliases.includes("ABC Traders"));
  assert.equal((await masters.parties(a)).length, 1);
});

test("the same vehicle number cannot be saved twice and a bad plate is refused", async () => {
  const { masters, a } = setup();
  await masters.createVehicle(a, { registrationNumber: "ka 01 ab 1234", vehicleType: "regular", bodyType: "open", ratedCapacityKg: 9000 }, { idempotencyKey: key() });
  assert.equal((await masters.vehicles(a))[0]?.registrationNumber, "KA01AB1234");
  await assert.rejects(async () => masters.createVehicle(a, { registrationNumber: "KA01AB1234", vehicleType: "regular", bodyType: "closed" }, { idempotencyKey: key() }), /already saved/);
  await assert.rejects(async () => masters.createVehicle(a, { registrationNumber: "LORRY 1", vehicleType: "regular", bodyType: "open" }, { idempotencyKey: key() }), /Indian vehicle number/);
});

test("bank accounts validate the IFSC and say who they belong to", async () => {
  const { masters, a } = setup();
  const party = await newParty(masters, a, "Shree Ram Steels");
  const account = await masters.createBankAccount(a, { ownerType: "party", partyId: party.record.id, accountName: "Shree Ram Steels", accountNumber: "0011 2233 4455 66", ifsc: "hdfc0001234", bankName: "HDFC Bank", accountType: "current" }, { idempotencyKey: key() });
  assert.equal(account.record.ifsc, "HDFC0001234");
  assert.equal(account.record.accountNumber, "001122334455 66".replace(/\s/g, ""));
  await assert.rejects(async () => masters.createBankAccount(a, { ownerType: "company", accountName: "Main", accountNumber: "001122334455", ifsc: "HDFC1001234", bankName: "HDFC Bank", accountType: "current" }, { idempotencyKey: key() }), /IFSC/);
  await assert.rejects(async () => masters.createBankAccount(a, { ownerType: "party", accountName: "Main", accountNumber: "001122334455", ifsc: "HDFC0001234", bankName: "HDFC Bank", accountType: "current" }, { idempotencyKey: key() }), /which supplier or customer/);
});

test("batches and serials only exist for items that track them", async () => {
  const { masters, a } = setup();
  const plain = await masters.createItem(a, { name: "Sona Masoori Rice", kind: "goods", hsnSac: "10063020", baseUnit: "KGS", trackBatches: false, trackSerials: false }, { idempotencyKey: key() });
  await assert.rejects(async () => masters.createBatch(a, { itemId: plain.record.id, batchNumber: "B-1" }, { idempotencyKey: key() }), /not set up to track batches/);

  const tracked = await masters.createItem(a, { name: "Herbal Bath Soap 100g", kind: "goods", hsnSac: "34011190", baseUnit: "PCS", trackBatches: true, trackSerials: true }, { idempotencyKey: key() });
  await masters.createBatch(a, { itemId: tracked.record.id, batchNumber: "B-1", manufacturedOn: "2026-01-01", expiresOn: "2027-01-01" }, { idempotencyKey: key() });
  await assert.rejects(async () => masters.createBatch(a, { itemId: tracked.record.id, batchNumber: "B-2", manufacturedOn: "2026-01-01", expiresOn: "2025-01-01" }, { idempotencyKey: key() }), /expiry date is before/);
  await masters.createSerial(a, { itemId: tracked.record.id, serial: "SN-1" }, { idempotencyKey: key() });
  await assert.rejects(async () => masters.createSerial(a, { itemId: tracked.record.id, serial: "SN-1" }, { idempotencyKey: key() }), /already recorded/);
});

test("every master change leaves an audit trail for the company that made it", async () => {
  const { masters, audit, a, b } = setup();
  const party = await newParty(masters, a, "ABC Traders");
  await masters.updateParty(a, party.record.id, { creditDays: 45 }, { idempotencyKey: key(), reason: "Agreed longer credit" });
  const events = audit.forCompany(a).map((event) => event.action);
  assert.ok(events.includes("masters.party.create.created"));
  assert.ok(events.includes("masters.party.update.finalised"));
  assert.equal(audit.forCompany(b).length, 0);
});
