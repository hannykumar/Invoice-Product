/**
 * Issue #352 — the one place field-level encryption keys and shapes are decided.
 *
 * What is sealed: every `app_records.value` (business details, bill prints, branding, prefill —
 * PAN, phone and email live there) and every `master_versions.data` the app appends (party PAN,
 * addresses, phones and bank account numbers live there). Sealed means AES-256-GCM from
 * `ops/security`; a database dump then shows ciphertext, never a plain bank number or PAN.
 *
 * Where keys come from: `APP_ENCRYPTION_KEYS`, a comma list of `keyId:base64` 32-byte keys —
 * a provider, never the database and never this repository. On a developer's machine or in a
 * test (the same places `isLocal` already allows memory and the demo sign-in) a fixed,
 * well-known key stands in so nothing else has to be set up; anywhere else a missing or
 * malformed variable fails closed at the first seal, like DATABASE_URL does.
 *
 * Rotation: every sealed value names its `keyId`; several keys can be configured at once and old
 * rows still open. The newest key in the list is the write key.
 *
 * Bound ciphertext: every value is sealed with the company and the record it belongs to as
 * authenticated data, so a ciphertext copied into another company or another row does not open.
 */
import { createHash } from 'node:crypto';
import { AesGcmEncryptionService, type EncryptedPayload, type EncryptionKeyProvider } from '../../../ops/security/src/encryption.ts';
import { registerSecretValues } from '../../../packages/platform/src/credentials.ts';
import { PlatformError } from '../../../packages/platform/src/types.ts';
import type { TransactionalExecutor } from '../../../packages/platform/src/database.ts';

/** Same local-only environments `persistence.ts` allows (kept here so this file never imports it). */
const isLocalEnvironment = (environment: string | undefined): boolean =>
  new Set(['', 'development', 'test']).has((environment ?? '').trim().toLowerCase());

/** The write key for app fields; older keys stay configured only to open old rows. */
export const APP_FIELD_KEY_ID = 'app-field-v1';
/** The write key for backups; a different key so a field key alone never opens a backup. */
export const APP_BACKUP_KEY_ID = 'app-backup-v1';

/**
 * The development stand-in key, named so nobody mistakes it for a real one. 32 bytes derived
 * from a public constant — it keeps dumps honest on a laptop, nothing more.
 */
const DEVELOPMENT_KEY = createHash('sha256').update('karobar-development-field-key').digest();

class EnvironmentKeyProvider implements EncryptionKeyProvider {
  readonly #keys: ReadonlyMap<string, Buffer>;
  constructor(keys: ReadonlyMap<string, Buffer>) { this.#keys = keys; }
  async key(keyId: string): Promise<Buffer> {
    const key = this.#keys.get(keyId);
    if (key === undefined) {
      throw new PlatformError('TRY_AGAIN', 'The encryption key this data was sealed with is not configured, so it cannot be opened.');
    }
    return key;
  }
}

const parseKeys = (env: NodeJS.ProcessEnv): Map<string, Buffer> => {
  const raw = env.APP_ENCRYPTION_KEYS?.trim() ?? '';
  const keys = new Map<string, Buffer>();
  if (raw !== '') {
    for (const entry of raw.split(',')) {
      const [keyId, encoded] = entry.trim().split(':');
      const bytes = Buffer.from(encoded ?? '', 'base64');
      if (!keyId || bytes.length !== 32) {
        throw new Error('APP_ENCRYPTION_KEYS must be keyId:base64 pairs of 32-byte keys.');
      }
      keys.set(keyId.trim(), bytes);
    }
    return keys;
  }
  if (isLocalEnvironment(env.NODE_ENV)) {
    keys.set(APP_FIELD_KEY_ID, DEVELOPMENT_KEY);
    keys.set(APP_BACKUP_KEY_ID, DEVELOPMENT_KEY);
    return keys;
  }
  throw new Error('APP_ENCRYPTION_KEYS is not set. The server cannot protect customer data without its keys.');
};

/**
 * The app's encryption service, built once per process. The key material is also registered as
 * secret so no log line can ever print it.
 */
export const appEncryption = (env: NodeJS.ProcessEnv = process.env): AesGcmEncryptionService => {
  const keys = parseKeys(env);
  registerSecretValues([...keys.values()].map((key) => key.toString('base64')));
  return new AesGcmEncryptionService(new EnvironmentKeyProvider(keys));
};

/** What a sealed value looks like in a `jsonb` column. */
export const isEncryptedPayload = (value: unknown): value is EncryptedPayload =>
  typeof value === 'object' && value !== null
  && (value as EncryptedPayload).algorithm === 'aes-256-gcm'
  && typeof (value as EncryptedPayload).keyId === 'string'
  && typeof (value as EncryptedPayload).iv === 'string'
  && typeof (value as EncryptedPayload).authenticationTag === 'string'
  && typeof (value as EncryptedPayload).ciphertext === 'string';

/** Seals a canonical-JSON string into the payload stored in a `jsonb` column. */
export const sealJson = async (encryption: AesGcmEncryptionService, keyId: string, plaintextJson: string, boundTo: string): Promise<EncryptedPayload> =>
  encryption.encrypt(Buffer.from(plaintextJson, 'utf8'), keyId, boundTo);

/**
 * Opens a stored value: a sealed payload is decrypted back into its value, anything else is
 * returned as it was — so rows written before encryption existed still load.
 */
export const unsealJson = async (encryption: AesGcmEncryptionService, stored: unknown, boundTo: string): Promise<unknown> => {
  if (!isEncryptedPayload(stored)) return stored;
  return JSON.parse((await encryption.decrypt(stored, boundTo)).toString('utf8'));
};

/** The authenticated-data string for one `app_records` row. */
export const appRecordBoundTo = (companyId: string, kind: string, key: string): string => `app-records/${companyId}/${kind}/${key}`;
/** The authenticated-data string for one `master_versions` row. */
export const masterVersionBoundTo = (companyId: string, kind: string): string => `master-versions/${companyId}/${kind}`;

/**
 * A master row is stored as its ids plus one sealed field: the versioned store needs `id` and
 * `companyId` to write its row, and everything else — PAN, addresses, phones, bank accounts —
 * goes into `__sealed`.
 */
export const sealMasterData = async <T extends { readonly id: string; readonly companyId: string }>(
  encryption: AesGcmEncryptionService, data: T, boundTo: string,
): Promise<{ readonly id: string; readonly companyId: string; readonly __sealed: EncryptedPayload }> => {
  const { id, companyId, ...rest } = data;
  return { id, companyId, __sealed: await sealJson(encryption, APP_FIELD_KEY_ID, JSON.stringify(rest), boundTo) };
};

/** Opens a stored master row: the sealed part is decrypted and merged back over the ids. */
export const unsealMasterData = async <T>(encryption: AesGcmEncryptionService, stored: unknown, boundTo: string): Promise<T> => {
  if (typeof stored !== 'object' || stored === null || !isEncryptedPayload((stored as { __sealed?: unknown }).__sealed)) return stored as T;
  const { __sealed, ...ids } = stored as { __sealed: EncryptedPayload } & Record<string, unknown>;
  return { ...ids, ...JSON.parse((await encryption.decrypt(__sealed, boundTo)).toString('utf8')) } as T;
};

/**
 * Boot-time sweep for databases written before encryption existed: every `app_records` row still
 * holding plaintext is sealed in place. Frozen rows are left alone — the database refuses to
 * change them by design (#368); bills printed after this change are sealed when they are
 * written. Runs once, inside each company's own unit of work, before the server opens.
 */
export const sealStoredAppRecords = async (db: TransactionalExecutor, encryption: AesGcmEncryptionService): Promise<void> => {
  const { rows: companies } = await db.query('SELECT id FROM companies');
  for (const company of companies) {
    const companyId = String(company.id);
    await db.unitOfWork(companyId, async (uow) => {
      const { rows } = await uow.sql.query(
        "SELECT kind, key, value FROM app_records WHERE company_id = $1 AND frozen = false AND value <> 'null'::jsonb", [companyId]);
      for (const row of rows) {
        if (isEncryptedPayload(row.value)) continue;
        const kind = String(row.kind); const key = String(row.key);
        const sealed = await sealJson(encryption, APP_FIELD_KEY_ID, JSON.stringify(row.value), appRecordBoundTo(companyId, kind, key));
        await uow.sql.query('UPDATE app_records SET value = $4::jsonb, updated_at = now() WHERE company_id = $1 AND kind = $2 AND key = $3', [companyId, kind, key, JSON.stringify(sealed)]);
      }
    });
  }
};
