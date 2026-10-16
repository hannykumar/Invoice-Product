// Issue #31 [E31] — the tables the purchase reconciliation owns.
//
// Three things about this schema are deliberate.
//
//   1. **One row per document, per company, per period.** Importing the same month twice is two
//      readings of one statement, not two statements, so the unique index makes doubling a figure
//      impossible in the database and not only in the code that writes to it. The history of who
//      imported what lives in `itc_import_batches`, which is append-only.
//   2. **Decisions are append-only and carry a fingerprint.** There is no `decision` column on the
//      document to be overwritten. An accountant who accepts a bill, changes their mind and
//      rejects it has done two things, and both stay visible. The fingerprint records the figures
//      the person was looking at, which is what lets a later recomputation say "your answer was
//      about different numbers" instead of applying it to numbers nobody agreed to.
//   3. **The portal's own words are kept verbatim.** `itc_available` and `itc_unavailable_reason`
//      are the government's statement about our purchase, stored as given. They are evidence. This
//      product's opinion about the credit is computed from them and is never written over them.

import type { Migration } from "../../platform/src/migration-definitions.ts";

export const itcMigrations: readonly Migration[] = Object.freeze([{
  id: "20260831T185431090Z_itc_dd5fc51b82d4_itc_reconciliation",
  up: `
    -- Every import of portal data: the file, its checksum, who brought it in and what it changed.
    CREATE TABLE itc_import_batches (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
      -- 'TYPED' is a first-class source, not a fallback: a shop reading the portal on a phone with
      -- no download often has no other way to supply the fact.
      source text NOT NULL CHECK (source IN ('GSTR2B_FILE','IMS_FILE','PORTAL_API','TYPED')),
      file_name text,
      -- sha256 of the file. The same file imported twice is recognised, not doubled.
      checksum text NOT NULL,
      imported_by uuid NOT NULL REFERENCES users(id),
      imported_at timestamptz NOT NULL DEFAULT now(),
      document_count integer NOT NULL CHECK (document_count >= 0),
      added_count integer NOT NULL DEFAULT 0,
      replaced_count integer NOT NULL DEFAULT 0,
      unchanged_count integer NOT NULL DEFAULT 0,
      -- Rows the file carried that could not be read, with the reason. Never silently dropped.
      rejected jsonb NOT NULL DEFAULT '[]',
      UNIQUE (company_id, period, checksum)
    );

    -- What the suppliers told the government, as they told it.
    CREATE TABLE itc_portal_documents (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
      supplier_gstin text NOT NULL CHECK (supplier_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$'),
      supplier_name text,
      kind text NOT NULL CHECK (kind IN ('INVOICE','CREDIT_NOTE','DEBIT_NOTE')),
      document_number text NOT NULL CHECK (btrim(document_number) <> ''),
      -- The number reduced to letters and digits, which is what matching compares. Stored rather
      -- than computed on read so the unique index below can use it.
      normalised_number text NOT NULL,
      document_date date NOT NULL,
      taxable_value_paise bigint NOT NULL,
      cgst_paise bigint NOT NULL DEFAULT 0,
      sgst_paise bigint NOT NULL DEFAULT 0,
      igst_paise bigint NOT NULL DEFAULT 0,
      cess_paise bigint NOT NULL DEFAULT 0,
      invoice_value_paise bigint NOT NULL DEFAULT 0,
      -- The portal's own flag. NULL means the file did not say; it never means yes.
      itc_available boolean,
      itc_unavailable_reason text,
      amends_number text,
      amends_period text,
      reversed boolean NOT NULL DEFAULT false,
      reverse_charge boolean NOT NULL DEFAULT false,
      source text NOT NULL CHECK (source IN ('GSTR2B_FILE','IMS_FILE','PORTAL_API','TYPED')),
      batch_id uuid NOT NULL REFERENCES itc_import_batches(id),
      observed_at timestamptz NOT NULL DEFAULT now(),
      -- One reading of one document. A second import replaces this row rather than adding to it.
      UNIQUE (company_id, period, supplier_gstin, normalised_number, kind)
    );

    -- Accept, reject or pending. Append-only; the newest row for a line is the live answer.
    CREATE TABLE itc_decisions (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
      -- Supplier registration, normalised number and kind. Built only from facts that do not move,
      -- so a recomputation re-attaches the answer to the same line.
      line_key text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('ACCEPT','REJECT','PENDING')),
      -- Required in words for a rejection and for a claim the portal does not support.
      reason text NOT NULL DEFAULT '',
      decided_by uuid NOT NULL REFERENCES users(id),
      decided_at timestamptz NOT NULL DEFAULT now(),
      -- sha256 over the figures the person was looking at when they answered.
      fingerprint text NOT NULL,
      idempotency_key text NOT NULL,
      UNIQUE (company_id, idempotency_key)
    );

    CREATE INDEX itc_portal_documents_company_period_idx
      ON itc_portal_documents(company_id, period);
    CREATE INDEX itc_portal_documents_supplier_idx
      ON itc_portal_documents(company_id, supplier_gstin, normalised_number);
    CREATE INDEX itc_decisions_line_idx
      ON itc_decisions(company_id, period, line_key, decided_at DESC);
    CREATE INDEX itc_import_batches_company_period_idx
      ON itc_import_batches(company_id, period, imported_at DESC);
  `,
  down: `
    DROP TABLE IF EXISTS itc_decisions;
    DROP TABLE IF EXISTS itc_portal_documents;
    DROP TABLE IF EXISTS itc_import_batches;
  `,
}, {
  id: "20260921T220829983Z_itc_8eca6bf0440b_claimed_credit_periods",
  up: `
    -- One source bill can feed one GSTR-3B period. The unique key is the double-claim guard.
    CREATE TABLE itc_claims (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      source_kind text NOT NULL,
      source_id text NOT NULL,
      period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
      outcome text NOT NULL CHECK (outcome IN ('CLAIM_NOW','CLAIM_AT_RISK')),
      line_key text NOT NULL,
      fingerprint text NOT NULL,
      claimed_by uuid NOT NULL REFERENCES users(id),
      claimed_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (company_id, source_kind, source_id)
    );
    CREATE INDEX itc_claims_company_period_idx ON itc_claims(company_id, period);
  `,
  down: `DROP TABLE IF EXISTS itc_claims;`,
}, {
  // Issue #366 — what the PostgreSQL repositories (postgres-repository.ts) need and the schema lacked.
  id: "20261011T144842064Z_itc_b00fbee60e25_repository_columns_and_row_security",
  up: `
    -- The service numbers a portal row "<batch id>:<row>" (service.ts, #storeBatch), which is not a uuid.
    ALTER TABLE itc_portal_documents ALTER COLUMN id TYPE text;
    -- The service stores a batch's rows first and the batch itself second, because the batch records
    -- how many rows were new. Both are in one transaction, so the link is checked when it commits.
    ALTER TABLE itc_portal_documents ALTER CONSTRAINT itc_portal_documents_batch_id_fkey DEFERRABLE INITIALLY DEFERRED;
    -- The sentence the person was shown when they imported, kept as shown.
    ALTER TABLE itc_import_batches ADD COLUMN sentence jsonb NOT NULL DEFAULT '{"en-IN":"","hi-IN":""}';
    -- The order rows were written in. "The newest answer wins" and "the latest import" cannot rest on
    -- a timestamp alone: two rows can carry the same one. Also the key lists are paged on.
    ALTER TABLE itc_import_batches ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
    ALTER TABLE itc_portal_documents ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
    ALTER TABLE itc_decisions ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
    ALTER TABLE itc_claims ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;

    -- For the foreign key to the import batch.
    CREATE INDEX itc_portal_documents_batch_idx ON itc_portal_documents(batch_id);
    -- "Everything up to this month", in the order it was written, a page at a time.
    CREATE INDEX itc_portal_documents_company_seq_idx ON itc_portal_documents(company_id, seq);
    -- Every answer ever given on one line (the existing index leads with the period, which history does not filter on).
    CREATE INDEX itc_decisions_history_idx ON itc_decisions(company_id, line_key, seq);
    -- Every claim a company has made, a page at a time.
    CREATE INDEX itc_claims_company_seq_idx ON itc_claims(company_id, seq);

    ALTER TABLE itc_import_batches ENABLE ROW LEVEL SECURITY; ALTER TABLE itc_import_batches FORCE ROW LEVEL SECURITY;
    CREATE POLICY itc_import_batches_tenant ON itc_import_batches USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    ALTER TABLE itc_portal_documents ENABLE ROW LEVEL SECURITY; ALTER TABLE itc_portal_documents FORCE ROW LEVEL SECURITY;
    CREATE POLICY itc_portal_documents_tenant ON itc_portal_documents USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    ALTER TABLE itc_decisions ENABLE ROW LEVEL SECURITY; ALTER TABLE itc_decisions FORCE ROW LEVEL SECURITY;
    CREATE POLICY itc_decisions_tenant ON itc_decisions USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    ALTER TABLE itc_claims ENABLE ROW LEVEL SECURITY; ALTER TABLE itc_claims FORCE ROW LEVEL SECURITY;
    CREATE POLICY itc_claims_tenant ON itc_claims USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
  `,
  down: `
    DROP POLICY IF EXISTS itc_import_batches_tenant ON itc_import_batches;
    ALTER TABLE itc_import_batches NO FORCE ROW LEVEL SECURITY; ALTER TABLE itc_import_batches DISABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS itc_portal_documents_tenant ON itc_portal_documents;
    ALTER TABLE itc_portal_documents NO FORCE ROW LEVEL SECURITY; ALTER TABLE itc_portal_documents DISABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS itc_decisions_tenant ON itc_decisions;
    ALTER TABLE itc_decisions NO FORCE ROW LEVEL SECURITY; ALTER TABLE itc_decisions DISABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS itc_claims_tenant ON itc_claims;
    ALTER TABLE itc_claims NO FORCE ROW LEVEL SECURITY; ALTER TABLE itc_claims DISABLE ROW LEVEL SECURITY;
    DROP INDEX IF EXISTS itc_claims_company_seq_idx;
    DROP INDEX IF EXISTS itc_decisions_history_idx;
    DROP INDEX IF EXISTS itc_portal_documents_company_seq_idx;
    DROP INDEX IF EXISTS itc_portal_documents_batch_idx;
    ALTER TABLE itc_import_batches DROP COLUMN IF EXISTS seq;
    ALTER TABLE itc_portal_documents DROP COLUMN IF EXISTS seq;
    ALTER TABLE itc_decisions DROP COLUMN IF EXISTS seq;
    ALTER TABLE itc_claims DROP COLUMN IF EXISTS seq;
    ALTER TABLE itc_import_batches DROP COLUMN IF EXISTS sentence;
    ALTER TABLE itc_portal_documents ALTER CONSTRAINT itc_portal_documents_batch_id_fkey NOT DEFERRABLE;
    -- "<batch>:<row>" cannot be read back as a uuid and nothing refers to this id, so each row gets a new one.
    ALTER TABLE itc_portal_documents ALTER COLUMN id TYPE uuid USING gen_random_uuid();
  `,
}]);
