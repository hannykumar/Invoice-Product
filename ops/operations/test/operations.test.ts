import assert from "node:assert/strict";
import test from "node:test";
import { AuditLog, PlatformError, type Permission, type RequestContext } from "../../../packages/platform/src/index.ts";
import { operationsMigrations } from "../src/migrations.ts";
import { OperationalQueue, OperationsTelemetry, StatusService, SupportAccessService, createOperations } from "../src/operations.ts";
import type { SafeLogEvent } from "../../security/src/index.ts";

const permissions = new Set<Permission>(["operations.read", "operations.manage", "support.access.grant", "queue.replay", "incident.manage", "feature-flags.manage"]);
const context = (companyId: string, actorId = `${companyId}-owner`, allowed: ReadonlySet<Permission> = permissions): RequestContext => ({ companyId, branchId: `${companyId}-branch`, actorId, sessionId: `${companyId}-session`, permissions: allowed });

test("every external failure is correlated, counted, traced and safely logged", () => {
  const logs: SafeLogEvent[] = [];
  const telemetry = new OperationsTelemetry((event) => logs.push(event), () => new Date("2026-08-30T10:00:00.000Z"));
  const actor = context("company-a");
  const span = telemetry.startSpan(actor, "irp.register", "corr-irp-1");
  const failure = telemetry.externalFailure(actor, { correlationId: "corr-irp-1", connector: "irp", operation: "register", errorCode: "IRP_2150", details: { token: "secret", invoiceNumber: "INV-41" } });
  telemetry.finishSpan(actor, span.spanId, "failure");
  assert.equal(failure.correlationId, "corr-irp-1");
  assert.equal(telemetry.metric(actor, "external.irp.failure"), 1);
  assert.equal(telemetry.metric(actor, "irp.register.failure"), 1);
  assert.equal(JSON.stringify(logs).includes("secret"), false);
  assert.equal(JSON.stringify(logs).includes("INV-41"), true);
  assert.throws(() => telemetry.externalFailure(actor, { correlationId: "", connector: "irp", operation: "register", errorCode: "DOWN" }), /CORRELATION/);
});

test("health checks report degraded state under injected failure", async () => {
  const telemetry = new OperationsTelemetry();
  telemetry.registerHealthCheck("database", () => true);
  telemetry.registerHealthCheck("queue", () => false);
  assert.deepEqual(await telemetry.health(), { state: "degraded", checks: { database: "up", queue: "down" } });
});

test("support access is consent-based, time-bound, tenant-scoped and audited", () => {
  let now = new Date("2026-08-30T10:00:00.000Z");
  const audit = new AuditLog();
  const support = new SupportAccessService(audit, () => now);
  const telemetry = new OperationsTelemetry(() => {}, () => now);
  const companyA = context("company-a");
  telemetry.externalFailure(companyA, { correlationId: "corr-1", connector: "irp", operation: "register", errorCode: "IRP_DOWN" });
  telemetry.externalFailure(context("company-b"), { correlationId: "corr-2", connector: "bank", operation: "sync", errorCode: "BANK_DOWN" });
  const grant = support.grant(companyA, { supportActorId: "support-1", reason: "Customer approved IRP failure diagnosis", scopes: ["external-failures"], durationMs: 30 * 60 * 1000 });
  const visible = telemetry.failuresForSupport(support, { grantId: grant.id, supportActorId: "support-1", companyId: "company-a" });
  assert.deepEqual(visible.map((item) => item.errorCode), ["IRP_DOWN"]);
  assert.equal(audit.forCompany(companyA).some((event) => event.action === "support.diagnostic.viewed"), true);
  assert.throws(() => telemetry.failuresForSupport(support, { grantId: grant.id, supportActorId: "support-1", companyId: "company-b" }), (error: unknown) => error instanceof PlatformError && error.code === "TENANT_ISOLATION");
  now = new Date("2026-08-30T10:31:00.000Z");
  assert.throws(() => telemetry.failuresForSupport(support, { grantId: grant.id, supportActorId: "support-1", companyId: "company-a" }), /expired/);
});

test("support permissions and consent scope are enforced server-side", () => {
  const support = new SupportAccessService(new AuditLog());
  assert.throws(() => support.grant(context("company-a", "cashier", new Set()), { supportActorId: "support-1", reason: "help", scopes: ["health"], durationMs: 1000 }), (error: unknown) => error instanceof PlatformError && error.code === "FORBIDDEN");
  const grant = support.grant(context("company-a"), { supportActorId: "support-1", reason: "queue check", scopes: ["queue-state"], durationMs: 1000 });
  assert.throws(() => support.authorize(grant.id, "support-1", "company-a", "external-failures"), /outside the approved/);
});

test("queue recovery replays only failed idempotent jobs and never duplicates enqueue", () => {
  const audit = new AuditLog();
  const queue = new OperationalQueue(audit);
  const actor = context("company-a");
  const job = queue.enqueue(actor, { kind: "irp-register", idempotencyKey: "invoice-41", idempotent: true, maxAttempts: 1, correlationId: "corr-41" });
  assert.equal(queue.enqueue(actor, { kind: "irp-register", idempotencyKey: "invoice-41", idempotent: true, correlationId: "corr-41" }).id, job.id);
  queue.begin(actor, job.id);
  const failed = queue.fail(actor, job.id, "IRP_DOWN");
  assert.equal(failed.state, "failure");
  assert.equal(queue.replay(actor, job.id).state, "draft");
  assert.equal(audit.forCompany(actor).some((event) => event.action === "queue.dead_lettered"), true);
  const unsafe = queue.enqueue(actor, { kind: "bank-transfer", idempotencyKey: "transfer-1", idempotent: false, correlationId: "corr-transfer" });
  queue.begin(actor, unsafe.id); queue.fail(actor, unsafe.id, "TIMEOUT");
  assert.throws(() => queue.replay(actor, unsafe.id), /Only jobs declared safe/);
  assert.equal(queue.list(context("company-b")).some((item) => item.id === job.id), false);
});

test("customer status timeline and staged feature controls are explicit and audited", () => {
  const audit = new AuditLog();
  const service = new StatusService(audit, () => new Date("2026-08-30T10:00:00.000Z"));
  const operator = context("company-a");
  const incident = service.openIncident(operator, "E-invoice registration delayed", "IRP", "Some registrations are failing. Invoices remain unchanged.");
  service.updateIncident(operator, incident.id, "resolved", "IRP calls are succeeding and queued registrations are being retried safely.");
  assert.deepEqual(service.publicStatus()[0]?.timeline.map((entry) => entry.state), ["investigating", "resolved"]);
  service.defineFlag("irp-registration", "Allow new IRP registration jobs");
  service.setFlag(operator, "irp-registration", true, ["company-a"]);
  assert.equal(service.enabled("irp-registration", "company-a"), true);
  assert.equal(service.enabled("irp-registration", "company-b"), false);
  assert.equal(audit.forCompany(operator).some((event) => event.action === "feature_flag.changed"), true);
});

test("operations factory exposes one audit trail across material controls", () => {
  const operations = createOperations();
  const actor = context("company-a");
  operations.support.grant(actor, { supportActorId: "support-1", reason: "diagnose", scopes: ["health"], durationMs: 1000 });
  assert.equal(operations.audit.forCompany(actor).length, 1);
});

test("operations migration persists tenant controls with forced row security", () => {
  const sql = operationsMigrations[0]!.up;
  assert.match(sql, /correlation_id text NOT NULL/);
  assert.match(sql, /idempotent boolean NOT NULL/);
  assert.match(sql, /expires_at timestamptz NOT NULL/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /current_setting\('app\.company_id'/);
});
