import type { Migration } from '../../platform/src/migration-definitions.ts';

export const returnMigrations: readonly Migration[] = Object.freeze([{
  id: '20260829T224438938Z_returns_07bbac9e2845_return_notes_and_lines',
  up: `
    CREATE TABLE return_notes (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      kind text NOT NULL CHECK (kind IN ('SALES_RETURN','PURCHASE_RETURN')),
      number text NOT NULL,
      document_date date NOT NULL,
      original_document_id text NOT NULL,
      original_document_number text NOT NULL,
      original_document_date date NOT NULL,
      party_id uuid NOT NULL REFERENCES master_records(id),
      reason text NOT NULL CHECK (length(trim(reason)) > 0),
      taxable_value_paise bigint NOT NULL,
      cgst_paise bigint NOT NULL DEFAULT 0,
      sgst_paise bigint NOT NULL DEFAULT 0,
      utgst_paise bigint NOT NULL DEFAULT 0,
      igst_paise bigint NOT NULL DEFAULT 0,
      cess_paise bigint NOT NULL DEFAULT 0,
      ineligible_tax_paise bigint NOT NULL DEFAULT 0,
      reverse_charge_tax_paise bigint NOT NULL DEFAULT 0,
      total_paise bigint NOT NULL CHECK (total_paise >= 0),
      voucher_id uuid NOT NULL,
      compliance_status text NOT NULL CHECK (compliance_status IN ('NOT_APPLICABLE','PENDING_ADJUSTMENT')),
      created_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      idempotency_key text NOT NULL,
      summary text NOT NULL,
      UNIQUE(company_id, kind, number),
      UNIQUE(company_id, idempotency_key)
    );
    CREATE INDEX return_notes_original_idx ON return_notes(company_id, kind, original_document_id);
    CREATE INDEX return_notes_party_date_idx ON return_notes(company_id, party_id, document_date DESC);

    CREATE TABLE return_note_lines (
      return_note_id uuid NOT NULL REFERENCES return_notes(id),
      company_id uuid NOT NULL REFERENCES companies(id),
      original_line_id text NOT NULL,
      item_id uuid NOT NULL REFERENCES master_records(id),
      description text NOT NULL,
      supply_kind text NOT NULL CHECK (supply_kind IN ('GOODS','SERVICES')),
      quantity_micro bigint NOT NULL CHECK (quantity_micro > 0),
      quantity_unit text NOT NULL,
      disposition text NOT NULL CHECK (disposition IN ('ACCEPTED','DAMAGED','SCRAPPED','REPLACEMENT')),
      warehouse_id uuid REFERENCES master_records(id),
      batch_id uuid REFERENCES master_records(id),
      serial_numbers jsonb NOT NULL DEFAULT '[]',
      replacement_serial_numbers jsonb NOT NULL DEFAULT '[]',
      taxable_value_paise bigint NOT NULL,
      cgst_paise bigint NOT NULL DEFAULT 0,
      sgst_paise bigint NOT NULL DEFAULT 0,
      utgst_paise bigint NOT NULL DEFAULT 0,
      igst_paise bigint NOT NULL DEFAULT 0,
      cess_paise bigint NOT NULL DEFAULT 0,
      ineligible_tax_paise bigint NOT NULL DEFAULT 0,
      reverse_charge_tax_paise bigint NOT NULL DEFAULT 0,
      total_paise bigint NOT NULL,
      PRIMARY KEY(return_note_id, original_line_id)
    );
    CREATE INDEX return_note_lines_eligibility_idx ON return_note_lines(company_id, original_line_id);

    ALTER TABLE return_notes ENABLE ROW LEVEL SECURITY;
    ALTER TABLE return_note_lines ENABLE ROW LEVEL SECURITY;
    ALTER TABLE return_notes FORCE ROW LEVEL SECURITY;
    ALTER TABLE return_note_lines FORCE ROW LEVEL SECURITY;
    CREATE POLICY return_notes_tenant ON return_notes
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    CREATE POLICY return_note_lines_tenant ON return_note_lines
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
  `,
  down: `DROP TABLE IF EXISTS return_note_lines; DROP TABLE IF EXISTS return_notes;`,
}]);
