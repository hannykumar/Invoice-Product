/**
 * Issue #366 — the assistant's plans and reports in PostgreSQL, beside `InMemoryAgentPlanStore` and
 * behaving the same (`test/agent-plan-store-contract.ts` runs one suite on both). Tables:
 * `migrations.ts`.
 *
 * Unit of work v1: writes go through `requireUnitOfWork(companyId).sql`, so they are saved with the
 * rest of the action or not at all, and throw `NO_UNIT_OF_WORK` when no action is open. Reads use
 * `tenantTransaction`. Nothing here opens a transaction of its own, and every query names its
 * company as well as relying on row-level security.
 *
 * Plan ids are uuids here (the service's default `crypto.randomUUID()`); a lookup by anything else
 * finds nothing, as it would in memory.
 */
import type { TransactionalExecutor } from '../../platform/src/database.ts';
import type { AgentPlan, AgentReport } from './model.ts';
import type { AgentPlanStore, Page } from './ports.ts';
import { REPORT_EXISTS } from './store.ts';

type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** jsonb with bigint kept exact (a step's amount): `{ "$bigint": "5000001" }` in, a bigint out. */
const json = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? { $bigint: item.toString() } : item));
const revive = (value: unknown): never => JSON.parse(String(value), (_key, item: unknown) =>
  item !== null && typeof item === 'object' && '$bigint' in item ? BigInt((item as { $bigint: string }).$bigint) : item) as never;
const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());
const orNull = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

const PLAN_COLUMNS = `id, company_id, request, today::text AS today, command_id, intent, evidence, confidence,
  steps::text AS steps, refusals::text AS refusals, needs_approval, fingerprint, instruction_flag,
  summary::text AS summary, state, requested_by, requested_at`;

const toPlan = (r: Row): AgentPlan => ({
  id: String(r.id),
  companyId: String(r.company_id),
  request: String(r.request),
  today: String(r.today),
  commandId: orNull(r.command_id),
  intent: r.intent as AgentPlan['intent'],
  evidence: String(r.evidence),
  confidence: Number(r.confidence),
  steps: revive(r.steps),
  refusals: revive(r.refusals),
  needsApproval: Boolean(r.needs_approval),
  fingerprint: orNull(r.fingerprint),
  instructionFlag: orNull(r.instruction_flag),
  summary: revive(r.summary),
  state: r.state as AgentPlan['state'],
  requestedBy: String(r.requested_by),
  requestedAt: iso(r.requested_at),
});

const REPORT_COLUMNS = `plan_id, state, steps::text AS steps, summary::text AS summary, refusals::text AS refusals,
  handed_back::text AS handed_back, finished_at`;

const toReport = (r: Row): AgentReport => ({
  planId: String(r.plan_id),
  state: r.state as AgentReport['state'],
  steps: revive(r.steps),
  summary: revive(r.summary),
  refusals: revive(r.refusals),
  handedBack: revive(r.handed_back),
  finishedAt: iso(r.finished_at),
});

export class PostgresAgentPlanStore implements AgentPlanStore {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) { this.#db = db; }

  /** New or not, the whole plan. An EXECUTED plan is frozen by the database (see migrations.ts). */
  async put(plan: AgentPlan): Promise<void> {
    await this.#db.requireUnitOfWork(plan.companyId).sql.query(
      `INSERT INTO agent_plans (id, company_id, request, today, command_id, intent, evidence, confidence, steps, refusals,
         needs_approval, fingerprint, instruction_flag, summary, state, requested_by, requested_at)
       VALUES ($1::uuid, $2::uuid, $3, $4::date, $5::uuid, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14::jsonb, $15, $16::uuid, $17::timestamptz)
       ON CONFLICT (id) DO UPDATE SET
         request = EXCLUDED.request, today = EXCLUDED.today, command_id = EXCLUDED.command_id, intent = EXCLUDED.intent,
         evidence = EXCLUDED.evidence, confidence = EXCLUDED.confidence, steps = EXCLUDED.steps, refusals = EXCLUDED.refusals,
         needs_approval = EXCLUDED.needs_approval, fingerprint = EXCLUDED.fingerprint, instruction_flag = EXCLUDED.instruction_flag,
         summary = EXCLUDED.summary, state = EXCLUDED.state, requested_by = EXCLUDED.requested_by,
         requested_at = EXCLUDED.requested_at, updated_at = now()
       WHERE agent_plans.company_id = EXCLUDED.company_id`,
      [plan.id, plan.companyId, plan.request, plan.today, plan.commandId, plan.intent, plan.evidence, plan.confidence,
        json(plan.steps), json(plan.refusals), plan.needsApproval, plan.fingerprint, plan.instructionFlag, json(plan.summary),
        plan.state, plan.requestedBy, plan.requestedAt],
    );
  }

  async find(companyId: string, id: string): Promise<AgentPlan | null> {
    if (!UUID.test(id)) return null;
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const found = await sql.query(`SELECT ${PLAN_COLUMNS} FROM agent_plans WHERE company_id = $1 AND id = $2::uuid`, [companyId, id]);
      return found.rows[0] === undefined ? null : toPlan(found.rows[0]);
    });
  }

  /** Newest first; a cursor that is not one of this company's plans means "from the start". */
  async list(companyId: string, page?: Page): Promise<readonly AgentPlan[]> {
    const after = page?.after !== undefined && UUID.test(page.after) ? page.after : null;
    return this.#db.tenantTransaction(companyId, async (sql) => (await sql.query(
      `SELECT ${PLAN_COLUMNS} FROM agent_plans p
        WHERE p.company_id = $1
          AND NOT EXISTS (SELECT 1 FROM agent_plans c WHERE c.company_id = $1 AND c.id = $2::uuid
                            AND (p.requested_at, p.seq) >= (c.requested_at, c.seq))
        ORDER BY p.requested_at DESC, p.seq DESC LIMIT $3::int`,
      [companyId, after, page?.limit ?? null],
    )).rows.map(toPlan));
  }

  async putReport(companyId: string, key: string, report: AgentReport): Promise<void> {
    const { sql } = this.#db.requireUnitOfWork(companyId);
    try {
      await sql.query(
        `INSERT INTO agent_reports (company_id, plan_id, idempotency_key, state, steps, summary, refusals, handed_back, finished_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::timestamptz)`,
        [companyId, report.planId, key, report.state, json(report.steps), json(report.summary), json(report.refusals),
          json(report.handedBack), report.finishedAt],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw REPORT_EXISTS();
      throw error;
    }
  }

  async findReport(companyId: string, key: string): Promise<AgentReport | null> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const found = await sql.query(`SELECT ${REPORT_COLUMNS} FROM agent_reports WHERE company_id = $1 AND idempotency_key = $2`, [companyId, key]);
      return found.rows[0] === undefined ? null : toReport(found.rows[0]);
    });
  }

  async reportFor(companyId: string, planId: string): Promise<AgentReport | null> {
    if (!UUID.test(planId)) return null;
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const found = await sql.query(
        `SELECT ${REPORT_COLUMNS} FROM agent_reports WHERE company_id = $1 AND plan_id = $2::uuid ORDER BY seq DESC LIMIT 1`,
        [companyId, planId],
      );
      return found.rows[0] === undefined ? null : toReport(found.rows[0]);
    });
  }
}
