/**
 * Issue #366 — this lane's records in PostgreSQL: e-way bills and trip sheets (#27), vehicle checks
 * (#28), vehicle-record readings and consent (#29), and the three per-company policies.
 *
 * Each class implements the same port as its in-memory twin and behaves the same. They are built
 * on the transaction executor and never open a transaction of their own: every write joins the
 * action's unit of work (`requireUnitOfWork`, which throws `NO_UNIT_OF_WORK` when none is open),
 * every read runs in `tenantTransaction`, and every query names its company as well as relying on
 * row-level security. Contracts: docs/contracts/unit-of-work-v1.md, database-immutability-v1.md.
 */
import type { TransactionalExecutor, SqlExecutor } from "../../platform/src/database.ts";
import type { CompanyId } from "@invoice/kernel";
import type { Id, IsoDate } from "../../masters/src/types.ts";
import { DUPLICATES, type ConsolidatedTripRepository, type EwayBillPolicyPort, type EwayBillRepository, type Page } from "./ports.ts";
import { DEFAULT_EWAY_BILL_POLICY } from "./types.ts";
import type { ConsolidatedTripRecord, EwayBillAcknowledgement, EwayBillPolicy, EwayBillRecord } from "./types.ts";
import { readPortalTimestamp, normaliseVehicleNumber } from "./validity.ts";
import { DEFAULT_VEHICLE_SUITABILITY_POLICY } from "./suitability-types.ts";
import type { SuitabilityOverride, VehicleEvidence, VehicleSuitabilityAssessment, VehicleSuitabilityPolicy } from "./suitability-types.ts";
import type { SuitabilityRepository, VehicleSuitabilityPolicyPort } from "./suitability-ports.ts";
import { carriesEvery } from "./suitability-adapters.ts";
import { DEFAULT_VEHICLE_RECORD_FRESHNESS } from "./vehicle-record-types.ts";
import type { VehicleLookupPurpose, VehicleRecordConsent, VehicleRecordFreshnessPolicy, VehicleRecordSnapshot } from "./vehicle-record-types.ts";
import type { VehicleRecordCacheRepository, VehicleRecordConsentPort, VehicleRecordFreshnessPort } from "./vehicle-record-ports.ts";

type Row = Record<string, unknown>;

// ------------------------------------------------------------------------------- helpers

/** jsonb with bigint kept exact: `{ "$bigint": "5000001" }` on the way in, a bigint on the way out. */
const json = (value: unknown): string | null => value === undefined || value === null
  ? null
  : JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? { $bigint: item.toString() } : item));
const revive = (value: unknown): unknown => JSON.parse(JSON.stringify(value), (_key, item: unknown) =>
  item !== null && typeof item === "object" && "$bigint" in item ? BigInt((item as { $bigint: string }).$bigint) : item);

/** `{ key: as(value) }`, or nothing at all when the column is null: the records use absent, never undefined. */
const opt = <K extends string, T>(key: K, value: unknown, as: (raw: unknown) => T): Partial<Record<K, T>> =>
  (value === null || value === undefined ? {} : { [key]: as(value) }) as Partial<Record<K, T>>;
const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));
const text = (value: unknown): string => String(value);

/**
 * An instant for a timestamptz column. The clock's ISO strings round-trip exactly; a time written in
 * the portal's own shape ("15/09/2026 11:59:00 PM", Indian time) is stored as the same instant and
 * comes back in ISO form.
 */
const instant = (raw: string | undefined): string | null => {
  if (raw === undefined) return null;
  const at = readPortalTimestamp(raw);
  if (Number.isNaN(at.getTime())) throw new Error(`"${raw}" is not a time we can read.`);
  return at.toISOString();
};

/** Runs a write and turns PostgreSQL's "already there" into the store's own duplicate error. */
const unique = async <T>(work: () => Promise<T>, duplicate: () => Error): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw duplicate();
    throw error;
  }
};

/** Keyset paging for tables that keep the order rows were written in (`seq`). `n` is the first free placeholder. */
const seqPage = (table: string, alias: string, n: number): string =>
  `AND ($${n}::uuid IS NULL OR ${alias}.seq > (SELECT p.seq FROM ${table} p WHERE p.company_id = $1 AND p.id = $${n}::uuid))
   ORDER BY ${alias}.seq LIMIT $${n + 1}::int`;
const pageValues = (page?: Page): unknown[] => [page?.after ?? null, page?.limit ?? null];

/** Effective-dated policy: the newest one in force on the day, or the product's default. */
const policyRow = (db: TransactionalExecutor, table: string, columns: string, companyId: string, on: IsoDate): Promise<Row | undefined> =>
  db.tenantTransaction(companyId, async (sql) => (await sql.query(
    `SELECT effective_from::text AS effective_from, ${columns} FROM ${table}
      WHERE company_id = $1 AND effective_from <= $2::date ORDER BY effective_from DESC LIMIT 1`, [companyId, on])).rows[0]);

// ------------------------------------------------------------------- e-way bills (#27)

/** Column, and its cast, in the order the values are built. */
const BILL: readonly (readonly [string, string])[] = [
  ["company_id", ""], ["id", ""], ["movement_id", ""], ["document_number", ""], ["document_date", "::date"], ["status", ""],
  ["applicability", "::jsonb"], ["consignment_value_paise", "::bigint"], ["from_state_code", ""], ["to_state_code", ""],
  ["distance_km", "::int"], ["from_pincode", ""], ["to_pincode", ""], ["eway_bill_number", ""], ["generated_at", ""],
  ["valid_until", "::timestamptz"], ["provider_request_id", ""], ["alert", ""], ["vehicle_legs", "::jsonb"], ["transporter", "::jsonb"],
  ["consolidated_trip_number", ""], ["failure_code", ""], ["failure_message", ""], ["failure_retryable", "::boolean"],
  ["cancellable_until", "::timestamptz"], ["cancelled_at", "::timestamptz"], ["cancel_reason_code", ""], ["cancel_reason", ""],
  ["rejected_at", "::timestamptz"], ["reject_reason_code", ""], ["message", ""], ["created_by", ""], ["created_at", "::timestamptz"],
  ["updated_at", "::timestamptz"], ["idempotency_key", ""],
];

const billValues = (r: EwayBillRecord): unknown[] => {
  const ack = r.acknowledgement;
  return [
    r.companyId, r.id, r.movementId, r.documentNumber, r.documentDate, r.status,
    json(r.applicability), r.consignmentValuePaise.toString(), r.fromStateCode, r.toStateCode,
    r.distanceKm ?? null, r.fromPincode ?? null, r.toPincode ?? null, ack?.ewayBillNumber ?? null, ack?.generatedAt ?? null,
    // The portal's own words are kept verbatim in eway_bill_acknowledgements; these copies serve the table's checks and indexes.
    instant(ack?.validUntil), ack?.providerRequestId ?? null, ack?.alert ?? null, json(r.vehicleLegs), json(r.transporter),
    r.consolidatedTripNumber ?? null, r.failure?.code ?? null, r.failure?.message ?? null, r.failure?.retryable ?? null,
    instant(r.cancellableUntil), instant(r.cancelledAt), r.cancelReasonCode ?? null, r.cancelReason ?? null,
    instant(r.rejectedAt), r.rejectReasonCode ?? null, r.message, r.createdBy, instant(r.createdAt),
    instant(r.updatedAt), r.idempotencyKey,
  ];
};

const BILL_SELECT = `b.id, b.company_id, b.movement_id, b.document_number, b.document_date::text AS document_date, b.status, b.applicability,
  b.consignment_value_paise::text AS consignment_value_paise, b.from_state_code, b.to_state_code, b.distance_km, b.from_pincode, b.to_pincode,
  b.vehicle_legs, b.transporter, b.consolidated_trip_number, b.failure_code, b.failure_message, b.failure_retryable, b.cancellable_until,
  b.cancelled_at, b.cancel_reason_code, b.cancel_reason, b.rejected_at, b.reject_reason_code, b.message, b.created_by, b.created_at,
  b.updated_at, b.idempotency_key,
  (SELECT a.acknowledgement FROM eway_bill_acknowledgements a WHERE a.company_id = b.company_id AND a.eway_bill_id = b.id
    ORDER BY a.seq DESC LIMIT 1) AS acknowledgement`;

const toBill = (r: Row): EwayBillRecord => ({
  id: text(r.id), companyId: text(r.company_id), movementId: text(r.movement_id), documentNumber: text(r.document_number),
  documentDate: text(r.document_date), status: r.status as EwayBillRecord["status"],
  applicability: revive(r.applicability) as EwayBillRecord["applicability"],
  consignmentValuePaise: BigInt(String(r.consignment_value_paise)), fromStateCode: text(r.from_state_code), toStateCode: text(r.to_state_code),
  ...opt("distanceKm", r.distance_km, Number), ...opt("fromPincode", r.from_pincode, text), ...opt("toPincode", r.to_pincode, text),
  ...opt("acknowledgement", r.acknowledgement, (raw) => raw as EwayBillAcknowledgement),
  vehicleLegs: r.vehicle_legs as EwayBillRecord["vehicleLegs"],
  ...opt("transporter", r.transporter, (raw) => raw as NonNullable<EwayBillRecord["transporter"]>),
  ...opt("consolidatedTripNumber", r.consolidated_trip_number, text),
  message: text(r.message),
  ...(r.failure_code === null ? {} : { failure: { code: text(r.failure_code), message: text(r.failure_message), retryable: r.failure_retryable === true } }),
  ...opt("cancellableUntil", r.cancellable_until, iso), ...opt("cancelledAt", r.cancelled_at, iso),
  ...opt("cancelReasonCode", r.cancel_reason_code, (raw) => raw as NonNullable<EwayBillRecord["cancelReasonCode"]>),
  ...opt("cancelReason", r.cancel_reason, text), ...opt("rejectedAt", r.rejected_at, iso),
  ...opt("rejectReasonCode", r.reject_reason_code, (raw) => raw as NonNullable<EwayBillRecord["rejectReasonCode"]>),
  createdBy: text(r.created_by), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), idempotencyKey: text(r.idempotency_key),
});

export class PostgresEwayBillRepository implements EwayBillRepository {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  async insert(record: EwayBillRecord): Promise<void> {
    const { sql } = this.#db.requireUnitOfWork(record.companyId);
    await unique(() => sql.query(
      `INSERT INTO eway_bills (${BILL.map(([column]) => column).join(", ")}) VALUES (${BILL.map(([, cast], i) => `$${i + 1}${cast}`).join(", ")})`,
      billValues(record),
    ), DUPLICATES.ewayBill);
    await this.#keepAcknowledgement(sql, record);
  }

  /**
   * Saves the whole record, as the in-memory store does. On a bill that has a government number the
   * freeze rule of #368 refuses any change to the fixed columns (SQLSTATE 23001), and that error is
   * passed on unchanged. A record that is not there is left alone, as in memory.
   */
  async update(record: EwayBillRecord): Promise<void> {
    const { sql } = this.#db.requireUnitOfWork(record.companyId);
    const updated = await unique(() => sql.query(
      `UPDATE eway_bills SET ${BILL.slice(2).map(([column, cast], i) => `${column} = $${i + 3}${cast}`).join(", ")}
        WHERE company_id = $1 AND id = $2 RETURNING id`,
      billValues(record),
    ), DUPLICATES.ewayBill);
    if (updated.rows.length > 0) await this.#keepAcknowledgement(sql, record);
  }

  /** A new row only when the portal's answer differs from the last one kept: the history is append-only. */
  async #keepAcknowledgement(sql: SqlExecutor, record: EwayBillRecord): Promise<void> {
    if (record.acknowledgement === undefined) return;
    await sql.query(
      `INSERT INTO eway_bill_acknowledgements (company_id, eway_bill_id, acknowledgement)
       SELECT $1, $2, $3::jsonb
        WHERE $3::jsonb IS DISTINCT FROM (SELECT a.acknowledgement FROM eway_bill_acknowledgements a
                                           WHERE a.company_id = $1 AND a.eway_bill_id = $2 ORDER BY a.seq DESC LIMIT 1)`,
      [record.companyId, record.id, json(record.acknowledgement)],
    );
  }

  async findById(companyId: CompanyId, id: Id): Promise<EwayBillRecord | null> {
    return (await this.#select(companyId, "b.id = $2", [id], "ORDER BY b.seq LIMIT 1"))[0] ?? null;
  }

  async findByMovementId(companyId: CompanyId, movementId: Id): Promise<EwayBillRecord | null> {
    return (await this.#select(companyId, "b.movement_id = $2", [movementId], "ORDER BY b.seq LIMIT 1"))[0] ?? null;
  }

  /** The first record holding the number, as in memory: two movements can share one through the portal's duplicate reply. */
  async findByNumber(companyId: CompanyId, ewayBillNumber: string): Promise<EwayBillRecord | null> {
    return (await this.#select(companyId, "b.eway_bill_number = $2", [ewayBillNumber], "ORDER BY b.seq LIMIT 1"))[0] ?? null;
  }

  list(companyId: CompanyId, page?: Page): Promise<EwayBillRecord[]> {
    return this.#select(companyId, "true", pageValues(page), seqPage("eway_bills", "b", 2));
  }

  listActive(companyId: CompanyId, page?: Page): Promise<EwayBillRecord[]> {
    return this.#select(companyId, "b.status IN ('ACTIVE','PART_A_ONLY')", pageValues(page), seqPage("eway_bills", "b", 2));
  }

  listExpiringBefore(companyId: CompanyId, before: string, page?: Page): Promise<EwayBillRecord[]> {
    return this.#select(companyId, "b.status = 'ACTIVE' AND b.valid_until <= $2::timestamptz", [instant(before), ...pageValues(page)], seqPage("eway_bills", "b", 3));
  }

  #select(companyId: CompanyId, where: string, values: unknown[], tail: string): Promise<EwayBillRecord[]> {
    return this.#db.tenantTransaction(companyId, async (sql) =>
      (await sql.query(`SELECT ${BILL_SELECT} FROM eway_bills b WHERE b.company_id = $1 AND ${where} ${tail}`, [companyId, ...values])).rows.map(toBill));
  }
}

const TRIP_SELECT = `id, company_id, trip_number, vehicle_number, from_place, from_state_code, transport_mode, eway_bill_numbers, created_by, created_at, message`;
const toTrip = (r: Row): ConsolidatedTripRecord => ({
  id: text(r.id), companyId: text(r.company_id), tripNumber: text(r.trip_number), vehicleNumber: text(r.vehicle_number),
  fromPlace: text(r.from_place), fromStateCode: text(r.from_state_code), transportMode: r.transport_mode as ConsolidatedTripRecord["transportMode"],
  ewayBillNumbers: r.eway_bill_numbers as string[], createdBy: text(r.created_by), createdAt: iso(r.created_at), message: text(r.message),
});

export class PostgresConsolidatedTripRepository implements ConsolidatedTripRepository {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  async insert(record: ConsolidatedTripRecord): Promise<void> {
    await unique(() => this.#db.requireUnitOfWork(record.companyId).sql.query(
      `INSERT INTO eway_consolidated_trips (company_id, id, trip_number, vehicle_number, from_place, from_state_code, transport_mode,
         eway_bill_numbers, created_by, created_at, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::timestamptz, $11)`,
      [record.companyId, record.id, record.tripNumber, record.vehicleNumber, record.fromPlace, record.fromStateCode, record.transportMode,
        json(record.ewayBillNumbers), record.createdBy, instant(record.createdAt), record.message],
    ), DUPLICATES.trip);
  }

  list(companyId: CompanyId, page?: Page): Promise<ConsolidatedTripRecord[]> {
    return this.#db.tenantTransaction(companyId, async (sql) => (await sql.query(
      `SELECT ${TRIP_SELECT} FROM eway_consolidated_trips t WHERE t.company_id = $1 ${seqPage("eway_consolidated_trips", "t", 2)}`,
      [companyId, ...pageValues(page)],
    )).rows.map(toTrip));
  }

  findByTripNumber(companyId: CompanyId, tripNumber: string): Promise<ConsolidatedTripRecord | null> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const row = (await sql.query(`SELECT ${TRIP_SELECT} FROM eway_consolidated_trips WHERE company_id = $1 AND trip_number = $2`, [companyId, tripNumber])).rows[0];
      return row === undefined ? null : toTrip(row);
    });
  }
}

export class PostgresEwayBillPolicies implements EwayBillPolicyPort {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  /** Replaces the policy that starts on the same day, as the in-memory `set` does. */
  async set(companyId: CompanyId, policy: EwayBillPolicy, setBy: Id): Promise<void> {
    await this.#db.requireUnitOfWork(companyId).sql.query(
      `INSERT INTO eway_bill_policies (company_id, effective_from, cancellation_window_hours, rejection_window_hours,
         kilometres_per_day_regular, kilometres_per_day_odc, extension_window_hours, set_by)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (company_id, effective_from) DO UPDATE SET cancellation_window_hours = EXCLUDED.cancellation_window_hours,
         rejection_window_hours = EXCLUDED.rejection_window_hours, kilometres_per_day_regular = EXCLUDED.kilometres_per_day_regular,
         kilometres_per_day_odc = EXCLUDED.kilometres_per_day_odc, extension_window_hours = EXCLUDED.extension_window_hours,
         set_by = EXCLUDED.set_by, set_at = now()`,
      [companyId, policy.effectiveFrom, policy.cancellationWindowHours, policy.rejectionWindowHours, policy.kilometresPerDayRegular,
        policy.kilometresPerDayOdc, policy.extensionWindowHours, setBy],
    );
  }

  async policyFor(companyId: CompanyId, on: IsoDate): Promise<EwayBillPolicy> {
    const r = await policyRow(this.#db, "eway_bill_policies",
      "cancellation_window_hours, rejection_window_hours, kilometres_per_day_regular, kilometres_per_day_odc, extension_window_hours", companyId, on);
    return r === undefined ? DEFAULT_EWAY_BILL_POLICY : {
      cancellationWindowHours: Number(r.cancellation_window_hours), rejectionWindowHours: Number(r.rejection_window_hours),
      kilometresPerDayRegular: Number(r.kilometres_per_day_regular), kilometresPerDayOdc: Number(r.kilometres_per_day_odc),
      extensionWindowHours: Number(r.extension_window_hours), effectiveFrom: text(r.effective_from),
    };
  }
}

// --------------------------------------------------------------- vehicle checks (#28)

const CHECK_SELECT = `c.id, c.company_id, c.movement_id, c.checked_at, c.checked_by, c.outcome, c.summary, c.transport, c.shipment,
  c.evidence, c.capacity, c.plate, c.findings, c.cleared_to_move, c.idempotency_key`;

/** The overrides of many checks in one query, each check's in the order they were given. */
const overridesOf = async (sql: SqlExecutor, companyId: string, checkIds: readonly string[]): Promise<Map<string, SuitabilityOverride[]>> => {
  const byCheck = new Map<string, SuitabilityOverride[]>(checkIds.map((id) => [id, []]));
  const { rows } = await sql.query(
    `SELECT check_id, finding_codes, reason, overridden_by, overridden_at FROM vehicle_suitability_overrides
      WHERE company_id = $1 AND check_id = ANY($2::uuid[]) ORDER BY check_id, position`,
    [companyId, checkIds],
  );
  for (const r of rows) {
    byCheck.get(text(r.check_id))?.push({ findingCodes: r.finding_codes as string[], reason: text(r.reason), byUserId: text(r.overridden_by), at: iso(r.overridden_at) });
  }
  return byCheck;
};

export class PostgresSuitabilityRepository implements SuitabilityRepository {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  async insert(a: VehicleSuitabilityAssessment): Promise<void> {
    const { sql } = this.#db.requireUnitOfWork(a.companyId);
    await unique(() => sql.query(
      `INSERT INTO vehicle_suitability_checks (company_id, id, movement_id, checked_at, checked_by, outcome, summary, transport, shipment,
         evidence, capacity, plate, findings, cleared_to_move, idempotency_key)
       VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14, $15)`,
      [a.companyId, a.id, a.movementId, instant(a.checkedAt), a.checkedBy, a.outcome, a.summary, json(a.transport), json(a.shipment),
        json(a.evidence), json(a.capacity), json(a.plate), json(a.findings), a.clearedToMove, a.idempotencyKey],
    ), DUPLICATES.check);
    await this.#addOverrides(sql, a, 0);
  }

  /**
   * An override is the only change a check ever takes: its summary, whether it may move, and the new
   * override rows. The evidence, the findings and the plate reading are never rewritten (the schema's
   * own promise). A save made from an old copy, missing somebody else's override, is refused.
   */
  async update(a: VehicleSuitabilityAssessment): Promise<void> {
    const { sql } = this.#db.requireUnitOfWork(a.companyId);
    const updated = await sql.query(
      `UPDATE vehicle_suitability_checks SET summary = $3, cleared_to_move = $4 WHERE company_id = $1 AND id = $2 RETURNING id`,
      [a.companyId, a.id, a.summary, a.clearedToMove],
    );
    if (updated.rows.length === 0) return;
    const held = (await overridesOf(sql, a.companyId, [a.id])).get(a.id) ?? [];
    if (!carriesEvery(held, a.overrides)) throw DUPLICATES.checkChanged();
    await this.#addOverrides(sql, a, held.length);
  }

  async #addOverrides(sql: SqlExecutor, a: VehicleSuitabilityAssessment, from: number): Promise<void> {
    const fresh = a.overrides.slice(from).map((entry, i) => ({
      position: from + i, finding_codes: entry.findingCodes, reason: entry.reason, overridden_by: entry.byUserId, overridden_at: instant(entry.at),
    }));
    if (fresh.length === 0) return;
    await unique(() => sql.query(
      `INSERT INTO vehicle_suitability_overrides (id, company_id, check_id, position, finding_codes, reason, overridden_by, overridden_at)
       SELECT gen_random_uuid(), $1, $2, o.position, o.finding_codes, o.reason, o.overridden_by, o.overridden_at
         FROM jsonb_to_recordset($3::jsonb) AS o(position int, finding_codes jsonb, reason text, overridden_by uuid, overridden_at timestamptz)`,
      [a.companyId, a.id, JSON.stringify(fresh)],
    ), DUPLICATES.checkChanged);
  }

  async findById(companyId: CompanyId, id: Id): Promise<VehicleSuitabilityAssessment | null> {
    return (await this.#select(companyId, "c.id = $2", [id], ""))[0] ?? null;
  }

  async findLatestForMovement(companyId: CompanyId, movementId: Id): Promise<VehicleSuitabilityAssessment | null> {
    return (await this.#select(companyId, "c.movement_id = $2", [movementId], "ORDER BY c.seq DESC LIMIT 1"))[0] ?? null;
  }

  list(companyId: CompanyId, page?: Page): Promise<VehicleSuitabilityAssessment[]> {
    return this.#select(companyId, "true", pageValues(page), seqPage("vehicle_suitability_checks", "c", 2));
  }

  /** `cleared_to_move` is false exactly when a blocking or undecided finding has no override (the service keeps it so). */
  listBlocked(companyId: CompanyId, page?: Page): Promise<VehicleSuitabilityAssessment[]> {
    return this.#select(companyId, "NOT c.cleared_to_move", pageValues(page), seqPage("vehicle_suitability_checks", "c", 2));
  }

  #select(companyId: CompanyId, where: string, values: unknown[], tail: string): Promise<VehicleSuitabilityAssessment[]> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const { rows } = await sql.query(`SELECT ${CHECK_SELECT} FROM vehicle_suitability_checks c WHERE c.company_id = $1 AND ${where} ${tail}`, [companyId, ...values]);
      if (rows.length === 0) return [];
      const overrides = await overridesOf(sql, companyId, rows.map((r) => text(r.id)));
      return rows.map((r): VehicleSuitabilityAssessment => ({
        id: text(r.id), companyId: text(r.company_id), movementId: text(r.movement_id), checkedAt: iso(r.checked_at), checkedBy: text(r.checked_by),
        outcome: r.outcome as VehicleSuitabilityAssessment["outcome"], summary: text(r.summary),
        transport: r.transport as VehicleSuitabilityAssessment["transport"], shipment: r.shipment as VehicleSuitabilityAssessment["shipment"],
        evidence: r.evidence as VehicleEvidence[],
        ...opt("capacity", r.capacity, (raw) => raw as NonNullable<VehicleSuitabilityAssessment["capacity"]>),
        ...opt("plate", r.plate, (raw) => raw as NonNullable<VehicleSuitabilityAssessment["plate"]>),
        findings: r.findings as VehicleSuitabilityAssessment["findings"], overrides: overrides.get(text(r.id)) ?? [],
        clearedToMove: r.cleared_to_move === true, idempotencyKey: text(r.idempotency_key),
      }));
    });
  }
}

export class PostgresVehicleSuitabilityPolicies implements VehicleSuitabilityPolicyPort {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  async set(companyId: CompanyId, policy: VehicleSuitabilityPolicy, setBy: Id): Promise<void> {
    await this.#db.requireUnitOfWork(companyId).sql.query(
      `INSERT INTO vehicle_suitability_policies (company_id, effective_from, class_ceiling_kg, warn_from_load_factor, overload_severity,
         plate_mismatch_severity, minimum_plate_confidence, expired_fitness_severity, wrong_permit_severity, set_by)
       VALUES ($1, $2::date, $3::jsonb, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (company_id, effective_from) DO UPDATE SET class_ceiling_kg = EXCLUDED.class_ceiling_kg,
         warn_from_load_factor = EXCLUDED.warn_from_load_factor, overload_severity = EXCLUDED.overload_severity,
         plate_mismatch_severity = EXCLUDED.plate_mismatch_severity, minimum_plate_confidence = EXCLUDED.minimum_plate_confidence,
         expired_fitness_severity = EXCLUDED.expired_fitness_severity, wrong_permit_severity = EXCLUDED.wrong_permit_severity,
         set_by = EXCLUDED.set_by, set_at = now()`,
      [companyId, policy.effectiveFrom, json(policy.classCeilingKg), String(policy.warnFromLoadFactor), policy.overloadSeverity,
        policy.plateMismatchSeverity, String(policy.minimumPlateConfidence), policy.expiredFitnessSeverity, policy.wrongPermitSeverity, setBy],
    );
  }

  async policyFor(companyId: CompanyId, on: IsoDate): Promise<VehicleSuitabilityPolicy> {
    const r = await policyRow(this.#db, "vehicle_suitability_policies", `class_ceiling_kg, warn_from_load_factor::text AS warn_from_load_factor,
      overload_severity, plate_mismatch_severity, minimum_plate_confidence::text AS minimum_plate_confidence, expired_fitness_severity, wrong_permit_severity`, companyId, on);
    return r === undefined ? DEFAULT_VEHICLE_SUITABILITY_POLICY : {
      classCeilingKg: r.class_ceiling_kg as VehicleSuitabilityPolicy["classCeilingKg"],
      warnFromLoadFactor: Number(r.warn_from_load_factor), minimumPlateConfidence: Number(r.minimum_plate_confidence),
      overloadSeverity: r.overload_severity as VehicleSuitabilityPolicy["overloadSeverity"],
      plateMismatchSeverity: r.plate_mismatch_severity as VehicleSuitabilityPolicy["plateMismatchSeverity"],
      expiredFitnessSeverity: r.expired_fitness_severity as VehicleSuitabilityPolicy["expiredFitnessSeverity"],
      wrongPermitSeverity: r.wrong_permit_severity as VehicleSuitabilityPolicy["wrongPermitSeverity"],
      effectiveFrom: text(r.effective_from),
    };
  }
}

// -------------------------------------------------------- vehicle-record readings (#29)

const READING_SELECT = `company_id, registration_number, provider, provider_reference, retrieved_at, not_found, vehicle_class, body_type,
  gross_vehicle_weight_kg, unladen_weight_kg, rated_payload_kg, permit_type, permit_valid_upto::text AS permit_valid_upto,
  fitness_valid_upto::text AS fitness_valid_upto, insurance_valid_upto::text AS insurance_valid_upto, registered_owner_masked, registration_status`;

/**
 * The table has a column for each fact the product may hold and nothing else (#29's privacy promise),
 * so the evidence is rebuilt from them: its source is always the registering authority, and its
 * number, time and reference are the reading's own.
 */
const toReading = (r: Row): VehicleRecordSnapshot => {
  const provenance = { provider: text(r.provider), providerReference: text(r.provider_reference), retrievedAt: iso(r.retrieved_at) };
  const registrationNumber = text(r.registration_number);
  if (r.not_found === true) return { companyId: text(r.company_id), registrationNumber, provenance, notFound: true };
  const evidence: VehicleEvidence = {
    registrationNumber, source: "GOVERNMENT_RECORD", retrievedAt: provenance.retrievedAt,
    ...opt("vehicleClass", r.vehicle_class, (raw) => raw as NonNullable<VehicleEvidence["vehicleClass"]>),
    ...opt("bodyType", r.body_type, (raw) => raw as NonNullable<VehicleEvidence["bodyType"]>),
    ...opt("grossVehicleWeightKg", r.gross_vehicle_weight_kg, Number), ...opt("unladenWeightKg", r.unladen_weight_kg, Number),
    ...opt("ratedPayloadKg", r.rated_payload_kg, Number),
    ...opt("permitType", r.permit_type, (raw) => raw as NonNullable<VehicleEvidence["permitType"]>),
    ...opt("permitValidUpto", r.permit_valid_upto, text), ...opt("fitnessValidUpto", r.fitness_valid_upto, text),
    ...opt("insuranceValidUpto", r.insurance_valid_upto, text), ...opt("registeredOwnerName", r.registered_owner_masked, text),
    ...opt("registrationStatus", r.registration_status, text), reference: provenance.providerReference,
  };
  return { companyId: text(r.company_id), registrationNumber, provenance, evidence, notFound: false };
};

export class PostgresVehicleRecordCache implements VehicleRecordCacheRepository {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  find(companyId: CompanyId, registrationNumber: string): Promise<VehicleRecordSnapshot | null> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const row = (await sql.query(`SELECT ${READING_SELECT} FROM vehicle_records WHERE company_id = $1 AND registration_number = $2 AND forgotten_at IS NULL`,
        [companyId, normaliseVehicleNumber(registrationNumber)])).rows[0];
      return row === undefined ? null : toReading(row);
    });
  }

  async save(s: VehicleRecordSnapshot): Promise<void> {
    const e = s.evidence;
    const number = normaliseVehicleNumber(s.registrationNumber);
    // Refused rather than silently changed: the table can only give back what its columns can hold.
    if (e !== undefined && (e.source !== "GOVERNMENT_RECORD" || e.retrievedAt !== s.provenance.retrievedAt
      || e.reference !== s.provenance.providerReference || normaliseVehicleNumber(e.registrationNumber) !== number)) {
      throw new Error("A stored vehicle reading must be the registering authority's own, with the reading's own number, time and reference.");
    }
    await this.#db.requireUnitOfWork(s.companyId).sql.query(
      `INSERT INTO vehicle_records (company_id, registration_number, provider, provider_reference, retrieved_at, not_found, vehicle_class,
         body_type, gross_vehicle_weight_kg, unladen_weight_kg, rated_payload_kg, permit_type, permit_valid_upto, fitness_valid_upto,
         insurance_valid_upto, registered_owner_masked, registration_status, forgotten_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11, $12, $13::date, $14::date, $15::date, $16, $17, NULL)
       ON CONFLICT (company_id, registration_number) DO UPDATE SET provider = EXCLUDED.provider, provider_reference = EXCLUDED.provider_reference,
         retrieved_at = EXCLUDED.retrieved_at, not_found = EXCLUDED.not_found, vehicle_class = EXCLUDED.vehicle_class, body_type = EXCLUDED.body_type,
         gross_vehicle_weight_kg = EXCLUDED.gross_vehicle_weight_kg, unladen_weight_kg = EXCLUDED.unladen_weight_kg,
         rated_payload_kg = EXCLUDED.rated_payload_kg, permit_type = EXCLUDED.permit_type, permit_valid_upto = EXCLUDED.permit_valid_upto,
         fitness_valid_upto = EXCLUDED.fitness_valid_upto, insurance_valid_upto = EXCLUDED.insurance_valid_upto,
         registered_owner_masked = EXCLUDED.registered_owner_masked, registration_status = EXCLUDED.registration_status, forgotten_at = NULL`,
      [s.companyId, number, s.provenance.provider, s.provenance.providerReference, instant(s.provenance.retrievedAt), s.notFound,
        e?.vehicleClass ?? null, e?.bodyType ?? null, e?.grossVehicleWeightKg ?? null, e?.unladenWeightKg ?? null, e?.ratedPayloadKg ?? null,
        e?.permitType ?? null, e?.permitValidUpto ?? null, e?.fitnessValidUpto ?? null, e?.insuranceValidUpto ?? null,
        e?.registeredOwnerName ?? null, e?.registrationStatus ?? null],
    );
  }

  /** In vehicle-number order when paged (byte order, as the in-memory store compares). */
  list(companyId: CompanyId, page?: Page): Promise<readonly VehicleRecordSnapshot[]> {
    return this.#db.tenantTransaction(companyId, async (sql) => (await sql.query(
      // ponytail: COLLATE "C" cannot use the primary key's order; fine for one company's readings, add a "C" index if that grows large.
      `SELECT ${READING_SELECT} FROM vehicle_records WHERE company_id = $1 AND forgotten_at IS NULL
         AND ($2::text IS NULL OR registration_number COLLATE "C" > $2) ORDER BY registration_number COLLATE "C" LIMIT $3::int`,
      [companyId, ...pageValues(page)],
    )).rows.map(toReading));
  }

  /**
   * The application may not delete (#368), so forgetting empties the reading: every fact, the masked
   * owner and the provider's reference are blanked. The vehicle number, the provider's name and the
   * time of the reading stay as the row's key and bookkeeping.
   */
  async forget(companyId: CompanyId, registrationNumber: string): Promise<void> {
    await this.#db.requireUnitOfWork(companyId).sql.query(
      `UPDATE vehicle_records SET provider_reference = '', not_found = false, vehicle_class = NULL, body_type = NULL,
         gross_vehicle_weight_kg = NULL, unladen_weight_kg = NULL, rated_payload_kg = NULL, permit_type = NULL, permit_valid_upto = NULL,
         fitness_valid_upto = NULL, insurance_valid_upto = NULL, registered_owner_masked = NULL, registration_status = NULL, forgotten_at = now()
       WHERE company_id = $1 AND registration_number = $2 AND forgotten_at IS NULL`,
      [companyId, normaliseVehicleNumber(registrationNumber)],
    );
  }
}

export class PostgresVehicleRecordConsents implements VehicleRecordConsentPort {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  current(companyId: CompanyId, purpose: VehicleLookupPurpose): Promise<VehicleRecordConsent | null> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const r = (await sql.query(
        `SELECT company_id, purpose, fields, granted_by, granted_at, expires_on::text AS expires_on, credential_reference, revoked_at
           FROM vehicle_record_consents WHERE company_id = $1 AND purpose = $2`, [companyId, purpose])).rows[0];
      return r === undefined ? null : {
        companyId: text(r.company_id), purpose: r.purpose as VehicleLookupPurpose, fields: r.fields as VehicleRecordConsent["fields"],
        grantedBy: text(r.granted_by), grantedAt: iso(r.granted_at), ...opt("expiresOn", r.expires_on, text),
        ...opt("credentialReference", r.credential_reference, text), ...opt("revokedAt", r.revoked_at, iso),
      };
    });
  }

  /** One consent per company and purpose, replaced as in memory. Who withdrew it is in the audit trail, not here. */
  async save(c: VehicleRecordConsent): Promise<void> {
    await this.#db.requireUnitOfWork(c.companyId).sql.query(
      `INSERT INTO vehicle_record_consents (company_id, purpose, fields, granted_by, granted_at, expires_on, credential_reference, revoked_at)
       VALUES ($1, $2, $3::jsonb, $4, $5::timestamptz, $6::date, $7, $8::timestamptz)
       ON CONFLICT (company_id, purpose) DO UPDATE SET fields = EXCLUDED.fields, granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at,
         expires_on = EXCLUDED.expires_on, credential_reference = EXCLUDED.credential_reference, revoked_at = EXCLUDED.revoked_at, revoked_by = NULL`,
      [c.companyId, c.purpose, json(c.fields), c.grantedBy, instant(c.grantedAt), c.expiresOn ?? null, c.credentialReference ?? null, instant(c.revokedAt)],
    );
  }
}

export class PostgresVehicleRecordFreshness implements VehicleRecordFreshnessPort {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  async set(companyId: CompanyId, policy: VehicleRecordFreshnessPolicy, setBy: Id): Promise<void> {
    await this.#db.requireUnitOfWork(companyId).sql.query(
      `INSERT INTO vehicle_record_freshness_policies (company_id, effective_from, reuse_within_hours, stale_after_days, set_by)
       VALUES ($1, $2::date, $3, $4, $5)
       ON CONFLICT (company_id, effective_from) DO UPDATE SET reuse_within_hours = EXCLUDED.reuse_within_hours,
         stale_after_days = EXCLUDED.stale_after_days, set_by = EXCLUDED.set_by, set_at = now()`,
      [companyId, policy.effectiveFrom, policy.reuseWithinHours, policy.staleAfterDays, setBy],
    );
  }

  async policyFor(companyId: CompanyId, on: IsoDate): Promise<VehicleRecordFreshnessPolicy> {
    const r = await policyRow(this.#db, "vehicle_record_freshness_policies", "reuse_within_hours, stale_after_days", companyId, on);
    return r === undefined ? DEFAULT_VEHICLE_RECORD_FRESHNESS
      : { reuseWithinHours: Number(r.reuse_within_hours), staleAfterDays: Number(r.stale_after_days), effectiveFrom: text(r.effective_from) };
  }
}
