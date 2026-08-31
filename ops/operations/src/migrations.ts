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
}];
