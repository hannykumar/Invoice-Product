/**
 * Issue #366 — the operations store on a real PostgreSQL, connected as the application role so
 * row-level security and the freeze rules of #368 are really in force.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";
import type { TransactionalExecutor } from "../../../packages/platform/src/database.ts";
import type { PostgresOperationsStore as Store } from "../src/postgres-store.ts";
import type { PostgresAuditLog as Audit } from "../../../packages/platform/src/postgres-audit.ts";
import { operationsContract, type OperationsHarness } from "./operations-contract.ts";

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error("DATABASE_URL must be set in CI so the operations database tests run.");
const skip = url === undefined && "DATABASE_URL is not set";

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let PostgresOperationsStore: typeof Store;
let PostgresAuditLog: typeof Audit;
const login = `invoice_app_test_${randomBytes(6).toString("hex")}`;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import("../../../packages/platform/src/database.ts");
  const { migrate } = await import("../../../packages/platform/src/migrations.ts");
  ({ PostgresOperationsStore } = await import("../src/postgres-store.ts"));
  ({ PostgresAuditLog } = await import("../../../packages/platform/src/postgres-audit.ts"));
  owner = createDatabase(url);
  await migrate(owner);
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

const user = async (label: string): Promise<string> => {
  const id = crypto.randomUUID();
  await app.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)", [id, `${label}-${id}@example.invalid`, `Synthetic ${label}`]);
  return id;
};
const company = async () => {
  const companyId = crypto.randomUUID();
  await app.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Ops Traders')", [companyId]);
  return { companyId, userId: await user("owner"), supportId: await user("support") };
};

const harness = (): OperationsHarness => ({
  store: new PostgresOperationsStore(app),
  audit: new PostgresAuditLog(app),
  auditActions: (companyId) => app.tenantTransaction(companyId, async (sql) =>
    (await sql.query("SELECT action FROM audit_events WHERE company_id = $1 ORDER BY recorded_at, occurred_at", [companyId])).rows.map((r) => String(r.action))),
  company,
  atomic: true,
});

operationsContract("postgres as the application role", harness, skip);

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
const failure = (companyId: string) => ({ id: crypto.randomUUID(), companyId, correlationId: "c", connector: "irp", operation: "register", errorCode: "IRP_DOWN", state: "failure" as const, occurredAt: "2026-10-01T10:00:00.000Z" });

test("a write outside the action's transaction is refused, not committed on its own", { skip }, async () => {
  const store = new PostgresOperationsStore(app);
  const a = await company();
  const f = failure(a.companyId);
  const grant = { id: crypto.randomUUID(), companyId: a.companyId, supportActorId: a.supportId, grantedBy: a.userId, reason: "r", scopes: new Set(["health" as const]), createdAt: "2026-10-01T10:00:00.000Z", expiresAt: "2026-10-01T11:00:00.000Z" };
  await assert.rejects(store.addFailure(f), code("NO_UNIT_OF_WORK"));
  await assert.rejects(store.addGrant(grant), code("NO_UNIT_OF_WORK"));
  await assert.rejects(store.revokeGrant(a.companyId, grant.id, "2026-10-01T10:30:00.000Z"), code("NO_UNIT_OF_WORK"));
  await assert.rejects(store.saveIncident(a.companyId, { id: crypto.randomUUID(), title: "t", affectedService: "s", state: "investigating", startedAt: "2026-10-01T10:00:00.000Z", timeline: [] }), code("NO_UNIT_OF_WORK"));
  assert.deepEqual(await store.failures(a.companyId), []);
});

test("the database refuses another company's rows, an unknown support person, and any change to a final record", { skip }, async () => {
  const store = new PostgresOperationsStore(app);
  const a = await company();
  const b = await company();
  const f = failure(a.companyId);
  const grant = { id: crypto.randomUUID(), companyId: a.companyId, supportActorId: a.supportId, grantedBy: a.userId, reason: "r", scopes: new Set(["health" as const]), createdAt: "2026-10-01T10:00:00.000Z", expiresAt: "2026-10-01T11:00:00.000Z" };
  await app.unitOfWork(a.companyId, async () => { await store.addFailure(f); await store.addGrant(grant); });
  await assert.rejects(app.unitOfWork(b.companyId, () => store.addFailure(failure(a.companyId))), code("TENANT_ISOLATION"));
  await assert.rejects(app.unitOfWork(b.companyId, () => app.requireUnitOfWork(b.companyId).sql.query(
    "INSERT INTO operational_failures (id, company_id, correlation_id, connector, operation, error_code) VALUES ($1, $2, 'c', 'irp', 'x', 'y')", [crypto.randomUUID(), a.companyId])), /row-level security/);
  assert.deepEqual(await store.failures(b.companyId), []);
  await assert.rejects(app.unitOfWork(a.companyId, () => store.addGrant({ ...grant, id: crypto.randomUUID(), supportActorId: crypto.randomUUID() })), code("NOT_FOUND"));
  const inA = (sql: string, values: unknown[]) => app.unitOfWork(a.companyId, ({ sql: s }) => s.query(sql, values));
  await assert.rejects(inA("UPDATE operational_failures SET error_code = 'EDITED' WHERE id = $1", [f.id]), code("23001"));
  await assert.rejects(inA("DELETE FROM operational_failures WHERE id = $1", [f.id]), code("42501"));
  await assert.rejects(inA("UPDATE support_access_grants SET expires_at = expires_at + interval '1 day' WHERE id = $1", [grant.id]), code("23001"));
  await assert.rejects(inA("DELETE FROM support_access_grants WHERE id = $1", [grant.id]), code("42501"));
  await inA("UPDATE support_access_grants SET revoked_at = '2026-10-01T10:30:00Z' WHERE id = $1", [grant.id]);
  await assert.rejects(inA("UPDATE support_access_grants SET revoked_at = NULL WHERE id = $1", [grant.id]), code("23001"));
  await assert.rejects(owner.query("DELETE FROM operational_failures WHERE id = $1", [f.id]), code("23001"));
  await assert.rejects(owner.query("TRUNCATE support_access_grants CASCADE"), code("23001"));
});

test("an incident update is final, and two operators cannot both write the same place in the timeline", { skip }, async () => {
  const store = new PostgresOperationsStore(app);
  const a = await company();
  const id = crypto.randomUUID();
  const opened = { id, title: "IRP delay", affectedService: "IRP", state: "investigating" as const, startedAt: "2026-10-01T10:00:00.000Z", timeline: [{ at: "2026-10-01T10:00:00.000Z", state: "investigating" as const, message: "Delayed." }] };
  await app.unitOfWork(a.companyId, () => store.saveIncident(a.companyId, opened));
  await assert.rejects(app.unitOfWork(a.companyId, ({ sql }) => sql.query("UPDATE status_incident_updates SET message = 'edited' WHERE incident_id = $1", [id])), code("23001"));
  await assert.rejects(app.unitOfWork(a.companyId, ({ sql }) => sql.query("DELETE FROM status_incident_updates WHERE incident_id = $1", [id])), code("42501"));
  await assert.rejects(app.unitOfWork(a.companyId, ({ sql }) => sql.query(
    "INSERT INTO status_incident_updates (id, incident_id, position, state, message, occurred_at) VALUES ($1, $2, 0, 'resolved', 'again', now())", [crypto.randomUUID(), id])), code("23505"));
  assert.deepEqual((await store.incident(id))!.timeline.map((u) => u.message), ["Delayed."]);
});
