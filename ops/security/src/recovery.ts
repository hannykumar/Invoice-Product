import { createHash, randomUUID } from "node:crypto";
import { AuditLog, PlatformError } from "../../../packages/platform/src/index.ts";
import type { Id, RequestContext } from "../../../packages/platform/src/index.ts";
import { AesGcmEncryptionService, type EncryptedPayload } from "./encryption.ts";

export interface BackupManifest { readonly id: Id; readonly companyId: Id; readonly schemaVersion: string; readonly createdAt: string; readonly expiresAt: string; readonly checksumSha256: string; readonly byteLength: number; readonly keyId: string; }
export interface StoredBackup { readonly manifest: BackupManifest; readonly payload: EncryptedPayload; }
export interface RestoreDrill { readonly id: Id; readonly companyId: Id; readonly backupId: Id; readonly status: "passed" | "failed"; readonly startedAt: string; readonly completedAt: string; readonly details: string; }

export interface BackupSource { snapshot(companyId: Id): Promise<Buffer>; }
export interface RestoreTarget { validate(snapshot: Buffer, manifest: BackupManifest): Promise<void>; replace(snapshot: Buffer, manifest: BackupManifest): Promise<void>; }
export interface BackupRepository {
  save(backup: StoredBackup): Promise<void>;
  get(id: Id): Promise<StoredBackup | undefined>;
  list(companyId: Id): Promise<readonly StoredBackup[]>;
  delete(id: Id): Promise<void>;
}

export class MemoryBackupRepository implements BackupRepository {
  readonly #items = new Map<Id, StoredBackup>();
  async save(backup: StoredBackup): Promise<void> { this.#items.set(backup.manifest.id, structuredClone(backup)); }
  async get(id: Id): Promise<StoredBackup | undefined> { const value = this.#items.get(id); return value && structuredClone(value); }
  async list(companyId: Id): Promise<readonly StoredBackup[]> { return [...this.#items.values()].filter((item) => item.manifest.companyId === companyId).map((item) => structuredClone(item)); }
  async delete(id: Id): Promise<void> { this.#items.delete(id); }
}

export class BackupRecoveryService {
  readonly #audit: AuditLog;
  readonly #repository: BackupRepository;
  readonly #encryption: AesGcmEncryptionService;
  readonly #keyId: string;
  readonly #now: () => Date;
  readonly #drills: RestoreDrill[] = [];
  readonly #createKeys = new Map<string, { readonly backupId: Id; readonly input: string }>();

  constructor(audit: AuditLog, repository: BackupRepository, encryption: AesGcmEncryptionService, keyId: string, now: () => Date = () => new Date()) {
    this.#audit = audit;
    this.#repository = repository;
    this.#encryption = encryption;
    this.#keyId = keyId;
    this.#now = now;
  }

  async create(context: RequestContext, source: BackupSource, schemaVersion: string, retentionDays: number, idempotencyKey: string): Promise<BackupManifest> {
    requireBackupPermission(context, "backup.manage");
    if (!schemaVersion.trim() || !Number.isInteger(retentionDays) || retentionDays < 1) throw new Error("INVALID_BACKUP_POLICY");
    if (!idempotencyKey.trim()) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
    const key = `${context.companyId}:${idempotencyKey}`;
    const input = JSON.stringify({ schemaVersion, retentionDays });
    const prior = this.#createKeys.get(key);
    if (prior) {
      if (prior.input !== input) throw new PlatformError("IDEMPOTENCY_CONFLICT", "This backup idempotency key was already used with another policy.");
      const existing = await this.#repository.get(prior.backupId);
      if (!existing) throw new Error("IDEMPOTENT_BACKUP_MISSING");
      return existing.manifest;
    }
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
    await this.#repository.save({ manifest, payload });
    this.#createKeys.set(key, { backupId: manifest.id, input });
    this.#audit.append({ companyId: context.companyId, actorId: context.actorId, action: "backup.created", correlationId: id, before: null, after: { schemaVersion, byteLength: snapshot.byteLength, checksumSha256: manifest.checksumSha256, expiresAt: manifest.expiresAt, keyId: manifest.keyId } });
    return manifest;
  }

  async restore(context: RequestContext, backupId: Id, target: RestoreTarget): Promise<RestoreDrill> {
    requireBackupPermission(context, "backup.restore");
    const startedAt = this.#now().toISOString();
    try {
      const backup = await this.#repository.get(backupId);
      if (!backup) throw new PlatformError("NOT_FOUND", "Backup was not found.");
      if (backup.manifest.companyId !== context.companyId) throw new PlatformError("TENANT_ISOLATION", "This backup belongs to another company.");
      const snapshot = await this.#encryption.decrypt(backup.payload, associatedData(backup.manifest));
      if (snapshot.byteLength !== backup.manifest.byteLength || checksum(snapshot) !== backup.manifest.checksumSha256) throw new Error("BACKUP_INTEGRITY_FAILED");
      await target.validate(snapshot, backup.manifest);
      await target.replace(snapshot, backup.manifest);
      return this.#recordDrill(context, backupId, "passed", startedAt, "Integrity, schema validation and replacement completed.");
    } catch (error) {
      const details = safeRestoreFailure(error);
      this.#recordDrill(context, backupId, "failed", startedAt, details);
      throw error;
    }
  }

  async pruneExpired(context: RequestContext): Promise<number> {
    requireBackupPermission(context, "backup.manage");
    const now = this.#now().getTime();
    const expired = (await this.#repository.list(context.companyId)).filter((backup) => Date.parse(backup.manifest.expiresAt) <= now);
    for (const backup of expired) await this.#repository.delete(backup.manifest.id);
    if (expired.length > 0) this.#audit.append({ companyId: context.companyId, actorId: context.actorId, action: "backup.retention.pruned", correlationId: randomUUID(), before: null, after: { deletedBackups: expired.length } });
    return expired.length;
  }

  drills(context: RequestContext): readonly RestoreDrill[] {
    requireBackupPermission(context, "backup.restore");
    return this.#drills.filter((drill) => drill.companyId === context.companyId);
  }

  #recordDrill(context: RequestContext, backupId: Id, status: RestoreDrill["status"], startedAt: string, details: string): RestoreDrill {
    const drill = Object.freeze({ id: randomUUID(), companyId: context.companyId, backupId, status, startedAt, completedAt: this.#now().toISOString(), details });
    this.#drills.push(drill);
    this.#audit.append({ companyId: context.companyId, actorId: context.actorId, action: `backup.restore.${status}`, correlationId: drill.id, before: null, after: { backupId, status, details } });
    return drill;
  }
}

function checksum(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function associatedData(manifest: Pick<BackupManifest, "id" | "companyId" | "schemaVersion">): string { return `${manifest.companyId}:${manifest.id}:${manifest.schemaVersion}`; }
function requireBackupPermission(context: RequestContext, permission: "backup.manage" | "backup.restore"): void { if (!context.permissions.has(permission)) throw new PlatformError("FORBIDDEN", `Permission ${permission} is required.`); }
function safeRestoreFailure(error: unknown): string {
  if (error instanceof PlatformError) return error.code;
  if (error instanceof Error && ["ENCRYPTION_KEY_UNAVAILABLE", "ENCRYPTION_KEY_MUST_BE_32_BYTES", "BACKUP_INTEGRITY_FAILED"].includes(error.message)) return error.message;
  return "RESTORE_VALIDATION_FAILED";
}
