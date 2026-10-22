/**
 * Issue #366 — the assistant's action plans (#47) in PostgreSQL. Exactly what
 * `InMemoryAgentPlanStore` keeps: one row per plan, one row per run report. Read and written by
 * `postgres-store.ts`.
 *
 * A plan moves PLANNED → PREVIEWED → APPROVED → EXECUTED (or → REJECTED), and preview may run again
 * on any plan that has not been EXECUTED (service.ts `preview`). Once EXECUTED the service only ever
 * saves it again unchanged (a read-only plan run under a second key), so the database freezes it:
 * nothing but `updated_at` may change and there is no move out of EXECUTED. A report is final the
 * moment it is written.
 */
import type { Migration } from '../../platform/src/migration-definitions.ts';
import { tenantPolicy } from '../../platform/src/immutability-migrations.ts';

const STATE = `'PLANNED','PREVIEWED','APPROVED','EXECUTED','REJECTED'`;
const INTENT = `'CHASE_UNPAID','SHOW_WHO_OWES','STOP_REMINDING','CANCEL_INVOICE','MOVE_MONEY','FILE_RETURN','NOT_MY_REQUEST'`;

export const actionAgentMigrations: readonly Migration[] = Object.freeze([{
  id: '20261016T014553421Z_action-agent_c034785b86d9_agent_plans_and_reports',
  up: `
    CREATE TABLE agent_plans (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      -- What the person typed, kept so the screen can show it back. Data, never an instruction.
      request text NOT NULL,
      today date NOT NULL,
      -- The platform command the plan became at preview. No foreign key: commands are still kept by
      -- the in-memory PlatformCommandService in the running app (#340 moves them).
      command_id uuid,
      intent text NOT NULL CHECK (intent IN (${INTENT})),
      evidence text NOT NULL,
      -- The lexicon's own constant (planning.ts), not a figure of money.
      confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      steps jsonb NOT NULL CHECK (jsonb_typeof(steps) = 'array'),
      refusals jsonb NOT NULL CHECK (jsonb_typeof(refusals) = 'array'),
      needs_approval boolean NOT NULL,
      fingerprint text,
      instruction_flag text,
      summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
      state text NOT NULL CHECK (state IN (${STATE})),
      requested_by uuid NOT NULL REFERENCES users(id),
      requested_at timestamptz NOT NULL,
      -- The order plans were first saved in: newest-first lists break ties on it.
      seq bigint GENERATED ALWAYS AS IDENTITY,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      -- Preview gives a plan its command and its fingerprint together, and nothing takes them away.
      CONSTRAINT agent_plans_previewed CHECK (state = 'PLANNED' OR (command_id IS NOT NULL AND fingerprint IS NOT NULL)),
      -- For the reports' company-scoped foreign key.
      CONSTRAINT agent_plans_company_id UNIQUE (company_id, id)
    );
    -- The plan list: one company's, newest first, a page at a time.
    CREATE INDEX agent_plans_company_requested_idx ON agent_plans (company_id, requested_at DESC, seq DESC);

    CREATE TABLE agent_reports (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES companies(id),
      plan_id uuid NOT NULL,
      -- The store's key for the run (the service passes "<plan id>:<the caller's key>"): the same key
      -- again returns this report, never a second run.
      idempotency_key text NOT NULL CHECK (idempotency_key <> ''),
      state text NOT NULL CHECK (state IN ('DONE','PARTLY_DONE','NOTHING_DONE')),
      steps jsonb NOT NULL CHECK (jsonb_typeof(steps) = 'array'),
      summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
      refusals jsonb NOT NULL CHECK (jsonb_typeof(refusals) = 'array'),
      handed_back jsonb NOT NULL CHECK (jsonb_typeof(handed_back) = 'array'),
      finished_at timestamptz NOT NULL,
      -- "The plan's report" is the latest one written.
      seq bigint GENERATED ALWAYS AS IDENTITY,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (company_id, plan_id) REFERENCES agent_plans (company_id, id),
      -- Also the index findReport looks the key up by.
      CONSTRAINT agent_reports_key UNIQUE (company_id, idempotency_key)
    );
    -- A plan's latest report (reportFor); also serves the foreign key.
    CREATE INDEX agent_reports_plan_idx ON agent_reports (company_id, plan_id, seq DESC);

    CREATE TRIGGER agent_plans_frozen BEFORE UPDATE OR DELETE ON agent_plans
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('state', 'EXECUTED', 'updated_at', '');
    CREATE TRIGGER agent_plans_no_truncate BEFORE TRUNCATE ON agent_plans
      FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();
    CREATE TRIGGER agent_reports_frozen BEFORE UPDATE OR DELETE ON agent_reports
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('', '*', '', '');
    CREATE TRIGGER agent_reports_no_truncate BEFORE TRUNCATE ON agent_reports
      FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();
    ${tenantPolicy('agent_plans')}
    ${tenantPolicy('agent_reports')}
  `,
  down: `DROP TABLE IF EXISTS agent_reports; DROP TABLE IF EXISTS agent_plans;`,
}]);
