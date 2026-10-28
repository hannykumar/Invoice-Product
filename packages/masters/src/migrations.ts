// PostgreSQL schema for master data (issue #5).
//
// Two ideas drive the shape of these tables:
//   * Every company's rows carry company_id and every unique constraint includes it,
//     so one company can never collide with or read another's data.
//   * Master records are append-only versions. `*_versions` tables hold the history;
//     reading "as of" a date means picking the latest version effective on or before it.

import type { Migration } from "../../platform/src/migration-definitions.ts";

/** Every table of this module that holds a company's rows: each one forces row-level security (issue #366). */
const TENANT_TABLES = ["master_records", "master_versions", "master_identity_keys", "master_name_index", "master_merges", "units_of_measure", "unit_conversions", "master_snapshots", "master_command_records"] as const;

export const masterDataMigrations: readonly Migration[] = Object.freeze([{
  id: "0006_master_data",
  up: `
    CREATE TABLE master_records (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      kind text NOT NULL CHECK (kind IN ('party','party_address','item','warehouse','batch','serial','opening_stock','price_list','price_list_entry','tax_default','transporter','vehicle','bank_account')),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX master_records_company_kind_idx ON master_records(company_id, kind);

    -- One row per change. The effective date is a date, not a timestamp: master data
    -- changes belong to a business day, and back-dated corrections must be possible.
    CREATE TABLE master_versions (
      record_id uuid NOT NULL REFERENCES master_records(id),
      version integer NOT NULL,
      company_id uuid NOT NULL REFERENCES companies(id),
      effective_from date NOT NULL,
      data jsonb NOT NULL,
      recorded_by uuid NOT NULL REFERENCES users(id),
      recorded_at timestamptz NOT NULL DEFAULT now(),
      reason text,
      PRIMARY KEY (record_id, version)
    );
    CREATE INDEX master_versions_asof_idx ON master_versions(company_id, record_id, effective_from DESC, version DESC);

    -- Identity keys are held separately so duplicate detection is an index lookup
    -- rather than a scan, and so a repeated GSTIN fails at the database as well as in
    -- application code.
    CREATE TABLE master_identity_keys (
      company_id uuid NOT NULL REFERENCES companies(id),
      record_id uuid NOT NULL REFERENCES master_records(id),
      key_type text NOT NULL CHECK (key_type IN ('gstin','pan','phone','email','bank_account','code','serial','vehicle_number','barcode')),
      key_value text NOT NULL,
      active boolean NOT NULL DEFAULT true,
      PRIMARY KEY (company_id, key_type, key_value)
    );
    CREATE INDEX master_identity_keys_record_idx ON master_identity_keys(record_id);

    -- Normalised names for fuzzy duplicate search. Stored, not computed at query time,
    -- so the normalisation rule that produced them is auditable.
    CREATE TABLE master_name_index (
      company_id uuid NOT NULL REFERENCES companies(id),
      record_id uuid NOT NULL REFERENCES master_records(id),
      raw_name text NOT NULL,
      normalised_name text NOT NULL,
      is_alias boolean NOT NULL DEFAULT false,
      PRIMARY KEY (record_id, raw_name)
    );
    CREATE INDEX master_name_index_lookup_idx ON master_name_index(company_id, normalised_name);

    -- Merges keep both ids alive: the losing record redirects, historical documents keep
    -- their snapshots, and the decision itself is auditable.
    CREATE TABLE master_merges (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      kind text NOT NULL,
      winner_id uuid NOT NULL REFERENCES master_records(id),
      loser_id uuid NOT NULL REFERENCES master_records(id),
      approved_by uuid NOT NULL REFERENCES users(id),
      command_id text NOT NULL,
      reason text,
      merged_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX master_merges_loser_idx ON master_merges(loser_id);

    CREATE TABLE units_of_measure (
      company_id uuid NOT NULL REFERENCES companies(id),
      code text NOT NULL,
      name text NOT NULL,
      display_decimals smallint NOT NULL DEFAULT 3,
      uqc text,
      PRIMARY KEY (company_id, code)
    );

    -- Conversions are exact ratios. item_id NULL means the conversion is universal.
    CREATE TABLE unit_conversions (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      item_id uuid REFERENCES master_records(id),
      from_unit text NOT NULL,
      to_unit text NOT NULL,
      numerator bigint NOT NULL CHECK (numerator > 0),
      denominator bigint NOT NULL CHECK (denominator > 0)
    );
    CREATE UNIQUE INDEX unit_conversions_unique_idx ON unit_conversions(company_id, COALESCE(item_id, '00000000-0000-0000-0000-000000000000'::uuid), from_unit, to_unit);

    -- The facts a document copied from a master, kept with the document forever.
    CREATE TABLE master_snapshots (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      document_type text NOT NULL,
      document_id uuid NOT NULL,
      kind text NOT NULL,
      master_id uuid NOT NULL REFERENCES master_records(id),
      version integer NOT NULL,
      effective_from date NOT NULL,
      facts jsonb NOT NULL,
      captured_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX master_snapshots_document_idx ON master_snapshots(company_id, document_type, document_id);
  `,
  down: `
    DROP TABLE IF EXISTS master_snapshots;
    DROP TABLE IF EXISTS unit_conversions;
    DROP TABLE IF EXISTS units_of_measure;
    DROP TABLE IF EXISTS master_merges;
    DROP TABLE IF EXISTS master_name_index;
    DROP TABLE IF EXISTS master_identity_keys;
    DROP TABLE IF EXISTS master_versions;
    DROP TABLE IF EXISTS master_records;
  `,
}, {
  // Issue #366 — what the PostgreSQL repositories (postgres-masters.ts) need that the first migration lacks.
  id: "20261011T144837144Z_masters_daa8ac15a52a_repositories_rls_and_command_index",
  up: `
    -- The order records were created in. The in-memory stores list in that order, and the service
    -- reads it ("the first tax default that matches"), so the database keeps it rather than guessing
    -- from a timestamp shared by every row of one transaction.
    ALTER TABLE master_records ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
    ALTER TABLE units_of_measure ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
    ALTER TABLE unit_conversions ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;

    -- The target of the same-company foreign keys below: a version, a conversion or a command's
    -- record can only point at a record of its own company. (Foreign-key checks do not go through
    -- row-level security, so without this another company's record id would be accepted.)
    CREATE UNIQUE INDEX master_records_company_id_idx ON master_records(company_id, id);
    -- Listing one kind page by page: WHERE company_id = $1 AND kind = $2 AND id > $3 ORDER BY id.
    CREATE INDEX master_records_company_kind_id_idx ON master_records(company_id, kind, id);
    ALTER TABLE master_versions ADD CONSTRAINT master_versions_same_company_fk FOREIGN KEY (company_id, record_id) REFERENCES master_records(company_id, id);
    ALTER TABLE unit_conversions ADD CONSTRAINT unit_conversions_same_company_fk FOREIGN KEY (company_id, item_id) REFERENCES master_records(company_id, id);
    -- For that foreign key: the unique index holds item_id only inside an expression.
    CREATE INDEX unit_conversions_item_idx ON unit_conversions(company_id, item_id) WHERE item_id IS NOT NULL;

    -- Which record a finished master-data command wrote, so a retry with the same idempotency key
    -- returns that record after a restart (the service's command-to-record map). Final when written.
    CREATE TABLE master_command_records (
      company_id uuid NOT NULL REFERENCES companies(id),
      command_id uuid NOT NULL REFERENCES command_records(id),
      record_id uuid NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (company_id, command_id),
      FOREIGN KEY (company_id, record_id) REFERENCES master_records(company_id, id)
    );
    -- For the foreign keys to the record and to the command.
    CREATE INDEX master_command_records_record_idx ON master_command_records(company_id, record_id);
    CREATE INDEX master_command_records_command_idx ON master_command_records(command_id);
    CREATE TRIGGER master_command_records_frozen BEFORE UPDATE OR DELETE ON master_command_records
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('', '*', '', '');
    CREATE TRIGGER master_command_records_no_truncate BEFORE TRUNCATE ON master_command_records
      FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();
${TENANT_TABLES.map((table) => `
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
    CREATE POLICY ${table}_tenant ON ${table}
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);`).join("")}
  `,
  down: `
    DROP TABLE IF EXISTS master_command_records;
${TENANT_TABLES.filter((table) => table !== "master_command_records").map((table) => `
    DROP POLICY IF EXISTS ${table}_tenant ON ${table};
    ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`).join("")}
    DROP INDEX IF EXISTS unit_conversions_item_idx;
    ALTER TABLE unit_conversions DROP CONSTRAINT IF EXISTS unit_conversions_same_company_fk;
    ALTER TABLE master_versions DROP CONSTRAINT IF EXISTS master_versions_same_company_fk;
    DROP INDEX IF EXISTS master_records_company_kind_id_idx;
    DROP INDEX IF EXISTS master_records_company_id_idx;
    ALTER TABLE unit_conversions DROP COLUMN IF EXISTS seq;
    ALTER TABLE units_of_measure DROP COLUMN IF EXISTS seq;
    ALTER TABLE master_records DROP COLUMN IF EXISTS seq;
  `,
}, {
  // Issue #366 — a process that keeps a copy of a company's master data for its synchronous readers
  // asks "what is new since version number N?" once per request. Writers hold the company's write lock
  // for the whole action, so numbers are handed out in the order actions commit.
  id: "20261027T234048262Z_masters_8909da6f2e1d_master_versions_sequence",
  up: `
    ALTER TABLE master_versions ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
    CREATE UNIQUE INDEX master_versions_company_seq_idx ON master_versions(company_id, seq);
  `,
  down: `
    DROP INDEX IF EXISTS master_versions_company_seq_idx;
    ALTER TABLE master_versions DROP COLUMN IF EXISTS seq;
  `,
}]);
