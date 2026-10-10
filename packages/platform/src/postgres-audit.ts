/**
 * Issues #363 and #364 — the audit trail in `audit_events`.
 *
 * `append` is the platform's own shape (the twin of the in-memory `AuditLog`); `record` takes the
 * module shape (the ledger's `AuditPort`, which sales, inventory and returns also use). Both redact
 * exactly as the in-memory log does before anything is stored.
 *
 * Called inside an action's unit of work a write joins it, so the record commits with the action or
 * not at all. Called after a commit (modules not yet moved over, #366) it saves in a short unit of
 * its own, which is what the in-memory port did. Rows are only ever inserted; #368 makes the
 * database refuse anything else.
 */
import { randomUUID } from "node:crypto";
import { redactSecrets } from "./credentials.ts";
import type { TransactionalExecutor } from "./database.ts";
import { canonicalJson, redact } from "./platform.ts";
import type { AuditEvent, RequestContext } from "./types.ts";

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

/** Reads back what `canonicalJson` wrote: `{ $bigint: "100" }` is 100n again. */
export const reviveJson = <T>(value: unknown): T =>
  JSON.parse(JSON.stringify(value), (_key, item: unknown) => (item !== null && typeof item === "object" && "$bigint" in item ? BigInt((item as { $bigint: string }).$bigint) : item)) as T;
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
};

export class PostgresAuditLog {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  append(event: Omit<AuditEvent, "id" | "occurredAt">, occurredAt = new Date().toISOString()): Promise<AuditEvent> {
    const stored: AuditEvent = redactSecrets({ ...event, id: randomUUID(), occurredAt, before: event.before && redact(structuredClone(event.before)), after: event.after && redact(structuredClone(event.after)) });
    return this.#db.unitOfWork(event.companyId, async ({ sql }) => {
      await sql.query(
        `INSERT INTO audit_events (id, company_id, actor_id, action, correlation_id, before_json, after_json, reason, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
        [stored.id, stored.companyId, stored.actorId, stored.action, stored.correlationId,
          stored.before === null ? null : canonicalJson(stored.before), stored.after === null ? null : canonicalJson(stored.after), stored.reason ?? null, stored.occurredAt],
      );
      return freeze(stored);
    });
  }

  async record(event: ModuleAuditEvent): Promise<void> {
    await this.append({
      companyId: event.companyId, actorId: event.actorId, action: event.action, correlationId: event.subjectId, before: null,
      after: { subjectType: event.subjectType, summary: event.summary, details: { ...event.details } },
      ...(event.overrideReason === undefined ? {} : { reason: event.overrideReason }),
    }, event.at);
  }

  /** One company's trail, in the order it was written. */
  async forCompany(context: RequestContext): Promise<readonly AuditEvent[]> {
    const { rows } = await this.#db.tenantTransaction(context.companyId, (sql) => sql.query(
      "SELECT id, company_id, actor_id, action, correlation_id, before_json, after_json, reason, occurred_at FROM audit_events WHERE company_id = $1 ORDER BY seq",
      [context.companyId],
    ));
    return Object.freeze(rows.map((r) => freeze<AuditEvent>({
      id: String(r.id), companyId: String(r.company_id), actorId: String(r.actor_id), action: String(r.action), occurredAt: (r.occurred_at as Date).toISOString(),
      correlationId: String(r.correlation_id), before: r.before_json === null ? null : reviveJson(r.before_json), after: r.after_json === null ? null : reviveJson(r.after_json),
      ...(r.reason === null ? {} : { reason: String(r.reason) }),
    })));
  }
}
