/**
 * Issue #366 — where operations keeps what must outlive a restart: connector failures, support
 * access grants and the public incident timeline. `InMemoryOperationsStore` is the default and is
 * what the unit tests use; `PostgresOperationsStore` (postgres-store.ts) is the same contract on
 * the database. Both run the shared suite in test/operations-contract.ts.
 *
 * Queue jobs are not here: on PostgreSQL the durable queue is the platform outbox, and recurring
 * work has its own store (recurring-postgres.ts). Feature flags stay in memory until something
 * outside the tests reads them.
 */
import type { AuditEvent, Id } from "../../../packages/platform/src/index.ts";
import type { ExternalFailure, Incident, SupportGrant } from "./types.ts";

export interface Page { readonly limit?: number; readonly after?: string }
export const pageLimit = (page?: Page): number => Math.min(Math.max(Math.trunc(page?.limit ?? 100), 1), 500);

/** The audit trail operations writes to: the in-memory `AuditLog` or `PostgresAuditLog` in the same unit of work. */
export interface OperationsAudit { append(event: Omit<AuditEvent, "id" | "occurredAt">): unknown }

export interface OperationsStore {
  /** One business action for `companyId`: everything written inside it is kept together, or (on the database) nothing is. */
  action<T>(companyId: Id, work: () => Promise<T>): Promise<T>;
  addFailure(failure: ExternalFailure): Promise<void>;
  /** Oldest first; `after` is the id of the last failure already shown. */
  /** Newest first, so an operations screen's first page shows the latest failures. */
  failures(companyId: Id, page?: Page): Promise<readonly ExternalFailure[]>;
  addGrant(grant: SupportGrant): Promise<void>;
  /** Records the revocation once: a grant already revoked keeps its first time, and `changed` is false. */
  revokeGrant(companyId: Id, grantId: Id, revokedAt: string): Promise<{ readonly grant: SupportGrant; readonly changed: boolean } | null>;
  /** Only this company's grant: another company's grant id is simply not found. */
  grant(companyId: Id, grantId: Id): Promise<SupportGrant | null>;
  /** Saves the incident header and appends the timeline entries not stored yet. `companyId` is the operator's company, whose action it is. */
  saveIncident(companyId: Id, incident: Incident): Promise<void>;
  incident(id: Id): Promise<Incident | null>;
  /** The public status page: platform-wide, newest first; `after` is the id of the last incident shown. */
  incidents(page?: Page): Promise<readonly Incident[]>;
}

const after = <T extends { readonly id: Id }>(items: readonly T[], page?: Page): readonly T[] => {
  const start = page?.after === undefined ? 0 : items.findIndex((item) => item.id === page.after) + 1;
  return items.slice(start, start + pageLimit(page));
};

export class InMemoryOperationsStore implements OperationsStore {
  readonly #failures: ExternalFailure[] = [];
  readonly #grants = new Map<Id, SupportGrant>();
  readonly #incidents = new Map<Id, Incident>();

  action<T>(_companyId: Id, work: () => Promise<T>): Promise<T> { return work(); }
  async addFailure(failure: ExternalFailure): Promise<void> { this.#failures.push(Object.freeze({ ...failure })); }
  async failures(companyId: Id, page?: Page): Promise<readonly ExternalFailure[]> { return after(this.#failures.filter((f) => f.companyId === companyId).reverse(), page); }
  async addGrant(grant: SupportGrant): Promise<void> {
    if (this.#grants.has(grant.id)) throw new Error(`Support grant ${grant.id} is already saved.`);
    this.#grants.set(grant.id, Object.freeze({ ...grant, scopes: new Set(grant.scopes) }));
  }
  async revokeGrant(companyId: Id, grantId: Id, revokedAt: string): Promise<{ readonly grant: SupportGrant; readonly changed: boolean } | null> {
    // Checked and set with no await between, so two revocations at once cannot both win.
    const found = this.#grants.get(grantId);
    const current = found !== undefined && found.companyId === companyId ? found : null;
    if (current === null) return null;
    if (current.revokedAt !== undefined) return { grant: current, changed: false };
    const revoked = Object.freeze({ ...current, revokedAt });
    this.#grants.set(grantId, revoked);
    return { grant: revoked, changed: true };
  }
  async grant(companyId: Id, grantId: Id): Promise<SupportGrant | null> {
    const grant = this.#grants.get(grantId);
    return grant !== undefined && grant.companyId === companyId ? grant : null;
  }
  async saveIncident(_companyId: Id, incident: Incident): Promise<void> {
    const stored = this.#incidents.get(incident.id);
    if (stored !== undefined && incident.timeline.slice(0, stored.timeline.length).some((entry, i) => entry !== stored.timeline[i] && JSON.stringify(entry) !== JSON.stringify(stored.timeline[i]))) {
      throw new Error("An incident's earlier timeline cannot be rewritten.");
    }
    this.#incidents.set(incident.id, Object.freeze({ ...incident, timeline: Object.freeze([...incident.timeline]) }));
  }
  async incident(id: Id): Promise<Incident | null> { return this.#incidents.get(id) ?? null; }
  async incidents(page?: Page): Promise<readonly Incident[]> { return after([...this.#incidents.values()].reverse(), page); }
}
