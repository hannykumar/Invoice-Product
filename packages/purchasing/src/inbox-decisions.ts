// Issue #489 — what a person decided about a document in the purchase inbox.
//
// A document that reached `draft_ready` is frozen by the database (inbox-migrations.ts), so
// "this became bill X" and "this was set aside, because …" cannot be a status on the document.
// They are kept here instead: one decision per document, written once, never changed, and
// scoped to the company like the document itself. The inbox still posts nothing — a "billed"
// decision is only the note that the purchase flow (#16 checks, #17 posts) recorded a bill.

import { conflict } from "@invoice/kernel";
import type { SqlExecutor, TransactionalExecutor } from "../../platform/src/database.ts";
import type { Id } from "../../masters/src/types.ts";

export type InboxDecisionKind = "billed" | "rejected";

export interface InboxDecision {
  readonly companyId: Id;
  readonly documentId: Id;
  readonly kind: InboxDecisionKind;
  /** Why a document was set aside. Always present on a rejection. */
  readonly reason?: string;
  /** The supplier's bill number it was recorded as. Always present on a bill. */
  readonly billNumber?: string;
  readonly supplierName?: string;
  readonly decidedBy: Id;
  readonly decidedAt: string;
}

export interface InboxDecisionStore {
  /**
   * Keeps the first decision for a document. A second decision of the same kind returns the first
   * (pressing Record twice is one bill); a different kind is refused — a bill is not un-billed,
   * and a rejected document is not billed.
   */
  record(decision: InboxDecision): Promise<InboxDecision>;
  forDocuments(companyId: Id, documentIds: readonly Id[]): Promise<ReadonlyMap<Id, InboxDecision>>;
}

export const inboxAlreadyDecided = (existing: InboxDecision) =>
  conflict("INBOX_ALREADY_DECIDED", existing.kind === "billed"
    ? `This document was already recorded as bill ${existing.billNumber ?? ""}.`.replace(" .", ".")
    : "This document was already set aside, so it cannot be recorded as a bill.");

const check = (decision: InboxDecision): void => {
  if (decision.kind === "rejected" && !(decision.reason ?? "").trim()) throw new Error("A rejection needs a reason.");
  if (decision.kind === "billed" && !(decision.billNumber ?? "").trim()) throw new Error("A recorded bill needs its bill number.");
};

const settle = (existing: InboxDecision | undefined, decision: InboxDecision): InboxDecision => {
  if (existing === undefined) return decision;
  if (existing.kind !== decision.kind) throw inboxAlreadyDecided(existing);
  return existing;
};

export class InMemoryInboxDecisionStore implements InboxDecisionStore {
  readonly #decisions = new Map<string, InboxDecision>();

  async record(decision: InboxDecision): Promise<InboxDecision> {
    check(decision);
    const key = `${decision.companyId}:${decision.documentId}`;
    const kept = settle(this.#decisions.get(key), decision);
    this.#decisions.set(key, kept);
    return kept;
  }

  async forDocuments(companyId: Id, documentIds: readonly Id[]): Promise<ReadonlyMap<Id, InboxDecision>> {
    const found = new Map<Id, InboxDecision>();
    for (const id of documentIds) {
      const decision = this.#decisions.get(`${companyId}:${id}`);
      if (decision !== undefined) found.set(id, decision);
    }
    return found;
  }
}

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = `company_id, document_id, kind, reason, bill_number, supplier_name, decided_by,
  to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at`;
const decisionOf = (r: Row): InboxDecision => Object.freeze({
  companyId: String(r.company_id), documentId: String(r.document_id), kind: r.kind as InboxDecisionKind,
  ...(r.reason === null ? {} : { reason: String(r.reason) }),
  ...(r.bill_number === null ? {} : { billNumber: String(r.bill_number) }),
  ...(r.supplier_name === null ? {} : { supplierName: String(r.supplier_name) }),
  decidedBy: String(r.decided_by), decidedAt: String(r.decided_at),
});

/** Writes join the unit of work the caller opened for the company; reads run in their own tenant transaction. */
export class PostgresInboxDecisionStore implements InboxDecisionStore {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  #write(companyId: Id): SqlExecutor { return this.#db.requireUnitOfWork(companyId).sql; }

  async record(decision: InboxDecision): Promise<InboxDecision> {
    check(decision);
    const sql = this.#write(decision.companyId);
    const inserted = await sql.query(
      `INSERT INTO purchase_inbox_decisions (company_id, document_id, kind, reason, bill_number, supplier_name, decided_by, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (company_id, document_id) DO NOTHING RETURNING document_id`,
      [decision.companyId, decision.documentId, decision.kind, decision.reason ?? null, decision.billNumber ?? null, decision.supplierName ?? null, decision.decidedBy, decision.decidedAt]);
    if (inserted.rows[0] !== undefined) return decision;
    const { rows } = await sql.query(`SELECT ${COLUMNS} FROM purchase_inbox_decisions WHERE company_id = $1 AND document_id = $2`, [decision.companyId, decision.documentId]);
    return settle(rows[0] === undefined ? undefined : decisionOf(rows[0]), decision);
  }

  async forDocuments(companyId: Id, documentIds: readonly Id[]): Promise<ReadonlyMap<Id, InboxDecision>> {
    const ids = documentIds.filter((id) => UUID.test(id));
    if (ids.length === 0) return new Map();
    const { rows } = await this.#db.tenantTransaction(companyId, (sql) => sql.query(
      `SELECT ${COLUMNS} FROM purchase_inbox_decisions WHERE company_id = $1 AND document_id = ANY($2::uuid[])`, [companyId, ids]));
    return new Map(rows.map((row) => [String(row.document_id), decisionOf(row)]));
  }
}
