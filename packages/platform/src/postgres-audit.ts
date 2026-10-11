/**
 * Issue #363 — module audit events (the ledger's `AuditPort` shape, which sales, inventory and
 * returns also use) written to `audit_events`.
 *
 * Called inside an action's unit of work it joins it, so the record commits with the action or not
 * at all. Called after a commit (modules not yet moved over, #366) it saves in a short unit of its
 * own, which is what the in-memory port did. #364 completes the platform's own audit store.
 */
import { randomUUID } from "node:crypto";
import type { TransactionalExecutor } from "./database.ts";

export interface ModuleAuditEvent {
  readonly companyId: string;
  readonly actorId: string;
  readonly at: string;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly summary: string;
  readonly details: Readonly<Record<string, string>>;
  readonly overrideReason?: string;
}

export class PostgresAuditLog {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  record(event: ModuleAuditEvent): Promise<void> {
    return this.#db.unitOfWork(event.companyId, async (uow) => {
      await uow.sql.query(
        `INSERT INTO audit_events (id, company_id, actor_id, action, correlation_id, before_json, after_json, reason, occurred_at)
         VALUES ($1, $2, $3, $4, $5, NULL, $6::jsonb, $7, $8)`,
        [randomUUID(), event.companyId, event.actorId, event.action, event.subjectId,
          JSON.stringify({ subjectType: event.subjectType, summary: event.summary, details: event.details }),
          event.overrideReason ?? null, event.at],
      );
    });
  }
}
