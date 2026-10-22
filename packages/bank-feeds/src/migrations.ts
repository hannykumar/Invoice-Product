import type { Migration } from '../../platform/src/migration-definitions.ts';

export const bankFeedMigrations: readonly Migration[] = [{
  id: '20260830T191155111Z_bank-feeds_26eb7bffdaf2_live_bank_feed_connections',
  up: `
    CREATE TABLE bank_feed_connections (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), provider text NOT NULL, provider_consent_id text, status text NOT NULL CHECK (status IN ('PENDING_CONSENT','CONNECTED','TOKEN_EXPIRED','REVOKED','DISCONNECTED','ERROR')), consent_expires_at timestamptz, connected_at timestamptz, disconnected_at timestamptz, last_synced_at timestamptz, sync_status text NOT NULL CHECK (sync_status IN ('IDLE','PROCESSING','SUCCEEDED','FAILED')), last_error text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(company_id, provider, provider_consent_id));
    CREATE TABLE bank_feed_accounts (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), connection_id uuid NOT NULL REFERENCES bank_feed_connections(id), provider_account_id text NOT NULL, display_name text NOT NULL, masked_account_number text NOT NULL, account_type text NOT NULL CHECK (account_type IN ('CURRENT','SAVINGS','CASH_CREDIT','OTHER')), currency text NOT NULL CHECK (currency = 'INR'), balance_paise bigint, balance_as_of timestamptz, cursor text, active boolean NOT NULL DEFAULT true, UNIQUE(company_id, connection_id, provider_account_id));
    CREATE TABLE bank_feed_transactions (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), connection_id uuid NOT NULL REFERENCES bank_feed_connections(id), account_id uuid NOT NULL REFERENCES bank_feed_accounts(id), provider_transaction_id text NOT NULL, booked_on date NOT NULL, description text NOT NULL, debit_paise bigint NOT NULL CHECK (debit_paise >= 0), credit_paise bigint NOT NULL CHECK (credit_paise >= 0), reference text, fingerprint text NOT NULL, imported_at timestamptz NOT NULL DEFAULT now(), CHECK ((debit_paise = 0) <> (credit_paise = 0)), UNIQUE(company_id, account_id, provider_transaction_id), UNIQUE(company_id, fingerprint));
    CREATE INDEX bank_feed_connections_company_status_idx ON bank_feed_connections(company_id, status);
    CREATE INDEX bank_feed_transactions_account_date_idx ON bank_feed_transactions(account_id, booked_on);
    ALTER TABLE bank_feed_connections ENABLE ROW LEVEL SECURITY; ALTER TABLE bank_feed_connections FORCE ROW LEVEL SECURITY;
    ALTER TABLE bank_feed_accounts ENABLE ROW LEVEL SECURITY; ALTER TABLE bank_feed_accounts FORCE ROW LEVEL SECURITY;
    ALTER TABLE bank_feed_transactions ENABLE ROW LEVEL SECURITY; ALTER TABLE bank_feed_transactions FORCE ROW LEVEL SECURITY;
    CREATE POLICY bank_feed_connections_tenant ON bank_feed_connections USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    CREATE POLICY bank_feed_accounts_tenant ON bank_feed_accounts USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    CREATE POLICY bank_feed_transactions_tenant ON bank_feed_transactions USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
  `,
  down: `DROP TABLE IF EXISTS bank_feed_transactions; DROP TABLE IF EXISTS bank_feed_accounts; DROP TABLE IF EXISTS bank_feed_connections;`,
}, {
  // Issue #366 — what PostgresBankFeedStore needs to hold everything the service kept in memory.
  id: '20261016T014425043Z_bank-feeds_156746db52c6_postgres_repositories',
  up: `
    -- The provider's page for the customer to grant permission, kept only while the request is
    -- pending (the service clears it on connect, disconnect and revoke). It is a link, not a
    -- credential: no password, OTP or token is stored (connector-v1 CredentialVault).
    ALTER TABLE bank_feed_connections ADD COLUMN consent_url text;
    -- The order rows were written in, for lists and keyset paging.
    ALTER TABLE bank_feed_connections ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
    ALTER TABLE bank_feed_accounts ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
    ALTER TABLE bank_feed_transactions ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
    CREATE UNIQUE INDEX bank_feed_connections_company_seq_idx ON bank_feed_connections(company_id, seq);
    CREATE UNIQUE INDEX bank_feed_accounts_connection_seq_idx ON bank_feed_accounts(company_id, connection_id, seq);
    CREATE UNIQUE INDEX bank_feed_transactions_connection_seq_idx ON bank_feed_transactions(company_id, connection_id, seq);

    -- What a sync with this idempotency key returned, so the same key returns it again without
    -- calling the bank. Written once. The transactions themselves are not copied: their ids are.
    CREATE TABLE bank_feed_syncs (
      company_id uuid NOT NULL REFERENCES companies(id),
      connection_id uuid NOT NULL REFERENCES bank_feed_connections(id),
      idempotency_key text NOT NULL,
      connection jsonb NOT NULL,
      imported integer NOT NULL CHECK (imported >= 0),
      duplicates integer NOT NULL CHECK (duplicates >= 0),
      transaction_ids uuid[] NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (company_id, connection_id, idempotency_key)
    );
    ALTER TABLE bank_feed_syncs ENABLE ROW LEVEL SECURITY; ALTER TABLE bank_feed_syncs FORCE ROW LEVEL SECURITY;
    CREATE POLICY bank_feed_syncs_tenant ON bank_feed_syncs USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);

    -- Imported bank lines and sync results are final when written (database-immutability-v1).
    CREATE TRIGGER bank_feed_transactions_frozen BEFORE UPDATE OR DELETE ON bank_feed_transactions
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('', '*', '', '');
    CREATE TRIGGER bank_feed_transactions_no_truncate BEFORE TRUNCATE ON bank_feed_transactions
      FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();
    CREATE TRIGGER bank_feed_syncs_frozen BEFORE UPDATE OR DELETE ON bank_feed_syncs
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('', '*', '', '');
    CREATE TRIGGER bank_feed_syncs_no_truncate BEFORE TRUNCATE ON bank_feed_syncs
      FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();

    -- The bank-feed audit trail lives in audit_events (PostgresAuditLog), read back by connection.
    CREATE INDEX audit_events_bank_feed_idx ON audit_events(company_id, correlation_id, seq) WHERE action LIKE 'bank_feed.%';
  `,
  down: `
    DROP INDEX IF EXISTS audit_events_bank_feed_idx;
    DROP TABLE IF EXISTS bank_feed_syncs;
    DROP TRIGGER IF EXISTS bank_feed_transactions_no_truncate ON bank_feed_transactions;
    DROP TRIGGER IF EXISTS bank_feed_transactions_frozen ON bank_feed_transactions;
    DROP INDEX IF EXISTS bank_feed_transactions_connection_seq_idx;
    DROP INDEX IF EXISTS bank_feed_accounts_connection_seq_idx;
    DROP INDEX IF EXISTS bank_feed_connections_company_seq_idx;
    ALTER TABLE bank_feed_transactions DROP COLUMN IF EXISTS seq;
    ALTER TABLE bank_feed_accounts DROP COLUMN IF EXISTS seq;
    ALTER TABLE bank_feed_connections DROP COLUMN IF EXISTS seq, DROP COLUMN IF EXISTS consent_url;
  `,
}];
