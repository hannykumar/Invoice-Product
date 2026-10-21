/**
 * Issue #366 — the compliance calendar's stores on PostgreSQL, beside the in-memory ones in
 * adapters.ts and behaving the same. See docs/contracts/unit-of-work-v1.md.
 *
 * Built on the transaction executor. A repository never opens a transaction: every write joins the
 * caller's unit of work (`requireUnitOfWork`, which throws `NO_UNIT_OF_WORK` when none is open) and
 * every read runs in `tenantTransaction`. Every query also names `company_id` itself.
 *
 * Not moved here: the company profile (#7's facts, derived per request today), deadline events (#26
 * and #27 own them) and contacts (#39). They are ports onto other modules with no table of ours.
 */
import { conflict, notFound, type CompanyId, type IsoDate, type UserId } from '@invoice/kernel';
import type { SqlExecutor, TransactionalExecutor } from '../../platform/src/database.ts';
import { checkPage } from './adapters.ts';
import type { AlertRepository, ComplianceExceptionRepository, OccurrenceRepository, Page } from './ports.ts';
import type { ComplianceAlert, ComplianceException, DueDateRevision, ObligationOccurrence, ObligationPeriod } from './types.ts';

type Row = Record<string, unknown>;

/** jsonb with bigint (paise) kept exact: written as `{ $bigint: "…" }`, read back as a bigint. */
const toJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? { $bigint: item.toString() } : item));
const fromJson = <T>(value: unknown): T =>
  JSON.parse(JSON.stringify(value), (_key, item: unknown) =>
    item !== null && typeof item === 'object' && '$bigint' in item ? BigInt((item as { $bigint: string }).$bigint) : item) as T;
const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));
const textOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

/** An occurrence key is `code:periodKey`; codes never contain a colon, period keys may. */
const splitKey = (key: string): [string, string] => {
  const at = key.indexOf(':');
  return at < 0 ? [key, ''] : [key.slice(0, at), key.slice(at + 1)];
};

/** A duplicate becomes the module's conflict; every other database error is rethrown as it is. */
const write = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw conflict('COMPLIANCE_RECORD_CONFLICT', 'This compliance record was saved by someone else at the same time. Refresh and try again.');
    }
    throw error;
  }
};

const keyset = (page: Page | undefined, cursor: string, next: number): { where: string; tail: string; values: unknown[] } => {
  checkPage(page);
  if (page === undefined) return { where: '', tail: '', values: [] };
  const values: unknown[] = [];
  let where = '';
  if (page.after !== undefined) {
    where = ` AND ${cursor} > $${next}`;
    values.push(page.after);
  }
  return { where, tail: ` LIMIT ${page.limit}`, values };
};

// ---------------------------------------------------------------------------- occurrences

const OCCURRENCE_COLUMNS = `o.id, o.company_id, o.code, o.period_key, o.period_kind, o.period_from::text AS period_from,
  o.period_to::text AS period_to, o.period_label, o.definition_version, o.review_state, o.source_ref, o.title, o.obligation_kind,
  o.due_date::text AS due_date, o.actionable_by::text AS actionable_by, o.status, o.not_applicable_reason,
  o.snooze_until::text AS snooze_until, o.snooze_reason, o.snoozed_by, o.snoozed_at, o.highest_alert_level, o.created_at, o.updated_at,
  c.evidence_kind, c.reference, c.note, c.filed_on::text AS filed_on, c.completed_by, c.completed_at`;

export class PostgresOccurrences implements OccurrenceRepository {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) {
    this.#db = db;
  }

  async find(companyId: CompanyId, key: string): Promise<ObligationOccurrence | null> {
    const [code, periodKey] = splitKey(key);
    return (await this.#select(companyId, 'AND o.code = $2 AND o.period_key = $3', [code, periodKey], ''))[0] ?? null;
  }

  async list(companyId: CompanyId, from: IsoDate, to: IsoDate, page?: Page): Promise<readonly ObligationOccurrence[]> {
    const { where, tail, values } = keyset(page, 'o.id', 4);
    return this.#select(companyId, `AND o.period_to >= $2 AND o.period_from <= $3${where}`, [from, to, ...values], `ORDER BY o.id${tail}`);
  }

  async put(occurrence: ObligationOccurrence): Promise<void> {
    const { sql } = this.#db.requireUnitOfWork(occurrence.companyId);
    const { period, snooze } = occurrence;
    await write(async () => {
      const saved = await sql.query(
        `INSERT INTO compliance_occurrences (id, company_id, code, period_key, period_kind, period_from, period_to, period_label,
           definition_version, review_state, source_ref, title, obligation_kind, due_date, actionable_by, status, not_applicable_reason,
           snooze_until, snooze_reason, snoozed_by, snoozed_at, highest_alert_level, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17::jsonb, $18, $19, $20, $21, $22, $23, $24)
         ON CONFLICT (company_id, code, period_key) DO UPDATE SET
           period_kind = EXCLUDED.period_kind, period_from = EXCLUDED.period_from, period_to = EXCLUDED.period_to,
           period_label = EXCLUDED.period_label, definition_version = EXCLUDED.definition_version, review_state = EXCLUDED.review_state,
           source_ref = EXCLUDED.source_ref, title = EXCLUDED.title, obligation_kind = EXCLUDED.obligation_kind,
           due_date = EXCLUDED.due_date, actionable_by = EXCLUDED.actionable_by, status = EXCLUDED.status,
           not_applicable_reason = EXCLUDED.not_applicable_reason, snooze_until = EXCLUDED.snooze_until,
           snooze_reason = EXCLUDED.snooze_reason, snoozed_by = EXCLUDED.snoozed_by, snoozed_at = EXCLUDED.snoozed_at,
           highest_alert_level = EXCLUDED.highest_alert_level, updated_at = EXCLUDED.updated_at
         WHERE compliance_occurrences.company_id = $2
         RETURNING id`,
        [occurrence.id, occurrence.companyId, occurrence.code, period.key, period.kind, period.from, period.to,
          period.kind === 'EVENT' ? toJson(period.label) : null, occurrence.version, occurrence.reviewState, occurrence.sourceRef,
          toJson(occurrence.title), occurrence.obligationKind, occurrence.dueDate, occurrence.actionableBy, occurrence.status,
          occurrence.notApplicableReason === null ? null : toJson(occurrence.notApplicableReason),
          snooze?.until ?? null, snooze?.reason ?? null, snooze?.snoozedBy ?? null, snooze?.snoozedAt ?? null,
          occurrence.highestAlertLevel, occurrence.createdAt, occurrence.updatedAt],
      );
      const id = String(saved.rows[0]?.id);
      if (occurrence.revisions.length > 0) {
        // Append-only: a repeated save adds only the revisions this row has not got yet.
        await sql.query(
          `INSERT INTO compliance_deadline_revisions (id, occurrence_id, company_id, position, previous_due_date, due_date,
             previous_version, version, reason, source_ref, recorded_at)
           SELECT gen_random_uuid(), $1, $2, r.position, r.previous_due_date, r.due_date, r.previous_version, r.version, r.reason,
             r.source_ref, r.recorded_at
             FROM jsonb_to_recordset($3::jsonb) AS r(position integer, previous_due_date date, due_date date, previous_version integer,
               version integer, reason jsonb, source_ref text, recorded_at timestamptz)
           ON CONFLICT (occurrence_id, position) DO NOTHING`,
          [id, occurrence.companyId, toJson(occurrence.revisions.map((revision, position) => ({
            position, previous_due_date: revision.previousDueDate, due_date: revision.dueDate, previous_version: revision.previousVersion,
            version: revision.version, reason: revision.reason, source_ref: revision.sourceRef, recorded_at: revision.at,
          })))],
        );
      }
      const completion = occurrence.completion;
      if (completion !== null) {
        // One completion per occurrence, never replaced: a completed occurrence is frozen.
        await sql.query(
          `INSERT INTO compliance_completions (id, occurrence_id, company_id, evidence_kind, reference, note, filed_on, completed_by, completed_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (occurrence_id) DO NOTHING`,
          [id, occurrence.companyId, completion.evidence.kind, completion.evidence.reference, completion.evidence.note,
            completion.evidence.filedOn, completion.completedBy, completion.completedAt],
        );
      }
    });
  }

  #select(companyId: CompanyId, where: string, values: readonly unknown[], order: string): Promise<ObligationOccurrence[]> {
    return this.#db.tenantTransaction(companyId, async (sql: SqlExecutor) => {
      const { rows } = await sql.query(
        `SELECT ${OCCURRENCE_COLUMNS}
           FROM compliance_occurrences o
           LEFT JOIN compliance_completions c ON c.occurrence_id = o.id AND c.company_id = o.company_id
          WHERE o.company_id = $1 ${where} ${order}`,
        [companyId, ...values],
      );
      if (rows.length === 0) return [];
      const revisions = await sql.query(
        `SELECT occurrence_id, previous_due_date::text AS previous_due_date, due_date::text AS due_date, previous_version, version,
                reason, source_ref, recorded_at
           FROM compliance_deadline_revisions
          WHERE company_id = $1 AND occurrence_id = ANY($2::uuid[])
          ORDER BY occurrence_id, position`,
        [companyId, rows.map((row) => row.id)],
      );
      const byOccurrence = new Map<string, DueDateRevision[]>();
      for (const r of revisions.rows) {
        const list = byOccurrence.get(String(r.occurrence_id)) ?? [];
        list.push({
          at: iso(r.recorded_at), previousDueDate: r.previous_due_date as IsoDate, dueDate: r.due_date as IsoDate,
          previousVersion: Number(r.previous_version), version: Number(r.version), reason: fromJson(r.reason), sourceRef: textOrNull(r.source_ref),
        });
        byOccurrence.set(String(r.occurrence_id), list);
      }
      return rows.map((r) => toOccurrence(r, byOccurrence.get(String(r.id)) ?? []));
    });
  }
}

const toOccurrence = (r: Row, revisions: readonly DueDateRevision[]): ObligationOccurrence => {
  const base = { key: String(r.period_key), from: r.period_from as IsoDate, to: r.period_to as IsoDate };
  const period = (r.period_kind === 'EVENT'
    ? { kind: 'EVENT', ...base, label: fromJson(r.period_label) }
    : { kind: r.period_kind, ...base }) as ObligationPeriod;
  return {
    id: String(r.id), companyId: r.company_id as CompanyId, key: `${String(r.code)}:${base.key}`,
    code: r.code as ObligationOccurrence['code'], obligationKind: r.obligation_kind as ObligationOccurrence['obligationKind'],
    title: fromJson(r.title), version: Number(r.definition_version), reviewState: r.review_state as ObligationOccurrence['reviewState'],
    sourceRef: textOrNull(r.source_ref), period, dueDate: r.due_date as IsoDate, actionableBy: r.actionable_by as IsoDate,
    status: r.status as ObligationOccurrence['status'],
    notApplicableReason: r.not_applicable_reason === null ? null : fromJson(r.not_applicable_reason),
    snooze: r.snooze_until === null
      ? null
      : { until: r.snooze_until as IsoDate, reason: String(r.snooze_reason), snoozedBy: r.snoozed_by as UserId, snoozedAt: iso(r.snoozed_at) },
    completion: r.evidence_kind === null
      ? null
      : {
          evidence: {
            kind: r.evidence_kind as NonNullable<ObligationOccurrence['completion']>['evidence']['kind'],
            reference: String(r.reference), filedOn: r.filed_on as IsoDate, note: String(r.note),
          },
          completedBy: r.completed_by as UserId, completedAt: iso(r.completed_at),
        },
    revisions,
    highestAlertLevel: (r.highest_alert_level ?? null) as ObligationOccurrence['highestAlertLevel'],
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
};

// ---------------------------------------------------------------------------- alerts

const ALERT_COLUMNS = `id, company_id, occurrence_key, code, obligation_kind, definition_version, review_state, source_ref, level,
  audiences, due_date::text AS due_date, days_remaining, period, headline, detail, next_action, action_code, consequence, signals,
  affected, deduplication_key, raised_at, raised_by, manual_reason`;

/** Append-only. A repeated deduplication key is ignored, as the in-memory store ignores it. */
export class PostgresAlerts implements AlertRepository {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) {
    this.#db = db;
  }

  async insert(alert: ComplianceAlert): Promise<void> {
    const { sql } = this.#db.requireUnitOfWork(alert.companyId);
    await write(async () => {
      // The occurrence id comes from the stored occurrence, so an alert cannot point at another
      // company's row or at nothing.
      const found = await sql.query(
        'SELECT id FROM compliance_occurrences WHERE company_id = $1 AND code = $2 AND period_key = $3',
        [alert.companyId, alert.code, alert.period.key],
      );
      if (found.rows.length === 0) throw notFound('COMPLIANCE_OCCURRENCE_NOT_FOUND', 'That obligation is not on this calendar.');
      await sql.query(
        `INSERT INTO compliance_alerts (id, company_id, occurrence_id, occurrence_key, code, obligation_kind, definition_version,
           review_state, source_ref, level, audiences, due_date, days_remaining, period, headline, detail, next_action, action_code,
           consequence, signals, affected, deduplication_key, raised_at, raised_by, manual_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18,
           $19::jsonb, $20::jsonb, $21::jsonb, $22, $23, $24, $25)
         ON CONFLICT (company_id, deduplication_key) DO NOTHING`,
        [alert.id, alert.companyId, found.rows[0]?.id, alert.occurrenceKey, alert.code, alert.obligationKind, alert.version,
          alert.reviewState, alert.sourceRef, alert.level, [...alert.audiences], alert.dueDate, alert.daysRemaining, toJson(alert.period),
          toJson(alert.headline), toJson(alert.detail), toJson(alert.nextAction), alert.actionCode, toJson(alert.consequence),
          toJson(alert.signals), toJson(alert.affected), alert.deduplicationKey, alert.raisedAt, alert.raisedBy, alert.manualReason ?? null],
      );
    });
  }

  raisedKeys(companyId: CompanyId, occurrenceKey: string): Promise<ReadonlySet<string>> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const { rows } = await sql.query(
        'SELECT deduplication_key FROM compliance_alerts WHERE company_id = $1 AND occurrence_key = $2',
        [companyId, occurrenceKey],
      );
      return new Set(rows.map((row) => String(row.deduplication_key)));
    });
  }

  listForCompany(companyId: CompanyId, page?: Page): Promise<readonly ComplianceAlert[]> {
    const { where, tail, values } = keyset(page, 'id', 2);
    // Unpaged, in the order raised (as the in-memory list is); paged, by id.
    const order = page === undefined ? 'ORDER BY raised_at, id' : `ORDER BY id${tail}`;
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const { rows } = await sql.query(`SELECT ${ALERT_COLUMNS} FROM compliance_alerts WHERE company_id = $1${where} ${order}`, [companyId, ...values]);
      return rows.map(toAlert);
    });
  }
}

const toAlert = (r: Row): ComplianceAlert => ({
  id: String(r.id), companyId: r.company_id as CompanyId, occurrenceKey: String(r.occurrence_key), code: r.code as ComplianceAlert['code'],
  obligationKind: r.obligation_kind as ComplianceAlert['obligationKind'], version: Number(r.definition_version),
  reviewState: r.review_state as ComplianceAlert['reviewState'], sourceRef: textOrNull(r.source_ref), level: r.level as ComplianceAlert['level'],
  audiences: (r.audiences as string[]) as ComplianceAlert['audiences'], dueDate: r.due_date as IsoDate, daysRemaining: Number(r.days_remaining),
  period: fromJson(r.period), headline: fromJson(r.headline), detail: fromJson(r.detail), nextAction: fromJson(r.next_action),
  actionCode: String(r.action_code), consequence: fromJson(r.consequence), signals: fromJson(r.signals), affected: fromJson(r.affected),
  deduplicationKey: String(r.deduplication_key), raisedAt: iso(r.raised_at), raisedBy: r.raised_by as UserId,
  ...(r.manual_reason === null ? {} : { manualReason: String(r.manual_reason) }),
});

// ---------------------------------------------------------------------------- exceptions

/**
 * The exception queue. `clear` cannot delete (the application role has no DELETE): it stamps
 * `resolved_at`, and a later `put` of the same obligation and period re-opens the row.
 */
export class PostgresComplianceExceptions implements ComplianceExceptionRepository {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) {
    this.#db = db;
  }

  async put(exception: ComplianceException): Promise<void> {
    const { sql } = this.#db.requireUnitOfWork(exception.companyId);
    await write(() => sql.query(
      `INSERT INTO compliance_calendar_exceptions (id, company_id, code, period_key, missing_facts, missing, question, raised_at, resolved_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, NULL)
       ON CONFLICT (company_id, code, period_key) DO UPDATE SET
         missing_facts = EXCLUDED.missing_facts, missing = EXCLUDED.missing, question = EXCLUDED.question,
         raised_at = EXCLUDED.raised_at, resolved_at = NULL
       WHERE compliance_calendar_exceptions.company_id = $1`,
      [exception.companyId, exception.code, exception.periodKey, exception.missing.map((item) => item.fact),
        toJson(exception.missing), toJson(exception.question), exception.raisedAt],
    ));
  }

  list(companyId: CompanyId, page?: Page): Promise<readonly ComplianceException[]> {
    // ponytail: the cursor is the `code:periodKey` string in byte order (COLLATE "C", as JavaScript
    // compares), which no index serves. A company has a handful of open questions; index an
    // expression if that ever stops being true.
    const cursor = `(code || ':' || period_key) COLLATE "C"`;
    const { where, tail, values } = keyset(page, cursor, 2);
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const { rows } = await sql.query(
        `SELECT code, period_key, missing, question, raised_at FROM compliance_calendar_exceptions
          WHERE company_id = $1 AND resolved_at IS NULL${where} ORDER BY ${cursor}${tail}`,
        [companyId, ...values],
      );
      return rows.map((r): ComplianceException => ({
        companyId, code: r.code as ComplianceException['code'], periodKey: String(r.period_key),
        missing: fromJson(r.missing), question: fromJson(r.question), raisedAt: iso(r.raised_at),
      }));
    });
  }

  async clear(companyId: CompanyId, code: string, periodKey: string): Promise<void> {
    const { sql } = this.#db.requireUnitOfWork(companyId);
    await sql.query(
      `UPDATE compliance_calendar_exceptions SET resolved_at = now()
        WHERE company_id = $1 AND code = $2 AND period_key = $3 AND resolved_at IS NULL`,
      [companyId, code, periodKey],
    );
  }
}
