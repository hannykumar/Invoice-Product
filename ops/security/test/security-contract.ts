/**
 * Issue #366 — one contract for the privacy and recovery stores, run against memory
 * (security-contract.test.ts) and PostgreSQL as the application role (security-contract.integration.test.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PlatformError } from "../../../packages/platform/src/index.ts";
import type { Permission, RequestContext } from "../../../packages/platform/src/index.ts";
import {
  AesGcmEncryptionService, BackupRecoveryService, PrivacyService, StaticEncryptionKeyProvider,
  type BackupRepository, type PrivacyDataStore, type PrivacyStore, type SecurityAudit,
} from "../src/index.ts";

export interface SecurityHarness {
  readonly privacy: PrivacyStore;
  readonly backups: BackupRepository;
  readonly audit: SecurityAudit;
  auditActions(companyId: string): Promise<readonly string[]>;
  /** A fresh company and a user who may act for it. */
  company(): Promise<{ readonly companyId: string; readonly actorId: string }>;
}

const ALL = new Set<Permission>(["privacy.manage", "privacy.export", "privacy.delete", "backup.manage", "backup.restore"]);
const ctx = (who: { readonly companyId: string; readonly actorId: string }, permissions = ALL): RequestContext => ({ companyId: who.companyId, branchId: "main", actorId: who.actorId, sessionId: crypto.randomUUID(), permissions });
const code = (expected: string) => (error: unknown) => (error instanceof PlatformError && error.code === expected) || (error instanceof Error && error.message === expected);
const NOW = new Date("2026-10-01T10:00:00.000Z");
const subjects = (): PrivacyDataStore & { deleted: string[] } => {
  const deleted: string[] = [];
  return { deleted, exportSubject: async (_c, s) => ({ subject: s }), deleteSubject: async (_c, s) => { deleted.push(s); return { deletedRecords: 1, retainedRecords: 0 }; } };
};
const encryption = () => new AesGcmEncryptionService(new StaticEncryptionKeyProvider(new Map([["backup-v1", Buffer.alloc(32, 5)]])));
const notice = { version: "2026-10", effectiveAt: "2026-09-01T00:00:00.000Z", purposes: ["invoice delivery", "reminders"] };

export function securityContract(name: string, make: () => SecurityHarness, skip: string | false = false): void {
  test(`${name}: a notice version is kept once, consents page per person, and another company sees none`, { skip }, async () => {
    const h = make();
    const service = new PrivacyService(h.audit, subjects(), () => NOW, h.privacy);
    const [a, b] = [ctx(await h.company()), ctx(await h.company())];
    await service.publishNotice(a, notice);
    assert.deepEqual(await service.publishNotice(a, { ...notice }), notice);
    await assert.rejects(service.publishNotice(a, { ...notice, purposes: ["other"] }), code("PRIVACY_NOTICE_VERSION_CONFLICT"));
    await assert.rejects(service.recordConsent(b, "cust-1", notice.version, "granted", ["reminders"]), code("PRIVACY_NOTICE_NOT_PUBLISHED"));
    for (let i = 0; i < 5; i += 1) await service.recordConsent(a, "cust-1", notice.version, i % 2 ? "withdrawn" : "granted", ["reminders"]);
    await assert.rejects(service.recordConsent(a, "cust-1", notice.version, "granted", ["marketing"]), code("INVALID_CONSENT_PURPOSE"));
    const first = await service.consents(a, "cust-1", { limit: 2 });
    const rest = await service.consents(a, "cust-1", { limit: 10, after: first.at(-1)!.id });
    assert.equal(new Set([...first, ...rest].map((c) => c.id)).size, 5);
    assert.deepEqual(await service.consents(b, "cust-1"), []);
    assert.deepEqual((await h.auditActions(a.companyId)).filter((x) => x === "privacy.notice.published").length, 1);
  });

  test(`${name}: a request retried, or sent twice at once, is one request audited once`, { skip }, async () => {
    const h = make();
    const service = new PrivacyService(h.audit, subjects(), () => NOW, h.privacy);
    const [a, b] = [ctx(await h.company()), ctx(await h.company())];
    const both = await Promise.all([service.request(a, "cust-1", "export", "k1"), service.request(a, "cust-1", "export", "k1")]);
    assert.equal(both[0].id, both[1].id);
    assert.equal((await service.request(a, "cust-1", "export", "k1")).id, both[0].id);
    await assert.rejects(service.request(a, "cust-2", "export", "k1"), code("IDEMPOTENCY_CONFLICT"));
    assert.notEqual((await service.request(a, "cust-1", "deletion", "k1")).id, both[0].id);
    assert.equal((await h.auditActions(a.companyId)).filter((x) => x === "privacy.export.requested").length, 1);
    await assert.rejects(service.get(b, both[0].id), code("NOT_FOUND"));
    await assert.rejects(service.get(a, "not-an-id"), code("NOT_FOUND"));
    await assert.rejects(service.executeExport(b, both[0].id), code("NOT_FOUND"));
  });

  test(`${name}: two executions at once export once; a finished request cannot run again`, { skip }, async () => {
    const h = make();
    const store = subjects();
    const service = new PrivacyService(h.audit, store, () => NOW, h.privacy);
    const a = ctx(await h.company());
    const req = await service.request(a, "cust-1", "deletion", "del-1");
    const settled = await Promise.allSettled([service.executeDeletion(a, req.id), service.executeDeletion(a, req.id)]);
    assert.equal(settled.filter((s) => s.status === "fulfilled").length, 1);
    assert.deepEqual(store.deleted, ["cust-1"]);
    assert.equal((await service.get(a, req.id)).status, "completed");
    await assert.rejects(service.executeDeletion(a, req.id), code("PRIVACY_REQUEST_NOT_EXECUTABLE"));
  });

  test(`${name}: holds and the latest retention date block deletion; a hold is released once`, { skip }, async () => {
    const h = make();
    const store = subjects();
    const service = new PrivacyService(h.audit, store, () => NOW, h.privacy);
    const [a, b] = [ctx(await h.company()), ctx(await h.company())];
    const hold = await service.placeLegalHold(a, "cust-1", "GST assessment");
    await service.setRetention(a, "cust-1", "2026-01-01T00:00:00.000Z");
    await service.setRetention(a, "cust-1", "2027-04-01T00:00:00.000Z");
    const blocked = await service.executeDeletion(a, (await service.request(a, "cust-1", "deletion", "d1")).id);
    assert.equal(blocked.request.status, "blocked");
    assert.deepEqual(blocked.request.blockers, ["Legal hold: GST assessment", "Records must be retained until 2027-04-01T00:00:00.000Z"]);
    assert.equal((await service.get(a, blocked.request.id)).status, "blocked");
    await assert.rejects(service.releaseLegalHold(b, hold.id, "done"), code("NOT_FOUND"));
    const released = await Promise.all([service.releaseLegalHold(a, hold.id, "done"), service.releaseLegalHold(a, hold.id, "done")]);
    assert.deepEqual(released.map((r) => r.active), [false, false]);
    assert.equal((await h.auditActions(a.companyId)).filter((x) => x === "privacy.legal_hold.released").length, 1);
    await service.setRetention(a, "cust-1", "2026-01-01T00:00:00.000Z");
    const done = await service.executeDeletion(a, (await service.request(a, "cust-1", "deletion", "d2")).id);
    assert.equal(done.request.status, "completed");
    assert.deepEqual(store.deleted, ["cust-1"]);
  });

  test(`${name}: wrong input and missing permissions are refused before anything is kept`, { skip }, async () => {
    const h = make();
    const service = new PrivacyService(h.audit, subjects(), () => NOW, h.privacy);
    const a = ctx(await h.company());
    await assert.rejects(service.publishNotice(a, { ...notice, effectiveAt: "never" }), code("INVALID_PRIVACY_NOTICE"));
    await assert.rejects(service.placeLegalHold(a, " ", "reason"), code("PRIVACY_SUBJECT_REQUIRED"));
    await assert.rejects(service.placeLegalHold(a, "cust-1", ""), code("LEGAL_HOLD_REASON_REQUIRED"));
    await assert.rejects(service.request(a, "cust-1", "erase" as "export", "k"), code("INVALID_PRIVACY_REQUEST_KIND"));
    await assert.rejects(service.request(a, "cust-1", "export", " "), code("IDEMPOTENCY_KEY_REQUIRED"));
    await assert.rejects(service.setRetention(a, "cust-1", "soon"), code("INVALID_RETENTION_DATE"));
    await assert.rejects(service.request(ctx(a, new Set()), "cust-1", "export", "k"), code("FORBIDDEN"));
    assert.deepEqual(await h.auditActions(a.companyId), []);
  });

  test(`${name}: a backup is made once per key, restored only by its company, and pruned once`, { skip }, async () => {
    const h = make();
    let now = NOW;
    const recovery = new BackupRecoveryService(h.audit, h.backups, encryption(), "backup-v1", () => now);
    const [a, b] = [ctx(await h.company()), ctx(await h.company())];
    let snapshots = 0;
    const source = { snapshot: async (companyId: string) => { snapshots += 1; return Buffer.from(JSON.stringify({ companyId })); } };
    const made = await Promise.all([recovery.create(a, source, "s1", 1, "nightly"), recovery.create(a, source, "s1", 1, "nightly")]);
    assert.equal(made[0].id, made[1].id);
    assert.equal((await recovery.create(a, source, "s1", 1, "nightly")).id, made[0].id);
    assert.ok(snapshots <= 2);
    await assert.rejects(recovery.create(a, source, "s2", 1, "nightly"), code("IDEMPOTENCY_CONFLICT"));
    assert.equal((await h.auditActions(a.companyId)).filter((x) => x === "backup.created").length, 1);
    let replaced = 0;
    const target = { validate: async () => {}, replace: async () => { replaced += 1; } };
    await assert.rejects(recovery.restore(b, made[0].id, target), code("NOT_FOUND"));
    await assert.rejects(recovery.restore(a, "not-an-id", target), code("NOT_FOUND"));
    assert.deepEqual(await recovery.drills(b), []);
    assert.equal((await recovery.restore(a, made[0].id, target)).status, "passed");
    const stored = (await h.backups.get(a.companyId, made[0].id))!;
    await h.backups.putPayload(stored.manifest, { ...stored.payload, ciphertext: `${stored.payload.ciphertext.slice(0, -2)}AA` });
    await assert.rejects(recovery.restore(a, made[0].id, target));
    assert.equal(replaced, 1);
    const drills = await recovery.drills(a, { limit: 1 });
    assert.deepEqual([...drills, ...(await recovery.drills(a, { after: drills[0]!.id }))].map((d) => d.status).sort(), ["failed", "passed"]);
    now = new Date(NOW.getTime() + 2 * 86_400_000);
    assert.equal(await recovery.pruneExpired(b), 0);
    const pruned = await Promise.all([recovery.pruneExpired(a), recovery.pruneExpired(a)]);
    assert.equal(pruned[0] + pruned[1], 1);
    await assert.rejects(recovery.restore(a, made[0].id, target), code("NOT_FOUND"));
    await assert.rejects(recovery.create(ctx(a, new Set()), source, "s1", 1, "x"), code("FORBIDDEN"));
  });
}
