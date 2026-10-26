/**
 * Issue #340 — where the running app keeps its books, decided once when the process starts.
 *
 * - `DATABASE_URL` set: PostgreSQL. Every store that has a PostgreSQL repository uses it, every
 *   write request runs as one unit of work (#363), and no demo data is ever written.
 * - `DATABASE_URL` not set: memory, with the synthetic demo companies. Only on a developer's machine
 *   or in a test: anywhere else the process refuses to start, so a shop's books can never quietly
 *   live in memory and vanish on the next restart.
 */
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertLeastPrivilege, createDatabase, type TransactionalExecutor } from '../../../packages/platform/src/database.ts';
import type { AesGcmEncryptionService } from '../../../ops/security/src/encryption.ts';
import type { PrivacyDataStore } from '../../../ops/security/src/privacy.ts';
import { InMemoryPrivacyStore, MemoryBackupRepository, type BackupRepository, type PrivacyStore } from '../../../ops/security/src/store.ts';
import { PostgresBackupRepository, PostgresPrivacyStore } from '../../../ops/security/src/postgres-store.ts';
import { appEncryption } from './field-encryption.ts';
import { LocalBackupObjectStore, MemoryAccountDataStore, PostgresAccountDataStore } from './privacy-application.ts';

/**
 * Issue #352 — the security stores the running app uses, decided with the rest of persistence:
 * on PostgreSQL the privacy register and the backup manifests are rows (#471's stores, finally
 * composed); in memory they are the in-memory ones. `accountData` is where export and deletion
 * actually find the account's data; `encryption` is the AES-256-GCM service whose keys come only
 * from `APP_ENCRYPTION_KEYS`, never the database or the repository.
 */
export interface SecurityStores {
  readonly encryption: AesGcmEncryptionService;
  readonly privacyRecords: PrivacyStore;
  readonly accountData: PrivacyDataStore;
  readonly backups: BackupRepository;
}

export type Persistence =
  | { readonly kind: 'memory'; security?: SecurityStores }
  | { readonly kind: 'postgres'; readonly db: TransactionalExecutor; security?: SecurityStores };

const LOCAL_ENVIRONMENTS = new Set(['', 'development', 'test']);
export const isLocal = (environment: string | undefined): boolean => LOCAL_ENVIRONMENTS.has((environment ?? '').trim().toLowerCase());

/** Chooses the persistence for this process from its environment. Throws instead of falling back. */
export async function openPersistence(env: NodeJS.ProcessEnv = process.env): Promise<Persistence> {
  const url = env.DATABASE_URL?.trim() ?? '';
  if (url === '') {
    if (!isLocal(env.NODE_ENV)) throw new Error('DATABASE_URL is not set. The server will not start without its database outside development.');
    return MEMORY;
  }
  const db = createDatabase(url);
  try {
    await db.query('SELECT 1');
    await assertLeastPrivilege(db, env.NODE_ENV);
  } catch (error) {
    await db.close();
    throw error;
  }
  const encryption = appEncryption(env);
  return {
    kind: 'postgres', db,
    security: {
      encryption,
      privacyRecords: new PostgresPrivacyStore(db),
      accountData: new PostgresAccountDataStore(db, encryption),
      backups: new PostgresBackupRepository(db, new LocalBackupObjectStore(env.APP_BACKUP_DIR?.trim() || join(tmpdir(), 'karobar-backups'))),
    },
  };
}

let memorySecurity: SecurityStores | null = null;
const memorySecurityStores = (): SecurityStores => memorySecurity ??= {
  encryption: appEncryption(process.env),
  privacyRecords: new InMemoryPrivacyStore(),
  accountData: new MemoryAccountDataStore(),
  backups: new MemoryBackupRepository(),
};

/**
 * The security stores for one persistence, filled in once when first asked for: a hand-made
 * `{ kind: 'postgres', db }` in a test gets the same composition the opened one got.
 */
export const securityOf = (persistence: Persistence): SecurityStores => {
  if (persistence.security !== undefined) return persistence.security;
  const stores: SecurityStores = persistence.kind === 'postgres'
    ? (() => {
      const encryption = appEncryption(process.env);
      return {
        encryption,
        privacyRecords: new PostgresPrivacyStore(persistence.db),
        accountData: new PostgresAccountDataStore(persistence.db, encryption),
        backups: new PostgresBackupRepository(persistence.db, new LocalBackupObjectStore(process.env.APP_BACKUP_DIR?.trim() || join(tmpdir(), 'karobar-backups'))),
      };
    })()
    : memorySecurityStores();
  persistence.security = stores;
  return stores;
};

export const MEMORY: Persistence = { kind: 'memory', get security() { return memorySecurityStores(); } };

/**
 * A fixed UUID for one of the app's own named records (an account code, the main godown), so the
 * same name always means the same row after a restart. The database keeps ids as UUIDs; memory
 * keeps the readable names the tests and the demo were written with.
 */
export const stableUuid = (...parts: readonly string[]): string => {
  const hex = createHash('sha256').update(parts.join('\u0000')).digest('hex');
  // Version 8 ("custom") and the RFC 9562 variant bits, so it is a well-formed UUID.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
};

/** The id a named record is stored under: its name in memory, a stable UUID in PostgreSQL. */
export const recordId = (persistence: Persistence, companyId: string, name: string): string =>
  persistence.kind === 'memory' ? name : stableUuid(companyId, name);
