/**
 * Issue #404 — the in-memory command lifecycle writing into a company's own audit trail.
 *
 * `PlatformCommandService` appends its `created`, `submitted`, `approved` … events to an `AuditLog`.
 * Built over this one, each event is also handed to the module audit port the rest of the company
 * writes to (the ledger's `AuditPort`: sales, collections, returns), so a command's lifecycle sits
 * beside the bills and reminders it caused rather than in a log nobody reads.
 *
 * Only for the in-memory trail, whose `record` never fails. On PostgreSQL use
 * `PostgresCommandService` over the company's `PostgresAuditLog`, which awaits every write.
 */
import { AuditLog, canonicalJson } from "./platform.ts";
import type { ModuleAuditEvent } from "./postgres-audit.ts";
import type { AuditEvent } from "./types.ts";

export interface ModuleAuditTrail {
  record(event: ModuleAuditEvent): Promise<void>;
}

const text = (value: unknown): string => (typeof value === "string" ? value : canonicalJson(value));

export class CompanyTrailAuditLog extends AuditLog {
  readonly #trail: ModuleAuditTrail;
  constructor(trail: ModuleAuditTrail) { super(); this.#trail = trail; }

  append(event: Omit<AuditEvent, "id" | "occurredAt">): AuditEvent {
    const stored = super.append(event);
    const after = stored.after ?? {};
    void this.#trail.record({
      companyId: stored.companyId, actorId: stored.actorId, at: stored.occurredAt, action: stored.action,
      subjectType: "command", subjectId: stored.correlationId,
      summary: typeof after.status === "string" ? `Moved to ${after.status}.` : "Recorded.",
      details: {
        ...Object.fromEntries(Object.entries(after).map(([key, value]) => [key, text(value)])),
        ...(stored.before === null ? {} : { from: text(stored.before.status) }),
        ...(stored.reason === undefined ? {} : { reason: stored.reason }),
      },
    });
    return stored;
  }
}
