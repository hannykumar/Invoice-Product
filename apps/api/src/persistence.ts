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
import { assertLeastPrivilege, createDatabase, type TransactionalExecutor } from '../../../packages/platform/src/database.ts';

export type Persistence =
  | { readonly kind: 'memory' }
  | { readonly kind: 'postgres'; readonly db: TransactionalExecutor };

const LOCAL_ENVIRONMENTS = new Set(['', 'development', 'test']);
const isLocal = (environment: string | undefined): boolean => LOCAL_ENVIRONMENTS.has((environment ?? '').trim().toLowerCase());

/** Chooses the persistence for this process from its environment. Throws instead of falling back. */
export async function openPersistence(env: NodeJS.ProcessEnv = process.env): Promise<Persistence> {
  const url = env.DATABASE_URL?.trim() ?? '';
  if (url === '') {
    if (!isLocal(env.NODE_ENV)) throw new Error('DATABASE_URL is not set. The server will not start without its database outside development.');
    return { kind: 'memory' };
  }
  const db = createDatabase(url);
  try {
    await db.query('SELECT 1');
    await assertLeastPrivilege(db, env.NODE_ENV);
  } catch (error) {
    await db.close();
    throw error;
  }
  return { kind: 'postgres', db };
}

export const MEMORY: Persistence = { kind: 'memory' };

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
