// Issue #17 [E17] — the tables purchase posting owns.
//
// Vouchers, journal lines and stock movements belong to GPT 1 (#4, #12) and are not created here.
// The ids of both are stored so a bill can be traced to its entry and its receipts, but there is
// deliberately no foreign key to either: those tables are another module's to create, and this
// migration must not fail because their SQL has not landed yet.

import type { Migration } from "../../platform/src/migration-definitions.ts";

export const purchasePostingMigrations: readonly Migration[] = Object.freeze([{
  id: "20260829T114946172Z_purchasing_dcef4724c889_purchase_posting",
  up: `
    CREATE TABLE purchase_bills (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      purchase_id text NOT NULL,
      source_document_id text NOT NULL,
      supplier_party_id uuid NOT NULL REFERENCES master_records(id),
      supplier_name text NOT NULL,
      invoice_number text NOT NULL,
      invoice_date date NOT NULL,
      due_date date NOT NULL,
      total_paise bigint NOT NULL,
      taxable_value_paise bigint NOT NULL,
      cgst_paise bigint NOT NULL DEFAULT 0,
      sgst_paise bigint NOT NULL DEFAULT 0,
      igst_paise bigint NOT NULL DEFAULT 0,
      cess_paise bigint NOT NULL DEFAULT 0,
      ineligible_itc_paise bigint NOT NULL DEFAULT 0,
      intra_state boolean NOT NULL,
      reverse_charge boolean NOT NULL,
      rule_set_version text,
      rule_id text,
      state text NOT NULL CHECK (state IN ('POSTED','REVERSED')),
      voucher_id uuid NOT NULL,
      reversed_by_voucher_id uuid,
      reversal_reason text,
      summary text NOT NULL,
      posted_by uuid NOT NULL REFERENCES users(id),
      posted_at timestamptz NOT NULL DEFAULT now(),
      idempotency_key text NOT NULL,
      -- One supplier cannot bill the same number twice into one business. This is the database's
      -- half of duplicate control; #16 catches it earlier and explains it better.
      UNIQUE (company_id, supplier_party_id, invoice_number)
    );
    -- One live bill per approved purchase, so two requests racing each other cannot both post.
    CREATE UNIQUE INDEX purchase_bills_one_live_idx ON purchase_bills(company_id, purchase_id) WHERE state = 'POSTED';
    CREATE INDEX purchase_bills_due_idx ON purchase_bills(company_id, state, due_date);
    CREATE INDEX purchase_bills_party_idx ON purchase_bills(company_id, supplier_party_id) WHERE state = 'POSTED';
    CREATE INDEX purchase_bills_voucher_idx ON purchase_bills(company_id, voucher_id);

    CREATE TABLE purchase_bill_lines (
      bill_id uuid NOT NULL REFERENCES purchase_bills(id),
      line_number integer NOT NULL,
      company_id uuid NOT NULL REFERENCES companies(id),
      item_id uuid NOT NULL REFERENCES master_records(id),
      description text NOT NULL,
      hsn_sac text NOT NULL,
      supply_kind text NOT NULL CHECK (supply_kind IN ('GOODS','SERVICES')),
      quantity_micro bigint NOT NULL,
      quantity_unit text NOT NULL,
      rate_paise bigint NOT NULL,
      taxable_value_paise bigint NOT NULL,
      gst_rate_basis_points integer NOT NULL,
      cess_rate_basis_points integer,
      itc_eligibility text NOT NULL CHECK (itc_eligibility IN ('ELIGIBLE','INELIGIBLE','CAPITAL_GOODS')),
      PRIMARY KEY (bill_id, line_number)
    );

    -- The receipts a bill produced, so a reversal puts back exactly what came in.
    CREATE TABLE purchase_bill_receipts (
      bill_id uuid NOT NULL REFERENCES purchase_bills(id),
      line_number integer NOT NULL,
      company_id uuid NOT NULL REFERENCES companies(id),
      stock_movement_id uuid NOT NULL,
      item_id uuid NOT NULL REFERENCES master_records(id),
      warehouse_id uuid NOT NULL REFERENCES master_records(id),
      batch_id uuid REFERENCES master_records(id),
      serial_numbers jsonb NOT NULL DEFAULT '[]',
      quantity_micro bigint NOT NULL,
      quantity_unit text NOT NULL,
      value_paise bigint NOT NULL,
      PRIMARY KEY (bill_id, line_number)
    );
  `,
  down: `
    DROP TABLE IF EXISTS purchase_bill_receipts;
    DROP TABLE IF EXISTS purchase_bill_lines;
    DROP TABLE IF EXISTS purchase_bills;
  `,
}]);
