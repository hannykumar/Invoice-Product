/**
 * Issue #340 — the app's own per-company stores, kept in PostgreSQL when the app has a database.
 *
 * Several screens keep what they know in a `Map` because no module has a table for it (business
 * details, branding, declared item rates, the frozen print copy of each bill). A `DurableMap` is
 * still that `Map` for every reader, synchronous as before. When the app has a database, each
 * `set` and `delete` is also written to `app_records` inside the request's unit of work, and a
 * company's rows are read back the first time the company is opened after a restart.
 *
 * Writes from a synchronous `set` cannot be awaited by the caller, so they are tracked here: the
 * action does not commit until they have landed (`asOneAction`), and when an action that wrote
 * fails, memory is thrown away and read back from the database (`forgetUnsavedWrites`), so memory
 * never keeps what the database refused.
 *
 * ponytail: memory stays the read path, so two API processes would not see each other's writes.
 * One process is the deployment today; the upgrade is a table per store, read directly.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalJson } from '../../../packages/platform/src/platform.ts';
import { reviveJson } from '../../../packages/platform/src/postgres-audit.ts';
import { PlatformError } from '../../../packages/platform/src/types.ts';
import type { SqlExecutor, TransactionalExecutor } from '../../../packages/platform/src/database.ts';
import { reportError } from '../../../packages/platform/src/error-reporting.ts';
import type { AesGcmEncryptionService } from '../../../ops/security/src/encryption.ts';
import { appRecordBoundTo, sealJson, unsealJson, APP_FIELD_KEY_ID } from './field-encryption.ts';

interface Durability {
  readonly db: TransactionalExecutor;
  /** Seals each record before it is stored (#352); null only in tests that never configured it. */
  readonly encryption: AesGcmEncryptionService | null;
  /** Companies whose records have been read back since the process started (or last forgot). */
  readonly loaded: Set<string>;
}

/** One action's writes: the action does not commit until they have all landed. */
interface Action {
  readonly pending: Promise<unknown>[];
  failed: { readonly error: unknown } | null;
}

let durability: Durability | null = null;
const action = new AsyncLocalStorage<Action>();
/** Reloaders, run for each loaded company after a failed action: master data registers one. */
const reloaders: ((companyId: string) => Promise<void>)[] = [];
const forgetters: ((companyId: string) => void)[] = [];

/** The database writes go to, or null in memory. */
export const durableDatabase = (): TransactionalExecutor | null => durability?.db ?? null;

/** The sealer every durable write goes through (#352), or null when none was configured. */
export const durableEncryption = (): AesGcmEncryptionService | null => durability?.encryption ?? null;

/** Called once at start-up, before any store is written. */
export const enableDurability = (db: TransactionalExecutor, encryption: AesGcmEncryptionService | null = null): void => {
  durability = { db, encryption, loaded: new Set() };
};

/**
 * Writes one record to PostgreSQL from synchronous code. Inside an action it joins the action's unit
 * of work and the action waits for it. Outside one (a screen that creates the walk-in customer the
 * first time it is read), the write is its own small unit of work; if it fails, memory is read back.
 */
export const persist = (companyId: string, write: (sql: SqlExecutor) => Promise<unknown>): void => {
  const db = durability?.db;
  if (db === undefined) return;
  const current = action.getStore();
  let sql: SqlExecutor | null = null;
  try { sql = db.requireUnitOfWork(companyId).sql; } catch (error) {
    // Another company's unit of work is open: that is a bug in the caller, and it is refused now.
    if (!(error instanceof PlatformError && error.code === 'NO_UNIT_OF_WORK')) throw error;
  }
  const written = sql === null ? db.unitOfWork(companyId, (uow) => write(uow.sql)) : write(sql);
  if (current !== undefined) {
    current.pending.push(written);
    written.catch((error: unknown) => { current.failed ??= { error }; });
    return;
  }
  // Not part of an action that waits for it: a failure is reported, and memory is read back.
  written.catch(async (error: unknown) => {
    reportError('api.durableWrite', error, { company: companyId });
    await forgetUnsavedWrites();
  });
};

/**
 * Issue #340 — one request that changes something is one business action: one unit of work (#363),
 * which commits only after every write started from synchronous code has landed. If it fails after
 * something was written to memory, memory is thrown away and read back, so it never keeps what the
 * database refused.
 */
export const asOneAction = async <T>(db: TransactionalExecutor, companyId: string, work: () => Promise<T>): Promise<T> => {
  const current: Action = { pending: [], failed: null };
  try {
    return await action.run(current, () => db.unitOfWork(companyId, async () => {
      const result = await work();
      await Promise.allSettled(current.pending);
      // The database's own error, so it is logged and answered like any other failed write.
      if (current.failed !== null) throw current.failed.error;
      return result;
    }));
  } catch (error) {
    if (current.pending.length > 0) await forgetUnsavedWrites();
    throw error;
  }
};

/**
 * A request that only reads. Issue #395: a GET writes nothing (`get-never-writes.test.ts`); should a
 * write slip in, the answer is still sent only once it has committed, so the next request can rely on it.
 */
export const asOneRead = async <T>(work: () => Promise<T>): Promise<T> => {
  if (durability === null) return work();
  const current: Action = { pending: [], failed: null };
  try {
    const result = await action.run(current, work);
    await Promise.allSettled(current.pending);
    if (current.failed !== null) throw current.failed.error;
    return result;
  } catch (error) {
    if (current.pending.length > 0) await forgetUnsavedWrites();
    throw error;
  }
};

/** Registers how a store reads one company back, and how it forgets it. */
export const onReload = (forget: (companyId: string) => void, reload: (companyId: string) => Promise<void>): void => {
  forgetters.push(forget);
  reloaders.push(reload);
};

/** Reads one company's app records back into memory, once per process. */
export const loadCompany = async (companyId: string): Promise<void> => {
  const current = durability;
  if (current === null || current.loaded.has(companyId)) return;
  for (const reload of reloaders) await reload(companyId);
  current.loaded.add(companyId);
};

/** After a failed write: memory forgets every loaded company and reads the database again. */
export const forgetUnsavedWrites = async (): Promise<void> => {
  const current = durability;
  if (current === null) return;
  const companies = [...current.loaded];
  current.loaded.clear();
  for (const companyId of companies) for (const forget of forgetters) forget(companyId);
  for (const companyId of companies) await loadCompany(companyId);
};

/** Every map by kind, held weakly: a map nobody uses any more is not kept alive by this list. */
const maps = new Map<string, Set<WeakRef<DurableMap<unknown>>>>();

/**
 * A `Map` whose entries also live in `app_records` under `kind`. `companyOf` names the company a
 * key belongs to. A `frozen` kind is a copy of an issued document: written once, never changed.
 */
export class DurableMap<V> extends Map<string, V> {
  readonly #kind: string;
  readonly #companyOf: (key: string) => string;
  readonly #frozen: boolean;
  /** Frozen maps hold copies of issued documents: never scrubbed (#352) — the database refuses them and the law keeps them. */
  readonly frozen: boolean;
  readonly #replayed: ((value: V, key: string) => void) | undefined;
  readonly #forgotten: ((companyId: string) => void) | undefined;
  #replaying = false;

  /**
   * `replayed` and `forgotten` let a store built on the map (the declared rates) follow it when a
   * company is read back after a restart, or forgotten after a failed request.
   */
  constructor(kind: string, companyOf: (key: string) => string, options: {
    readonly frozen?: boolean;
    readonly replayed?: (value: V, key: string) => void;
    readonly forgotten?: (companyId: string) => void;
  } = {}) {
    super();
    this.#kind = kind;
    this.#companyOf = companyOf;
    this.#frozen = options.frozen === true;
    this.frozen = this.#frozen;
    this.#replayed = options.replayed;
    this.#forgotten = options.forgotten;
    const same = maps.get(kind) ?? new Set();
    same.add(new WeakRef(this as DurableMap<unknown>));
    maps.set(kind, same);
  }

  override set(key: string, value: V): this {
    super.set(key, value);
    if (this.#replaying) return this;
    const companyId = this.#companyOf(key);
    persist(companyId, async (sql) => {
      // #352 — the stored value is sealed, so a dump of app_records never shows a bank number or a PAN.
      const stored = durability?.encryption === null || durability?.encryption === undefined
        ? canonicalJson(value)
        : canonicalJson(await sealJson(durability.encryption, APP_FIELD_KEY_ID, canonicalJson(value), appRecordBoundTo(companyId, this.#kind, key)));
      return sql.query(
        this.#frozen
          ? 'INSERT INTO app_records (company_id, kind, key, value, frozen) VALUES ($1, $2, $3, $4::jsonb, true) ON CONFLICT (company_id, kind, key) DO NOTHING'
          : `INSERT INTO app_records (company_id, kind, key, value) VALUES ($1, $2, $3, $4::jsonb)
             ON CONFLICT (company_id, kind, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [companyId, this.#kind, key, stored],
      );
    });
    return this;
  }

  override delete(key: string): boolean {
    const had = super.delete(key);
    if (this.#replaying || !had) return had;
    const companyId = this.#companyOf(key);
    // The application may not delete rows (#368): a removed record keeps its row, with null in it.
    persist(companyId, (sql) => sql.query("UPDATE app_records SET value = 'null'::jsonb, updated_at = now() WHERE company_id = $1 AND kind = $2 AND key = $3", [companyId, this.#kind, key]));
    return had;
  }

  /** Forgets one company's entries without touching the database. */
  forget(companyId: string): void {
    for (const key of [...this.keys()]) if (this.#companyOf(key) === companyId) super.delete(key);
    this.#forgotten?.(companyId);
  }

  /** Puts a row read from the database back into memory, without writing it again. */
  replay(key: string, value: V): void {
    this.#replaying = true;
    try { super.set(key, value); } finally { this.#replaying = false; }
    this.#replayed?.(value, key);
  }

  /** Whether this map holds this company's keys (one map per company, or one shared map). */
  holds(companyId: string, key: string): boolean { return this.#companyOf(key) === companyId; }
}

/** The maps of one kind still in use; the ones collected are dropped from the list. */
const live = (same: Set<WeakRef<DurableMap<unknown>>>): DurableMap<unknown>[] => {
  const found: DurableMap<unknown>[] = [];
  for (const ref of same) {
    const map = ref.deref();
    if (map === undefined) same.delete(ref);
    else found.push(map);
  }
  return found;
};

onReload(
  (companyId) => { for (const same of maps.values()) for (const map of live(same)) map.forget(companyId); },
  async (companyId) => {
    const db = durability?.db;
    if (db === undefined) return;
    const { rows } = await db.tenantTransaction(companyId, (sql) => sql.query(
      "SELECT kind, key, value FROM app_records WHERE company_id = $1 AND value <> 'null'::jsonb ORDER BY kind, key", [companyId]));
    for (const row of rows) {
      const kind = String(row.kind);
      const key = String(row.key);
      const opened = durability?.encryption === null || durability?.encryption === undefined
        ? row.value
        : await unsealJson(durability.encryption, row.value, appRecordBoundTo(companyId, kind, key));
      for (const map of live(maps.get(kind) ?? new Set())) {
        if (map.holds(companyId, key)) map.replay(key, reviveJson(opened));
      }
    }
  },
);

/** #352 — every entry every durable map holds for one company: the account export's memory side. */
export const durableEntries = (companyId: string): Record<string, Record<string, unknown>> => {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [kind, same] of maps) {
    for (const map of live(same)) {
      for (const [key, value] of map) {
        if (map.holds(companyId, key)) (out[kind] ??= {})[key] = value;
      }
    }
  }
  return out;
};

/**
 * #352 — removes everything the durable maps hold for one company: on the database each `delete`
 * writes the 'null' tombstone the no-delete role (#368) allows, in memory it just goes.
 */
export const scrubDurableRecords = (companyId: string): number => {
  let removed = 0;
  for (const same of maps.values()) {
    for (const map of live(same)) {
      // Frozen maps are issued-document copies: the database refuses their tombstone writes and
      // the law keeps them, so they are skipped, not deleted.
      if (map.frozen) continue;
      for (const key of [...map.keys()]) {
        if (map.holds(companyId, key) && map.delete(key)) removed += 1;
      }
    }
  }
  return removed;
};
