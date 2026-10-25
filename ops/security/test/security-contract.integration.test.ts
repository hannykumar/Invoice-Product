/**
 * Issue #366 — the privacy and recovery stores on a real PostgreSQL, connected as the application
 * role so row-level security and the freeze rules of #368 are really in force.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";
import type { TransactionalExecutor } from "../../../packages/platform/src/database.ts";
import type * as Stores from "../src/postgres-store.ts";
import type { PostgresAuditLog as Audit } from "../../../packages/platform/src/postgres-audit.ts";
import { securityContract, type SecurityHarness } from "./security-contract.ts";

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error("DATABASE_URL must be set in CI so the security database tests run.");
const skip = url === undefined && "DATABASE_URL is not set";

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let stores: typeof Stores;
let PostgresAuditLog: typeof Audit;
const login = `invoice_app_test_${randomBytes(6).toString("hex")}`;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import("../../../packages/platform/src/database.ts");
  const { migrate } = await import("../../../packages/platform/src/migrations.ts");
  stores = await import("../src/postgres-store.ts");
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

const company = async (): Promise<string> => {
  const id = crypto.randomUUID();
  await app.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Privacy Traders')", [id]);
  return id;
};

const companyWithUser = async () => {
  const companyId = await company();
  const actorId = crypto.randomUUID();
  await app.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Synthetic owner')", [actorId, `owner-${actorId}@example.invalid`]);
  return { companyId, actorId };
};

const harness = (): SecurityHarness => ({
  privacy: new stores.PostgresPrivacyStore(app),
  backups: new stores.PostgresBackupRepository(app, new stores.MemoryBackupObjectStore()),
  audit: new PostgresAuditLog(app),
  auditActions: (companyId) => app.tenantTransaction(companyId, async (sql) =>
    (await sql.query("SELECT action FROM audit_events WHERE company_id = $1 ORDER BY recorded_at, occurred_at", [companyId])).rows.map((r) => String(r.action))),
  company: companyWithUser,
});

securityContract("postgres as the application role", harness, skip);

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

test("a write outside a unit of work is refused, not committed on its own", { skip }, async () => {
  const privacy = new stores.PostgresPrivacyStore(app);
  const a = await company();
  await assert.rejects(privacy.addNotice(a, { version: "v1", effectiveAt: "2026-01-01T00:00:00.000Z", purposes: ["x"] }), code("NO_UNIT_OF_WORK"));
  await assert.rejects(privacy.setRetention(a, "s", "2027-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"), code("NO_UNIT_OF_WORK"));
  await assert.rejects(privacy.releaseHold(a, crypto.randomUUID(), "2026-01-01T00:00:00.000Z"), code("NO_UNIT_OF_WORK"));
  assert.equal(await privacy.notice(a, "v1"), null);
});

test("the database refuses another company's rows and any change to settled evidence", { skip }, async () => {
  const a = await company();
  const b = await company();
  const inA = (sql: string, values: unknown[]) => app.unitOfWork(a, ({ sql: s }) => s.query(sql, values));
  await assert.rejects(app.unitOfWork(b, ({ sql }) => sql.query(
    "INSERT INTO privacy_legal_holds (id, company_id, subject_id, reason) VALUES ($1, $2, 's', 'r')", [crypto.randomUUID(), a])), /row-level security/);
  const [hold, req, consentNotice] = [crypto.randomUUID(), crypto.randomUUID(), "v1"];
  await inA("INSERT INTO privacy_notices (company_id, version, effective_at, purposes) VALUES ($1, $2, now(), '[\"x\"]')", [a, consentNotice]);
  await inA("INSERT INTO privacy_legal_holds (id, company_id, subject_id, reason) VALUES ($1, $2, 's', 'r')", [hold, a]);
  await inA("INSERT INTO privacy_requests (id, company_id, subject_id, kind, status, requested_at, idempotency_key) VALUES ($1, $2, 's', 'export', 'requested', now(), 'k')", [req, a]);
  await inA("INSERT INTO privacy_retention_rules (id, company_id, subject_id, retain_until, set_at) VALUES (gen_random_uuid(), $1, 's', now(), now())", [a]);
  const FROZEN = "23001";
  await assert.rejects(inA("UPDATE privacy_notices SET purposes = '[\"y\"]' WHERE company_id = $1", [a]), code(FROZEN));
  await assert.rejects(inA("UPDATE privacy_retention_rules SET retain_until = now() + interval '1 year' WHERE company_id = $1", [a]), code(FROZEN));
  await assert.rejects(inA("UPDATE privacy_legal_holds SET reason = 'edited' WHERE id = $1", [hold]), code(FROZEN));
  await inA("UPDATE privacy_legal_holds SET active = false, released_at = now() WHERE id = $1", [hold]);
  await assert.rejects(inA("UPDATE privacy_legal_holds SET active = true WHERE id = $1", [hold]), code(FROZEN));
  await assert.rejects(inA("UPDATE privacy_requests SET subject_id = 'other' WHERE id = $1", [req]), code(FROZEN));
  await inA("UPDATE privacy_requests SET status = 'completed', completed_at = now() WHERE id = $1", [req]);
  await assert.rejects(inA("UPDATE privacy_requests SET status = 'requested', completed_at = NULL WHERE id = $1", [req]), code(FROZEN));
  await assert.rejects(inA("UPDATE privacy_requests SET completed_at = now() - interval '1 day' WHERE id = $1", [req]), code(FROZEN));
  for (const table of ["privacy_notices", "privacy_legal_holds", "privacy_requests", "privacy_retention_rules", "backup_records", "restore_drills", "privacy_consents"]) {
    await assert.rejects(inA(`DELETE FROM ${table} WHERE company_id = $1`, [a]), code("42501"), table);
  }
  await assert.rejects(owner.query("DELETE FROM privacy_requests WHERE id = $1", [req]), code(FROZEN));
  await assert.rejects(owner.query("TRUNCATE restore_drills CASCADE"), code(FROZEN));
});
