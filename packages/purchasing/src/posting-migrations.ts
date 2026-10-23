// Issue #17 [E17] — the tables purchase posting owns.
//
// Vouchers, journal lines and stock movements belong to GPT 1 (#4, #12) and are not created here.
// The ids of both are stored so a bill can be traced to its entry and its receipts, but there is
// deliberately no foreign key to either: those tables are another module's to create, and this
// migration must not fail because their SQL has not landed yet.

import type { Migration } from "../../platform/src/migration-definitions.ts";
import { enforceTenant, releaseTenant } from "./tenant-policy.ts";

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
}, {
  // Issue #366 — what the PostgreSQL bill repository needs that #17's tables did not have.
  id: "20261011T144949662Z_purchasing_1236777b1d2e_posting_repository",
  up: `
    -- A posted bill keeps, per line, the tax split it was posted with and its share of the
    -- supplier's printed total (#45 returns part of a line under the original treatment), and where
    -- the goods landed. The table had no columns for any of these.
    ALTER TABLE purchase_bill_lines
      ADD COLUMN warehouse_id uuid REFERENCES master_records(id),
      ADD COLUMN batch_id uuid REFERENCES master_records(id),
      ADD COLUMN serial_numbers jsonb NOT NULL DEFAULT '[]',
      ADD COLUMN cgst_paise bigint NOT NULL DEFAULT 0,
      ADD COLUMN sgst_paise bigint NOT NULL DEFAULT 0,
      ADD COLUMN igst_paise bigint NOT NULL DEFAULT 0,
      ADD COLUMN cess_paise bigint NOT NULL DEFAULT 0,
      ADD COLUMN ineligible_itc_paise bigint NOT NULL DEFAULT 0,
      ADD COLUMN supplier_value_paise bigint NOT NULL DEFAULT 0,
      -- The bill as the service keeps it does not carry these four, so the repository has nothing
      -- to put in them. They stay, empty, until the purchase lane decides whether a posted line
      -- should record them.
      ALTER COLUMN hsn_sac DROP NOT NULL,
      ALTER COLUMN rate_paise DROP NOT NULL,
      ALTER COLUMN gst_rate_basis_points DROP NOT NULL,
      ALTER COLUMN itc_eligibility DROP NOT NULL;

    -- Deliveries (#18) whose goods this bill pays for and which moved the stock themselves.
    ALTER TABLE purchase_bills ADD COLUMN received_by_receipt_ids jsonb NOT NULL DEFAULT '[]';

    -- A reversed bill "must be approved afresh" (purchase-posting-v1): the same supplier bill is
    -- then recorded again as a new row. The old rule counted the reversed row too and refused it.
    -- One LIVE bill per supplier bill number is what was meant, and is what the in-memory store does.
    ALTER TABLE purchase_bills DROP CONSTRAINT purchase_bills_company_id_supplier_party_id_invoice_number_key;
    CREATE UNIQUE INDEX purchase_bills_live_number_idx ON purchase_bills(company_id, supplier_party_id, invoice_number) WHERE state = 'POSTED';

    -- Every bill of a business, oldest first, a page at a time.
    CREATE INDEX purchase_bills_list_idx ON purchase_bills(company_id, posted_at, id);
    -- Every bill of one supplier, whatever its state (the existing party index covers live bills only).
    CREATE INDEX purchase_bills_party_list_idx ON purchase_bills(company_id, supplier_party_id, posted_at, id);
    -- "Has this approved purchase been recorded?", including a bill since reversed (the existing index covers live bills only).
    CREATE INDEX purchase_bills_purchase_idx ON purchase_bills(company_id, purchase_id);
    ${enforceTenant(["purchase_bills", "purchase_bill_lines", "purchase_bill_receipts"])}
  `,
  // Going back restores the old rules, and PostgreSQL refuses if bills written since do not fit
  // them (a bill recorded again after a reversal, a line without an HSN code). That refusal is
  // right: it must be looked at, not lost.
  down: `
    ${releaseTenant(["purchase_bill_receipts", "purchase_bill_lines", "purchase_bills"])}
    DROP INDEX IF EXISTS purchase_bills_purchase_idx;
    DROP INDEX IF EXISTS purchase_bills_party_list_idx;
    DROP INDEX IF EXISTS purchase_bills_list_idx;
    DROP INDEX IF EXISTS purchase_bills_live_number_idx;
    ALTER TABLE purchase_bills ADD CONSTRAINT purchase_bills_company_id_supplier_party_id_invoice_number_key UNIQUE (company_id, supplier_party_id, invoice_number);
    ALTER TABLE purchase_bills DROP COLUMN IF EXISTS received_by_receipt_ids;
    ALTER TABLE purchase_bill_lines
      ALTER COLUMN itc_eligibility SET NOT NULL,
      ALTER COLUMN gst_rate_basis_points SET NOT NULL,
      ALTER COLUMN rate_paise SET NOT NULL,
      ALTER COLUMN hsn_sac SET NOT NULL,
      DROP COLUMN IF EXISTS supplier_value_paise,
      DROP COLUMN IF EXISTS ineligible_itc_paise,
      DROP COLUMN IF EXISTS cess_paise,
      DROP COLUMN IF EXISTS igst_paise,
      DROP COLUMN IF EXISTS sgst_paise,
      DROP COLUMN IF EXISTS cgst_paise,
      DROP COLUMN IF EXISTS serial_numbers,
      DROP COLUMN IF EXISTS batch_id,
      DROP COLUMN IF EXISTS warehouse_id;
  `,
}, {
  // Issue #289, part 3 — credit blocked by CGST s.17(5): which clause, on the line, and the blocked
  // tax by head on the bill, because GSTR-3B reports it head by head in Table 4(B)(1) (Circular
  // 170/02/2022-GST, para 4 B). Old bills had nothing blocked, so 0 and no clause are right for them.
  id: "20261021T210946011Z_purchasing_c17039d84ac6_blocked_credit_heads",
  up: `
    ALTER TABLE purchase_bills
      ADD COLUMN ineligible_cgst_paise bigint NOT NULL DEFAULT 0 CHECK (ineligible_cgst_paise >= 0),
      ADD COLUMN ineligible_sgst_paise bigint NOT NULL DEFAULT 0 CHECK (ineligible_sgst_paise >= 0),
      ADD COLUMN ineligible_igst_paise bigint NOT NULL DEFAULT 0 CHECK (ineligible_igst_paise >= 0),
      ADD COLUMN ineligible_cess_paise bigint NOT NULL DEFAULT 0 CHECK (ineligible_cess_paise >= 0),
      ADD CONSTRAINT purchase_bills_ineligible_heads_add_up
        CHECK (ineligible_cgst_paise + ineligible_sgst_paise + ineligible_igst_paise + ineligible_cess_paise IN (0, ineligible_itc_paise));
    ALTER TABLE purchase_bill_lines ADD COLUMN blocked_credit_clause text
      CHECK (blocked_credit_clause IS NULL OR blocked_credit_clause ~ '^17\\(5\\)\\([a-z]{1,2}\\)$');
  `,
  down: `
    ALTER TABLE purchase_bill_lines DROP COLUMN IF EXISTS blocked_credit_clause;
    ALTER TABLE purchase_bills
      DROP CONSTRAINT IF EXISTS purchase_bills_ineligible_heads_add_up,
      DROP COLUMN IF EXISTS ineligible_cess_paise,
      DROP COLUMN IF EXISTS ineligible_igst_paise,
      DROP COLUMN IF EXISTS ineligible_sgst_paise,
      DROP COLUMN IF EXISTS ineligible_cgst_paise;
  `,
}]);
