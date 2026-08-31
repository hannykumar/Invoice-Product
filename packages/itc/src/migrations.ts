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
}]);
