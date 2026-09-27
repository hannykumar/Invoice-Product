/**
 * Issue #224 — every address the masters keep has a PIN code from its own state, and a saved
 * address can be corrected without retyping the party.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AccessControl, AuditLog, PlatformCommandService } from "../../platform/src/index.ts";
import type { Permission } from "../../platform/src/types.ts";
import { MASTER_APPROVAL_POLICIES, MasterDataError, MasterDataService } from "../src/index.ts";

const ALL: ReadonlySet<Permission> = new Set(["approval.decide", "access.review"] as const);

function setup() {
  const access = new AccessControl();
  access.grant({ companyId: "company-a", userId: "owner-a", branchIds: new Set(["branch-a"]), active: true, permissions: ALL });
  const audit = new AuditLog();
  const masters = new MasterDataService(new PlatformCommandService(audit, MASTER_APPROVAL_POLICIES), audit);
  return { masters, a: access.context("company-a", "branch-a", "owner-a", "session-a") };
}

let sequence = 0;
const key = () => `pin-${(sequence += 1)}`;

function caught(work: () => unknown): MasterDataError {
  try { work(); } catch (error) { return error as MasterDataError; }
  throw new Error("Expected this to be refused, but it was accepted.");
}

test("an address whose PIN code is in another state is refused", () => {
  const { masters, a } = setup();
  const party = masters.createParty(a, { legalName: "Uppal Castings", role: "customer", gstRegistrationType: "unregistered" }, { idempotencyKey: key() });
  const error = caught(() => masters.addAddress(a, { partyId: party.record.id, label: "Works", line1: "Plot 12, IDA Uppal", city: "Hyderabad", stateCode: "36", pincode: "110039", use: "both", isPrimary: true }, { idempotencyKey: key() }));
  assert.equal(error.problems[0]?.code, "PINCODE_STATE_MISMATCH");
  assert.match(error.message, /110039 is not in Telangana/);
});

test("a godown whose PIN code is in another state is refused", () => {
  const { masters, a } = setup();
  const error = caught(() => masters.createWarehouse(a, { code: "HYD", name: "Hyderabad godown", addressLine: "Cherlapally", city: "Hyderabad", stateCode: "36", pincode: "560058" }, { idempotencyKey: key() }));
  assert.equal(error.problems[0]?.code, "PINCODE_STATE_MISMATCH");
});

test("a saved address is corrected in place, and a wrong PIN is refused on correction too", () => {
  const { masters, a } = setup();
  const party = masters.createParty(a, { legalName: "Uppal Castings", role: "customer", gstRegistrationType: "unregistered" }, { idempotencyKey: key() });
  const saved = masters.addAddress(a, { partyId: party.record.id, label: "Works", line1: "Plot 21, IDA Uppal", city: "Hyderabad", stateCode: "36", pincode: "500040", use: "both", isPrimary: true }, { idempotencyKey: key() });

  const refused = caught(() => masters.correctAddress(a, saved.record.id, { pincode: "110039" }, { idempotencyKey: key() }));
  assert.equal(refused.problems[0]?.code, "PINCODE_STATE_MISMATCH");

  const corrected = masters.correctAddress(a, saved.record.id, { line1: "Plot 12, IDA Uppal", pincode: "500039" }, { idempotencyKey: key() });
  assert.equal(corrected.record.id, saved.record.id, "the same address, not a second one");
  assert.equal(corrected.record.pincode, "500039");
  assert.equal(corrected.record.line1, "Plot 12, IDA Uppal");
  assert.equal(corrected.record.stateCode, "36", "the state is not changed by a correction");
  const now = masters.addressesOfParty("company-a", party.record.id);
  assert.equal(now.length, 1);
  assert.equal(now[0]?.pincode, "500039");
});
