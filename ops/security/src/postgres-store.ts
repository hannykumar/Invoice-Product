/**
 * Issue #366 — privacy and recovery records on PostgreSQL. Neither store opens a transaction of
 * its own: every write joins the action's unit of work (`requireUnitOfWork`, which throws
 * `NO_UNIT_OF_WORK` when none is open), every read runs in `tenantTransaction`, and every query
 * names its company as well as relying on row-level security.
 *
 * Backup bytes are not kept in the database: `backup_records.object_key` points at them in the
 * object store (#341), reached through `BackupObjectStore` and only outside a unit of work.
 */
import type { Id } from "../../../packages/platform/src/index.ts";
import type { SqlExecutor, TransactionalExecutor } from "../../../packages/platform/src/database.ts";
import type { EncryptedPayload } from "./encryption.ts";
import type { ConsentRecord, LegalHold, PrivacyNotice, PrivacyRequest } from "./privacy.ts";
import type { BackupManifest, RestoreDrill, StoredBackup } from "./recovery.ts";
import { pageLimit, type BackupRecord, type BackupRepository, type Page, type PrivacyStore } from "./store.ts";

type Row = Record<string, unknown>;
const iso = (value: unknown): string => (value instanceof Date ? value : new Date(String(value))).toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (value: string | undefined): string | null => (value !== undefined && UUID.test(value) ? value : value === undefined ? null : "00000000-0000-0000-0000-000000000000");

const NOTICE = "n.version, n.effective_at, n.purposes";
const notice = (r: Row): PrivacyNotice => Object.freeze({ version: String(r.version), effectiveAt: iso(r.effective_at), purposes: Object.freeze([...(r.purposes as string[])]) });
const CONSENT = "c.id, c.company_id, c.subject_id, c.notice_version, c.purposes, c.decision, c.decided_at";
const consent = (r: Row): ConsentRecord => Object.freeze({
  id: String(r.id), companyId: String(r.company_id), subjectId: String(r.subject_id), noticeVersion: String(r.notice_version),
  purposes: Object.freeze([...(r.purposes as string[])]), decision: String(r.decision) as ConsentRecord["decision"], decidedAt: iso(r.decided_at),
});
const HOLD = "h.id, h.company_id, h.subject_id, h.reason, h.active";
const hold = (r: Row): LegalHold => Object.freeze({ id: String(r.id), companyId: String(r.company_id), subjectId: String(r.subject_id), reason: String(r.reason), active: Boolean(r.active) });
const REQUEST = "q.id, q.company_id, q.subject_id, q.kind, q.status, q.blockers, q.requested_at, q.completed_at";
const request = (r: Row): PrivacyRequest => Object.freeze({
  id: String(r.id), companyId: String(r.company_id), subjectId: String(r.subject_id), kind: String(r.kind) as PrivacyRequest["kind"],
  status: String(r.status) as PrivacyRequest["status"], requestedAt: iso(r.requested_at), blockers: Object.freeze([...(r.blockers as string[])]),
  ...(r.completed_at === null || r.completed_at === undefined ? {} : { completedAt: iso(r.completed_at) }),
});

export class PostgresPrivacyStore implements PrivacyStore {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  action<T>(companyId: Id, work: () => Promise<T>): Promise<T> { return this.#db.unitOfWork(companyId, () => work()); }
  #read<T>(companyId: Id, work: (sql: SqlExecutor) => Promise<T>): Promise<T> { return this.#db.tenantTransaction(companyId, work); }
  #write(companyId: Id): SqlExecutor { return this.#db.requireUnitOfWork(companyId).sql; }

  async addNotice(companyId: Id, n: PrivacyNotice): Promise<PrivacyNotice> {
    const sql = this.#write(companyId);
    const inserted = await sql.query(
      `INSERT INTO privacy_notices (company_id, version, effective_at, purposes) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (company_id, version) DO NOTHING RETURNING version`,
      [companyId, n.version, n.effectiveAt, JSON.stringify(n.purposes)]);
    if (inserted.rows.length > 0) return n;
    const kept = await sql.query(`SELECT ${NOTICE} FROM privacy_notices n WHERE n.company_id = $1 AND n.version = $2`, [companyId, n.version]);
    return notice(kept.rows[0]!);
  }

  notice(companyId: Id, version: string): Promise<PrivacyNotice | null> {
    return this.#read(companyId, async (sql) => {
      const row = (await sql.query(`SELECT ${NOTICE} FROM privacy_notices n WHERE n.company_id = $1 AND n.version = $2`, [companyId, version])).rows[0];
      return row === undefined ? null : notice(row);
    });
  }

  async addConsent(c: ConsentRecord): Promise<void> {
    await this.#write(c.companyId).query(
      `INSERT INTO privacy_consents (id, company_id, subject_id, notice_version, purposes, decision, decided_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [c.id, c.companyId, c.subjectId, c.noticeVersion, JSON.stringify(c.purposes), c.decision, c.decidedAt]);
  }

  consents(companyId: Id, subjectId: Id, page?: Page): Promise<readonly ConsentRecord[]> {
    return this.#read(companyId, async (sql) => (await sql.query(
      `SELECT ${CONSENT} FROM privacy_consents c
        WHERE c.company_id = $1 AND c.subject_id = $2
          AND ($3::uuid IS NULL OR (c.decided_at, c.id) > (SELECT a.decided_at, a.id FROM privacy_consents a WHERE a.company_id = $1 AND a.id = $3))
        ORDER BY c.decided_at, c.id LIMIT $4`,
      [companyId, subjectId, uuidOrNull(page?.after), pageLimit(page)])).rows.map(consent));
  }

  async addHold(h: LegalHold, createdAt: string): Promise<void> {
    await this.#write(h.companyId).query(
      `INSERT INTO privacy_legal_holds (id, company_id, subject_id, reason, active, created_at) VALUES ($1, $2, $3, $4, true, $5)`,
      [h.id, h.companyId, h.subjectId, h.reason, createdAt]);
  }

  async releaseHold(companyId: Id, holdId: Id, releasedAt: string): Promise<{ readonly hold: LegalHold; readonly changed: boolean } | null> {
    const sql = this.#write(companyId);
    if (!UUID.test(holdId)) return null;
    // The row lock makes a second release wait for the first and then see it released.
    const current = (await sql.query(`SELECT ${HOLD} FROM privacy_legal_holds h WHERE h.company_id = $1 AND h.id = $2 FOR UPDATE`, [companyId, holdId])).rows[0];
    if (current === undefined) return null;
    if (!current.active) return { hold: hold(current), changed: false };
    const released = await sql.query(
      `UPDATE privacy_legal_holds h SET active = false, released_at = $3 WHERE h.company_id = $1 AND h.id = $2 RETURNING ${HOLD}`,
      [companyId, holdId, releasedAt]);
    return { hold: hold(released.rows[0]!), changed: true };
  }

  activeHolds(companyId: Id, subjectId: Id): Promise<readonly LegalHold[]> {
    return this.#read(companyId, async (sql) => (await sql.query(
      `SELECT ${HOLD} FROM privacy_legal_holds h WHERE h.company_id = $1 AND h.subject_id = $2 AND h.active ORDER BY h.created_at, h.id LIMIT 500`,
      [companyId, subjectId])).rows.map(hold));
  }

  async setRetention(companyId: Id, subjectId: Id, retainUntil: string, setAt: string): Promise<void> {
    await this.#write(companyId).query(
      `INSERT INTO privacy_retention_rules (id, company_id, subject_id, retain_until, set_at) VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
      [companyId, subjectId, retainUntil, setAt]);
  }

  retention(companyId: Id, subjectId: Id): Promise<string | undefined> {
    return this.#read(companyId, async (sql) => {
      const row = (await sql.query(
        `SELECT r.retain_until FROM privacy_retention_rules r WHERE r.company_id = $1 AND r.subject_id = $2 ORDER BY r.seq DESC LIMIT 1`,
        [companyId, subjectId])).rows[0];
      return row === undefined ? undefined : iso(row.retain_until);
    });
  }

  async addRequest(q: PrivacyRequest, idempotencyKey: string): Promise<PrivacyRequest> {
    const sql = this.#write(q.companyId);
    const inserted = await sql.query(
      `INSERT INTO privacy_requests (id, company_id, subject_id, kind, status, blockers, requested_at, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       ON CONFLICT (company_id, kind, idempotency_key) DO NOTHING RETURNING id`,
      [q.id, q.companyId, q.subjectId, q.kind, q.status, JSON.stringify(q.blockers), q.requestedAt, idempotencyKey]);
    if (inserted.rows.length > 0) return q;
    const kept = await sql.query(`SELECT ${REQUEST} FROM privacy_requests q WHERE q.company_id = $1 AND q.kind = $2 AND q.idempotency_key = $3`, [q.companyId, q.kind, idempotencyKey]);
    return request(kept.rows[0]!);
  }

  request(companyId: Id, requestId: Id): Promise<PrivacyRequest | null> {
    if (!UUID.test(requestId)) return Promise.resolve(null);
    return this.#read(companyId, async (sql) => {
      const row = (await sql.query(`SELECT ${REQUEST} FROM privacy_requests q WHERE q.company_id = $1 AND q.id = $2`, [companyId, requestId])).rows[0];
      return row === undefined ? null : request(row);
    });
  }

  async settleRequest(settled: PrivacyRequest): Promise<boolean> {
    const changed = await this.#write(settled.companyId).query(
      `UPDATE privacy_requests q SET status = $3, blockers = $4::jsonb, completed_at = $5
        WHERE q.company_id = $1 AND q.id = $2 AND q.status = 'requested' RETURNING q.id`,
      [settled.companyId, settled.id, settled.status, JSON.stringify(settled.blockers), settled.completedAt ?? null]);
    return changed.rows.length > 0;
  }
}

/** Where the encrypted backup bytes live (object storage, #341). Never called inside a unit of work. */
export interface BackupObjectStore {
  put(key: string, payload: EncryptedPayload): Promise<void>;
  get(key: string): Promise<EncryptedPayload | undefined>;
  delete(key: string): Promise<void>;
}

export class MemoryBackupObjectStore implements BackupObjectStore {
  readonly #objects = new Map<string, EncryptedPayload>();
  async put(key: string, payload: EncryptedPayload): Promise<void> { this.#objects.set(key, structuredClone(payload)); }
  async get(key: string): Promise<EncryptedPayload | undefined> { const value = this.#objects.get(key); return value && structuredClone(value); }
  async delete(key: string): Promise<void> { this.#objects.delete(key); }
}

const BACKUP = "b.id, b.company_id, b.object_key, b.schema_version, b.checksum_sha256, b.byte_length, b.encryption_key_id, b.created_at, b.expires_at";
const record = (r: Row): BackupRecord => ({
  objectKey: String(r.object_key),
  manifest: Object.freeze({
    id: String(r.id), companyId: String(r.company_id), schemaVersion: String(r.schema_version), createdAt: iso(r.created_at), expiresAt: iso(r.expires_at),
    checksumSha256: String(r.checksum_sha256), byteLength: Number(r.byte_length), keyId: String(r.encryption_key_id),
  }),
});
const DRILL = "d.id, d.company_id, d.backup_id, d.status, d.details, d.started_at, d.completed_at";
const drill = (r: Row): RestoreDrill => Object.freeze({
  id: String(r.id), companyId: String(r.company_id), backupId: String(r.backup_id), status: String(r.status) as RestoreDrill["status"],
  details: String(r.details), startedAt: iso(r.started_at), completedAt: iso(r.completed_at),
});

export class PostgresBackupRepository implements BackupRepository {
  readonly #db: TransactionalExecutor;
  readonly #objects: BackupObjectStore;
  constructor(db: TransactionalExecutor, objects: BackupObjectStore) { this.#db = db; this.#objects = objects; }

  action<T>(companyId: Id, work: () => Promise<T>): Promise<T> { return this.#db.unitOfWork(companyId, () => work()); }
  #read<T>(companyId: Id, work: (sql: SqlExecutor) => Promise<T>): Promise<T> { return this.#db.tenantTransaction(companyId, work); }
  #write(companyId: Id): SqlExecutor { return this.#db.requireUnitOfWork(companyId).sql; }

  async putPayload(manifest: BackupManifest, payload: EncryptedPayload): Promise<string> {
    const key = `backups/${manifest.companyId}/${manifest.id}`;
    await this.#objects.put(key, payload);
    return key;
  }

  async save(m: BackupManifest, objectKey: string, idempotency: { readonly key: string; readonly input: string }): Promise<boolean> {
    const inserted = await this.#write(m.companyId).query(
      `INSERT INTO backup_records (id, company_id, object_key, schema_version, checksum_sha256, byte_length, encryption_key_id, created_at, expires_at, idempotency_key, idempotency_input)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (company_id, idempotency_key) DO NOTHING RETURNING id`,
      [m.id, m.companyId, objectKey, m.schemaVersion, m.checksumSha256, m.byteLength, m.keyId, m.createdAt, m.expiresAt, idempotency.key, idempotency.input]);
    return inserted.rows.length > 0;
  }

  async get(companyId: Id, backupId: Id): Promise<StoredBackup | undefined> {
    if (!UUID.test(backupId)) return undefined;
    const found = await this.#read(companyId, async (sql) => (await sql.query(
      `SELECT ${BACKUP} FROM backup_records b WHERE b.company_id = $1 AND b.id = $2 AND b.pruned_at IS NULL`, [companyId, backupId])).rows[0]);
    if (found === undefined) return undefined;
    const { manifest, objectKey } = record(found);
    const payload = await this.#objects.get(objectKey);
    return payload === undefined ? undefined : { manifest, payload };
  }

  byKey(companyId: Id, idempotencyKey: string): Promise<{ readonly backupId: Id; readonly input: string } | undefined> {
    return this.#read(companyId, async (sql) => {
      const row = (await sql.query(`SELECT b.id, b.idempotency_input FROM backup_records b WHERE b.company_id = $1 AND b.idempotency_key = $2`, [companyId, idempotencyKey])).rows[0];
      return row === undefined ? undefined : { backupId: String(row.id), input: String(row.idempotency_input) };
    });
  }

  expired(companyId: Id, at: string): Promise<readonly BackupRecord[]> {
    return this.#read(companyId, async (sql) => (await sql.query(
      `SELECT ${BACKUP} FROM backup_records b WHERE b.company_id = $1 AND b.pruned_at IS NULL AND b.expires_at <= $2 ORDER BY b.expires_at, b.id LIMIT 500`,
      [companyId, at])).rows.map(record));
  }

  async prune(companyId: Id, backupId: Id, at: string): Promise<boolean> {
    const pruned = await this.#write(companyId).query(
      `UPDATE backup_records b SET pruned_at = $3 WHERE b.company_id = $1 AND b.id = $2 AND b.pruned_at IS NULL RETURNING b.id`, [companyId, backupId, at]);
    return pruned.rows.length > 0;
  }

  deletePayload(objectKey: string): Promise<void> { return this.#objects.delete(objectKey); }

  async addDrill(d: RestoreDrill): Promise<void> {
    await this.#write(d.companyId).query(
      `INSERT INTO restore_drills (id, company_id, backup_id, status, details, started_at, completed_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [d.id, d.companyId, d.backupId, d.status, d.details, d.startedAt, d.completedAt]);
  }

  drills(companyId: Id, page?: Page): Promise<readonly RestoreDrill[]> {
    return this.#read(companyId, async (sql) => (await sql.query(
      `SELECT ${DRILL} FROM restore_drills d
        WHERE d.company_id = $1
          AND ($2::uuid IS NULL OR (d.completed_at, d.id) > (SELECT a.completed_at, a.id FROM restore_drills a WHERE a.company_id = $1 AND a.id = $2))
        ORDER BY d.completed_at, d.id LIMIT $3`,
      [companyId, uuidOrNull(page?.after), pageLimit(page)])).rows.map(drill));
  }
}
