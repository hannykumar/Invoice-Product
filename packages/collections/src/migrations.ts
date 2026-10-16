import type { Migration } from '../../platform/src/migration-definitions.ts';

const TENANT = `USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid)`;
const rls = (table: string): string =>
  `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY; CREATE POLICY ${table}_tenant ON ${table} ${TENANT};`;
/**
 * Both directions throw away the other shape's tables, so both refuse to run over a single saved row.
 * Forced row-level security would hide every row from the owner (no company is set while migrating),
 * so it is lifted first; the migration is one transaction, and a refusal rolls that back too.
 */
const refuseIfUsed = (tables: readonly string[]): string => `${tables.map((t) => `ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY;`).join(' ')}
  DO $$ BEGIN
  IF ${tables.map((t) => `EXISTS (SELECT 1 FROM ${t})`).join(' OR ')} THEN
    RAISE EXCEPTION 'collections tables already hold rows; reshape them by hand instead of this migration';
  END IF; END $$;`;

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
}, {
  /*
   * Issue #366 — the first schema did not fit the model the service stores (`model.ts`): no document
   * on a promise, a required document on a dispute, no step/level/audience on a reminder, no `sms`
   * channel, preferences as one row per party instead of one per channel. Nothing ever wrote to these
   * tables (there was no repository), so they are replaced rather than altered column by column; the
   * guard makes sure that is still true wherever this runs. `collection_communications` is kept as it
   * was and only re-linked to the new reminders table.
   *
   * The old "one open dispute per bill" index is not carried over: the service lets a second dispute
   * be raised on a bill that already has one, and the store must behave as the in-memory one does.
   */
  id: '20261014T182251738Z_collections_d509936797d8_reminders_schema_for_postgres_repositories',
  up: `
    ${refuseIfUsed(['collection_preferences', 'collection_promises', 'collection_disputes', 'collection_reminders', 'collection_communications'])}
    DROP TABLE collection_preferences, collection_promises, collection_disputes, collection_reminders CASCADE;
    CREATE TABLE collection_preferences (
      company_id uuid NOT NULL REFERENCES companies(id), party_id text NOT NULL,
      channel text NOT NULL CHECK (channel IN ('in_app','email','whatsapp','sms')),
      state text NOT NULL CHECK (state IN ('ENABLED','DISABLED')), reason text,
      recorded_by text NOT NULL, recorded_at timestamptz NOT NULL,
      PRIMARY KEY(company_id, party_id, channel)
    );
    -- The application has no DELETE: resuming reminders sets ended_at, a new opt-out clears it.
    CREATE TABLE collection_opt_outs (
      company_id uuid NOT NULL REFERENCES companies(id), party_id text NOT NULL, reason text NOT NULL,
      recorded_by text NOT NULL, recorded_at timestamptz NOT NULL, ended_at timestamptz,
      PRIMARY KEY(company_id, party_id)
    );
    CREATE TABLE collection_promises (
      id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), party_id text NOT NULL,
      document_id text NOT NULL, amount_paise bigint NOT NULL CHECK (amount_paise > 0), promised_on date NOT NULL,
      note text, state text NOT NULL CHECK (state IN ('OPEN','CANCELLED')),
      recorded_by text NOT NULL, recorded_at timestamptz NOT NULL
    );
    -- promises(companyId) in recorded order and its keyset pages; also the company foreign key.
    CREATE INDEX collection_promises_list_idx ON collection_promises(company_id, recorded_at, id);
    CREATE TABLE collection_disputes (
      id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), party_id text NOT NULL,
      document_id text, reason text NOT NULL, state text NOT NULL CHECK (state IN ('OPEN','RESOLVED')),
      resolution text, raised_by text NOT NULL, raised_at timestamptz NOT NULL,
      resolved_by text, resolved_at timestamptz
    );
    -- disputes(companyId) in raised order and its keyset pages; also the company foreign key.
    CREATE INDEX collection_disputes_list_idx ON collection_disputes(company_id, raised_at, id);
    CREATE TABLE collection_reminders (
      id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), branch_id uuid REFERENCES branches(id),
      party_id text NOT NULL, document_id text NOT NULL, reminder_key text NOT NULL, step_code text NOT NULL,
      level text NOT NULL CHECK (level IN ('ADVANCE','GENTLE','FIRM','FINAL','ESCALATE')),
      channel text NOT NULL CHECK (channel IN ('in_app','email','whatsapp','sms')),
      audience text NOT NULL CHECK (audience IN ('CUSTOMER','OWNER')), message jsonb NOT NULL,
      snapshot_as_of date NOT NULL, document_number text NOT NULL, document_value_paise bigint NOT NULL,
      outstanding_paise bigint NOT NULL, party_outstanding_paise bigint NOT NULL, days_overdue integer NOT NULL,
      state text NOT NULL CHECK (state IN ('SCHEDULED','SENT','FAILED','SUPPRESSED','CANCELLED')),
      failure_reason text, notification_id text, scheduled_by text NOT NULL, scheduled_at timestamptz NOT NULL,
      sent_at timestamptz,
      -- findByKey, and the database's own refusal of a second reminder for one bill and rung.
      UNIQUE(company_id, reminder_key)
    );
    -- list(companyId), newest first, and its keyset pages.
    CREATE INDEX collection_reminders_list_idx ON collection_reminders(company_id, scheduled_at DESC, id DESC);
    -- The foreign key to branches.
    CREATE INDEX collection_reminders_branch_idx ON collection_reminders(branch_id);
    ALTER TABLE collection_communications ADD CONSTRAINT collection_communications_reminder_id_fkey FOREIGN KEY (reminder_id) REFERENCES collection_reminders(id);
    ALTER TABLE collection_communications FORCE ROW LEVEL SECURITY;
    -- The foreign key to reminders, which had no index.
    CREATE INDEX collection_communications_reminder_idx ON collection_communications(reminder_id);
    ${['collection_preferences', 'collection_opt_outs', 'collection_promises', 'collection_disputes', 'collection_reminders'].map(rls).join('\n    ')}
  `,
  down: `
    ${refuseIfUsed(['collection_preferences', 'collection_opt_outs', 'collection_promises', 'collection_disputes', 'collection_reminders', 'collection_communications'])}
    DROP INDEX collection_communications_reminder_idx;
    DROP TABLE collection_preferences, collection_opt_outs, collection_promises, collection_disputes, collection_reminders CASCADE;
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
    CREATE INDEX collection_reminders_review_idx ON collection_reminders(company_id, status, scheduled_at);
    CREATE INDEX collection_promises_party_idx ON collection_promises(company_id, party_id, status, promised_on);
    ALTER TABLE collection_communications ADD CONSTRAINT collection_communications_reminder_id_fkey FOREIGN KEY (reminder_id) REFERENCES collection_reminders(id);
    ALTER TABLE collection_communications FORCE ROW LEVEL SECURITY;
    ${['collection_preferences', 'collection_promises', 'collection_disputes', 'collection_reminders'].map(rls).join('\n    ')}
  `,
}];
