import assert from "node:assert/strict";
import test from "node:test";
import { AccessControl, AuditLog, PlatformCommandService, PlatformError } from "../src/index.ts";

const permissions = new Set(["sale.draft.create", "approval.decide"] as const);
const setup = () => {
  const access = new AccessControl();
  access.grant({ companyId: "company-a", userId: "owner-a", branchIds: new Set(["branch-a"]), active: true, permissions });
  access.grant({ companyId: "company-b", userId: "owner-b", branchIds: new Set(["branch-b"]), active: true, permissions });
  const audit = new AuditLog();
  const commands = new PlatformCommandService(audit, [{ action: "sale.finalise", minimumRisk: "medium", requiredPermission: "approval.decide" }]);
  return { access, audit, commands };
};

test("tenant isolation blocks cross-company command reads", () => {
  const { access, commands } = setup();
  const a = access.context("company-a", "branch-a", "owner-a", "session-a");
  const b = access.context("company-b", "branch-b", "owner-b", "session-b");
  const record = commands.create(a, { action: "sale.finalise", risk: "medium", idempotencyKey: "sale-1", payload: { partyId: "party-a" } });
  assert.throws(() => commands.get(b, record.id), (error: unknown) => error instanceof PlatformError && error.code === "TENANT_ISOLATION");
});

test("idempotency returns the same record and rejects divergent retries", () => {
  const { access, commands } = setup(); const context = access.context("company-a", "branch-a", "owner-a", "session-a");
  const first = commands.create(context, { action: "sale.finalise", risk: "medium", idempotencyKey: "sale-1", payload: { totalPaise: 100n } });
  const retry = commands.create(context, { action: "sale.finalise", risk: "medium", idempotencyKey: "sale-1", payload: { totalPaise: 100n } });
  assert.equal(first.id, retry.id);
  assert.throws(() => commands.create(context, { action: "sale.finalise", risk: "medium", idempotencyKey: "sale-1", payload: { totalPaise: 200n } }), /different input/);
});

test("approval policy and audit trail prevent finalisation bypass", () => {
  const { access, audit, commands } = setup(); const context = access.context("company-a", "branch-a", "owner-a", "session-a");
  const record = commands.create(context, { action: "sale.finalise", risk: "medium", idempotencyKey: "sale-2", payload: { overrideReason: "manager approved", token: "do-not-log" } });
  commands.transition(context, record.id, "submitted");
  assert.throws(() => commands.transition(context, record.id, "finalised"), /Cannot move submitted/);
  commands.transition(context, record.id, "approved", "Reviewed inventory override");
  assert.equal(commands.transition(context, record.id, "finalised").status, "finalised");
  const created = audit.forCompany(context)[0]!;
  assert.equal(created.after?.payload && (created.after.payload as Record<string, unknown>).token, "[REDACTED]");
});

test("revoked users cannot create a new authenticated request context", () => {
  const { access } = setup(); access.revoke("company-a", "owner-a");
  assert.throws(() => access.context("company-a", "branch-a", "owner-a", "session-a"), (error: unknown) => error instanceof PlatformError && error.code === "SESSION_REVOKED");
});

