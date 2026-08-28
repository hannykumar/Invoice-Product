import type { Migration } from "../../../packages/platform/src/migration-definitions.ts";

export const securityMigrations: readonly Migration[] = [{
  id: "20260828T222939592Z_security_c8e935e1735a_privacy_recovery",
  up: `
    CREATE TABLE privacy_notices (company_id uuid NOT NULL REFERENCES companies(id), version text NOT NULL, effective_at timestamptz NOT NULL, purposes jsonb NOT NULL, published_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id, version));
    CREATE TABLE privacy_consents (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), subject_id text NOT NULL, notice_version text NOT NULL, purposes jsonb NOT NULL, decision text NOT NULL CHECK (decision IN ('granted','withdrawn')), decided_at timestamptz NOT NULL, FOREIGN KEY(company_id, notice_version) REFERENCES privacy_notices(company_id, version));
    CREATE TABLE privacy_requests (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), subject_id text NOT NULL, kind text NOT NULL CHECK (kind IN ('export','deletion')), status text NOT NULL CHECK (status IN ('requested','blocked','completed')), blockers jsonb NOT NULL DEFAULT '[]', requested_at timestamptz NOT NULL, completed_at timestamptz);
    CREATE TABLE privacy_legal_holds (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), subject_id text NOT NULL, reason text NOT NULL, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE backup_records (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), object_key text NOT NULL, schema_version text NOT NULL, checksum_sha256 text NOT NULL, byte_length bigint NOT NULL CHECK (byte_length >= 0), encryption_key_id text NOT NULL, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, UNIQUE(company_id, id));
    CREATE TABLE restore_drills (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), backup_id uuid NOT NULL, status text NOT NULL CHECK (status IN ('passed','failed')), details text NOT NULL, started_at timestamptz NOT NULL, completed_at timestamptz NOT NULL, FOREIGN KEY(company_id, backup_id) REFERENCES backup_records(company_id, id));
    CREATE INDEX privacy_requests_company_status_idx ON privacy_requests(company_id, status);
    CREATE INDEX privacy_holds_company_subject_idx ON privacy_legal_holds(company_id, subject_id) WHERE active;
    CREATE INDEX backup_records_company_created_idx ON backup_records(company_id, created_at DESC);
    ALTER TABLE privacy_notices ENABLE ROW LEVEL SECURITY;
    ALTER TABLE privacy_consents ENABLE ROW LEVEL SECURITY;
    ALTER TABLE privacy_requests ENABLE ROW LEVEL SECURITY;
    ALTER TABLE privacy_legal_holds ENABLE ROW LEVEL SECURITY;
    ALTER TABLE backup_records ENABLE ROW LEVEL SECURITY;
    ALTER TABLE restore_drills ENABLE ROW LEVEL SECURITY;
    ALTER TABLE privacy_notices FORCE ROW LEVEL SECURITY;
    ALTER TABLE privacy_consents FORCE ROW LEVEL SECURITY;
    ALTER TABLE privacy_requests FORCE ROW LEVEL SECURITY;
    ALTER TABLE privacy_legal_holds FORCE ROW LEVEL SECURITY;
    ALTER TABLE backup_records FORCE ROW LEVEL SECURITY;
    ALTER TABLE restore_drills FORCE ROW LEVEL SECURITY;
    CREATE POLICY privacy_notices_tenant ON privacy_notices USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    CREATE POLICY privacy_consents_tenant ON privacy_consents USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    CREATE POLICY privacy_requests_tenant ON privacy_requests USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    CREATE POLICY privacy_holds_tenant ON privacy_legal_holds USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    CREATE POLICY backup_records_tenant ON backup_records USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    CREATE POLICY restore_drills_tenant ON restore_drills USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
  `,
  down: `DROP TABLE IF EXISTS restore_drills; DROP TABLE IF EXISTS backup_records; DROP TABLE IF EXISTS privacy_legal_holds; DROP TABLE IF EXISTS privacy_requests; DROP TABLE IF EXISTS privacy_consents; DROP TABLE IF EXISTS privacy_notices;`,
}];
