/**
 * Issue #345 — recurring work kept in PostgreSQL (`recurring_work_status`), so it survives a
 * restart and any number of workers can run it without running one job twice at the same time.
 *
 * The rules are the in-memory runner's (`recurring.ts`, contract `recurring-work.v1`): one run per
 * company, job and schedule slot; missed slots coalesce to the latest; a failure is retried after its
 * delay, doubling, and dead-lettered at the job's limit; an operator may replay a dead-lettered job.
 * What PostgreSQL adds is the claim: a worker marks the row `running` in its own short transaction
 * (`FOR UPDATE SKIP LOCKED`), runs the job holding nothing, and records the result only if the row
 * is still its claim. A worker that dies mid-run leaves the row `running`; once the lease has passed
 * another worker claims it again. Jobs must therefore be idempotent, as the contract already asks.
 */
import type { TransactionalExecutor } from "../../../packages/platform/src/database.ts";
import { PlatformError, type RequestContext } from "../../../packages/platform/src/index.ts";
import type { RecurringJobDefinition } from "./recurring.ts";
import type { RecurringRunOutcome, RecurringWorkStatus } from "./types.ts";

const MINUTE = 60_000;
/** A run older than this is taken to have died with its worker: longer than any job's 30-second timeout. */
export const RECURRING_LEASE_MS = 5 * MINUTE;
type Row = Record<string, unknown>;
const iso = (value: unknown): string | undefined => (value instanceof Date ? value.toISOString() : undefined);

const errorCodeOf = (error: unknown): string => {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9_.-]+$/.test(error.code)) return error.code;
  if (error instanceof Error && /^[A-Za-z0-9_.-]+$/.test(error.name)) return error.name.toUpperCase();
  return "RECURRING_JOB_FAILED";
};

const statusOf = (r: Row): RecurringWorkStatus => Object.fromEntries(Object.entries({
  companyId: String(r.company_id),
  jobKey: String(r.job_key),
  name: String(r.name),
  everyMs: Number(r.every_ms),
  nextRunAt: iso(r.next_run_at)!,
  outcome: String(r.outcome) as RecurringRunOutcome,
  attempts: Number(r.attempts),
  maxAttempts: Number(r.max_attempts),
  lastScheduledFor: iso(r.last_scheduled_for),
  lastStartedAt: iso(r.last_started_at),
  lastCompletedAt: iso(r.last_completed_at),
  durationMs: r.duration_ms === null ? undefined : Number(r.duration_ms),
  lastErrorCode: r.last_error_code === null ? undefined : String(r.last_error_code),
  summary: r.summary === null ? undefined : String(r.summary),
}).filter(([, value]) => value !== undefined)) as unknown as RecurringWorkStatus;

const COLUMNS = "company_id, job_key, name, every_ms, next_run_at, outcome, attempts, max_attempts, last_scheduled_for, last_started_at, last_completed_at, duration_ms, last_error_code, summary";

export class PostgresRecurringWork {
  readonly #db: TransactionalExecutor;
  readonly #leaseMs: number;

  constructor(db: TransactionalExecutor, options: { readonly leaseMs?: number } = {}) {
    this.#db = db;
    this.#leaseMs = options.leaseMs ?? RECURRING_LEASE_MS;
  }

  get leaseMs(): number { return this.#leaseMs; }

  /** Puts each job on the company's schedule once; a job already there keeps its progress. */
  async ensure(context: RequestContext, definitions: readonly RecurringJobDefinition[]): Promise<void> {
    if (!context.permissions.has("queue.replay")) throw new Error("RECURRING_SERVICE_ACTOR_NEEDS_QUEUE_REPLAY");
    await this.#db.unitOfWork(context.companyId, async ({ sql }) => {
      for (const definition of definitions) {
        if (!Number.isSafeInteger(definition.everyMs) || definition.everyMs < MINUTE) throw new Error("RECURRING_INTERVAL_INVALID");
        await sql.query(
          `INSERT INTO recurring_work_status (company_id, job_key, name, every_ms, next_run_at, outcome, attempts, max_attempts)
           VALUES ($1, $2, $3, $4, now(), 'never', 0, $5)
           ON CONFLICT (company_id, job_key) DO UPDATE SET name = EXCLUDED.name, every_ms = EXCLUDED.every_ms, max_attempts = EXCLUDED.max_attempts`,
          [context.companyId, definition.key, definition.name, definition.everyMs, definition.maxAttempts ?? 3],
        );
      }
    });
  }

  /**
   * Runs this company's due jobs, one after another. `asAction` wraps each run in the caller's unit
   * of work for the job's own writes; the claim and the result are separate short transactions.
   */
  async runDue(context: RequestContext, definitions: readonly RecurringJobDefinition[], asAction: <T>(work: () => Promise<T>) => Promise<T>): Promise<readonly RecurringWorkStatus[]> {
    const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
    const claimed = await this.#db.unitOfWork(context.companyId, ({ sql }) => sql.query(
      `UPDATE recurring_work_status r
          SET attempts = CASE WHEN r.outcome IN ('failure', 'running') THEN r.attempts + 1 ELSE 1 END,
              last_scheduled_for = CASE WHEN r.outcome IN ('failure', 'running') AND r.last_scheduled_for IS NOT NULL THEN r.last_scheduled_for
                                        ELSE r.next_run_at + floor(greatest(0, extract(epoch FROM now() - r.next_run_at) * 1000) / r.every_ms) * r.every_ms * interval '1 millisecond' END,
              outcome = 'running', last_started_at = clock_timestamp(), last_error_code = NULL
        WHERE (r.company_id, r.job_key) IN (
          SELECT company_id, job_key FROM recurring_work_status
           WHERE company_id = $1 AND job_key = ANY($2::text[])
             AND ((outcome <> 'running' AND next_run_at <= now()) OR (outcome = 'running' AND last_started_at < now() - make_interval(secs => $3)))
           ORDER BY next_run_at FOR UPDATE SKIP LOCKED)
        RETURNING ${COLUMNS}, last_started_at::text AS claim`,
      [context.companyId, [...byKey.keys()], this.#leaseMs / 1000],
    ));
    const results: RecurringWorkStatus[] = [];
    for (const row of claimed.rows) {
      const definition = byKey.get(String(row.job_key))!;
      // The claim is the start time to the microsecond, as text: a JavaScript Date keeps only milliseconds.
      const claim = String(row.claim);
      const scheduledFor = row.last_scheduled_for as Date;
      const attempts = Number(row.attempts);
      let outcome: { ok: true; summary?: string | undefined } | { ok: false; code: string };
      const signal = AbortSignal.timeout(definition.timeoutMs ?? 30_000);
      const running = asAction(() => definition.run(context, scheduledFor, signal));
      try {
        const result = await running;
        outcome = signal.aborted ? { ok: false, code: "RECURRING_JOB_TIMED_OUT" } : { ok: true, summary: result?.summary };
      } catch (error) {
        outcome = { ok: false, code: signal.aborted ? "RECURRING_JOB_TIMED_OUT" : errorCodeOf(error) };
      }
      // The job is told to stop at its timeout (`signal`), and the row stays claimed until it really
      // has: a retry never starts while the first run could still commit. A run that never settles is
      // taken over when the lease runs out, as if its worker had died.

      const dead = !outcome.ok && attempts >= Number(row.max_attempts);
      const retryMs = (definition.retryDelayMs ?? MINUTE) * 2 ** Math.max(0, attempts - 1);
      // Recorded only while the row is still this worker's claim; one whose lease ran out may have been taken over.
      const saved = await this.#db.unitOfWork(context.companyId, ({ sql }) => sql.query(
        `UPDATE recurring_work_status
            SET outcome = $4, last_completed_at = clock_timestamp(),
                duration_ms = greatest(0, (extract(epoch FROM clock_timestamp() - last_started_at) * 1000)::bigint),
                next_run_at = CASE WHEN $4 = 'failure' THEN clock_timestamp() + make_interval(secs => $5) ELSE last_scheduled_for + every_ms * interval '1 millisecond' END,
                last_error_code = $6, summary = $7
          WHERE company_id = $1 AND job_key = $2 AND outcome = 'running' AND last_started_at::text = $3
          RETURNING ${COLUMNS}`,
        [context.companyId, definition.key, claim, outcome.ok ? "success" : dead ? "dead_lettered" : "failure", retryMs / 1000,
          outcome.ok ? null : outcome.code, outcome.ok ? outcome.summary ?? null : null],
      ));
      if (saved.rows[0] !== undefined) results.push(statusOf(saved.rows[0]));
    }
    return results;
  }

  /** The operator's view of this company's recurring work. */
  async status(context: RequestContext): Promise<readonly RecurringWorkStatus[]> {
    if (!context.permissions.has("operations.read")) throw new Error("RECURRING_STATUS_FORBIDDEN");
    const { rows } = await this.#db.tenantTransaction(context.companyId, (sql) => sql.query(
      `SELECT ${COLUMNS} FROM recurring_work_status WHERE company_id = $1 ORDER BY job_key`, [context.companyId]));
    return rows.map(statusOf);
  }

  /** An operator puts a dead-lettered (or failing) job back for the next tick, for the same slot. */
  async replay(context: RequestContext, jobKey: string): Promise<RecurringWorkStatus> {
    if (!context.permissions.has("queue.replay")) throw new PlatformError("FORBIDDEN", "You do not have permission to perform this operational action.");
    const { rows } = await this.#db.unitOfWork(context.companyId, ({ sql }) => sql.query(
      `UPDATE recurring_work_status SET outcome = 'failure', attempts = 0, next_run_at = now()
        WHERE company_id = $1 AND job_key = $2 AND outcome IN ('dead_lettered', 'failure')
        RETURNING ${COLUMNS}`, [context.companyId, jobKey]));
    if (rows[0] === undefined) throw new Error("ONLY_FAILED_JOBS_CAN_BE_REPLAYED");
    return statusOf(rows[0]);
  }
}
