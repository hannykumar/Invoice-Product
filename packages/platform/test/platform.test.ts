import assert from "node:assert/strict";
import test from "node:test";
import { AccessControl, AuditLog, ExceptionQueue, PlatformCommandService, PlatformError } from "../src/index.ts";

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
  assert.throws(() => { (created.after as Record<string, unknown>).status = "tampered"; }, TypeError);
});

test("revoked users cannot create a new authenticated request context", () => {
  const { access } = setup(); access.revoke("company-a", "owner-a");
  assert.throws(() => access.context("company-a", "branch-a", "owner-a", "session-a"), (error: unknown) => error instanceof PlatformError && error.code === "SESSION_REVOKED");
});

test("exceptions preserve evidence, audit comments and tenant isolation", () => { const { access, audit } = setup(); const a = access.context("company-a", "branch-a", "owner-a", "session-a"); const b = access.context("company-b", "branch-b", "owner-b", "session-b"); const queue = new ExceptionQueue(audit); const item = queue.create(a, "Missing GST rate", ["invoice-page-1"]); assert.equal(queue.comment(a, item.id, "Awaiting supplier clarification").comments.length, 1); assert.throws(() => queue.get(b, item.id), /another company/); assert.equal(queue.resolve(a, item.id).status, "resolved"); assert.deepEqual(audit.forCompany(a).slice(-3).map((event) => event.action), ["exception.created", "exception.commented", "exception.resolved"]); });

test("commands snapshot input before an idempotent retry", () => { const { access, commands } = setup(); const context = access.context("company-a", "branch-a", "owner-a", "session-a"); const payload = { lines: [{ quantity: 1 }] }; const record = commands.create(context, { action: "sale.finalise", risk: "low", idempotencyKey: "snapshot-1", payload }); payload.lines[0]!.quantity = 99; assert.equal((record.payload.lines as { quantity: number }[])[0]!.quantity, 1); });
