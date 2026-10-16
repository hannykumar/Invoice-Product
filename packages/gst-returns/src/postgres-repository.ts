/**
 * Issue #366 — the return workspace's own storage in PostgreSQL.
 *
 * Both repositories are built on the transaction executor and never open a transaction: a write
 * needs the action's open unit of work (`requireUnitOfWork`) and throws without one, a read joins
 * it or takes a short tenant transaction (docs/contracts/unit-of-work-v1.md).
 *
 * A preparation is three tables. The row in `gst_return_preparations` holds the photograph of the
 * books; its current approval is the one row of `gst_return_approvals` that has not been withdrawn;
 * its current submission is the one row of `gst_return_submissions` that has not been set aside.
 * Approvals and attempts are never deleted (the application has no DELETE): reopening withdraws,
 * preparing again sets the old attempts aside. The freeze rules of
 * docs/contracts/database-immutability-v1.md are left to refuse what they refuse — nothing here
 * works round them.
 */
import { conflict, invalid, money, type CompanyId, type IsoDate } from '@invoice/kernel';
import type { SqlExecutor, TransactionalExecutor } from '../../platform/src/database.ts';
import type { Page, ReturnPreparationRepository, ReturnUpdateFacts } from './ports.ts';
import {
  InMemoryDeclaredThresholds, thresholdExists, validateDeclaredThreshold,
  type DeclaredThreshold, type DeclaredThresholdReader,
} from './thresholds.ts';
import type { ReturnPreparation, TaxPeriod } from './types.ts';

type Row = Record<string, unknown>;

/** bigint paise inside jsonb, kept exact: the same `$bigint` wrapper the #363 pilot uses. */
const encode = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? { $bigint: item.toString() } : item));
const decode = <T>(text: unknown): T =>
  JSON.parse(String(text), (_key, item: unknown) =>
    item !== null && typeof item === 'object' && '$bigint' in item ? BigInt((item as { $bigint: string }).$bigint) : item) as T;

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());
const orNull = <T>(value: unknown, as: (v: unknown) => T): T | null => (value === null || value === undefined ? null : as(value));
const codeOf = (error: unknown): string | undefined => (error as { code?: string }).code;

const exists = (preparation: ReturnPreparation): Error =>
  conflict('GST_RETURN_EXISTS', `${preparation.period} has already been started.`);

// jsonb is read as text so the bigint wrapper is unwrapped in one parse.
const COLUMNS = `p.id, p.company_id, p.gstin, p.period, p.return_type, p.state, p.snapshot::text AS snapshot,
  p.findings::text AS findings, p.exported_at, p.created_by, p.created_at, p.idempotency_key, p.version,
  a.approved_by, a.approved_at, a.fingerprint AS approval_fingerprint, a.note AS approval_note,
  s.id AS submission_id, s.reference, s.attempted_at, s.outcome, s.message, s.errors`;
// One live approval and one live submission per preparation (two partial unique indexes), so the
// joins never multiply a row and a list is one query, not one per preparation.
const FROM = `gst_return_preparations p
  LEFT JOIN gst_return_approvals a ON a.preparation_id = p.id AND a.withdrawn_at IS NULL
  LEFT JOIN gst_return_submissions s ON s.preparation_id = p.id AND s.superseded_at IS NULL`;
/** A child row is only ever touched through a preparation of this company. */
const OWNED = `EXISTS (SELECT 1 FROM gst_return_preparations p WHERE p.id = $2 AND p.company_id = $1)`;

const toPreparation = (r: Row): ReturnPreparation => ({
  id: String(r.id),
  companyId: r.company_id as CompanyId,
  gstin: String(r.gstin),
  period: r.period as TaxPeriod,
  returnType: r.return_type as ReturnPreparation['returnType'],
  state: r.state as ReturnPreparation['state'],
  snapshot: decode(r.snapshot),
  findings: decode(r.findings),
  approval: r.approved_at === null || r.approved_at === undefined ? null : {
    approvedBy: r.approved_by as ReturnPreparation['createdBy'],
    approvedAt: iso(r.approved_at),
    fingerprint: String(r.approval_fingerprint),
    note: orNull(r.approval_note, String),
  },
  exportedAt: orNull(r.exported_at, iso),
  submission: r.submission_id === null || r.submission_id === undefined ? null : {
    reference: orNull(r.reference, String),
    attemptedAt: iso(r.attempted_at),
    outcome: r.outcome as NonNullable<ReturnPreparation['submission']>['outcome'],
    message: String(r.message),
    errors: r.errors as NonNullable<ReturnPreparation['submission']>['errors'],
  },
  createdBy: r.created_by as ReturnPreparation['createdBy'],
  createdAt: iso(r.created_at),
  idempotencyKey: String(r.idempotency_key),
  version: Number(r.version),
});

export class PostgresReturnPreparations implements ReturnPreparationRepository {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) { this.#db = db; }

  async find(companyId: CompanyId, period: TaxPeriod, returnType: 'GSTR1' | 'GSTR3B'): Promise<ReturnPreparation | null> {
    return (await this.#select(companyId, 'AND p.period = $2 AND p.return_type = $3', [period, returnType]))[0] ?? null;
  }

  async findByIdempotencyKey(companyId: CompanyId, key: string): Promise<ReturnPreparation | null> {
    return (await this.#select(companyId, 'AND p.idempotency_key = $2', [key]))[0] ?? null;
  }

  async insert(preparation: ReturnPreparation): Promise<void> {
    const sql = this.#db.requireUnitOfWork(preparation.companyId).sql;
    const { snapshot } = preparation;
    // An attempt row needs its channel and filing key, which only `update` is given.
    if (preparation.submission !== null) {
      throw invalid('GST_RETURN_ATTEMPT_UNATTRIBUTED', 'A new return cannot already carry a submission.');
    }
    try {
      // The port knows a return by company, period and type, so a second one for the same month is
      // refused here even under another GST number — as the in-memory store refuses it.
      const inserted = await sql.query(
        `INSERT INTO gst_return_preparations (id, company_id, gstin, period, return_type, state, snapshot, fingerprint,
           document_count, findings, exported_at, created_by, created_at, idempotency_key, version)
         SELECT $1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8, $9::int, $10::jsonb, $11::timestamptz, $12::uuid,
                $13::timestamptz, $14, $15::int
          WHERE NOT EXISTS (SELECT 1 FROM gst_return_preparations WHERE company_id = $2::uuid AND period = $4 AND return_type = $5)
         RETURNING id`,
        [preparation.id, preparation.companyId, preparation.gstin, preparation.period, preparation.returnType, preparation.state,
          encode(snapshot), snapshot.fingerprint, snapshot.documentCount, encode(preparation.findings), preparation.exportedAt,
          preparation.createdBy, preparation.createdAt, preparation.idempotencyKey, preparation.version],
      );
      if (inserted.rows.length === 0) throw exists(preparation);
      await this.#saveApproval(sql, preparation, undefined);
    } catch (error) {
      if (codeOf(error) === '23505') throw exists(preparation);
      throw error;
    }
  }

  async update(preparation: ReturnPreparation, expectedVersion: number, facts?: ReturnUpdateFacts): Promise<void> {
    const sql = this.#db.requireUnitOfWork(preparation.companyId).sql;
    const { snapshot, companyId, period, returnType } = preparation;
    try {
      // The whole record is saved, as the in-memory store replaces it. On an approved return the
      // database compares by value and lets through only what database-immutability-v1 allows.
      const updated = await sql.query(
        `UPDATE gst_return_preparations
            SET gstin = $5, state = $6, snapshot = $7::jsonb, fingerprint = $8, document_count = $9, findings = $10::jsonb,
                exported_at = $11, idempotency_key = $12, version = $13
          WHERE company_id = $1 AND period = $2 AND return_type = $3 AND version = $4
         RETURNING id`,
        [companyId, period, returnType, expectedVersion, preparation.gstin, preparation.state, encode(snapshot),
          snapshot.fingerprint, snapshot.documentCount, encode(preparation.findings), preparation.exportedAt,
          preparation.idempotencyKey, preparation.version],
      );
      const id = updated.rows[0]?.id;
      if (id === undefined) {
        const current = await sql.query(
          'SELECT version FROM gst_return_preparations WHERE company_id = $1 AND period = $2 AND return_type = $3',
          [companyId, period, returnType],
        );
        if (current.rows.length === 0) {
          throw conflict('GST_RETURN_MISSING', `${period} is not stored, so it cannot be updated.`);
        }
        throw conflict(
          'GST_RETURN_CHANGED',
          'Somebody else changed this return while you were working on it. Open it again so you are looking at their figures before you change anything.',
        );
      }
      await this.#saveApproval(sql, { ...preparation, id: String(id) }, facts);
      await this.#saveSubmission(sql, { ...preparation, id: String(id) }, facts);
    } catch (error) {
      if (codeOf(error) === '23505') throw exists(preparation);
      // The table's own rule: a withdrawal names who and why, or it is not written.
      if (codeOf(error) === '23514' && (error as { constraint?: string }).constraint === 'gst_return_withdrawal_complete') {
        throw invalid('GST_RETURN_WITHDRAWAL_UNATTRIBUTED', 'An approval can only be taken back with the name of the person reopening the return and their reason.');
      }
      throw error;
    }
  }

  async list(companyId: CompanyId, page?: Page): Promise<readonly ReturnPreparation[]> {
    if (page === undefined) return this.#select(companyId, '', []);
    if (page.after === undefined) return this.#select(companyId, '', [], `LIMIT ${Math.trunc(page.limit)}`);
    const [period, id] = page.after.split('|');
    return this.#select(companyId, 'AND (p.period, p.id) < ($2, $3::uuid)', [period, id], `LIMIT ${Math.trunc(page.limit)}`);
  }

  /** Served by gst_return_preparations_company_period_idx (company_id, period DESC). */
  #select(companyId: CompanyId, where: string, values: unknown[], limit = ''): Promise<ReturnPreparation[]> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const { rows } = await sql.query(
        `SELECT ${COLUMNS} FROM ${FROM} WHERE p.company_id = $1 ${where} ORDER BY p.period DESC, p.id DESC ${limit}`,
        [companyId, ...values],
      );
      return rows.map(toPreparation);
    });
  }

  async #saveApproval(sql: SqlExecutor, preparation: ReturnPreparation, facts: ReturnUpdateFacts | undefined): Promise<void> {
    const { approval, companyId, id } = preparation;
    if (approval === null) {
      // Reopening. With nobody named, the table's CHECK refuses the withdrawal (see `update`).
      await sql.query(
        `UPDATE gst_return_approvals SET withdrawn_at = now(), withdrawn_by = $3, withdrawn_reason = $4
          WHERE preparation_id = $2 AND withdrawn_at IS NULL AND ${OWNED}`,
        [companyId, id, facts?.withdrawal?.by ?? null, facts?.withdrawal?.reason ?? null],
      );
      return;
    }
    // An approval row is written once and never edited; a return that is still approved keeps it.
    await sql.query(
      `INSERT INTO gst_return_approvals (id, preparation_id, approved_by, approved_at, fingerprint, note)
       SELECT gen_random_uuid(), p.id, $3::uuid, $4::timestamptz, $5, $6
         FROM gst_return_preparations p WHERE p.company_id = $1 AND p.id = $2
       ON CONFLICT (preparation_id) WHERE withdrawn_at IS NULL DO NOTHING`,
      [companyId, id, approval.approvedBy, approval.approvedAt, approval.fingerprint, approval.note],
    );
  }

  async #saveSubmission(sql: SqlExecutor, preparation: ReturnPreparation, facts: ReturnUpdateFacts | undefined): Promise<void> {
    const { submission, companyId, id } = preparation;
    const attempt = facts?.attempt;
    // Nothing new to record: the return still shows the attempt it showed before.
    if (submission !== null && attempt === undefined) return;
    // Earlier attempts leave the return but stay on record. An accepted one cannot be set aside:
    // the database refuses, because a filed return is not un-filed.
    await sql.query(
      `UPDATE gst_return_submissions SET superseded_at = now()
        WHERE preparation_id = $2 AND superseded_at IS NULL
          AND (provider, idempotency_key) IS DISTINCT FROM ($3::text, $4::text) AND ${OWNED}`,
      [companyId, id, attempt?.provider ?? null, attempt?.idempotencyKey ?? null],
    );
    if (submission === null || attempt === undefined) return;
    // One row per filing: a retry under the same key is the same filing, so it updates its row.
    await sql.query(
      `INSERT INTO gst_return_submissions (id, preparation_id, provider, idempotency_key, attempted_at, outcome, reference, errors, message)
       SELECT gen_random_uuid(), p.id, $3, $4, $5::timestamptz, $6, $7, $8::jsonb, $9
         FROM gst_return_preparations p WHERE p.company_id = $1 AND p.id = $2
       ON CONFLICT (preparation_id, provider, idempotency_key) DO UPDATE
         SET attempted_at = EXCLUDED.attempted_at, outcome = EXCLUDED.outcome, reference = EXCLUDED.reference,
             errors = EXCLUDED.errors, message = EXCLUDED.message, superseded_at = NULL`,
      [companyId, id, attempt.provider, attempt.idempotencyKey, submission.attemptedAt, submission.outcome,
        submission.reference, JSON.stringify(submission.errors), submission.message],
    );
  }
}

const THRESHOLD_COLUMNS = `company_id, above_value_minor, effective_from::text AS effective_from, effective_to::text AS effective_to,
  declared_by, declared_on::text AS declared_on, basis`;

const toThreshold = (r: Row): DeclaredThreshold => ({
  companyId: String(r.company_id),
  aboveValue: money(BigInt(String(r.above_value_minor))),
  effectiveFrom: r.effective_from as IsoDate,
  effectiveTo: orNull(r.effective_to, (v) => v as IsoDate),
  declaredBy: String(r.declared_by),
  declaredOn: r.declared_on as IsoDate,
  basis: String(r.basis),
});

/**
 * The B2CL threshold a business set for itself (`gst_return_declared_thresholds`).
 *
 * `B2clThresholdTable` asks its reader synchronously, in the middle of building a return, so the
 * database cannot answer it directly: `readerFor` loads one company's declarations (a handful of
 * rows) and hands back a reader that can.
 */
export class PostgresDeclaredThresholds {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) { this.#db = db; }

  async declare(threshold: DeclaredThreshold): Promise<void> {
    validateDeclaredThreshold(threshold);
    try {
      await this.#db.requireUnitOfWork(threshold.companyId).sql.query(
        `INSERT INTO gst_return_declared_thresholds (company_id, above_value_minor, effective_from, effective_to, declared_by, declared_on, basis)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [threshold.companyId, threshold.aboveValue.minor.toString(), threshold.effectiveFrom, threshold.effectiveTo,
          threshold.declaredBy, threshold.declaredOn, threshold.basis],
      );
    } catch (error) {
      if (codeOf(error) === '23505') throw thresholdExists(threshold);
      throw error;
    }
  }

  /** The declaration in force on `on`: the latest that has started and not ended. Served by the primary key. */
  async find(companyId: string, on: IsoDate): Promise<DeclaredThreshold | undefined> {
    const rows = await this.#select(companyId,
      'AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date) ORDER BY effective_from DESC LIMIT 1', [on]);
    return rows[0];
  }

  /** Oldest first. With a page, the last row's `effectiveFrom` is the next `after`. */
  async list(companyId: string, page?: Page): Promise<readonly DeclaredThreshold[]> {
    if (page === undefined) return this.#select(companyId, 'ORDER BY effective_from', []);
    const limit = `ORDER BY effective_from LIMIT ${Math.trunc(page.limit)}`;
    return page.after === undefined
      ? this.#select(companyId, limit, [])
      : this.#select(companyId, `AND effective_from > $2::date ${limit}`, [page.after]);
  }

  /** Everything this company has declared, as the synchronous reader `B2clThresholdTable` takes. */
  async readerFor(companyId: string): Promise<DeclaredThresholdReader> {
    const reader = new InMemoryDeclaredThresholds();
    for (const threshold of await this.list(companyId)) reader.declare(threshold);
    return reader;
  }

  #select(companyId: string, tail: string, values: unknown[]): Promise<DeclaredThreshold[]> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const { rows } = await sql.query(
        `SELECT ${THRESHOLD_COLUMNS} FROM gst_return_declared_thresholds WHERE company_id = $1 ${tail}`,
        [companyId, ...values],
      );
      return rows.map(toThreshold);
    });
  }
}
