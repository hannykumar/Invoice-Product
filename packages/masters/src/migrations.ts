// PostgreSQL schema for master data (issue #5).
//
// Two ideas drive the shape of these tables:
//   * Every company's rows carry company_id and every unique constraint includes it,
//     so one company can never collide with or read another's data.
//   * Master records are append-only versions. `*_versions` tables hold the history;
//     reading "as of" a date means picking the latest version effective on or before it.

import type { Migration } from "../../platform/src/migration-definitions.ts";

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
}]);
