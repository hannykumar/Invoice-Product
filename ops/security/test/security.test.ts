import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { AccessControl, AuditLog, PlatformError } from "../../../packages/platform/src/index.ts";
import type { Permission, RequestContext } from "../../../packages/platform/src/index.ts";
import {
  AesGcmEncryptionService,
  BackupRecoveryService,
  MemoryBackupRepository,
  PrivacyService,
  SecureLogger,
  StaticEncryptionKeyProvider,
  type PrivacyDataStore,
  type RestoreTarget,
  type SafeLogEvent,
  securityMigrations,
} from "../src/index.ts";

const allSecurityPermissions = new Set<Permission>(["privacy.manage", "privacy.export", "privacy.delete", "backup.manage", "backup.restore"]);

function context(companyId: string, actorId = `${companyId}-owner`, permissions = allSecurityPermissions): RequestContext {
  return { companyId, branchId: `${companyId}-branch`, actorId, sessionId: `${companyId}-session`, permissions };
}

test("AES-GCM encrypts sensitive bytes and authenticates tenant-bound metadata", async () => {
  const service = new AesGcmEncryptionService(new StaticEncryptionKeyProvider(new Map([["backup-v1", randomBytes(32)]])));
  const plaintext = Buffer.from("invoice and bank statement data");
  const encrypted = await service.encrypt(plaintext, "backup-v1", "company-a:backup-1:v1");
  assert.equal(encrypted.ciphertext.includes(plaintext.toString("base64")), false);
  assert.deepEqual(await service.decrypt(encrypted, "company-a:backup-1:v1"), plaintext);
  await assert.rejects(service.decrypt(encrypted, "company-b:backup-1:v1"));
});

test("secure logging redacts secrets, documents, bearer tokens and connection passwords", () => {
  const events: SafeLogEvent[] = [];
  const logger = new SecureLogger((event) => events.push(event));
  logger.write("error", "connector failed", {
    token: "top-secret",
    request: { authorization: "Bearer abc.def.ghi", documentContent: "invoice bytes" },
    databaseUrl: "postgresql://invoice:plain-password@db.internal/invoice",
    safeReference: "INV-2026-001",
  });
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes("top-secret"), false);
  assert.equal(serialized.includes("abc.def.ghi"), false);
  assert.equal(serialized.includes("invoice bytes"), false);
  assert.equal(serialized.includes("plain-password"), false);
  assert.equal(serialized.includes("INV-2026-001"), true);
});

class SubjectStore implements PrivacyDataStore {
  readonly records = new Map<string, Record<string, unknown>>();
  async exportSubject(companyId: string, subjectId: string) { return structuredClone(this.records.get(`${companyId}:${subjectId}`) ?? {}); }
  async deleteSubject(companyId: string, subjectId: string) { const key = `${companyId}:${subjectId}`; const deletedRecords = this.records.delete(key) ? 1 : 0; return { deletedRecords, retainedRecords: 0 }; }
}

test("privacy exports are tenant isolated and deletion respects retention and legal holds", async () => {
  const audit = new AuditLog();
  const store = new SubjectStore();
  store.records.set("company-a:customer-1", { invoices: ["INV-1"], phone: "synthetic" });
  store.records.set("company-b:customer-1", { invoices: ["OTHER"] });
  const now = new Date("2026-08-29T10:00:00.000Z");
  const privacy = new PrivacyService(audit, store, () => now);
  const a = context("company-a");
  const b = context("company-b");

  privacy.publishNotice(a, { version: "2026-08", effectiveAt: "2026-08-01", purposes: ["invoice delivery", "payment reminders"] });
  assert.throws(() => privacy.publishNotice(a, { version: "2026-08", effectiveAt: "2026-08-01", purposes: ["unrelated purpose"] }), /VERSION_CONFLICT/);
  privacy.recordConsent(a, "customer-1", "2026-08", "granted", ["invoice delivery"]);
  const exportRequest = privacy.request(a, "customer-1", "export", "export-customer-1");
  assert.equal(privacy.request(a, "customer-1", "export", "export-customer-1").id, exportRequest.id);
  assert.throws(() => privacy.request(a, "customer-2", "export", "export-customer-1"), /another person/);
  assert.throws(() => privacy.get(b, exportRequest.id), (error: unknown) => error instanceof PlatformError && error.code === "TENANT_ISOLATION");
  const exported = await privacy.executeExport(a, exportRequest.id);
  assert.deepEqual(exported.data, { invoices: ["INV-1"], phone: "synthetic" });

  privacy.placeLegalHold(a, "customer-1", "Active GST assessment");
  privacy.setRetention(a, "customer-1", "2027-04-01T00:00:00.000Z");
  const deletion = privacy.request(a, "customer-1", "deletion", "delete-customer-1");
  const blocked = await privacy.executeDeletion(a, deletion.id);
  assert.equal(blocked.request.status, "blocked");
  assert.deepEqual(blocked.request.blockers, ["Legal hold: Active GST assessment", "Records must be retained until 2027-04-01T00:00:00.000Z"]);
  assert.equal(store.records.has("company-a:customer-1"), true);
  assert.equal(audit.forCompany(a).some((event) => event.action === "privacy.deletion.blocked"), true);
});

test("privacy deletion completes after approved retention and holds no longer apply", async () => {
  const audit = new AuditLog();
  const store = new SubjectStore();
  store.records.set("company-a:customer-2", { contact: "synthetic" });
  const privacy = new PrivacyService(audit, store, () => new Date("2026-08-29T10:00:00.000Z"));
  const actor = context("company-a");
  const hold = privacy.placeLegalHold(actor, "customer-2", "Reconciliation review");
  privacy.releaseLegalHold(actor, hold.id, "Review completed");
  privacy.setRetention(actor, "customer-2", "2026-08-01T00:00:00.000Z");
  const request = privacy.request(actor, "customer-2", "deletion", "delete-customer-2");
  const completed = await privacy.executeDeletion(actor, request.id);
  assert.equal(completed.request.status, "completed");
  assert.deepEqual(completed.result, { deletedRecords: 1, retainedRecords: 0 });
  assert.equal(store.records.has("company-a:customer-2"), false);
});

test("privacy operations require explicit server-side permissions", () => {
  const privacy = new PrivacyService(new AuditLog(), new SubjectStore());
  const unprivileged = context("company-a", "cashier", new Set());
  assert.throws(() => privacy.request(unprivileged, "customer-1", "export", "export-1"), (error: unknown) => error instanceof PlatformError && error.code === "FORBIDDEN");
});

test("encrypted backup restore validates integrity and schema before replacing data", async () => {
  const audit = new AuditLog();
  const repository = new MemoryBackupRepository();
  const encryption = new AesGcmEncryptionService(new StaticEncryptionKeyProvider(new Map([["backup-v1", Buffer.alloc(32, 7)]])));
  let now = new Date("2026-08-29T10:00:00.000Z");
  const recovery = new BackupRecoveryService(audit, repository, encryption, "backup-v1", () => now);
  const actor = context("company-a");
  let snapshotCalls = 0;
  const source = { snapshot: async (companyId: string) => { snapshotCalls += 1; return Buffer.from(JSON.stringify({ companyId, invoices: 4 })); } };
  const manifest = await recovery.create(actor, source, "schema-8", 30, "scheduled-2026-08-29");
  assert.equal((await recovery.create(actor, source, "schema-8", 30, "scheduled-2026-08-29")).id, manifest.id);
  assert.equal(snapshotCalls, 1);
  await assert.rejects(recovery.create(actor, source, "schema-9", 30, "scheduled-2026-08-29"), /another policy/);
  let restored: string | undefined;
  const target: RestoreTarget = {
    async validate(snapshot, received) { assert.equal(received.schemaVersion, "schema-8"); assert.equal(JSON.parse(snapshot.toString()).companyId, "company-a"); },
    async replace(snapshot) { restored = snapshot.toString(); },
  };
  const drill = await recovery.restore(actor, manifest.id, target);
  assert.equal(drill.status, "passed");
  assert.equal(JSON.parse(restored!).invoices, 4);
  assert.equal(recovery.drills(actor).length, 1);

  const stored = await repository.get(manifest.id);
  assert.ok(stored);
  await repository.save({ ...stored, payload: { ...stored.payload, ciphertext: `${stored.payload.ciphertext.slice(0, -2)}AA` } });
  restored = undefined;
  await assert.rejects(recovery.restore(actor, manifest.id, target));
  assert.equal(restored, undefined);
  assert.equal(recovery.drills(actor).at(-1)?.status, "failed");
  assert.equal(recovery.drills(actor).at(-1)?.details, "RESTORE_VALIDATION_FAILED");
});

test("backup listing, restore and pruning cannot cross company boundaries", async () => {
  const audit = new AuditLog();
  const repository = new MemoryBackupRepository();
  const encryption = new AesGcmEncryptionService(new StaticEncryptionKeyProvider(new Map([["backup-v1", Buffer.alloc(32, 9)]])));
  let now = new Date("2026-08-01T00:00:00.000Z");
  const recovery = new BackupRecoveryService(audit, repository, encryption, "backup-v1", () => now);
  const backup = await recovery.create(context("company-a"), { snapshot: async () => Buffer.from("a") }, "schema-8", 1, "daily-1");
  await assert.rejects(recovery.restore(context("company-b"), backup.id, { validate: async () => {}, replace: async () => {} }), (error: unknown) => error instanceof PlatformError && error.code === "TENANT_ISOLATION");
  now = new Date("2026-08-03T00:00:00.000Z");
  assert.equal(await recovery.pruneExpired(context("company-b")), 0);
  assert.equal(await recovery.pruneExpired(context("company-a")), 1);
});

test("security permissions are only obtained through authenticated company membership", () => {
  const access = new AccessControl();
  access.grant({ companyId: "company-a", userId: "dpo", branchIds: new Set(["branch-a"]), active: true, permissions: allSecurityPermissions });
  const authenticated = access.context("company-a", "branch-a", "dpo", "session-a");
  assert.equal(authenticated.permissions.has("backup.restore"), true);
  assert.throws(() => access.context("company-b", "branch-a", "dpo", "session-a"), /no longer active/);
});

test("security persistence migration forces tenant RLS and relational tenant integrity", () => {
  const sql = securityMigrations[0]!.up;
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /current_setting\('app\.company_id'/);
  assert.match(sql, /FOREIGN KEY\(company_id, backup_id\)/);
  assert.match(sql, /FOREIGN KEY\(company_id, notice_version\)/);
});
