/**
 * Issue #366 — the notification records of #39 in PostgreSQL: `notifications`,
 * `notification_delivery_events` and `notification_preferences`.
 *
 * It implements `NotificationStore` and behaves as `InMemoryNotificationStore` does; one contract
 * suite runs against both (test/notification-store-contract.ts). Built on the transaction executor,
 * it never opens a transaction of its own: every write joins the action's unit of work
 * (`requireUnitOfWork`, which throws `NO_UNIT_OF_WORK` when none is open), every read runs in
 * `tenantTransaction`, and every query names its company as well as relying on row-level security.
 * Contracts: docs/contracts/unit-of-work-v1.md, database-immutability-v1.md, notification-v1.md.
 */
import type { TransactionalExecutor } from "./database.ts";
import { notificationDuplicate, notificationNotFound } from "./notifications.ts";
import type { Notification, NotificationChannel, NotificationDeliveryEvent, NotificationPage, NotificationPreference, NotificationStore } from "./notifications.ts";
import type { Id } from "./types.ts";

type Row = Record<string, unknown>;

/** An id the database cannot hold is one it does not have; asking would spoil the action's transaction. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** jsonb with bigint kept exact: `{ "$bigint": "5000001" }` on the way in, a bigint on the way out. */
const json = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? { $bigint: item.toString() } : item));
const revive = (value: unknown): unknown => JSON.parse(JSON.stringify(value), (_key, item: unknown) =>
  item !== null && typeof item === "object" && "$bigint" in item ? BigInt((item as { $bigint: string }).$bigint) : item);
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
};
const at = (ms: number): string => new Date(ms).toISOString();
const ms = (value: unknown): number => (value as Date).getTime();

const NOTIFICATION = `n.id, n.company_id, n.recipient_id, n.recipient_role, n.channel, n.template, n.locale, n.sensitivity, n.payload,
  n.deduplication_key, n.scheduled_at, n.status, n.attempts, n.last_error`;
const toNotification = (r: Row): Notification => Object.freeze({
  id: String(r.id), companyId: String(r.company_id), recipientId: String(r.recipient_id),
  recipientRole: r.recipient_role as Notification["recipientRole"], channel: r.channel as Notification["channel"],
  template: String(r.template), locale: r.locale as Notification["locale"], sensitivity: r.sensitivity as Notification["sensitivity"],
  payload: deepFreeze(revive(r.payload) as Record<string, unknown>), deduplicationKey: String(r.deduplication_key),
  scheduledAt: ms(r.scheduled_at), status: r.status as Notification["status"], attempts: Number(r.attempts),
  ...(r.last_error === null ? {} : { lastError: String(r.last_error) }),
});

const EVENT = "e.id, e.notification_id, e.company_id, e.actor_id, e.event_type, e.occurred_at, e.detail";
const toEvent = (r: Row): NotificationDeliveryEvent => Object.freeze({
  id: String(r.id), notificationId: String(r.notification_id), companyId: String(r.company_id), actorId: String(r.actor_id),
  type: r.event_type as NotificationDeliveryEvent["type"], occurredAt: ms(r.occurred_at),
  ...(r.detail === null ? {} : { detail: String(r.detail) }),
});

const toPreference = (r: Row): NotificationPreference => Object.freeze({
  companyId: String(r.company_id), recipientId: String(r.recipient_id), channel: r.channel as NotificationChannel, enabled: Boolean(r.enabled),
  ...(r.quiet_from_hour === null ? {} : { quietFromHour: Number(r.quiet_from_hour) }),
  ...(r.quiet_to_hour === null ? {} : { quietToHour: Number(r.quiet_to_hour) }),
  ...(r.time_zone === null ? {} : { timeZone: String(r.time_zone) }),
});

export class PostgresNotificationStore implements NotificationStore {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  async insert(n: Notification): Promise<void> {
    const { sql } = this.#db.requireUnitOfWork(n.companyId);
    // DO NOTHING rather than a unique violation, so a refused insert leaves the action's transaction usable.
    const { rows } = await sql.query(
      `INSERT INTO notifications (id, company_id, recipient_id, recipient_role, channel, template, locale, sensitivity, payload,
         deduplication_key, scheduled_at, status, attempts, last_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::timestamptz, $12, $13, $14)
       ON CONFLICT DO NOTHING RETURNING id`,
      [n.id, n.companyId, n.recipientId, n.recipientRole, n.channel, n.template, n.locale, n.sensitivity, json(n.payload),
        n.deduplicationKey, at(n.scheduledAt), n.status, n.attempts, n.lastError ?? null],
    );
    if (rows.length === 0) throw notificationDuplicate();
  }

  async update(n: Notification): Promise<void> {
    const { sql } = this.#db.requireUnitOfWork(n.companyId);
    if (!UUID.test(n.id)) throw notificationNotFound();
    const clash = await this.findByDeduplicationKey(n.companyId, n.deduplicationKey);
    if (clash && clash.id !== n.id) throw notificationDuplicate();
    const { rows } = await sql.query(
      `UPDATE notifications SET recipient_id = $3, recipient_role = $4, channel = $5, template = $6, locale = $7, sensitivity = $8,
         payload = $9::jsonb, deduplication_key = $10, scheduled_at = $11::timestamptz, status = $12, attempts = $13, last_error = $14
       WHERE company_id = $1 AND id = $2 RETURNING id`,
      [n.companyId, n.id, n.recipientId, n.recipientRole, n.channel, n.template, n.locale, n.sensitivity, json(n.payload),
        n.deduplicationKey, at(n.scheduledAt), n.status, n.attempts, n.lastError ?? null],
    );
    if (rows.length === 0) throw notificationNotFound();
  }

  async find(companyId: Id, id: Id): Promise<Notification | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.#db.tenantTransaction(companyId, (sql) => sql.query(
      `SELECT ${NOTIFICATION} FROM notifications n WHERE n.company_id = $1 AND n.id = $2`, [companyId, id]));
    return rows[0] ? toNotification(rows[0]) : null;
  }

  async findByDeduplicationKey(companyId: Id, key: string): Promise<Notification | null> {
    const { rows } = await this.#db.tenantTransaction(companyId, (sql) => sql.query(
      `SELECT ${NOTIFICATION} FROM notifications n WHERE n.company_id = $1 AND n.deduplication_key = $2`, [companyId, key]));
    return rows[0] ? toNotification(rows[0]) : null;
  }

  async due(companyId: Id, when: number, page?: NotificationPage): Promise<readonly Notification[]> {
    if (page?.after !== undefined && !UUID.test(page.after)) return [];
    // The cursor is the last row's place in the order of writing, whatever its status is now.
    const { rows } = await this.#db.tenantTransaction(companyId, (sql) => sql.query(
      `SELECT ${NOTIFICATION} FROM notifications n
        WHERE n.company_id = $1 AND n.status = 'scheduled' AND n.scheduled_at <= $2::timestamptz
          AND ($3::uuid IS NULL OR n.seq > (SELECT p.seq FROM notifications p WHERE p.company_id = $1 AND p.id = $3::uuid))
        ORDER BY n.seq LIMIT $4::int`,
      [companyId, at(when), page?.after ?? null, page?.limit ?? null]));
    return rows.map(toNotification);
  }

  async appendEvent(e: NotificationDeliveryEvent): Promise<void> {
    const { sql } = this.#db.requireUnitOfWork(e.companyId);
    if (!UUID.test(e.notificationId)) throw notificationNotFound();
    const { rows } = await sql.query(
      `INSERT INTO notification_delivery_events (id, notification_id, company_id, actor_id, event_type, occurred_at, detail)
       SELECT $1, n.id, n.company_id, $3, $4, $5::timestamptz, $6 FROM notifications n WHERE n.company_id = $2 AND n.id = $7::uuid
       ON CONFLICT DO NOTHING RETURNING id`,
      [e.id, e.companyId, e.actorId, e.type, at(e.occurredAt), e.detail ?? null, e.notificationId],
    );
    if (rows.length === 0) throw (await this.find(e.companyId, e.notificationId)) ? notificationDuplicate() : notificationNotFound();
  }

  async events(companyId: Id, notificationId: Id, page?: NotificationPage): Promise<readonly NotificationDeliveryEvent[]> {
    if (!UUID.test(notificationId) || (page?.after !== undefined && !UUID.test(page.after))) return [];
    const { rows } = await this.#db.tenantTransaction(companyId, (sql) => sql.query(
      `SELECT ${EVENT} FROM notification_delivery_events e
        WHERE e.company_id = $1 AND e.notification_id = $2
          AND ($3::uuid IS NULL OR e.seq > (SELECT p.seq FROM notification_delivery_events p WHERE p.company_id = $1 AND p.notification_id = $2 AND p.id = $3::uuid))
        ORDER BY e.seq LIMIT $4::int`,
      [companyId, notificationId, page?.after ?? null, page?.limit ?? null]));
    return rows.map(toEvent);
  }

  async savePreference(p: NotificationPreference): Promise<void> {
    const { sql } = this.#db.requireUnitOfWork(p.companyId);
    await sql.query(
      `INSERT INTO notification_preferences (company_id, recipient_id, channel, enabled, quiet_from_hour, quiet_to_hour, time_zone)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (company_id, recipient_id, channel) DO UPDATE
         SET enabled = EXCLUDED.enabled, quiet_from_hour = EXCLUDED.quiet_from_hour, quiet_to_hour = EXCLUDED.quiet_to_hour, time_zone = EXCLUDED.time_zone`,
      [p.companyId, p.recipientId, p.channel, p.enabled, p.quietFromHour ?? null, p.quietToHour ?? null, p.timeZone ?? null],
    );
  }

  async preference(companyId: Id, recipientId: Id, channel: NotificationChannel): Promise<NotificationPreference | null> {
    const { rows } = await this.#db.tenantTransaction(companyId, (sql) => sql.query(
      `SELECT company_id, recipient_id, channel, enabled, quiet_from_hour, quiet_to_hour, time_zone
         FROM notification_preferences WHERE company_id = $1 AND recipient_id = $2 AND channel = $3`, [companyId, recipientId, channel]));
    return rows[0] ? toPreference(rows[0]) : null;
  }
}
