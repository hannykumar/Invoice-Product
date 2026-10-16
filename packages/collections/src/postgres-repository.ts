/**
 * Issue #366 — reminders, channel preferences, opt-outs, promises and disputes in PostgreSQL.
 *
 * Built on the transaction executor of #363 and never opens a transaction of its own: every write
 * joins the command's unit of work (`requireUnitOfWork`, which throws `NO_UNIT_OF_WORK` when none is
 * open), every read runs in `tenantTransaction`, so row-level security is in force, and every query
 * also names the company. It behaves as `InMemoryReminderRepository` does; the contract suite in
 * `test/reminder-repository-contract.ts` runs against both.
 */
import { money, type CompanyId, type IsoDate, type PartyId } from '@invoice/kernel';
import type { SqlExecutor, TransactionalExecutor } from '../../platform/src/database.ts';
import type { ContactPreference, Dispute, OptOut, PromiseToPay, Reminder } from './model.ts';
import type { Page, ReminderRepository } from './ports.ts';
import { reminderDuplicate, reminderNotFound } from './repository.ts';

type Row = Record<string, unknown>;
const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));
const isoOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : iso(value));
const textOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const paise = (value: unknown) => money(BigInt(String(value)));
/** A unique-key refusal is the module's duplicate error; any other database error is rethrown as it is. */
const duplicateAs = async <T>(work: Promise<T>): Promise<T> => {
  try {
    return await work;
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw reminderDuplicate();
    throw error;
  }
};
/** `LIMIT` for a page, or none. Keyset conditions are added by each list. */
const limitOf = (page: Page | undefined, n: number): string => (page === undefined ? '' : ` LIMIT $${n}`);
const pageValues = (page: Page | undefined): unknown[] => (page === undefined ? [] : [page.limit]);

const REMINDER_COLUMNS = `id, company_id, branch_id, party_id, document_id, reminder_key, step_code, level, channel, audience,
  message, snapshot_as_of::text AS snapshot_as_of, document_number, document_value_paise, outstanding_paise,
  party_outstanding_paise, days_overdue, state, failure_reason, notification_id, scheduled_by, scheduled_at, sent_at`;
const reminderValues = (r: Reminder): unknown[] => [
  r.companyId, r.id, r.branchId, r.partyId, r.documentId, r.reminderKey, r.stepCode, r.level, r.channel, r.audience,
  JSON.stringify(r.message), r.snapshot.asOf, r.snapshot.documentNumber, r.snapshot.documentValue.minor.toString(),
  r.snapshot.outstanding.minor.toString(), r.snapshot.partyOutstanding.minor.toString(), r.snapshot.daysOverdue,
  r.state, r.failureReason, r.notificationId, r.scheduledBy, r.scheduledAt, r.sentAt,
];
const toReminder = (r: Row): Reminder => ({
  id: String(r.id), companyId: r.company_id as CompanyId, branchId: textOrNull(r.branch_id) as Reminder['branchId'],
  partyId: r.party_id as PartyId, documentId: String(r.document_id), reminderKey: String(r.reminder_key),
  stepCode: String(r.step_code), level: r.level as Reminder['level'], channel: r.channel as Reminder['channel'],
  audience: r.audience as Reminder['audience'], message: r.message as Reminder['message'],
  snapshot: {
    asOf: r.snapshot_as_of as IsoDate, documentNumber: String(r.document_number),
    documentValue: paise(r.document_value_paise), outstanding: paise(r.outstanding_paise),
    partyOutstanding: paise(r.party_outstanding_paise), daysOverdue: Number(r.days_overdue),
  },
  state: r.state as Reminder['state'], failureReason: textOrNull(r.failure_reason), notificationId: textOrNull(r.notification_id),
  scheduledBy: r.scheduled_by as Reminder['scheduledBy'], scheduledAt: iso(r.scheduled_at), sentAt: isoOrNull(r.sent_at),
});

const PROMISE_COLUMNS = 'id, company_id, party_id, document_id, amount_paise, promised_on::text AS promised_on, note, state, recorded_by, recorded_at';
const toPromise = (r: Row): PromiseToPay => ({
  id: String(r.id), companyId: r.company_id as CompanyId, partyId: r.party_id as PartyId, documentId: String(r.document_id),
  amount: paise(r.amount_paise), promisedOn: r.promised_on as IsoDate, note: textOrNull(r.note),
  state: r.state as PromiseToPay['state'], recordedBy: r.recorded_by as PromiseToPay['recordedBy'], recordedAt: iso(r.recorded_at),
});

const DISPUTE_COLUMNS = 'id, company_id, party_id, document_id, reason, state, resolution, raised_by, raised_at, resolved_by, resolved_at';
const toDispute = (r: Row): Dispute => ({
  id: String(r.id), companyId: r.company_id as CompanyId, partyId: r.party_id as PartyId, documentId: textOrNull(r.document_id),
  reason: String(r.reason), state: r.state as Dispute['state'], resolution: textOrNull(r.resolution),
  raisedBy: r.raised_by as Dispute['raisedBy'], raisedAt: iso(r.raised_at),
  resolvedBy: textOrNull(r.resolved_by) as Dispute['resolvedBy'], resolvedAt: isoOrNull(r.resolved_at),
});

export class PostgresReminderRepository implements ReminderRepository {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) { this.#db = db; }

  #write(companyId: CompanyId): SqlExecutor { return this.#db.requireUnitOfWork(companyId).sql; }

  #read(companyId: CompanyId, sql: string, values: unknown[]): Promise<Row[]> {
    return this.#db.tenantTransaction(companyId, async (executor) => (await executor.query(sql, values)).rows);
  }

  async insert(reminder: Reminder): Promise<void> {
    await duplicateAs(this.#write(reminder.companyId).query(
      `INSERT INTO collection_reminders (company_id, id, branch_id, party_id, document_id, reminder_key, step_code, level, channel,
         audience, message, snapshot_as_of, document_number, document_value_paise, outstanding_paise, party_outstanding_paise,
         days_overdue, state, failure_reason, notification_id, scheduled_by, scheduled_at, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
      reminderValues(reminder),
    ));
  }

  async update(reminder: Reminder): Promise<void> {
    const updated = await duplicateAs(this.#write(reminder.companyId).query(
      `UPDATE collection_reminders SET branch_id = $3, party_id = $4, document_id = $5, reminder_key = $6, step_code = $7, level = $8,
         channel = $9, audience = $10, message = $11::jsonb, snapshot_as_of = $12, document_number = $13, document_value_paise = $14,
         outstanding_paise = $15, party_outstanding_paise = $16, days_overdue = $17, state = $18, failure_reason = $19,
         notification_id = $20, scheduled_by = $21, scheduled_at = $22, sent_at = $23
       WHERE company_id = $1 AND id = $2 RETURNING id`,
      reminderValues(reminder),
    ));
    if (updated.rows.length === 0) throw reminderNotFound();
  }

  async findByKey(companyId: CompanyId, key: string): Promise<Reminder | null> {
    const rows = await this.#read(companyId, `SELECT ${REMINDER_COLUMNS} FROM collection_reminders WHERE company_id = $1 AND reminder_key = $2`, [companyId, key]);
    return rows[0] === undefined ? null : toReminder(rows[0]);
  }

  async findById(companyId: CompanyId, id: string): Promise<Reminder | null> {
    // A malformed id cannot name a reminder; asking PostgreSQL would fail the whole unit of work.
    if (!UUID.test(id)) return null;
    const rows = await this.#read(companyId, `SELECT ${REMINDER_COLUMNS} FROM collection_reminders WHERE company_id = $1 AND id = $2`, [companyId, id]);
    return rows[0] === undefined ? null : toReminder(rows[0]);
  }

  async list(companyId: CompanyId, page?: Page): Promise<readonly Reminder[]> {
    if (page?.after !== undefined && !UUID.test(page.after)) return [];
    const after = page?.after === undefined ? '' :
      ` AND (scheduled_at, id) < (SELECT scheduled_at, id FROM collection_reminders WHERE company_id = $1 AND id = $2)`;
    const values = [companyId, ...(page?.after === undefined ? [] : [page.after])];
    const rows = await this.#read(companyId,
      `SELECT ${REMINDER_COLUMNS} FROM collection_reminders WHERE company_id = $1${after}
       ORDER BY scheduled_at DESC, id DESC${limitOf(page, values.length + 1)}`,
      [...values, ...pageValues(page)]);
    return rows.map(toReminder);
  }

  async savePreference(p: ContactPreference): Promise<void> {
    await this.#write(p.companyId).query(
      `INSERT INTO collection_preferences (company_id, party_id, channel, state, reason, recorded_by, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (company_id, party_id, channel) DO UPDATE
         SET state = EXCLUDED.state, reason = EXCLUDED.reason, recorded_by = EXCLUDED.recorded_by, recorded_at = EXCLUDED.recorded_at`,
      [p.companyId, p.partyId, p.channel, p.state, p.reason, p.recordedBy, p.recordedAt],
    );
  }

  async preferences(companyId: CompanyId, partyId: PartyId, page?: Page): Promise<readonly ContactPreference[]> {
    const after = page?.after === undefined ? '' : ' AND channel COLLATE "C" > $3';
    const values = [companyId, partyId, ...(page?.after === undefined ? [] : [page.after])];
    const rows = await this.#read(companyId,
      `SELECT company_id, party_id, channel, state, reason, recorded_by, recorded_at FROM collection_preferences
       WHERE company_id = $1 AND party_id = $2${after} ORDER BY channel COLLATE "C"${limitOf(page, values.length + 1)}`,
      [...values, ...pageValues(page)]);
    return rows.map((r): ContactPreference => ({
      companyId: r.company_id as CompanyId, partyId: r.party_id as PartyId, channel: r.channel as ContactPreference['channel'],
      state: r.state as ContactPreference['state'], reason: textOrNull(r.reason),
      recordedBy: r.recorded_by as ContactPreference['recordedBy'], recordedAt: iso(r.recorded_at),
    }));
  }

  async saveOptOut(o: OptOut): Promise<void> {
    await this.#write(o.companyId).query(
      `INSERT INTO collection_opt_outs (company_id, party_id, reason, recorded_by, recorded_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id, party_id) DO UPDATE
         SET reason = EXCLUDED.reason, recorded_by = EXCLUDED.recorded_by, recorded_at = EXCLUDED.recorded_at, ended_at = NULL`,
      [o.companyId, o.partyId, o.reason, o.recordedBy, o.recordedAt],
    );
  }

  /** Ends the opt-out rather than deleting it: the application role has no DELETE. */
  async removeOptOut(companyId: CompanyId, partyId: PartyId): Promise<void> {
    await this.#write(companyId).query(
      'UPDATE collection_opt_outs SET ended_at = now() WHERE company_id = $1 AND party_id = $2 AND ended_at IS NULL',
      [companyId, partyId],
    );
  }

  async optOut(companyId: CompanyId, partyId: PartyId): Promise<OptOut | null> {
    const rows = await this.#read(companyId,
      `SELECT company_id, party_id, reason, recorded_by, recorded_at FROM collection_opt_outs
       WHERE company_id = $1 AND party_id = $2 AND ended_at IS NULL`, [companyId, partyId]);
    const r = rows[0];
    return r === undefined ? null : {
      companyId: r.company_id as CompanyId, partyId: r.party_id as PartyId, reason: String(r.reason),
      recordedBy: r.recorded_by as OptOut['recordedBy'], recordedAt: iso(r.recorded_at),
    };
  }

  async savePromise(p: PromiseToPay): Promise<void> {
    await this.#write(p.companyId).query(
      `INSERT INTO collection_promises (id, company_id, party_id, document_id, amount_paise, promised_on, note, state, recorded_by, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET party_id = EXCLUDED.party_id, document_id = EXCLUDED.document_id,
         amount_paise = EXCLUDED.amount_paise, promised_on = EXCLUDED.promised_on, note = EXCLUDED.note, state = EXCLUDED.state,
         recorded_by = EXCLUDED.recorded_by, recorded_at = EXCLUDED.recorded_at
       WHERE collection_promises.company_id = EXCLUDED.company_id`,
      [p.id, p.companyId, p.partyId, p.documentId, p.amount.minor.toString(), p.promisedOn, p.note, p.state, p.recordedBy, p.recordedAt],
    );
  }

  promises(companyId: CompanyId, page?: Page): Promise<readonly PromiseToPay[]> {
    return this.#ascending(companyId, 'collection_promises', PROMISE_COLUMNS, 'recorded_at', page).then((rows) => rows.map(toPromise));
  }

  async saveDispute(d: Dispute): Promise<void> {
    await this.#write(d.companyId).query(
      `INSERT INTO collection_disputes (id, company_id, party_id, document_id, reason, state, resolution, raised_by, raised_at, resolved_by, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET party_id = EXCLUDED.party_id, document_id = EXCLUDED.document_id, reason = EXCLUDED.reason,
         state = EXCLUDED.state, resolution = EXCLUDED.resolution, raised_by = EXCLUDED.raised_by, raised_at = EXCLUDED.raised_at,
         resolved_by = EXCLUDED.resolved_by, resolved_at = EXCLUDED.resolved_at
       WHERE collection_disputes.company_id = EXCLUDED.company_id`,
      [d.id, d.companyId, d.partyId, d.documentId, d.reason, d.state, d.resolution, d.raisedBy, d.raisedAt, d.resolvedBy, d.resolvedAt],
    );
  }

  disputes(companyId: CompanyId, page?: Page): Promise<readonly Dispute[]> {
    return this.#ascending(companyId, 'collection_disputes', DISPUTE_COLUMNS, 'raised_at', page).then((rows) => rows.map(toDispute));
  }

  /** Promises and disputes: oldest first by their timestamp, then id. */
  async #ascending(companyId: CompanyId, table: string, columns: string, at: string, page?: Page): Promise<Row[]> {
    if (page?.after !== undefined && !UUID.test(page.after)) return [];
    const after = page?.after === undefined ? '' :
      ` AND (${at}, id) > (SELECT ${at}, id FROM ${table} WHERE company_id = $1 AND id = $2)`;
    const values = [companyId, ...(page?.after === undefined ? [] : [page.after])];
    return this.#read(companyId,
      `SELECT ${columns} FROM ${table} WHERE company_id = $1${after} ORDER BY ${at}, id${limitOf(page, values.length + 1)}`,
      [...values, ...pageValues(page)]);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
