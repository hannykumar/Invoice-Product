// Issue #366 — the purchase inbox's routed documents in PostgreSQL, beside InMemoryInboxStore
// (inbox-store.ts). Lane owner: GPT 3.
//
// The rules of docs/contracts/unit-of-work-v1.md: a write joins the unit of work the caller opened
// for the document's company (`requireUnitOfWork`, `NO_UNIT_OF_WORK` otherwise) and never opens
// one; a read runs in `tenantTransaction` and names `company_id` as well. Tables and freeze rules:
// inbox-migrations.ts.

import type { SqlExecutor, TransactionalExecutor } from "../../platform/src/database.ts";
import type { Id } from "../../masters/src/types.ts";
import { pageLimit, type Page } from "./paging.ts";
import {
  inboxDocumentAlreadyStored, inboxDocumentNotFound, inboxDraftAlreadyStored, type InboxDocumentKeys, type InboxStore,
} from "./inbox-store.ts";
import type { ExtractionDraft, InboundDocument, InboundSender, InboundStatus, QuarantineReason, RoutingDecision } from "./inbox-types.ts";

type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An id that is not an id finds nothing, as in memory, instead of failing inside PostgreSQL. */
const isUuid = (value: string): boolean => UUID.test(value);
/** A timestamp as the service writes it: `toISOString()`, to the millisecond. */
const iso = (column: string): string => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${column}`;
const opt = <K extends string, V>(key: K, value: V | null | undefined): Partial<Record<K, V>> =>
  (value === null || value === undefined ? {} : { [key]: value } as Record<K, V>);

/** Paise inside the draft's jsonb travel as `{"$bigint":"…"}`, so no figure ever passes through a float. */
const toJson = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? { $bigint: item.toString() } : item));
const fromJson = (text: string): unknown => JSON.parse(text, (_key, item: unknown) => {
  if (item !== null && typeof item === "object" && !Array.isArray(item)) {
    const tagged = item as Record<string, unknown>;
    if (typeof tagged.$bigint === "string" && Object.keys(tagged).length === 1) return BigInt(tagged.$bigint);
  }
  return item;
});

const DOCUMENT = `id, company_id, branch_id, channel, sender::text AS sender, attachment_id, file_name, declared_mime_type, size_bytes,
  sha256, storage_key, page_count, ${iso("received_at")}, status, quarantine_reason, status_message, duplicate_of_id, attempts,
  routing::text AS routing`;

const documentOf = (r: Row): InboundDocument => Object.freeze({
  id: String(r.id), companyId: String(r.company_id), ...opt("branchId", r.branch_id as string | null),
  channel: r.channel as InboundDocument["channel"], sender: fromJson(String(r.sender)) as InboundSender,
  attachment: {
    id: String(r.attachment_id), fileName: String(r.file_name), declaredMimeType: String(r.declared_mime_type),
    sizeBytes: Number(r.size_bytes), sha256: String(r.sha256), storageKey: String(r.storage_key),
    ...opt("pageCount", r.page_count === null ? null : Number(r.page_count)),
  },
  receivedAt: String(r.received_at), status: r.status as InboundStatus,
  ...opt("quarantineReason", r.quarantine_reason as QuarantineReason | null), ...opt("statusMessage", r.status_message as string | null),
  ...opt("duplicateOfId", r.duplicate_of_id as string | null), attempts: Number(r.attempts),
  ...opt("routing", r.routing === null ? null : fromJson(String(r.routing)) as RoutingDecision),
}) as InboundDocument;

const draftOf = (r: Row): ExtractionDraft => Object.freeze({
  ...(fromJson(String(r.body)) as object),
  id: String(r.id), companyId: String(r.company_id), documentId: String(r.document_id),
  source: r.source as ExtractionDraft["source"], createdAt: String(r.created_at),
}) as ExtractionDraft;

/** A unique-key refusal becomes the in-memory store's error; anything else is rethrown untouched. */
const refuse = (duplicate: () => Error) => (error: unknown): never => {
  throw (error as { code?: string }).code === "23505" ? duplicate() : error;
};

export class PostgresInboxStore implements InboxStore {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) { this.#db = db; }

  #write(companyId: Id): SqlExecutor { return this.#db.requireUnitOfWork(companyId).sql; }

  async insertDocument(document: InboundDocument, keys: InboxDocumentKeys): Promise<void> {
    const a = document.attachment;
    await this.#write(document.companyId).query(
      `INSERT INTO purchase_inbox_documents (id, company_id, branch_id, channel, sender, attachment_id, file_name, declared_mime_type,
         size_bytes, sha256, storage_key, page_count, received_at, status, quarantine_reason, status_message, duplicate_of_id, attempts,
         routing, message_key, intake_key)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20, $21)`,
      [document.id, document.companyId, document.branchId ?? null, document.channel, toJson(document.sender), a.id, a.fileName,
        a.declaredMimeType, String(a.sizeBytes), a.sha256, a.storageKey, a.pageCount ?? null, document.receivedAt, document.status,
        document.quarantineReason ?? null, document.statusMessage ?? null, document.duplicateOfId ?? null, document.attempts,
        document.routing === undefined ? null : toJson(document.routing), keys.messageKey, keys.intakeKey],
    ).catch(refuse(inboxDocumentAlreadyStored));
  }

  /** Sets only the columns the application may change (the others are not even granted). */
  async updateDocument(document: InboundDocument): Promise<void> {
    const { rows } = await this.#write(document.companyId).query(
      `UPDATE purchase_inbox_documents SET status = $3, quarantine_reason = $4, status_message = $5, duplicate_of_id = $6, attempts = $7,
         routing = $8::jsonb
       WHERE company_id = $1 AND id = $2 RETURNING id`,
      [document.companyId, document.id, document.status, document.quarantineReason ?? null, document.statusMessage ?? null,
        document.duplicateOfId ?? null, document.attempts, document.routing === undefined ? null : toJson(document.routing)],
    );
    if (rows.length === 0) throw inboxDocumentNotFound();
  }

  async document(companyId: Id, id: Id): Promise<InboundDocument | null> {
    if (!isUuid(id)) return null;
    return (await this.#documents(companyId, "AND id = $2", [id]))[0] ?? null;
  }

  documents(companyId: Id, status?: InboundStatus, page?: Page): Promise<readonly InboundDocument[]> {
    const values: unknown[] = [];
    let where = "";
    if (status !== undefined) { values.push(status); where += ` AND status = $${values.length + 1}`; }
    // Qualified, so the order is the timestamp column and not the text it is selected as.
    let tail = "ORDER BY purchase_inbox_documents.received_at, id";
    if (page !== undefined) {
      if (page.after !== undefined) {
        if (!isUuid(page.after)) return Promise.resolve([]);
        values.push(page.after);
        // A cursor that names no row of this list gives nothing, as in memory.
        where += ` AND (purchase_inbox_documents.received_at, id) > (SELECT c.received_at, c.id FROM purchase_inbox_documents c WHERE c.company_id = $1 AND c.id = $${values.length + 1}::uuid)`;
      }
      values.push(pageLimit(page));
      tail += ` LIMIT $${values.length + 1}`;
    }
    return this.#documents(companyId, `${where} ${tail}`, values);
  }

  async documentByMessageKey(companyId: Id, messageKey: string): Promise<InboundDocument | null> {
    return (await this.#documents(companyId, "AND message_key = $2", [messageKey]))[0] ?? null;
  }

  intakeKey(companyId: Id, documentId: Id): Promise<string | null> {
    if (!isUuid(documentId)) return Promise.resolve(null);
    return this.#read(companyId, async (sql) => {
      const row = (await sql.query("SELECT intake_key FROM purchase_inbox_documents WHERE company_id = $1 AND id = $2", [companyId, documentId])).rows[0];
      return row === undefined ? null : String(row.intake_key);
    });
  }

  /**
   * One statement: take the file if nobody in this company has it, and say who does. Runs inside
   * the unit of work, whose per-company lock means no other claim on this company is in flight.
   */
  async claimContent(companyId: Id, sha256: string, documentId: Id): Promise<Id> {
    const { rows } = await this.#write(companyId).query(
      `WITH taken AS (
         INSERT INTO purchase_inbox_contents (company_id, sha256, document_id)
         SELECT $1, $2, d.id FROM purchase_inbox_documents d WHERE d.company_id = $1 AND d.id = $3
         ON CONFLICT (company_id, sha256) DO NOTHING
         RETURNING document_id)
       SELECT document_id FROM taken
       UNION ALL
       SELECT document_id FROM purchase_inbox_contents WHERE company_id = $1 AND sha256 = $2
       LIMIT 1`,
      [companyId, sha256, isUuid(documentId) ? documentId : null],
    );
    if (rows[0] === undefined) throw inboxDocumentNotFound();
    return String(rows[0].document_id);
  }

  async insertDraft(draft: ExtractionDraft): Promise<void> {
    const { id, companyId, documentId, source, createdAt, ...body } = draft;
    const { rows } = await this.#write(companyId).query(
      `INSERT INTO purchase_inbox_drafts (id, company_id, document_id, source, body, created_at)
       SELECT $1, $2, d.id, $4, $5::jsonb, $6 FROM purchase_inbox_documents d WHERE d.company_id = $2 AND d.id = $3
       RETURNING id`,
      [id, companyId, isUuid(documentId) ? documentId : null, source, toJson(body), createdAt],
    ).catch(refuse(inboxDraftAlreadyStored));
    if (rows.length === 0) throw inboxDocumentNotFound();
  }

  draftFor(companyId: Id, documentId: Id): Promise<ExtractionDraft | null> {
    if (!isUuid(documentId)) return Promise.resolve(null);
    return this.#read(companyId, async (sql) => {
      const row = (await sql.query(
        `SELECT id, company_id, document_id, source, body::text AS body, ${iso("created_at")}
           FROM purchase_inbox_drafts WHERE company_id = $1 AND document_id = $2`,
        [companyId, documentId],
      )).rows[0];
      return row === undefined ? null : draftOf(row);
    });
  }

  #read<T>(companyId: Id, work: (sql: SqlExecutor) => Promise<T>): Promise<T> {
    return this.#db.tenantTransaction(companyId, work);
  }

  #documents(companyId: Id, rest: string, values: readonly unknown[]): Promise<InboundDocument[]> {
    return this.#read(companyId, async (sql) => {
      const { rows } = await sql.query(`SELECT ${DOCUMENT} FROM purchase_inbox_documents WHERE company_id = $1 ${rest}`, [companyId, ...values]);
      return rows.map(documentOf);
    });
  }
}
