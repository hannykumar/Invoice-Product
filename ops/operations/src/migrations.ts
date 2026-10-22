import type { Migration } from "../../../packages/platform/src/migration-definitions.ts";

export const operationsMigrations: readonly Migration[] = [{
  id: "20260830T194934633Z_operations_be500fa8ce1f_monitoring_support_controls",
  up: `
    CREATE TABLE operational_failures (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), correlation_id text NOT NULL, connector text NOT NULL, operation text NOT NULL, error_code text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE operational_jobs (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), kind text NOT NULL, idempotency_key text NOT NULL, idempotent boolean NOT NULL, state text NOT NULL CHECK (state IN ('draft','processing','success','failure')), attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL CHECK (max_attempts > 0), correlation_id text NOT NULL, last_error_code text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, UNIQUE(company_id, kind, idempotency_key), UNIQUE(company_id, id));
    CREATE TABLE support_access_grants (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), support_actor_id uuid NOT NULL REFERENCES users(id), granted_by uuid NOT NULL REFERENCES users(id), reason text NOT NULL, scopes jsonb NOT NULL, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz, CHECK (expires_at > created_at));
    CREATE TABLE status_incidents (id uuid PRIMARY KEY, title text NOT NULL, affected_service text NOT NULL, state text NOT NULL CHECK (state IN ('investigating','identified','monitoring','resolved')), started_at timestamptz NOT NULL, resolved_at timestamptz);
    CREATE TABLE status_incident_updates (id uuid PRIMARY KEY, incident_id uuid NOT NULL REFERENCES status_incidents(id), state text NOT NULL, message text NOT NULL, occurred_at timestamptz NOT NULL);
    CREATE TABLE operational_feature_flags (key text PRIMARY KEY, description text NOT NULL, enabled boolean NOT NULL DEFAULT false, allowed_company_ids jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX operational_failures_company_time_idx ON operational_failures(company_id, occurred_at DESC);
    CREATE INDEX operational_jobs_company_state_idx ON operational_jobs(company_id, state);
    CREATE INDEX support_grants_company_expiry_idx ON support_access_grants(company_id, expires_at) WHERE revoked_at IS NULL;
    ALTER TABLE operational_failures ENABLE ROW LEVEL SECURITY; ALTER TABLE operational_failures FORCE ROW LEVEL SECURITY;
    ALTER TABLE operational_jobs ENABLE ROW LEVEL SECURITY; ALTER TABLE operational_jobs FORCE ROW LEVEL SECURITY;
    ALTER TABLE support_access_grants ENABLE ROW LEVEL SECURITY; ALTER TABLE support_access_grants FORCE ROW LEVEL SECURITY;
    CREATE POLICY operational_failures_tenant ON operational_failures USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    CREATE POLICY operational_jobs_tenant ON operational_jobs USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    CREATE POLICY support_access_grants_tenant ON support_access_grants USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
  `,
  down: `DROP TABLE IF EXISTS operational_feature_flags; DROP TABLE IF EXISTS status_incident_updates; DROP TABLE IF EXISTS status_incidents; DROP TABLE IF EXISTS support_access_grants; DROP TABLE IF EXISTS operational_jobs; DROP TABLE IF EXISTS operational_failures;`,
}, {
  id: "20260901T130036302Z_operations_91c75652d848_recurring_work_scheduler",
  up: `
    CREATE TABLE recurring_work_status (
      company_id uuid NOT NULL REFERENCES companies(id),
      job_key text NOT NULL,
      name text NOT NULL,
      every_ms bigint NOT NULL CHECK (every_ms >= 60000),
      next_run_at timestamptz NOT NULL,
      outcome text NOT NULL CHECK (outcome IN ('never','running','success','failure','dead_lettered')),
      attempts integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL CHECK (max_attempts > 0),
      last_scheduled_for timestamptz,
      last_started_at timestamptz,
      last_completed_at timestamptz,
      duration_ms bigint CHECK (duration_ms >= 0),
      last_error_code text,
      queue_job_id uuid,
      summary text,
      PRIMARY KEY (company_id, job_key),
      FOREIGN KEY (company_id, queue_job_id) REFERENCES operational_jobs(company_id, id)
    );
    CREATE INDEX recurring_work_due_idx ON recurring_work_status(next_run_at) WHERE outcome <> 'running';
    ALTER TABLE recurring_work_status ENABLE ROW LEVEL SECURITY;
    ALTER TABLE recurring_work_status FORCE ROW LEVEL SECURITY;
    CREATE POLICY recurring_work_tenant ON recurring_work_status USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
  `,
  down: `DROP TABLE IF EXISTS recurring_work_status;`,
}, {
  // Issue #345 — the worker has to find which companies have work due without being able to read any
  // company's data. Row-level security hides every row from a connection that names no company, so
  // one function, owned by a role that may see only the columns that say "something is due", answers
  // that question with company ids and nothing else. The application role may only call it.
  id: "20261016T071944132Z_operations_b75f8117d2e9_worker_finds_due_work",
  up: `
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'invoice_work_finder') THEN
        CREATE ROLE invoice_work_finder NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      END IF;
    END $$;
    GRANT USAGE ON SCHEMA public TO invoice_work_finder;
    GRANT SELECT (id) ON companies TO invoice_work_finder;
    GRANT SELECT (company_id, sent_at, dead_at, available_at) ON outbox_messages TO invoice_work_finder;
    GRANT SELECT (company_id, outcome, next_run_at, last_started_at) ON recurring_work_status TO invoice_work_finder;
    CREATE POLICY outbox_messages_work_finder ON outbox_messages FOR SELECT TO invoice_work_finder USING (true);
    CREATE POLICY recurring_work_status_work_finder ON recurring_work_status FOR SELECT TO invoice_work_finder USING (true);
    CREATE FUNCTION companies_with_due_work(stale_after interval) RETURNS SETOF uuid
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
        SELECT c.id FROM companies c
         WHERE EXISTS (SELECT 1 FROM outbox_messages o
                        WHERE o.company_id = c.id AND o.sent_at IS NULL AND o.dead_at IS NULL AND o.available_at <= now())
            OR EXISTS (SELECT 1 FROM recurring_work_status r
                        WHERE r.company_id = c.id
                          AND ((r.outcome <> 'running' AND r.next_run_at <= now())
                            OR (r.outcome = 'running' AND r.last_started_at < now() - stale_after)))
         ORDER BY c.id
    $fn$;
    GRANT invoice_work_finder TO CURRENT_USER;
    ALTER FUNCTION companies_with_due_work(interval) OWNER TO invoice_work_finder;
    REVOKE ALL ON FUNCTION companies_with_due_work(interval) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION companies_with_due_work(interval) TO invoice_app;
  `,
  // The role is shared by every database on the server, so it is left in place.
  down: `
    DROP FUNCTION IF EXISTS companies_with_due_work(interval);
    DROP POLICY IF EXISTS recurring_work_status_work_finder ON recurring_work_status;
    DROP POLICY IF EXISTS outbox_messages_work_finder ON outbox_messages;
    REVOKE ALL ON recurring_work_status, outbox_messages, companies FROM invoice_work_finder;
    REVOKE USAGE ON SCHEMA public FROM invoice_work_finder;
  `,
}];
