import type { Migration } from '../../platform/src/migration-definitions.ts';

export const collectionMigrations: readonly Migration[] = [{
  id: '20260830T111739009Z_collections_7b9b231c18b7_payment_reminders',
  up: `
    CREATE TABLE collection_preferences (
      company_id uuid NOT NULL REFERENCES companies(id), party_id text NOT NULL,
      opted_out boolean NOT NULL DEFAULT false, disabled_channels jsonb NOT NULL DEFAULT '[]',
      locale text NOT NULL DEFAULT 'en-IN' CHECK (locale IN ('en-IN','hi-IN')),
      updated_at timestamptz NOT NULL, updated_by text NOT NULL,
      PRIMARY KEY(company_id, party_id)
    );
    CREATE TABLE collection_promises (
      id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), party_id text NOT NULL,
      amount_paise bigint NOT NULL CHECK (amount_paise > 0), promised_on date NOT NULL, note text,
      status text NOT NULL CHECK (status IN ('OPEN','KEPT','BROKEN','CANCELLED')),
      balance_at_promise_paise bigint NOT NULL, created_at timestamptz NOT NULL, created_by text NOT NULL,
      closed_at timestamptz
    );
    CREATE TABLE collection_disputes (
      id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), party_id text NOT NULL,
      document_id text NOT NULL, document_number text NOT NULL, reason text NOT NULL,
      status text NOT NULL CHECK (status IN ('OPEN','RESOLVED')),
      opened_at timestamptz NOT NULL, opened_by text NOT NULL, resolved_at timestamptz, resolution text
    );
    CREATE UNIQUE INDEX collection_one_open_dispute_idx ON collection_disputes(company_id, party_id, document_id) WHERE status = 'OPEN';
    CREATE TABLE collection_reminders (
      id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), party_id text NOT NULL,
      party_name text NOT NULL, channel text NOT NULL CHECK (channel IN ('in_app','email','whatsapp')),
      locale text NOT NULL CHECK (locale IN ('en-IN','hi-IN')), template text NOT NULL,
      stage integer NOT NULL CHECK (stage > 0), scheduled_at timestamptz NOT NULL,
      status text NOT NULL CHECK (status IN ('SCHEDULED','DELIVERED','FAILED','SUPPRESSED','CANCELLED')),
      subject text NOT NULL, message text NOT NULL, balance_snapshot jsonb NOT NULL,
      deduplication_key text NOT NULL, notification_id text, status_reason text,
      created_at timestamptz NOT NULL, created_by text NOT NULL, updated_at timestamptz NOT NULL,
      UNIQUE(company_id, deduplication_key)
    );
    CREATE TABLE collection_communications (
      id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id),
      reminder_id uuid NOT NULL REFERENCES collection_reminders(id), party_id text NOT NULL,
      channel text NOT NULL, outcome text NOT NULL, subject text NOT NULL, message text NOT NULL,
      balance_snapshot jsonb NOT NULL, provider_reference text, detail text,
      occurred_at timestamptz NOT NULL, actor_id text NOT NULL
    );
    CREATE INDEX collection_reminders_review_idx ON collection_reminders(company_id, status, scheduled_at);
    CREATE INDEX collection_promises_party_idx ON collection_promises(company_id, party_id, status, promised_on);
    CREATE INDEX collection_communications_party_idx ON collection_communications(company_id, party_id, occurred_at DESC);
    ALTER TABLE collection_preferences ENABLE ROW LEVEL SECURITY; ALTER TABLE collection_preferences FORCE ROW LEVEL SECURITY;
    ALTER TABLE collection_promises ENABLE ROW LEVEL SECURITY; ALTER TABLE collection_promises FORCE ROW LEVEL SECURITY;
    ALTER TABLE collection_disputes ENABLE ROW LEVEL SECURITY; ALTER TABLE collection_disputes FORCE ROW LEVEL SECURITY;
    ALTER TABLE collection_reminders ENABLE ROW LEVEL SECURITY; ALTER TABLE collection_reminders FORCE ROW LEVEL SECURITY;
    ALTER TABLE collection_communications ENABLE ROW LEVEL SECURITY; ALTER TABLE collection_communications FORCE ROW LEVEL SECURITY;
    CREATE POLICY collection_preferences_tenant ON collection_preferences USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    CREATE POLICY collection_promises_tenant ON collection_promises USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    CREATE POLICY collection_disputes_tenant ON collection_disputes USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    CREATE POLICY collection_reminders_tenant ON collection_reminders USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    CREATE POLICY collection_communications_tenant ON collection_communications USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
  `,
  down: `
    DROP TABLE IF EXISTS collection_communications;
    DROP TABLE IF EXISTS collection_reminders;
    DROP TABLE IF EXISTS collection_disputes;
    DROP TABLE IF EXISTS collection_promises;
    DROP TABLE IF EXISTS collection_preferences;
  `,
}];
