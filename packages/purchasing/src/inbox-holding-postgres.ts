// Issue #488 — the inbox's pre-tenant holding in PostgreSQL, beside InMemoryInboxHolding
// (inbox-holding.ts). Lane owner: GPT 3.
//
// The application role has no privilege on the holding's tables. Every statement here is a call to
// one of the narrow functions of migration `…_inbox_holding`. The server's own steps (a document
// arriving, the scanner answering, the expiry) are plain calls on the pool, as the webhook events
// of #389 are. The three a business triggers — what is waiting for it, a look at one document, and
// taking it — run inside that company's transaction, because the functions read the company from
// `app.company_id` and never from an argument. The company id passed in is only used to open that
// transaction.

import type { SqlExecutor, TransactionalExecutor } from "../../platform/src/database.ts";
import type { Id } from "../../masters/src/types.ts";
import type { HeldDelivery, HeldRecord, HeldStatus, InboxHolding, WaitingItem } from "./inbox-holding.ts";
import { UNROUTED } from "./inbox-holding.ts";
import type { Attachment, InboundSender, IntakeChannel, QuarantineReason } from "./inbox-types.ts";

type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An id that is not an id finds nothing, as in memory, instead of failing inside PostgreSQL. */
const isUuid = (value: string): boolean => UUID.test(value);
const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));

/** What the holding keeps of a document besides its columns: sender, the file's facts and what a restart needs. */
interface Metadata {
  readonly sender: InboundSender;
  readonly attachment: Omit<Attachment, "storageKey">;
  readonly delivery: HeldDelivery;
}

const metadataOf = (record: HeldRecord): Metadata => {
  const { storageKey: _storageKey, ...attachment } = record.document.attachment;
  return { sender: record.document.sender, attachment, delivery: record.delivery };
};

const COLUMNS = "id, channel, message_key, intake_key, received_at, status, quarantine_reason, status_message, storage_key, metadata";

const recordOf = (row: Row): HeldRecord => {
  const metadata = row.metadata as Metadata;
  return {
    document: Object.freeze({
      id: String(row.id), companyId: UNROUTED, channel: row.channel as IntakeChannel, sender: metadata.sender,
      attachment: { ...metadata.attachment, storageKey: String(row.storage_key) },
      receivedAt: iso(row.received_at), status: row.status as HeldStatus, attempts: 1,
      ...(row.quarantine_reason === null ? {} : { quarantineReason: row.quarantine_reason as QuarantineReason }),
      ...(row.status_message === null ? {} : { statusMessage: String(row.status_message) }),
    }),
    keys: { messageKey: row.message_key === null ? null : String(row.message_key), intakeKey: String(row.intake_key) },
    delivery: metadata.delivery,
  };
};

export class PostgresInboxHolding implements InboxHolding {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) { this.#db = db; }

  async put(record: HeldRecord, owners: readonly Id[]): Promise<{ readonly record: HeldRecord; readonly created: boolean }> {
    const d = record.document;
    const { rows } = await this.#db.query(
      "SELECT purchase_holding_put($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid[], $11::jsonb) AS id",
      [d.id, d.channel, record.keys.messageKey, record.keys.intakeKey, d.receivedAt, d.status, d.quarantineReason ?? null, d.statusMessage ?? null,
        d.attachment.storageKey, [...owners], JSON.stringify(metadataOf(record))],
    );
    const kept = String((rows[0] as Row).id);
    if (kept === d.id) return { record, created: true };
    // Another copy of the same message got there first: it is the held document.
    return { record: await this.get(kept) as HeldRecord, created: false };
  }

  async save(record: HeldRecord, owners: readonly Id[], from?: { readonly status: HeldStatus; readonly quarantineReason?: QuarantineReason }): Promise<boolean> {
    const d = record.document;
    const { rows } = await this.#db.query(
      "SELECT purchase_holding_save($1, $2, $3, $4, $5::uuid[], $6::jsonb, $7, $8, $9) AS saved",
      [d.id, d.status, d.quarantineReason ?? null, d.statusMessage ?? null, [...owners], JSON.stringify(metadataOf(record)),
        from?.status ?? null, from?.quarantineReason ?? null, from !== undefined],
    );
    return (rows[0] as Row).saved === true;
  }

  async get(id: Id): Promise<HeldRecord | null> {
    if (!isUuid(id)) return null;
    const row = (await this.#db.query(`SELECT ${COLUMNS} FROM purchase_holding_get($1)`, [id])).rows[0];
    return row === undefined ? null : recordOf(row);
  }

  async byMessage(messageKey: string): Promise<HeldRecord | null> {
    const row = (await this.#db.query(`SELECT ${COLUMNS} FROM purchase_holding_get_by_message($1)`, [messageKey])).rows[0];
    return row === undefined ? null : recordOf(row);
  }

  async channelOwners(id: Id): Promise<readonly Id[]> {
    if (!isUuid(id)) return [];
    const { rows } = await this.#db.query("SELECT purchase_holding_channel_owners($1) AS owners", [id]);
    return ((rows[0] as Row).owners as string[]).map(String);
  }

  waitingFor(companyId: Id): Promise<readonly WaitingItem[]> {
    return this.#asCompany(companyId, async (sql) => {
      const { rows } = await sql.query("SELECT id, channel, received_at, file_name, size_bytes FROM purchase_holding_waiting()");
      return rows.map((row: Row) => ({
        id: String(row.id), channel: row.channel as IntakeChannel, receivedAt: iso(row.received_at), fileName: String(row.file_name), sizeBytes: Number(row.size_bytes),
      }));
    });
  }

  peek(companyId: Id, id: Id): Promise<HeldRecord | null> {
    if (!isUuid(id)) return Promise.resolve(null);
    return this.#asCompany(companyId, async (sql) => {
      const row = (await sql.query(`SELECT ${COLUMNS} FROM purchase_holding_peek($1)`, [id])).rows[0];
      return row === undefined ? null : recordOf(row);
    });
  }

  async claim(companyId: Id, id: Id): Promise<HeldRecord | null> {
    if (!isUuid(id)) return null;
    // Inside the caller's unit of work, so the removal commits with the move into the books.
    const row = (await this.#db.requireUnitOfWork(companyId).sql.query(`SELECT ${COLUMNS} FROM purchase_holding_claim($1)`, [id])).rows[0];
    return row === undefined ? null : recordOf(row);
  }

  async stalled(before: Date): Promise<readonly HeldRecord[]> {
    const { rows } = await this.#db.query(`SELECT ${COLUMNS} FROM purchase_holding_stalled($1)`, [before.toISOString()]);
    return rows.map(recordOf);
  }

  async expire(before: Date): Promise<readonly { readonly id: Id; readonly storageKey: string }[]> {
    const { rows } = await this.#db.query("SELECT id, storage_key FROM purchase_holding_expire($1)", [before.toISOString()]);
    return rows.map((row: Row) => ({ id: String(row.id), storageKey: String(row.storage_key) }));
  }

  #asCompany<T>(companyId: Id, work: (sql: SqlExecutor) => Promise<T>): Promise<T> {
    return this.#db.tenantTransaction(companyId, work);
  }
}
