/**
 * Issue #363 — one business action, one database transaction. See
 * docs/decisions/0363-unit-of-work-and-outbox.md and docs/contracts/unit-of-work-v1.md.
 *
 * `unitOfWork` opens the transaction a command runs in. Everything called inside it for the same
 * company joins it: a nested `unitOfWork` under a savepoint, `query` and `tenantTransaction`
 * directly on its connection. So nothing inside a unit of work ever takes a second connection, and
 * a write repository (`requireUnitOfWork`) can never commit on its own.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { PlatformError } from "./types.ts";

export interface SqlExecutor { query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>; }

/** Work that must happen after commit and reach outside the database (IRN, e-way bill, messages). */
export interface OutboxMessageInput { topic: string; dedupeKey: string; payload: Record<string, unknown>; }

export interface UnitOfWork {
  readonly companyId: string;
  readonly sql: SqlExecutor;
  /** Written in this transaction: it commits with the action or disappears with it. A repeat is a no-op. */
  enqueue(message: OutboxMessageInput): Promise<void>;
}

export interface TransactionalExecutor extends SqlExecutor {
  transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T>;
  /** For reads. Joins the open unit of work for this company, otherwise a short transaction of its own. */
  tenantTransaction<T>(companyId: string, work: (executor: SqlExecutor) => Promise<T>): Promise<T>;
  /** Opens the action's transaction, or joins the open one for this company under a savepoint. */
  unitOfWork<T>(companyId: string, work: (uow: UnitOfWork) => Promise<T>): Promise<T>;
  /** For writes. Throws unless a unit of work is open for this company. */
  requireUnitOfWork(companyId: string): UnitOfWork;
  close(): Promise<void>;
}

interface Open { db: object; uow: UnitOfWork; closed: boolean; savepoints: number }
const current = new AsyncLocalStorage<Open>();
/** First key of the two-key advisory lock, so the company lock cannot collide with anyone else's. */
const COMPANY_WRITE_LOCK = 363;

/** Runs `work` as if no unit of work were open: the outbox relay must never join a caller's transaction. */
export const outsideUnitOfWork = <T>(work: () => T): T => current.exit(work);

const json = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item);

/** The local development database of `docker compose up db`. Never a fallback in production (issue #368). */
const LOCAL_DEVELOPMENT_URL = "postgresql://invoice:invoice@localhost:5432/invoice";

export function createDatabase(connectionString = process.env.DATABASE_URL): TransactionalExecutor {
  if (connectionString === undefined || connectionString.trim() === "") {
    // A production server with no database configured must stop, not quietly keep a shop's books in a developer database.
    if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is not set. The server will not start without its database in production.");
    connectionString = LOCAL_DEVELOPMENT_URL;
  }
  // A stuck pool or a held lock fails loudly instead of hanging (ADR 0363 §1).
  const pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 15_000, lock_timeout: 15_000 });
  const self = {};

  const openFor = (companyId: string | undefined): Open | undefined => {
    const open = current.getStore();
    if (open === undefined || open.closed || open.db !== self) return undefined;
    if (companyId !== undefined && open.uow.companyId !== companyId) {
      throw new PlatformError("TENANT_ISOLATION", "One action cannot touch two companies.");
    }
    return open;
  };

  const underSavepoint = async <T>(open: Open, work: () => Promise<T>): Promise<T> => {
    const name = `uow_${(open.savepoints += 1)}`;
    await open.uow.sql.query(`SAVEPOINT ${name}`);
    try {
      const result = await work();
      await open.uow.sql.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      try { await open.uow.sql.query(`ROLLBACK TO SAVEPOINT ${name}`); } catch { /* the original error is the one that matters */ }
      throw error;
    }
  };

  const run = async <T>(companyId: string | undefined, asUnit: boolean, work: (open: Open | undefined, sql: SqlExecutor) => Promise<T>): Promise<T> => {
    const client: PoolClient = await pool.connect();
    let finished = false;
    // One connection runs one statement at a time, so reads started together wait their turn.
    let queue: Promise<unknown> = Promise.resolve();
    const sql: SqlExecutor = {
      async query(text, values) {
        if (finished) throw new PlatformError("UNIT_OF_WORK_ABORTED", "This transaction has already finished, so its connection can no longer be used.");
        const result = queue.then(() => client.query(text, values as unknown[]));
        queue = result.catch(() => undefined);
        return result;
      },
    };
    let broken = false;
    try {
      await client.query("BEGIN");
      if (companyId !== undefined) await client.query("SELECT set_config('app.company_id', $1, true)", [companyId]);
      let result: T;
      if (asUnit) {
        // One write at a time per company, across every server process; released at commit or rollback.
        // ponytail: per-company lock; per-row locks in a fixed order (#367) if one company's write volume ever matters.
        await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [COMPANY_WRITE_LOCK, companyId]);
        const open: Open = {
          db: self, closed: false, savepoints: 0,
          uow: {
            companyId: companyId as string, sql,
            async enqueue(message) {
              await sql.query(
                `INSERT INTO outbox_messages (id, company_id, topic, dedupe_key, payload) VALUES ($1, $2, $3, $4, $5::jsonb)
                 ON CONFLICT (company_id, topic, dedupe_key) DO NOTHING`,
                [randomUUID(), companyId, message.topic, message.dedupeKey, json(message.payload)],
              );
            },
          },
        };
        try { result = await current.run(open, () => work(open, sql)); } finally { open.closed = true; }
      } else {
        result = await work(undefined, sql);
      }
      finished = true;
      // PostgreSQL answers COMMIT with ROLLBACK when an earlier statement failed and the error was swallowed.
      const commit = await client.query("COMMIT");
      if (commit.command !== "COMMIT") throw new PlatformError("UNIT_OF_WORK_ABORTED", "Nothing was saved: a step of this action failed part-way, so all of it was undone.");
      return result;
    } catch (error) {
      finished = true;
      try { await client.query("ROLLBACK"); } catch { broken = true; }
      throw error;
    } finally {
      // A connection whose rollback failed is discarded rather than handed to the next request.
      client.release(broken);
    }
  };

  return {
    query: (text, values) => {
      const open = openFor(undefined);
      return open === undefined ? pool.query(text, values as unknown[]) : open.uow.sql.query(text, values);
    },
    transaction: (work) => {
      const open = openFor(undefined);
      return open === undefined ? run(undefined, false, (_open, sql) => work(sql)) : underSavepoint(open, () => work(open.uow.sql));
    },
    tenantTransaction: (companyId, work) => {
      const open = openFor(companyId);
      return open === undefined ? run(companyId, false, (_open, sql) => work(sql)) : work(open.uow.sql);
    },
    unitOfWork: (companyId, work) => {
      const open = openFor(companyId);
      return open === undefined ? run(companyId, true, (opened) => work((opened as Open).uow)) : underSavepoint(open, () => work(open.uow));
    },
    requireUnitOfWork: (companyId) => {
      const open = openFor(companyId);
      if (open === undefined) throw new PlatformError("NO_UNIT_OF_WORK", "This change must run inside the action's transaction, so it is saved with the rest of it or not at all.");
      return open.uow;
    },
    close: () => pool.end(),
  };
}
