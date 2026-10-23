/**
 * Issue #366 — where privacy and recovery keep what must outlive a restart: notices, consents,
 * legal holds, retention dates, subject requests, backup manifests and restore drills.
 * The in-memory stores are the default and what the unit tests use; postgres-store.ts is the same
 * contract on the database. Both run the shared suite in test/security-contract.ts.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AuditEvent, Id } from "../../../packages/platform/src/index.ts";
import type { EncryptedPayload } from "./encryption.ts";
import type { ConsentRecord, LegalHold, PrivacyNotice, PrivacyRequest } from "./privacy.ts";
import type { BackupManifest, RestoreDrill, StoredBackup } from "./recovery.ts";

export interface Page { readonly limit?: number; readonly after?: string }
export const pageLimit = (page?: Page): number => Math.min(Math.max(Math.trunc(page?.limit ?? 100), 1), 500);

/** The audit trail: the in-memory `AuditLog`, or `PostgresAuditLog` joining the same unit of work. */
export interface SecurityAudit { append(event: Omit<AuditEvent, "id" | "occurredAt">): unknown }

export interface PrivacyStore {
  /** One business action for `companyId`: on the database everything written inside it is kept together, or nothing is. */
  action<T>(companyId: Id, work: () => Promise<T>): Promise<T>;
  /** Keeps the first notice published under a version and returns whichever is kept. */
  addNotice(companyId: Id, notice: PrivacyNotice): Promise<PrivacyNotice>;
  notice(companyId: Id, version: string): Promise<PrivacyNotice | null>;
  addConsent(consent: ConsentRecord): Promise<void>;
  /** Oldest first; `after` is the id of the last consent already shown. */
  consents(companyId: Id, subjectId: Id, page?: Page): Promise<readonly ConsentRecord[]>;
  addHold(hold: LegalHold, createdAt: string): Promise<void>;
  /** Releases once: a hold already released stays as it was, and `changed` is false. */
  releaseHold(companyId: Id, holdId: Id, releasedAt: string): Promise<{ readonly hold: LegalHold; readonly changed: boolean } | null>;
  activeHolds(companyId: Id, subjectId: Id): Promise<readonly LegalHold[]>;
  setRetention(companyId: Id, subjectId: Id, retainUntil: string, setAt: string): Promise<void>;
  /** The retention date set last, if any. */
  retention(companyId: Id, subjectId: Id): Promise<string | undefined>;
  /** Keeps the first request made under `kind` + `idempotencyKey` and returns whichever is kept. */
  addRequest(request: PrivacyRequest, idempotencyKey: string): Promise<PrivacyRequest>;
  request(companyId: Id, requestId: Id): Promise<PrivacyRequest | null>;
  /** Moves a request out of "requested" once; false when it had already left it. */
  settleRequest(settled: PrivacyRequest): Promise<boolean>;
}

const sameCompany = <T extends { readonly companyId: Id }>(value: T | undefined, companyId: Id): T | null =>
  value !== undefined && value.companyId === companyId ? value : null;
const after = <T extends { readonly id: Id }>(items: readonly T[], page?: Page): readonly T[] => {
  const start = page?.after === undefined ? 0 : items.findIndex((item) => item.id === page.after) + 1;
  return start === 0 && page?.after !== undefined ? [] : items.slice(start, start + pageLimit(page));
};

/** Every check-and-set below runs with no await in between, so two callers at once cannot both win. */
export class InMemoryPrivacyStore implements PrivacyStore {
  readonly #notices = new Map<string, PrivacyNotice>();
  readonly #consents: ConsentRecord[] = [];
  readonly #holds = new Map<Id, LegalHold>();
  readonly #retention = new Map<string, string>();
  readonly #requests = new Map<Id, PrivacyRequest>();
  readonly #requestKeys = new Map<string, Id>();

  readonly #undo = new AsyncLocalStorage<(() => void)[]>();

  /** Like the database's unit of work: if `work` throws, every change it made here is undone, so a retry starts clean. */
  async action<T>(_companyId: Id, work: () => Promise<T>): Promise<T> {
    const undo: (() => void)[] = [];
    try {
      return await this.#undo.run(undo, work);
    } catch (error) {
      for (const step of undo.reverse()) step();
      throw error;
    }
  }
  #onUndo(step: () => void): void { this.#undo.getStore()?.push(step); }
  #setUndoably<K, V>(map: Map<K, V>, key: K, value: V): void {
    const had = map.has(key);
    const prior = map.get(key);
    map.set(key, value);
    this.#onUndo(() => { if (had) map.set(key, prior as V); else map.delete(key); });
  }
  async addNotice(companyId: Id, notice: PrivacyNotice): Promise<PrivacyNotice> {
    const key = `${companyId}:${notice.version}`;
    const kept = this.#notices.get(key) ?? notice;
    if (kept === notice) this.#setUndoably(this.#notices, key, kept);
    return kept;
  }
  async notice(companyId: Id, version: string): Promise<PrivacyNotice | null> { return this.#notices.get(`${companyId}:${version}`) ?? null; }
  async addConsent(consent: ConsentRecord): Promise<void> {
    this.#consents.push(consent);
    this.#onUndo(() => { const at = this.#consents.indexOf(consent); if (at >= 0) this.#consents.splice(at, 1); });
  }
  async consents(companyId: Id, subjectId: Id, page?: Page): Promise<readonly ConsentRecord[]> {
    return after(this.#consents.filter((c) => c.companyId === companyId && c.subjectId === subjectId), page);
  }
  async addHold(hold: LegalHold): Promise<void> {
    if (this.#holds.has(hold.id)) throw new Error("LEGAL_HOLD_EXISTS");
    this.#setUndoably(this.#holds, hold.id, hold);
  }
  async releaseHold(companyId: Id, holdId: Id): Promise<{ readonly hold: LegalHold; readonly changed: boolean } | null> {
    const current = sameCompany(this.#holds.get(holdId), companyId);
    if (current === null) return null;
    if (!current.active) return { hold: current, changed: false };
    const released = Object.freeze({ ...current, active: false });
    this.#setUndoably(this.#holds, holdId, released);
    return { hold: released, changed: true };
  }
  async activeHolds(companyId: Id, subjectId: Id): Promise<readonly LegalHold[]> {
    return [...this.#holds.values()].filter((h) => h.companyId === companyId && h.subjectId === subjectId && h.active);
  }
  async setRetention(companyId: Id, subjectId: Id, retainUntil: string): Promise<void> { this.#setUndoably(this.#retention, `${companyId}:${subjectId}`, retainUntil); }
  async retention(companyId: Id, subjectId: Id): Promise<string | undefined> { return this.#retention.get(`${companyId}:${subjectId}`); }
  async addRequest(request: PrivacyRequest, idempotencyKey: string): Promise<PrivacyRequest> {
    const key = `${request.companyId}:${request.kind}:${idempotencyKey}`;
    const prior = this.#requestKeys.get(key);
    if (prior !== undefined) return this.#requests.get(prior)!;
    this.#setUndoably(this.#requests, request.id, request);
    this.#setUndoably(this.#requestKeys, key, request.id);
    return request;
  }
  async request(companyId: Id, requestId: Id): Promise<PrivacyRequest | null> { return sameCompany(this.#requests.get(requestId), companyId); }
  async settleRequest(settled: PrivacyRequest): Promise<boolean> {
    const current = sameCompany(this.#requests.get(settled.id), settled.companyId);
    if (current === null || current.status !== "requested") return false;
    this.#setUndoably(this.#requests, settled.id, settled);
    return true;
  }
}

/** A backup's manifest and where its encrypted bytes are kept. */
export interface BackupRecord { readonly manifest: BackupManifest; readonly objectKey: string }

export interface BackupRepository {
  action<T>(companyId: Id, work: () => Promise<T>): Promise<T>;
  /** Writes the encrypted bytes to object storage. Called outside any unit of work; returns the object key. */
  putPayload(manifest: BackupManifest, payload: EncryptedPayload): Promise<string>;
  /** Records the manifest. False when another backup already holds this idempotency key. */
  save(manifest: BackupManifest, objectKey: string, idempotency: { readonly key: string; readonly input: string }): Promise<boolean>;
  /** This company's backup and its bytes; another company's id, or a pruned backup, is not found. */
  get(companyId: Id, backupId: Id): Promise<StoredBackup | undefined>;
  byKey(companyId: Id, idempotencyKey: string): Promise<{ readonly backupId: Id; readonly input: string } | undefined>;
  /** Backups not yet pruned whose expiry is at or before `at`, oldest first, at most 500. */
  expired(companyId: Id, at: string): Promise<readonly BackupRecord[]>;
  /** Marks a backup pruned, once. False when it already was. */
  prune(companyId: Id, backupId: Id, at: string): Promise<boolean>;
  /** Removes the bytes from object storage. Called after the prune is committed. */
  deletePayload(objectKey: string): Promise<void>;
  addDrill(drill: RestoreDrill): Promise<void>;
  /** Oldest first; `after` is the id of the last drill already shown. */
  drills(companyId: Id, page?: Page): Promise<readonly RestoreDrill[]>;
}

export class MemoryBackupRepository implements BackupRepository {
  readonly #records = new Map<Id, BackupRecord & { readonly key: string; readonly input: string; readonly prunedAt?: string }>();
  readonly #payloads = new Map<string, EncryptedPayload>();
  readonly #drills: RestoreDrill[] = [];

  readonly #undo = new AsyncLocalStorage<(() => void)[]>();

  /** Like the database's unit of work: if `work` throws, every change it made here is undone, so a retry starts clean. */
  async action<T>(_companyId: Id, work: () => Promise<T>): Promise<T> {
    const undo: (() => void)[] = [];
    try {
      return await this.#undo.run(undo, work);
    } catch (error) {
      for (const step of undo.reverse()) step();
      throw error;
    }
  }
  #onUndo(step: () => void): void { this.#undo.getStore()?.push(step); }
  #setUndoably<K, V>(map: Map<K, V>, key: K, value: V): void {
    const had = map.has(key);
    const prior = map.get(key);
    map.set(key, value);
    this.#onUndo(() => { if (had) map.set(key, prior as V); else map.delete(key); });
  }
  async putPayload(manifest: BackupManifest, payload: EncryptedPayload): Promise<string> {
    const key = `backups/${manifest.companyId}/${manifest.id}`;
    this.#payloads.set(key, structuredClone(payload));
    return key;
  }
  async save(manifest: BackupManifest, objectKey: string, idempotency: { readonly key: string; readonly input: string }): Promise<boolean> {
    if ([...this.#records.values()].some((r) => r.manifest.companyId === manifest.companyId && r.key === idempotency.key)) return false;
    this.#records.set(manifest.id, { manifest, objectKey, key: idempotency.key, input: idempotency.input });
    return true;
  }
  async get(companyId: Id, backupId: Id): Promise<StoredBackup | undefined> {
    const record = this.#records.get(backupId);
    if (record === undefined || record.manifest.companyId !== companyId || record.prunedAt !== undefined) return undefined;
    const payload = this.#payloads.get(record.objectKey);
    return payload === undefined ? undefined : { manifest: record.manifest, payload: structuredClone(payload) };
  }
  async byKey(companyId: Id, idempotencyKey: string): Promise<{ readonly backupId: Id; readonly input: string } | undefined> {
    const record = [...this.#records.values()].find((r) => r.manifest.companyId === companyId && r.key === idempotencyKey);
    return record === undefined ? undefined : { backupId: record.manifest.id, input: record.input };
  }
  async expired(companyId: Id, at: string): Promise<readonly BackupRecord[]> {
    return [...this.#records.values()]
      .filter((r) => r.manifest.companyId === companyId && r.prunedAt === undefined && Date.parse(r.manifest.expiresAt) <= Date.parse(at))
      .slice(0, 500).map((r) => ({ manifest: r.manifest, objectKey: r.objectKey }));
  }
  async prune(companyId: Id, backupId: Id, at: string): Promise<boolean> {
    const record = this.#records.get(backupId);
    if (record === undefined || record.manifest.companyId !== companyId || record.prunedAt !== undefined) return false;
    this.#records.set(backupId, { ...record, prunedAt: at });
    return true;
  }
  async deletePayload(objectKey: string): Promise<void> { this.#payloads.delete(objectKey); }
  async addDrill(drill: RestoreDrill): Promise<void> { this.#drills.push(drill); }
  async drills(companyId: Id, page?: Page): Promise<readonly RestoreDrill[]> { return after(this.#drills.filter((d) => d.companyId === companyId), page); }
}
