/**
 * Issue #366 — the subscription stores on PostgreSQL, beside the in-memory ones in `repository.ts`.
 *
 * Built on the transaction executor of #363 (docs/contracts/unit-of-work-v1.md): every write joins
 * the caller's unit of work (`requireUnitOfWork`) and never opens a transaction of its own, so a
 * write outside one throws `NO_UNIT_OF_WORK`; every read runs in `tenantTransaction`. Every query
 * names `company_id` as well as relying on row-level security.
 *
 * `record` keeps the concurrency guarantee of the port: the unique index on
 * `(company_id, idempotency_key)` decides whether an event is counted, in one insert, and the
 * company's write lock (taken by `unitOfWork`) means the total read straight after is exact.
 */
import { conflict, money, type IsoDate } from '@invoice/kernel';
import type { SqlExecutor, TransactionalExecutor } from '../../platform/src/database.ts';
import type { MeterId, ServiceInvoice, Subscription, UsageEvent } from './model.ts';
import type { Page, ServiceInvoiceRepository, SubscriptionRepository, UsageRepository } from './ports.ts';
import { SERVICE_INVOICE_DUPLICATE_PERIOD } from './repository.ts';

type Row = Record<string, unknown>;
const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));
const orNull = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
/** Ids are uuids in PostgreSQL. Anything else cannot be a row here, so it finds nothing — as in memory — rather than failing the cast. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const code = (error: unknown): string | undefined => (error as { code?: string }).code;

/** A limit the database can be handed: a positive whole number, never a value from outside unchecked. */
const limitOf = (page: Page): number => {
  if (!Number.isSafeInteger(page.limit) || page.limit < 1) throw new RangeError('A page needs a limit of at least one row.');
  return page.limit;
};

const SUBSCRIPTION_COLUMNS = `id, company_id, plan_id, started_on::text AS started_on, trial_ends_on::text AS trial_ends_on,
  paid_through::text AS paid_through, cancelled_on::text AS cancelled_on, cancellation_reason, history, updated_at, updated_by`;

const toSubscription = (r: Row): Subscription => ({
  id: String(r.id),
  companyId: String(r.company_id),
  planId: String(r.plan_id),
  startedOn: String(r.started_on) as IsoDate,
  trialEndsOn: String(r.trial_ends_on) as IsoDate,
  paidThrough: orNull(r.paid_through) as IsoDate | null,
  cancelledOn: orNull(r.cancelled_on) as IsoDate | null,
  cancellationReason: orNull(r.cancellation_reason),
  history: r.history as Subscription['history'],
  updatedAt: iso(r.updated_at),
  updatedBy: String(r.updated_by),
});

export class PostgresSubscriptionRepository implements SubscriptionRepository {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  /** One subscription per company, replaced whole — as the in-memory store's `Map.set` does. */
  async save(s: Subscription): Promise<void> {
    try {
      await this.#db.requireUnitOfWork(s.companyId).sql.query(
        `INSERT INTO subscriptions (id, company_id, plan_id, started_on, trial_ends_on, paid_through, cancelled_on,
           cancellation_reason, history, updated_at, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
         ON CONFLICT (company_id) DO UPDATE SET id = EXCLUDED.id, plan_id = EXCLUDED.plan_id, started_on = EXCLUDED.started_on,
           trial_ends_on = EXCLUDED.trial_ends_on, paid_through = EXCLUDED.paid_through, cancelled_on = EXCLUDED.cancelled_on,
           cancellation_reason = EXCLUDED.cancellation_reason, history = EXCLUDED.history, updated_at = EXCLUDED.updated_at,
           updated_by = EXCLUDED.updated_by
         WHERE subscriptions.company_id = $2`,
        [s.id, s.companyId, s.planId, s.startedOn, s.trialEndsOn, s.paidThrough, s.cancelledOn, s.cancellationReason,
          JSON.stringify(s.history), s.updatedAt, s.updatedBy],
      );
    } catch (error) {
      // Only the primary key is left to collide: another company's subscription already has this id.
      if (code(error) === '23505') throw conflict('SUBSCRIPTION_DUPLICATE', 'This subscription has already been recorded.');
      throw error;
    }
  }

  find(companyId: string): Promise<Subscription | null> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const { rows } = await sql.query(`SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions WHERE company_id = $1`, [companyId]);
      return rows[0] === undefined ? null : toSubscription(rows[0]);
    });
  }
}

const USAGE_COLUMNS = 'id, company_id, meter, quantity, period, idempotency_key, note, recorded_at, recorded_by';

const toUsage = (r: Row): UsageEvent => ({
  id: String(r.id),
  companyId: String(r.company_id),
  meter: r.meter as MeterId,
  quantity: BigInt(String(r.quantity)),
  period: String(r.period),
  idempotencyKey: String(r.idempotency_key),
  at: iso(r.recorded_at),
  by: String(r.recorded_by),
  note: String(r.note),
});

const totalOf = async (sql: SqlExecutor, companyId: string, meter: MeterId, period: string): Promise<bigint> => {
  // Served by subscription_usage_period_idx (company_id, meter, period).
  const { rows } = await sql.query(
    `SELECT COALESCE(SUM(quantity), 0)::text AS total FROM subscription_usage_events WHERE company_id = $1 AND meter = $2 AND period = $3`,
    [companyId, meter, period],
  );
  return BigInt(String(rows[0]?.total ?? '0'));
};

export class PostgresUsageRepository implements UsageRepository {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  async record(event: UsageEvent): Promise<{ counted: boolean; total: bigint }> {
    const { sql } = this.#db.requireUnitOfWork(event.companyId);
    let inserted: Row[];
    try {
      ({ rows: inserted } = await sql.query(
        `INSERT INTO subscription_usage_events (id, company_id, meter, quantity, period, idempotency_key, note, recorded_at, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (company_id, idempotency_key) DO NOTHING RETURNING id`,
        [event.id, event.companyId, event.meter, event.quantity.toString(), event.period, event.idempotencyKey, event.note, event.at, event.by],
      ));
    } catch (error) {
      // The key was not seen, but the event id was: the same event recorded under a second key.
      if (code(error) === '23505') throw conflict('USAGE_EVENT_DUPLICATE', 'This usage event has already been recorded.');
      throw error;
    }
    return { counted: inserted.length === 1, total: await totalOf(sql, event.companyId, event.meter, event.period) };
  }

  total(companyId: string, meter: MeterId, period: string): Promise<bigint> {
    return this.#db.tenantTransaction(companyId, (sql) => totalOf(sql, companyId, meter, period));
  }

  events(companyId: string, period: string, page?: Page): Promise<readonly UsageEvent[]> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      // Served by subscription_usage_events_page_idx (company_id, period, recorded_at, id).
      const values: unknown[] = [companyId, period];
      let where = '';
      let limit = '';
      if (page !== undefined) {
        values.push(limitOf(page));
        limit = 'LIMIT $3';
        if (page.after !== undefined) {
          if (!UUID.test(page.after)) return [];
          values.push(page.after);
          where = `AND (recorded_at, id) > (SELECT recorded_at, id FROM subscription_usage_events WHERE company_id = $1 AND id = $4)`;
        }
      }
      const { rows } = await sql.query(
        `SELECT ${USAGE_COLUMNS} FROM subscription_usage_events WHERE company_id = $1 AND period = $2 ${where}
          ORDER BY recorded_at, id ${limit}`,
        values,
      );
      return rows.map(toUsage);
    });
  }
}

const INVOICE_COLUMNS = `id, company_id, plan_id, period, net_paise, gst_paise, total_paise, state, issued_on::text AS issued_on,
  due_on::text AS due_on, paid_on::text AS paid_on, provider_reference, failure_reason`;

const toInvoice = (r: Row): ServiceInvoice => ({
  id: String(r.id),
  companyId: String(r.company_id),
  planId: String(r.plan_id),
  period: String(r.period),
  net: money(BigInt(String(r.net_paise))),
  gst: money(BigInt(String(r.gst_paise))),
  total: money(BigInt(String(r.total_paise))),
  state: r.state as ServiceInvoice['state'],
  issuedOn: String(r.issued_on) as IsoDate,
  dueOn: String(r.due_on) as IsoDate,
  paidOn: orNull(r.paid_on) as IsoDate | null,
  providerReference: orNull(r.provider_reference),
  failureReason: orNull(r.failure_reason),
});

export class PostgresServiceInvoiceRepository implements ServiceInvoiceRepository {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  /**
   * Saves the whole invoice, as the in-memory store does. Once it is ISSUED, PAID or FAILED the
   * freeze trigger of #368 lets only the state (never back to DRAFT), `paid_on`,
   * `provider_reference` and `failure_reason` change — which is everything `#settle` and `#fail`
   * in the service change — and refuses the rest with 23001.
   */
  async save(i: ServiceInvoice): Promise<void> {
    let saved: Row[];
    try {
      ({ rows: saved } = await this.#db.requireUnitOfWork(i.companyId).sql.query(
        `INSERT INTO subscription_service_invoices (id, company_id, plan_id, period, net_paise, gst_paise, total_paise, state,
           issued_on, due_on, paid_on, provider_reference, failure_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO UPDATE SET plan_id = EXCLUDED.plan_id, period = EXCLUDED.period, net_paise = EXCLUDED.net_paise,
           gst_paise = EXCLUDED.gst_paise, total_paise = EXCLUDED.total_paise, state = EXCLUDED.state, issued_on = EXCLUDED.issued_on,
           due_on = EXCLUDED.due_on, paid_on = EXCLUDED.paid_on, provider_reference = EXCLUDED.provider_reference,
           failure_reason = EXCLUDED.failure_reason
         WHERE subscription_service_invoices.company_id = $2
         RETURNING id`,
        [i.id, i.companyId, i.planId, i.period, i.net.minor.toString(), i.gst.minor.toString(), i.total.minor.toString(), i.state,
          i.issuedOn, i.dueOn, i.paidOn, i.providerReference, i.failureReason],
      ));
    } catch (error) {
      if (code(error) === '23505') throw SERVICE_INVOICE_DUPLICATE_PERIOD();
      if (code(error) === '23001') {
        throw conflict('SERVICE_INVOICE_FROZEN', 'This subscription invoice has been issued, so its amounts and dates can no longer change.');
      }
      throw error;
    }
    // The id is already another company's invoice: nothing was written, and saying so is the only honest answer.
    if (saved.length === 0) throw conflict('SERVICE_INVOICE_DUPLICATE', 'This subscription invoice has already been recorded.');
  }

  async find(companyId: string, id: string): Promise<ServiceInvoice | null> {
    if (!UUID.test(id)) return null;
    return (await this.#select(companyId, 'AND id = $2', [id]))[0] ?? null;
  }

  async findForPeriod(companyId: string, period: string): Promise<ServiceInvoice | null> {
    return (await this.#select(companyId, 'AND period = $2', [period]))[0] ?? null;
  }

  list(companyId: string, page?: Page): Promise<readonly ServiceInvoice[]> {
    if (page === undefined) return this.#select(companyId, '', []);
    // Served by subscription_invoice_period_idx (company_id, period); a period is unique per company.
    const limit = `LIMIT ${limitOf(page)}`;
    if (page.after === undefined) return this.#select(companyId, '', [], limit);
    if (!UUID.test(page.after)) return Promise.resolve([]);
    return this.#select(companyId, 'AND period < (SELECT period FROM subscription_service_invoices WHERE company_id = $1 AND id = $2)', [page.after], limit);
  }

  #select(companyId: string, where: string, values: unknown[], limit = ''): Promise<ServiceInvoice[]> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const { rows } = await sql.query(
        `SELECT ${INVOICE_COLUMNS} FROM subscription_service_invoices WHERE company_id = $1 ${where} ORDER BY period DESC ${limit}`,
        [companyId, ...values],
      );
      return rows.map(toInvoice);
    });
  }
}
