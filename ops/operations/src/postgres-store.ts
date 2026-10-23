/**
 * Issue #366 — the operations store on PostgreSQL. It never opens a transaction of its own: every
 * write joins the action's unit of work (`requireUnitOfWork`, which throws `NO_UNIT_OF_WORK` when
 * none is open), every company read runs in `tenantTransaction`, and every company query names its
 * company as well as relying on row-level security.
 *
 * Incidents are the one platform-wide record (the public status page has no company), so they
 * have no `company_id` and no row security; they are written inside the operator's own action and
 * read with a plain query.
 */
import { PlatformError, type Id } from "../../../packages/platform/src/index.ts";
import type { SqlExecutor, TransactionalExecutor } from "../../../packages/platform/src/database.ts";
import type { DiagnosticScope, ExternalFailure, Incident, IncidentUpdate, SupportGrant } from "./types.ts";
import { pageLimit, type OperationsStore, type Page } from "./store.ts";

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (value: unknown): string => (value instanceof Date ? value : new Date(String(value))).toISOString();
const optionalIso = (value: unknown): string | undefined => (value === null || value === undefined ? undefined : iso(value));

const FAILURE = "f.id, f.company_id, f.correlation_id, f.connector, f.operation, f.error_code, f.occurred_at";
const failure = (r: Row): ExternalFailure => Object.freeze({
  id: String(r.id), companyId: String(r.company_id), correlationId: String(r.correlation_id), connector: String(r.connector),
  operation: String(r.operation), errorCode: String(r.error_code), state: "failure" as const, occurredAt: iso(r.occurred_at),
});

const GRANT = "g.id, g.company_id, g.support_actor_id, g.granted_by, g.reason, g.scopes, g.created_at, g.expires_at, g.revoked_at";
const grant = (r: Row): SupportGrant => {
  const revokedAt = optionalIso(r.revoked_at);
  return Object.freeze({
    id: String(r.id), companyId: String(r.company_id), supportActorId: String(r.support_actor_id), grantedBy: String(r.granted_by),
    reason: String(r.reason), scopes: new Set(r.scopes as DiagnosticScope[]), createdAt: iso(r.created_at), expiresAt: iso(r.expires_at),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  });
};

const INCIDENT = `i.id, i.title, i.affected_service, i.state, i.started_at, i.resolved_at,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('at', u.occurred_at, 'state', u.state, 'message', u.message) ORDER BY u.position NULLS FIRST, u.occurred_at)
              FROM status_incident_updates u WHERE u.incident_id = i.id), '[]'::jsonb) AS timeline`;
const incident = (r: Row): Incident => {
  const resolvedAt = optionalIso(r.resolved_at);
  const timeline = (r.timeline as { at: string; state: IncidentUpdate["state"]; message: string }[])
    .map((u) => Object.freeze({ at: iso(u.at), state: u.state, message: u.message }));
  return Object.freeze({
    id: String(r.id), title: String(r.title), affectedService: String(r.affected_service), state: String(r.state) as IncidentUpdate["state"],
    startedAt: iso(r.started_at), ...(resolvedAt === undefined ? {} : { resolvedAt }), timeline: Object.freeze(timeline),
  });
};

/** A support person or granting user who is not a user here is the caller's mistake, said plainly. */
const unknownPerson = (error: unknown): never => {
  const code = (error as { code?: string }).code;
  if (code === "23503" || code === "22P02") throw new PlatformError("NOT_FOUND", "That support person is not a user of this system.");
  throw error;
};

export class PostgresOperationsStore implements OperationsStore {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  action<T>(companyId: Id, work: () => Promise<T>): Promise<T> { return this.#db.unitOfWork(companyId, () => work()); }
  #read<T>(companyId: Id, work: (sql: SqlExecutor) => Promise<T>): Promise<T> { return this.#db.tenantTransaction(companyId, work); }
  #write(companyId: Id): SqlExecutor { return this.#db.requireUnitOfWork(companyId).sql; }

  async addFailure(f: ExternalFailure): Promise<void> {
    await this.#write(f.companyId).query(
      `INSERT INTO operational_failures (id, company_id, correlation_id, connector, operation, error_code, occurred_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [f.id, f.companyId, f.correlationId, f.connector, f.operation, f.errorCode, f.occurredAt]);
  }

  failures(companyId: Id, page?: Page): Promise<readonly ExternalFailure[]> {
    return this.#read(companyId, async (sql) => (await sql.query(
      `SELECT ${FAILURE} FROM operational_failures f
        WHERE f.company_id = $1
          AND ($2::uuid IS NULL OR (f.occurred_at, f.id) > (SELECT a.occurred_at, a.id FROM operational_failures a WHERE a.company_id = $1 AND a.id = $2))
        ORDER BY f.occurred_at, f.id LIMIT $3`,
      [companyId, page?.after ?? null, pageLimit(page)])).rows.map(failure));
  }

  async addGrant(g: SupportGrant): Promise<void> {
    await this.#write(g.companyId).query(
      `INSERT INTO support_access_grants (id, company_id, support_actor_id, granted_by, reason, scopes, created_at, expires_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
      [g.id, g.companyId, g.supportActorId, g.grantedBy, g.reason, JSON.stringify([...g.scopes]), g.createdAt, g.expiresAt, g.revokedAt ?? null]).catch(unknownPerson);
  }

  async revokeGrant(companyId: Id, grantId: Id, revokedAt: string): Promise<{ readonly grant: SupportGrant; readonly changed: boolean } | null> {
    if (!UUID.test(grantId)) return null;
    const sql = this.#write(companyId);
    const updated = (await sql.query(
      `UPDATE support_access_grants g SET revoked_at = $3 WHERE g.company_id = $1 AND g.id = $2 AND g.revoked_at IS NULL RETURNING ${GRANT}`,
      [companyId, grantId, revokedAt])).rows[0];
    if (updated !== undefined) return { grant: grant(updated), changed: true };
    const current = (await sql.query(`SELECT ${GRANT} FROM support_access_grants g WHERE g.company_id = $1 AND g.id = $2`, [companyId, grantId])).rows[0];
    return current === undefined ? null : { grant: grant(current), changed: false };
  }

  async grant(companyId: Id, grantId: Id): Promise<SupportGrant | null> {
    if (!UUID.test(grantId)) return null;
    return this.#read(companyId, async (sql) => {
      const row = (await sql.query(`SELECT ${GRANT} FROM support_access_grants g WHERE g.company_id = $1 AND g.id = $2`, [companyId, grantId])).rows[0];
      return row === undefined ? null : grant(row);
    });
  }

  async saveIncident(companyId: Id, i: Incident): Promise<void> {
    const sql = this.#write(companyId);
    await sql.query(
      `INSERT INTO status_incidents (id, title, affected_service, state, started_at, resolved_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, resolved_at = EXCLUDED.resolved_at`,
      [i.id, i.title, i.affectedService, i.state, i.startedAt, i.resolvedAt ?? null]);
    const stored = Number((await sql.query(`SELECT count(*)::int AS n FROM status_incident_updates u WHERE u.incident_id = $1`, [i.id])).rows[0]?.n ?? 0);
    const fresh = i.timeline.slice(stored);
    if (fresh.length === 0) return;
    await sql.query(
      `INSERT INTO status_incident_updates (id, incident_id, position, state, message, occurred_at)
       SELECT gen_random_uuid(), $1, $2 + r.ordinality - 1, r.state, r.message, r.at
         FROM ROWS FROM (jsonb_to_recordset($3::jsonb) AS (state text, message text, at timestamptz)) WITH ORDINALITY AS r(state, message, at, ordinality)`,
      [i.id, stored, JSON.stringify(fresh)]);
  }

  async incident(id: Id): Promise<Incident | null> {
    if (!UUID.test(id)) return null;
    const row = (await this.#db.query(`SELECT ${INCIDENT} FROM status_incidents i WHERE i.id = $1`, [id])).rows[0];
    return row === undefined ? null : incident(row);
  }

  async incidents(page?: Page): Promise<readonly Incident[]> {
    return (await this.#db.query(
      `SELECT ${INCIDENT} FROM status_incidents i
        WHERE $1::uuid IS NULL OR (i.started_at, i.id) < (SELECT a.started_at, a.id FROM status_incidents a WHERE a.id = $1)
        ORDER BY i.started_at DESC, i.id DESC LIMIT $2`,
      [page?.after ?? null, pageLimit(page)])).rows.map(incident);
  }
}
