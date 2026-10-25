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
}, {
  // #366: what PrivacyService and BackupRecoveryService kept in memory now lives here, and the
  // evidence tables follow docs/contracts/database-immutability-v1.md: final when written, or
  // settled once (a request leaves "requested", a hold is released, a backup is pruned) and then final.
  id: "20261023T012522279Z_security_4a5cb8ae000d_persist_privacy_recovery",
  up: `
    ALTER TABLE privacy_requests ADD COLUMN idempotency_key text;
    ALTER TABLE privacy_requests ADD CONSTRAINT privacy_requests_key UNIQUE (company_id, kind, idempotency_key);
    ALTER TABLE privacy_legal_holds ADD COLUMN released_at timestamptz;
    ALTER TABLE backup_records ADD COLUMN idempotency_key text, ADD COLUMN idempotency_input text, ADD COLUMN pruned_at timestamptz;
    ALTER TABLE backup_records ADD CONSTRAINT backup_records_key UNIQUE (company_id, idempotency_key);
    CREATE TABLE privacy_retention_rules (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), subject_id text NOT NULL, retain_until timestamptz NOT NULL, set_at timestamptz NOT NULL, seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE);
    CREATE INDEX privacy_retention_latest_idx ON privacy_retention_rules(company_id, subject_id, seq DESC);
    CREATE INDEX privacy_consents_subject_idx ON privacy_consents(company_id, subject_id, decided_at, id);
    CREATE INDEX restore_drills_company_idx ON restore_drills(company_id, completed_at, id);
    CREATE INDEX backup_records_expiry_idx ON backup_records(company_id, expires_at) WHERE pruned_at IS NULL;
    ALTER TABLE privacy_retention_rules ENABLE ROW LEVEL SECURITY;
    ALTER TABLE privacy_retention_rules FORCE ROW LEVEL SECURITY;
    CREATE POLICY privacy_retention_rules_tenant ON privacy_retention_rules USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    CREATE FUNCTION security_settled_stays_settled() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
    BEGIN
      IF (to_jsonb(OLD) ->> TG_ARGV[0]) IS DISTINCT FROM NULLIF(TG_ARGV[1], '') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
        RAISE EXCEPTION 'A settled record stays as it was settled.' USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME, COLUMN = TG_ARGV[0];
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER privacy_notices_frozen BEFORE UPDATE OR DELETE ON privacy_notices FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('', '*', '', '');
    CREATE TRIGGER privacy_consents_frozen BEFORE UPDATE OR DELETE ON privacy_consents FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('', '*', '', '');
    CREATE TRIGGER privacy_retention_rules_frozen BEFORE UPDATE OR DELETE ON privacy_retention_rules FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('', '*', '', '');
    CREATE TRIGGER restore_drills_frozen BEFORE UPDATE OR DELETE ON restore_drills FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('', '*', '', '');
    CREATE TRIGGER privacy_requests_frozen BEFORE UPDATE OR DELETE ON privacy_requests FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('status', '*', 'blockers,completed_at', 'requested>blocked,requested>completed');
    CREATE TRIGGER privacy_requests_settled BEFORE UPDATE ON privacy_requests FOR EACH ROW EXECUTE FUNCTION security_settled_stays_settled('status', 'requested');
    CREATE TRIGGER privacy_legal_holds_frozen BEFORE UPDATE OR DELETE ON privacy_legal_holds FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('', '*', 'active,released_at', '');
    CREATE TRIGGER privacy_legal_holds_settled BEFORE UPDATE ON privacy_legal_holds FOR EACH ROW EXECUTE FUNCTION security_settled_stays_settled('active', 'true');
    CREATE TRIGGER backup_records_frozen BEFORE UPDATE OR DELETE ON backup_records FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('', '*', 'pruned_at', '');
    CREATE TRIGGER backup_records_settled BEFORE UPDATE ON backup_records FOR EACH ROW EXECUTE FUNCTION security_settled_stays_settled('pruned_at', '');
    CREATE TRIGGER privacy_notices_no_truncate BEFORE TRUNCATE ON privacy_notices FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();
    CREATE TRIGGER privacy_consents_no_truncate BEFORE TRUNCATE ON privacy_consents FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();
    CREATE TRIGGER privacy_retention_rules_no_truncate BEFORE TRUNCATE ON privacy_retention_rules FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();
    CREATE TRIGGER privacy_requests_no_truncate BEFORE TRUNCATE ON privacy_requests FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();
    CREATE TRIGGER privacy_legal_holds_no_truncate BEFORE TRUNCATE ON privacy_legal_holds FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();
    CREATE TRIGGER backup_records_no_truncate BEFORE TRUNCATE ON backup_records FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();
    CREATE TRIGGER restore_drills_no_truncate BEFORE TRUNCATE ON restore_drills FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();
    REVOKE DELETE ON privacy_notices, privacy_consents, privacy_retention_rules, privacy_requests, privacy_legal_holds, backup_records, restore_drills FROM invoice_app;
  `,
  down: `
    DROP TRIGGER IF EXISTS restore_drills_no_truncate ON restore_drills;
    DROP TRIGGER IF EXISTS backup_records_no_truncate ON backup_records;
    DROP TRIGGER IF EXISTS privacy_legal_holds_no_truncate ON privacy_legal_holds;
    DROP TRIGGER IF EXISTS privacy_requests_no_truncate ON privacy_requests;
    DROP TRIGGER IF EXISTS privacy_consents_no_truncate ON privacy_consents;
    DROP TRIGGER IF EXISTS privacy_notices_no_truncate ON privacy_notices;
    DROP TRIGGER IF EXISTS backup_records_settled ON backup_records;
    DROP TRIGGER IF EXISTS backup_records_frozen ON backup_records;
    DROP TRIGGER IF EXISTS privacy_legal_holds_settled ON privacy_legal_holds;
    DROP TRIGGER IF EXISTS privacy_legal_holds_frozen ON privacy_legal_holds;
    DROP TRIGGER IF EXISTS privacy_requests_settled ON privacy_requests;
    DROP TRIGGER IF EXISTS privacy_requests_frozen ON privacy_requests;
    DROP TRIGGER IF EXISTS restore_drills_frozen ON restore_drills;
    DROP TRIGGER IF EXISTS privacy_consents_frozen ON privacy_consents;
    DROP TRIGGER IF EXISTS privacy_notices_frozen ON privacy_notices;
    DROP FUNCTION IF EXISTS security_settled_stays_settled();
    DROP TABLE IF EXISTS privacy_retention_rules;
    DROP INDEX IF EXISTS backup_records_expiry_idx;
    DROP INDEX IF EXISTS restore_drills_company_idx;
    DROP INDEX IF EXISTS privacy_consents_subject_idx;
    ALTER TABLE backup_records DROP CONSTRAINT IF EXISTS backup_records_key;
    ALTER TABLE backup_records DROP COLUMN IF EXISTS pruned_at, DROP COLUMN IF EXISTS idempotency_input, DROP COLUMN IF EXISTS idempotency_key;
    ALTER TABLE privacy_legal_holds DROP COLUMN IF EXISTS released_at;
    ALTER TABLE privacy_requests DROP CONSTRAINT IF EXISTS privacy_requests_key;
    ALTER TABLE privacy_requests DROP COLUMN IF EXISTS idempotency_key;
  `,
}];
