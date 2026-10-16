/**
 * Issue #366 — master data in PostgreSQL (`master_records`, `master_versions`,
 * `master_command_records`, `units_of_measure`, `unit_conversions`).
 *
 * Each class mirrors its in-memory twin method for method, returning promises:
 * `PostgresVersionedStore` is `VersionedStore`, `PostgresCommandRecordIndex` is `CommandRecordIndex`
 * and `PostgresUnitRegistry` is `UnitRegistry`. `test/masters-store-contract.ts` runs one suite
 * against both. Every write runs in the unit of work the command handler opened (#363): a new
 * version of a party commits with its command record and its audit event, or not at all. Nothing
 * here opens a transaction of its own.
 */
import { randomUUID } from "node:crypto";
import type { SqlExecutor, TransactionalExecutor } from "../../platform/src/database.ts";
import { canonicalJson } from "../../platform/src/platform.ts";
import { reviveJson } from "../../platform/src/postgres-audit.ts";
import { PlatformError } from "../../platform/src/types.ts";
import { isIsoDate, pageOf, today } from "./effective.ts";
import type { CommandRecordStore, Page, Version, VersionStore } from "./effective.ts";
import { MasterDataError } from "./masters.ts";
import type { Id, IsoDate, MasterKind } from "./types.ts";
import { UnitRegistry, createDefaultUnitRegistry } from "./units.ts";
import type { Quantity, UnitConversion, UnitOfMeasure, UnitStore } from "./units.ts";

type Row = Record<string, unknown>;
/** The kinds `master_records.kind` allows: the eleven a document can reference, and two that only the service reads. */
export type StoredMasterKind = MasterKind | "opening_stock" | "price_list_entry";

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const codeOf = (error: unknown): string | undefined => (error as { code?: string }).code;
const limitOf = (page: Page | undefined): number | null => (page === undefined ? null : page.limit);

const VERSION = "v.record_id, v.version, v.company_id, v.effective_from::text AS effective_from, v.data, v.recorded_by, v.recorded_at, v.reason";
/** The versions of one company's records of one kind. The join is what keeps a party's id from answering as an item. */
const VERSIONS_OF_KIND = "master_versions v JOIN master_records r ON r.company_id = v.company_id AND r.id = v.record_id WHERE v.company_id = $1 AND r.kind = $2";

export class PostgresVersionedStore<T extends { readonly id: Id; readonly companyId: Id }> implements VersionStore<T> {
  readonly #db: TransactionalExecutor;
  readonly #kind: StoredMasterKind;
  constructor(db: TransactionalExecutor, kind: StoredMasterKind) { this.#db = db; this.#kind = kind; }

  #version(r: Row): Version<T> {
    return Object.freeze({
      recordId: String(r.record_id), companyId: String(r.company_id), version: Number(r.version), effectiveFrom: String(r.effective_from),
      data: Object.freeze(reviveJson<T>(r.data)), recordedAt: (r.recorded_at as Date).toISOString(), recordedBy: String(r.recorded_by),
      ...(r.reason === null ? {} : { reason: String(r.reason) }),
    });
  }

  /** Records a new version. Back-dating is allowed and slots into the timeline. */
  async append(data: T, effectiveFrom: IsoDate, recordedBy: Id, reason?: string): Promise<Version<T>> {
    if (!isIsoDate(effectiveFrom)) throw new PlatformError("INVALID_TRANSITION", `"${effectiveFrom}" is not a date in YYYY-MM-DD form.`);
    const { sql } = this.#db.requireUnitOfWork(data.companyId);
    // The database keeps ids as UUIDs. Refused before any statement, so the action's transaction is not spoiled.
    if (!UUID.test(data.id)) throw new MasterDataError("VALIDATION_FAILED", "This record's reference is not one the database can keep.");
    try {
      await sql.query("INSERT INTO master_records (id, company_id, kind) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING", [data.id, data.companyId, this.#kind]);
      // Numbered in the order recorded. The unit of work holds the company's write lock, so two appends never read the same maximum.
      const { rows } = await sql.query(
        `WITH v AS (
           INSERT INTO master_versions (record_id, version, company_id, effective_from, data, recorded_by, recorded_at, reason)
           SELECT r.id, COALESCE((SELECT max(p.version) FROM master_versions p WHERE p.company_id = r.company_id AND p.record_id = r.id), 0) + 1,
                  r.company_id, $4::date, $5::jsonb, $6, clock_timestamp(), $7
             FROM master_records r WHERE r.company_id = $1 AND r.id = $3 AND r.kind = $2
           RETURNING record_id, version, company_id, effective_from, data, recorded_by, recorded_at, reason)
         SELECT ${VERSION} FROM v`,
        [data.companyId, this.#kind, data.id, effectiveFrom, canonicalJson(data), recordedBy, reason ?? null],
      );
      if (rows[0] !== undefined) return this.#version(rows[0]);
      const other = await sql.query("SELECT kind FROM master_records WHERE company_id = $1 AND id = $2", [data.companyId, data.id]);
      if (other.rows[0] !== undefined) throw new MasterDataError("CONFLICT", "This reference is already used by a different kind of record.");
      // The id exists but this company cannot see it: it is another company's record.
      throw new PlatformError("TENANT_ISOLATION", "This record belongs to another company.");
    } catch (error) {
      if (codeOf(error) === "22008" || codeOf(error) === "22007") throw new PlatformError("INVALID_TRANSITION", `"${effectiveFrom}" is not a date in YYYY-MM-DD form.`);
      if (codeOf(error) === "23505") throw new MasterDataError("CONFLICT", "Someone else changed this record at the same moment. Please try again.");
      throw error;
    }
  }

  /** Every version of one record, oldest recorded first. */
  history(companyId: Id, id: Id, page?: Page): Promise<readonly Version<T>[]> {
    return this.#versions(companyId, id, "AND v.version > $4 ORDER BY v.version LIMIT $5", [page?.after === undefined ? 0 : Number(page.after), limitOf(page)]);
  }

  /** The version in force on `asOf`, or null when the record did not exist yet. */
  async asOf(companyId: Id, id: Id, asOf: IsoDate): Promise<Version<T> | null> {
    // Latest effective date wins; a later-recorded correction wins a tie.
    return (await this.#versions(companyId, id, "AND v.effective_from <= $4::date ORDER BY v.effective_from DESC, v.version DESC LIMIT 1", [asOf]))[0] ?? null;
  }

  /** The most recently recorded version, regardless of its effective date. */
  async latest(companyId: Id, id: Id): Promise<Version<T> | null> {
    return (await this.#versions(companyId, id, "ORDER BY v.version DESC LIMIT 1", []))[0] ?? null;
  }

  async current(companyId: Id, id: Id, asOf: IsoDate = today()): Promise<T | null> {
    return (await this.asOf(companyId, id, asOf))?.data ?? null;
  }

  /** Every record of this kind that exists as of a date, for one company. */
  async list(companyId: Id, asOf: IsoDate = today(), page?: Page): Promise<readonly T[]> {
    // One statement for every record: the version in force is picked per record by the as-of index
    // (company_id, record_id, effective_from DESC, version DESC), never by a query per record.
    const { rows } = await this.#db.tenantTransaction(companyId, (sql) => sql.query(
      `SELECT v.data FROM master_records r
         JOIN LATERAL (SELECT p.data FROM master_versions p
                        WHERE p.company_id = r.company_id AND p.record_id = r.id AND p.effective_from <= $3::date
                        ORDER BY p.effective_from DESC, p.version DESC LIMIT 1) v ON true
        WHERE r.company_id = $1 AND r.kind = $2 AND ($4::uuid IS NULL OR r.id > $4::uuid)
        ORDER BY ${page === undefined ? "r.seq" : "r.id"} LIMIT $5`,
      [companyId, this.#kind, asOf, page?.after ?? null, limitOf(page)],
    ));
    return rows.map((r) => Object.freeze(reviveJson<T>(r.data)));
  }

  async size(companyId: Id): Promise<number> {
    // Every record has at least one version, so the records of this kind are the count.
    const { rows } = await this.#db.tenantTransaction(companyId, (sql) => sql.query("SELECT count(*)::int AS n FROM master_records WHERE company_id = $1 AND kind = $2", [companyId, this.#kind]));
    return Number(rows[0]?.n);
  }

  /** An id that is not a UUID cannot be in the table, so it is "no such record" rather than a database error. */
  async #versions(companyId: Id, id: Id, rest: string, values: readonly unknown[]): Promise<Version<T>[]> {
    if (!UUID.test(id)) return [];
    const { rows } = await this.#db.tenantTransaction(companyId, (sql) => sql.query(`SELECT ${VERSION} FROM ${VERSIONS_OF_KIND} AND v.record_id = $3 ${rest}`, [companyId, this.#kind, id, ...values]));
    return rows.map((r) => this.#version(r));
  }
}

export class PostgresCommandRecordIndex implements CommandRecordStore {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  async set(companyId: Id, commandId: Id, recordId: Id): Promise<void> {
    const { sql } = this.#db.requireUnitOfWork(companyId);
    try {
      const { rows } = await sql.query(
        `INSERT INTO master_command_records (company_id, command_id, record_id) VALUES ($1, $2, $3)
         ON CONFLICT (company_id, command_id) DO NOTHING RETURNING command_id`,
        [companyId, commandId, recordId],
      );
      if (rows[0] !== undefined) return;
      // Said twice is fine. A command that already wrote a different record is not: the row is final.
      const existing = await this.#find(sql, companyId, commandId);
      if (existing !== recordId) throw new MasterDataError("CONFLICT", "This change has already been saved against a different record.");
    } catch (error) {
      if (codeOf(error) === "23503") throw new MasterDataError("NOT_FOUND", "The record or the command this change belongs to was not found.");
      throw error;
    }
  }

  get(companyId: Id, commandId: Id): Promise<Id | undefined> {
    return this.#db.tenantTransaction(companyId, (sql) => this.#find(sql, companyId, commandId));
  }

  async #find(sql: SqlExecutor, companyId: Id, commandId: Id): Promise<Id | undefined> {
    if (!UUID.test(commandId)) return undefined;
    const { rows } = await sql.query("SELECT record_id FROM master_command_records WHERE company_id = $1 AND command_id = $2", [companyId, commandId]);
    return rows[0] === undefined ? undefined : String(rows[0].record_id);
  }
}

/**
 * One company's units and conversions. The day-one units live in code (`createDefaultUnitRegistry`);
 * the tables hold what this company added or changed on top of them.
 *
 * ponytail: every call reads the company's units and conversions (two small queries) and answers
 * from an in-memory `UnitRegistry`, so the conversion rules exist once. Cache per request if a
 * bill with hundreds of lines ever makes that show up.
 */
export class PostgresUnitRegistry implements UnitStore {
  readonly #db: TransactionalExecutor;
  readonly #companyId: Id;
  readonly #base: () => UnitRegistry;
  constructor(db: TransactionalExecutor, companyId: Id, base: () => UnitRegistry = createDefaultUnitRegistry) { this.#db = db; this.#companyId = companyId; this.#base = base; }

  #load(): Promise<UnitRegistry> {
    return this.#db.tenantTransaction(this.#companyId, async (sql) => {
      const registry = this.#base();
      const units = await sql.query("SELECT code, name, display_decimals, uqc FROM units_of_measure WHERE company_id = $1 ORDER BY seq", [this.#companyId]);
      for (const r of units.rows) registry.registerUnit({ code: String(r.code), name: String(r.name), displayDecimals: Number(r.display_decimals), ...(r.uqc === null ? {} : { uqc: String(r.uqc) }) });
      const conversions = await sql.query(
        "SELECT item_id, from_unit, to_unit, numerator::text AS numerator, denominator::text AS denominator FROM unit_conversions WHERE company_id = $1 ORDER BY seq",
        [this.#companyId],
      );
      for (const r of conversions.rows) {
        registry.registerConversion({ fromUnit: String(r.from_unit), toUnit: String(r.to_unit), numerator: BigInt(String(r.numerator)), denominator: BigInt(String(r.denominator)), ...(r.item_id === null ? {} : { itemId: String(r.item_id) }) });
      }
      return registry;
    });
  }

  async registerUnit(unit: UnitOfMeasure): Promise<void> {
    await this.#db.requireUnitOfWork(this.#companyId).sql.query(
      `INSERT INTO units_of_measure (company_id, code, name, display_decimals, uqc) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id, code) DO UPDATE SET name = EXCLUDED.name, display_decimals = EXCLUDED.display_decimals, uqc = EXCLUDED.uqc`,
      [this.#companyId, unit.code.toUpperCase(), unit.name, unit.displayDecimals, unit.uqc ?? null],
    );
  }

  async unit(code: string): Promise<UnitOfMeasure> { return (await this.#load()).unit(code); }

  async units(page?: Page): Promise<readonly UnitOfMeasure[]> {
    const all = (await this.#load()).units();
    return page === undefined ? all : pageOf([...all].sort((left, right) => (left.code < right.code ? -1 : 1)), (unit) => unit.code, page);
  }

  async registerConversion(conversion: UnitConversion): Promise<void> {
    const { sql } = this.#db.requireUnitOfWork(this.#companyId);
    // The same refusals as in memory (unknown unit, a ratio that is not positive), before anything is written.
    (await this.#load()).registerConversion(conversion);
    if (conversion.itemId !== undefined && !UUID.test(conversion.itemId)) throw new MasterDataError("NOT_FOUND", "That item was not found.");
    // One row per pair of units, whichever way round it was said, so saying it again replaces it as it does in memory.
    const [from, to] = [conversion.fromUnit.toUpperCase(), conversion.toUnit.toUpperCase()];
    const [first, second, numerator, denominator] = from <= to ? [from, to, conversion.numerator, conversion.denominator] : [to, from, conversion.denominator, conversion.numerator];
    try {
      await sql.query(
        `INSERT INTO unit_conversions (id, company_id, item_id, from_unit, to_unit, numerator, denominator) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (company_id, COALESCE(item_id, '00000000-0000-0000-0000-000000000000'::uuid), from_unit, to_unit)
         DO UPDATE SET numerator = EXCLUDED.numerator, denominator = EXCLUDED.denominator`,
        [randomUUID(), this.#companyId, conversion.itemId ?? null, first, second, numerator.toString(), denominator.toString()],
      );
    } catch (error) {
      if (codeOf(error) === "23503") throw new MasterDataError("NOT_FOUND", "That item was not found.");
      throw error;
    }
  }

  async factor(from: string, to: string, itemId?: string): Promise<{ numerator: bigint; denominator: bigint } | null> { return (await this.#load()).factor(from, to, itemId); }
  async convert(value: Quantity, toUnit: string, itemId?: string): Promise<{ quantity: Quantity; exact: boolean }> { return (await this.#load()).convert(value, toUnit, itemId); }
  async convertExact(value: Quantity, toUnit: string, itemId?: string): Promise<Quantity> { return (await this.#load()).convertExact(value, toUnit, itemId); }
}
