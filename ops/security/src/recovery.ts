import { createHash, randomUUID } from "node:crypto";
import { PlatformError } from "../../../packages/platform/src/index.ts";
import type { Id, RequestContext } from "../../../packages/platform/src/index.ts";
import { AesGcmEncryptionService, type EncryptedPayload } from "./encryption.ts";
import type { BackupRepository, Page, SecurityAudit } from "./store.ts";

export { MemoryBackupRepository, type BackupRepository } from "./store.ts";

export interface BackupManifest { readonly id: Id; readonly companyId: Id; readonly schemaVersion: string; readonly createdAt: string; readonly expiresAt: string; readonly checksumSha256: string; readonly byteLength: number; readonly keyId: string; }
export interface StoredBackup { readonly manifest: BackupManifest; readonly payload: EncryptedPayload; }
export interface RestoreDrill { readonly id: Id; readonly companyId: Id; readonly backupId: Id; readonly status: "passed" | "failed"; readonly startedAt: string; readonly completedAt: string; readonly details: string; }

export interface BackupSource { snapshot(companyId: Id): Promise<Buffer>; }
export interface RestoreTarget { validate(snapshot: Buffer, manifest: BackupManifest): Promise<void>; replace(snapshot: Buffer, manifest: BackupManifest): Promise<void>; }
/**
 * Each command writes and audits inside one `repository.action(...)` (#366): on PostgreSQL that is
 * one unit of work. Snapshots, encryption and object storage are external, so they happen before
 * the action opens (create) or after it commits (prune), never inside it.
 */
export class BackupRecoveryService {
  readonly #audit: SecurityAudit;
  readonly #repository: BackupRepository;
  readonly #encryption: AesGcmEncryptionService;
  readonly #keyId: string;
  readonly #now: () => Date;

  constructor(audit: SecurityAudit, repository: BackupRepository, encryption: AesGcmEncryptionService, keyId: string, now: () => Date = () => new Date()) {
    this.#audit = audit;
    this.#repository = repository;
    this.#encryption = encryption;
    this.#keyId = keyId;
    this.#now = now;
  }

  async create(context: RequestContext, source: BackupSource, schemaVersion: string, retentionDays: number, idempotencyKey: string): Promise<BackupManifest> {
    requireBackupPermission(context, "backup.manage");
    if (typeof schemaVersion !== "string" || !schemaVersion.trim() || !Number.isInteger(retentionDays) || retentionDays < 1) throw new Error("INVALID_BACKUP_POLICY");
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
    const input = JSON.stringify({ schemaVersion, retentionDays });
    const prior = await this.#prior(context.companyId, idempotencyKey, input);
    if (prior) return prior;
    const snapshot = await source.snapshot(context.companyId);
    const id = randomUUID();
    const createdAt = this.#now();
    const manifest = Object.freeze({
      id,
      companyId: context.companyId,
      schemaVersion,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + retentionDays * 86_400_000).toISOString(),
      checksumSha256: checksum(snapshot),
      byteLength: snapshot.byteLength,
      keyId: this.#keyId,
    });
    const payload = await this.#encryption.encrypt(snapshot, this.#keyId, associatedData(manifest));
    const objectKey = await this.#repository.putPayload(manifest, payload);
    let saved: boolean;
    try {
      saved = await this.#repository.action(context.companyId, async () => {
        if (!(await this.#repository.save(manifest, objectKey, { key: idempotencyKey, input }))) return false;
        await this.#audit.append({ companyId: context.companyId, actorId: context.actorId, action: "backup.created", correlationId: id, before: null, after: { schemaVersion, byteLength: snapshot.byteLength, checksumSha256: manifest.checksumSha256, expiresAt: manifest.expiresAt, keyId: manifest.keyId } });
        return true;
      });
    } catch (error) {
      // Nothing was recorded, so the bytes already written must not be left behind.
      await this.#repository.deletePayload(objectKey);
      throw error;
    }
    if (saved) return manifest;
    // Another run with the same key won the race: its backup is the answer, and these bytes are not kept.
    await this.#repository.deletePayload(objectKey);
    const winner = await this.#prior(context.companyId, idempotencyKey, input);
    if (!winner) throw new Error("IDEMPOTENT_BACKUP_MISSING");
    return winner;
  }

  async restore(context: RequestContext, backupId: Id, target: RestoreTarget): Promise<RestoreDrill> {
    requireBackupPermission(context, "backup.restore");
    const startedAt = this.#now().toISOString();
    // Another company's backup is not found: row-level security never reads it, and no drill is recorded against it.
    const backup = await this.#repository.get(context.companyId, backupId);
    if (!backup) throw new PlatformError("NOT_FOUND", "This backup was not found for this company.");
    try {
      const snapshot = await this.#encryption.decrypt(backup.payload, associatedData(backup.manifest));
      if (snapshot.byteLength !== backup.manifest.byteLength || checksum(snapshot) !== backup.manifest.checksumSha256) throw new Error("BACKUP_INTEGRITY_FAILED");
      await target.validate(snapshot, backup.manifest);
      await target.replace(snapshot, backup.manifest);
      return await this.#recordDrill(context, backupId, "passed", startedAt, "Integrity, schema validation and replacement completed.");
    } catch (error) {
      if (error instanceof DrillNotRecorded) throw error.cause;
      await this.#recordDrill(context, backupId, "failed", startedAt, safeRestoreFailure(error));
      throw error;
    }
  }

  async pruneExpired(context: RequestContext): Promise<number> {
    requireBackupPermission(context, "backup.manage");
    const at = this.#now().toISOString();
    const expired = await this.#repository.expired(context.companyId, at);
    const pruned = await this.#repository.action(context.companyId, async () => {
      const done: string[] = [];
      for (const record of expired) if (await this.#repository.prune(context.companyId, record.manifest.id, at)) done.push(record.objectKey);
      if (done.length > 0) await this.#audit.append({ companyId: context.companyId, actorId: context.actorId, action: "backup.retention.pruned", correlationId: randomUUID(), before: null, after: { deletedBackups: done.length } });
      return done;
    });
    for (const objectKey of pruned) await this.#repository.deletePayload(objectKey);
    return pruned.length;
  }

  async drills(context: RequestContext, page?: Page): Promise<readonly RestoreDrill[]> {
    requireBackupPermission(context, "backup.restore");
    return this.#repository.drills(context.companyId, page);
  }

  async #prior(companyId: Id, idempotencyKey: string, input: string): Promise<BackupManifest | undefined> {
    const prior = await this.#repository.byKey(companyId, idempotencyKey);
    if (!prior) return undefined;
    if (prior.input !== input) throw new PlatformError("IDEMPOTENCY_CONFLICT", "This backup idempotency key was already used with another policy.");
    const existing = await this.#repository.get(companyId, prior.backupId);
    if (!existing) throw new Error("IDEMPOTENT_BACKUP_MISSING");
    return existing.manifest;
  }

  async #recordDrill(context: RequestContext, backupId: Id, status: RestoreDrill["status"], startedAt: string, details: string): Promise<RestoreDrill> {
    const drill = Object.freeze({ id: randomUUID(), companyId: context.companyId, backupId, status, startedAt, completedAt: this.#now().toISOString(), details });
    try {
      await this.#repository.action(context.companyId, async () => {
        await this.#repository.addDrill(drill);
        await this.#audit.append({ companyId: context.companyId, actorId: context.actorId, action: `backup.restore.${status}`, correlationId: drill.id, before: null, after: { backupId, status, details } });
      });
    } catch (error) {
      throw new DrillNotRecorded(error);
    }
    return drill;
  }
}

/** Recording the drill itself failed: that error is reported as it is, not recorded as a failed drill. */
class DrillNotRecorded extends Error {
  constructor(cause: unknown) { super("RESTORE_DRILL_NOT_RECORDED", { cause }); }
}

function checksum(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function associatedData(manifest: Pick<BackupManifest, "id" | "companyId" | "schemaVersion">): string { return `${manifest.companyId}:${manifest.id}:${manifest.schemaVersion}`; }
function requireBackupPermission(context: RequestContext, permission: "backup.manage" | "backup.restore"): void { if (!context.permissions.has(permission)) throw new PlatformError("FORBIDDEN", `Permission ${permission} is required.`); }
function safeRestoreFailure(error: unknown): string {
  if (error instanceof PlatformError) return error.code;
  if (error instanceof Error && ["ENCRYPTION_KEY_UNAVAILABLE", "ENCRYPTION_KEY_MUST_BE_32_BYTES", "BACKUP_INTEGRITY_FAILED"].includes(error.message)) return error.message;
  return "RESTORE_VALIDATION_FAILED";
}
