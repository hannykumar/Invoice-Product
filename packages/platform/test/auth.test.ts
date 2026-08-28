import assert from "node:assert/strict";
import test from "node:test";
import { AccessControl, AuthenticationService } from "../src/index.ts";

test("invitation grants only the specified company and branch permissions", () => {
  let now = 100; const access = new AccessControl(); access.grant({ companyId: "a", userId: "owner", branchIds: new Set(["a1"]), active: true, permissions: new Set(["access.review"]) });
  const service = new AuthenticationService(access, () => now); const owner = access.context("a", "a1", "owner", "s"); const { token } = service.invite(owner, "Cashier@example.invalid", new Set(["sale.draft.create"])); service.acceptInvitation(token, "cashier");
  const session = service.createSession("a", "a1", "cashier"); assert.ok(service.authenticate(session.id).permissions.has("sale.draft.create")); assert.equal(service.review("a").length, 2);
});
test("expired or revoked sessions cannot authenticate", () => { let now = 100; const access = new AccessControl(); access.grant({ companyId: "a", userId: "u", branchIds: new Set(["b"]), active: true, permissions: new Set() }); const service = new AuthenticationService(access, () => now); const session = service.createSession("a", "b", "u", 10); now = 111; assert.throws(() => service.authenticate(session.id), /SESSION_EXPIRED/); });
test("cashier role is server-side limited and cannot obtain bank or GST permissions", () => {
  const access = new AccessControl(); access.grant({ companyId: "a", userId: "owner", branchIds: new Set(["b"]), active: true, permissions: new Set(["access.review"]) }); const service = new AuthenticationService(access); const { token } = service.invite(access.context("a", "b", "owner", "owner-session"), "cashier@example.invalid", new Set(["sale.draft.create"])); service.acceptInvitation(token, "cashier"); const context = service.authenticate(service.createSession("a", "b", "cashier").id); assert.ok(context.permissions.has("sale.draft.create")); assert.equal(context.permissions.has("bank.balance.read"), false); assert.equal(context.permissions.has("gst.file"), false);
});
test("revoking access invalidates active sessions", () => { const access = new AccessControl(); access.grant({ companyId: "a", userId: "u", branchIds: new Set(["b"]), active: true, permissions: new Set() }); const service = new AuthenticationService(access); const session = service.createSession("a", "b", "u"); service.revokeMember("a", "u"); assert.throws(() => service.authenticate(session.id), /SESSION_EXPIRED/); });
