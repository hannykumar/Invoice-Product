/**
 * Issue #352 — the account's data, found and scrubbed for the privacy module.
 *
 * `PrivacyService` decides whether an export or deletion may run (permissions, idempotency,
 * legal holds, retention). What it cannot know is where the running app actually keeps the
 * account's data — that is the `PrivacyDataStore` port, implemented here twice:
 *
 * - `PostgresAccountDataStore`: every tenant table, dumped with the sealed fields opened, and a
 *   scrub that removes what is not the books. Deleting rows is impossible by design (#368), so
 *   removal means tombstoning `app_records`, revoking sessions and access, and anonymising users
 *   who belong to no other company. Posted bills and the audit trail are never touched —
 *   CGST Act s.36 and Companies Act s.128 keep the books for eight years (decision 0010).
 * - `MemoryAccountDataStore`: the same over the in-memory stores, for local runs and tests.
 *
 * The same dump feeds `PostgresBackupSource`, so a backup is exactly the export, sealed again.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TransactionalExecutor } from '../../../packages/platform/src/database.ts';
import type { AesGcmEncryptionService, EncryptedPayload } from '../../../ops/security/src/encryption.ts';
import type { PrivacyDataStore, SubjectDeletionResult } from '../../../ops/security/src/privacy.ts';
import type { BackupSource } from '../../../ops/security/src/recovery.ts';
import type { BackupObjectStore } from '../../../ops/security/src/postgres-store.ts';
import { appRecordBoundTo, masterVersionBoundTo, unsealJson, unsealMasterData } from './field-encryption.ts';
import { durableEntries, scrubDurableRecords } from './durable.ts';
import { allMasterRecords } from './master-data.ts';

/** Plain words for what a deletion keeps and why — the shopkeeper's answer, not a table list. */
export const RETAINED_PLAINLY = Object.freeze([
  'Posted bills, vouchers and GST records stay because the law keeps the books for eight years after the financial year ends (CGST Act section 36; Companies Act section 128). Names inside a posted bill stay with the bill.',
  'The names and addresses of customers, suppliers and people the kept books name stay with those records, for the same eight years.',
  'The audit trail stays so it can always be shown who did what.',
  'The consent, hold and request records of this privacy register stay so the request itself can be shown later.',
  'The sign-in address of a person stays in the identity table, which only the platform may change; their name inside this business is removed.',
  'A removed account can never be signed in to again.',
]);

/**
 * Every row the tenant keeps, with sealed fields opened. Tables are discovered from the schema,
 * so a new tenant table is exported automatically instead of being silently forgotten.
 */
export const dumpAccount = async (db: TransactionalExecutor, encryption: AesGcmEncryptionService, companyId: string): Promise<Record<string, unknown>> => {
  return db.tenantTransaction(companyId, async (sql) => {
    const { rows: tableRows } = await sql.query(
      `SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'company_id' ORDER BY table_name`);
    const out: Record<string, unknown> = {};
    for (const { table_name: table } of tableRows) {
      const name = String(table);
      if (name === 'companies') continue;
      if (name === 'master_versions') {
        // `kind` lives on the record row, and the sealed data was bound with it.
        const { rows } = await sql.query(
          `SELECT v.*, r.kind FROM master_versions v JOIN master_records r ON r.company_id = v.company_id AND r.id = v.record_id WHERE v.company_id = $1`, [companyId]);
        out[name] = await Promise.all(rows.map(async (row) => ({
          ...row,
          data: await unsealMasterData(encryption, row.data, masterVersionBoundTo(companyId, String(row.kind))),
        })));
        continue;
      }
      const { rows } = await sql.query(`SELECT * FROM "${name}" WHERE company_id = $1`, [companyId]);
      out[name] = name === 'app_records'
        ? await Promise.all(rows.map(async (row) => ({ ...row, value: await unsealJson(encryption, row.value, appRecordBoundTo(companyId, String(row.kind), String(row.key))) })))
        : rows;
    }
    const { rows: company } = await sql.query('SELECT id, legal_name, created_at FROM companies WHERE id = $1', [companyId]);
    out.companies = company;
    return out;
  });
};

/** #352 — the account's data on PostgreSQL: dump for export, scrub for deletion. */
export class PostgresAccountDataStore implements PrivacyDataStore {
  readonly #db: TransactionalExecutor;
  readonly #encryption: AesGcmEncryptionService;
  constructor(db: TransactionalExecutor, encryption: AesGcmEncryptionService) { this.#db = db; this.#encryption = encryption; }

  async exportSubject(companyId: string, subjectId: string): Promise<Readonly<Record<string, unknown>>> {
    if (subjectId === companyId) return dumpAccount(this.#db, this.#encryption, companyId);
    // A person, not the whole account: the records the privacy register itself holds for them.
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const out: Record<string, unknown> = {};
      for (const table of ['privacy_consents', 'privacy_legal_holds', 'privacy_requests', 'privacy_retention_rules'] as const) {
        const { rows } = await sql.query(`SELECT * FROM ${table} WHERE company_id = $1 AND subject_id = $2`, [companyId, subjectId]);
        out[table] = rows;
      }
      return out;
    });
  }

  /**
   * Scrubbing, not deleting: rows stay, personal data goes. Everything in `app_records` that is
   * not frozen is tombstoned (business details, branding, prefill), every session is revoked,
   * every access row is removed — the one table the app role may DELETE from — and a user with no
   * other live membership is anonymised. The books are never touched.
   */
  async deleteSubject(companyId: string, subjectId: string): Promise<SubjectDeletionResult> {
    if (subjectId !== companyId) return { deletedRecords: 0, retainedRecords: 1 };
    const outcome = await this.#db.unitOfWork(companyId, async (uow) => {
      let deleted = 0;
      deleted += (await uow.sql.query("UPDATE app_records SET value = 'null'::jsonb, updated_at = now() WHERE company_id = $1 AND frozen = false AND value <> 'null'::jsonb RETURNING key", [companyId])).rows.length;
      deleted += (await uow.sql.query('DELETE FROM user_branch_access WHERE company_id = $1 RETURNING user_id', [companyId])).rows.length;
      deleted += (await uow.sql.query('UPDATE sessions SET revoked_at = now() WHERE company_id = $1 AND revoked_at IS NULL RETURNING id', [companyId])).rows.length;
      deleted += (await uow.sql.query('UPDATE memberships SET active = false WHERE company_id = $1 AND active = true RETURNING user_id', [companyId])).rows.length;
      // The application role may change only `display_name` and `active` on `users` — the sign-in
      // address is deliberately out of its reach (the grant's own comment says so). What the role
      // may do is done here; the email is kept by the identity table and named in `kept`.
      deleted += (await uow.sql.query(
        `UPDATE users u SET display_name = 'Removed account', active = false
          WHERE EXISTS (SELECT 1 FROM memberships m WHERE m.company_id = $1 AND m.user_id = u.id)
            AND NOT EXISTS (SELECT 1 FROM memberships m2 WHERE m2.user_id = u.id AND m2.company_id <> $1 AND m2.active = true) RETURNING u.id`, [companyId])).rows.length;
      deleted += (await uow.sql.query('UPDATE notification_preferences SET enabled = false WHERE company_id = $1 AND enabled = true RETURNING recipient_id', [companyId])).rows.length;
      const { rows } = await uow.sql.query(
        `SELECT (SELECT count(*)::int FROM app_records WHERE company_id = $1 AND value <> 'null'::jsonb)
              + (SELECT count(*)::int FROM audit_events WHERE company_id = $1)
              + (SELECT count(*)::int FROM master_versions WHERE company_id = $1)
              + (SELECT count(*)::int FROM privacy_requests WHERE company_id = $1) AS kept`, [companyId]);
      return { deletedRecords: deleted, retainedRecords: Number((rows[0] as { kept: number }).kept) };
    });
    // The maps mirror the database as the read path, so they are scrubbed here too; their
    // per-key tombstone writes join no open unit of work anymore and no-op against the rows
    // the statement above already tombstoned.
    scrubDurableRecords(companyId);
    return outcome;
  }
}

/** #352 — the account's data in memory: the same shape, over the live stores. */
export class MemoryAccountDataStore implements PrivacyDataStore {
  async exportSubject(companyId: string, subjectId: string): Promise<Readonly<Record<string, unknown>>> {
    if (subjectId !== companyId) return Object.freeze({ privacy: {} });
    return Object.freeze({ app: durableEntries(companyId), masters: allMasterRecords(companyId) });
  }

  async deleteSubject(companyId: string, subjectId: string): Promise<SubjectDeletionResult> {
    if (subjectId !== companyId) return { deletedRecords: 0, retainedRecords: 1 };
    return { deletedRecords: scrubDurableRecords(companyId), retainedRecords: Object.values(allMasterRecords(companyId)).reduce((total, rows) => total + rows.length, 0) };
  }
}

/** #352 — one backup is the account dump, sealed again by the recovery service. */
export class PostgresBackupSource implements BackupSource {
  readonly #db: TransactionalExecutor;
  readonly #encryption: AesGcmEncryptionService;
  constructor(db: TransactionalExecutor, encryption: AesGcmEncryptionService) { this.#db = db; this.#encryption = encryption; }
  async snapshot(companyId: string): Promise<Buffer> {
    return Buffer.from(JSON.stringify(await dumpAccount(this.#db, this.#encryption, companyId)));
  }
}

/**
 * #352 — where backup objects go while only local storage is wired: one file per object under
 * `APP_BACKUP_DIR` (decision 0013 keeps data in India — in production this is the object store
 * #341 places in BLR1, reached through the same port).
 */
export class LocalBackupObjectStore implements BackupObjectStore {
  readonly #dir: string;
  constructor(dir: string) { this.#dir = dir; }
  readonly #path = (key: string): string => join(this.#dir, `${key.replace(/[^0-9a-zA-Z_-]/g, '_')}.json`);
  async put(key: string, payload: EncryptedPayload): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    await writeFile(this.#path(key), JSON.stringify(payload));
  }
  async get(key: string): Promise<EncryptedPayload | undefined> {
    try { return JSON.parse(await readFile(this.#path(key), 'utf8')) as EncryptedPayload; }
    catch { return undefined; }
  }
  async delete(key: string): Promise<void> { await rm(this.#path(key), { force: true }); }
}
