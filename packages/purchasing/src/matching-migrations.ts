// Issue #18 [E18] — the tables purchase orders, goods receipts and match approvals own.
//
// Stock movements belong to #12 and vouchers to #4; neither is created here. Movement ids are
// stored so a cancelled delivery can put back exactly what it took in, but there is deliberately
// no foreign key to that table: it is another module's to create, and this migration must not
// fail because their SQL has not landed yet. The same reasoning as #17's migration.

import type { Migration } from "../../platform/src/migration-definitions.ts";

export const purchaseMatchingMigrations: readonly Migration[] = Object.freeze([{
  id: "20260829T130536327Z_purchasing_77404f7e8b5f_three_way_matching",
  up: `
    CREATE TABLE purchase_orders (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      order_number text NOT NULL,
      supplier_party_id uuid NOT NULL REFERENCES master_records(id),
      supplier_name text NOT NULL,
      order_date date NOT NULL,
      expected_date date,
      state text NOT NULL CHECK (state IN ('DRAFT','PLACED','PARTIALLY_RECEIVED','RECEIVED','CLOSED','CANCELLED')),
      ordered_value_paise bigint NOT NULL,
      placed_by uuid REFERENCES users(id),
      placed_at timestamptz,
      closed_reason text,
      cancelled_reason text,
      summary text NOT NULL,
      created_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      -- One business cannot raise the same order number twice. This is the database's half of
      -- the guard; the service catches it earlier and returns the existing order instead.
      UNIQUE (company_id, order_number)
    );
    CREATE INDEX purchase_orders_party_idx ON purchase_orders(company_id, supplier_party_id);
    CREATE INDEX purchase_orders_open_idx ON purchase_orders(company_id, state)
      WHERE state IN ('PLACED','PARTIALLY_RECEIVED');

    CREATE TABLE purchase_order_lines (
      order_id uuid NOT NULL REFERENCES purchase_orders(id),
      line_number integer NOT NULL,
      company_id uuid NOT NULL REFERENCES companies(id),
      item_id uuid NOT NULL REFERENCES master_records(id),
      description text NOT NULL,
      hsn_sac text NOT NULL,
      supply_kind text NOT NULL CHECK (supply_kind IN ('GOODS','SERVICES')),
      quantity_micro bigint NOT NULL CHECK (quantity_micro > 0),
      quantity_unit text NOT NULL,
      rate_paise bigint NOT NULL CHECK (rate_paise >= 0),
      gst_rate_basis_points integer NOT NULL,
      cess_rate_basis_points integer,
      warehouse_id uuid REFERENCES master_records(id),
      PRIMARY KEY (order_id, line_number)
    );

    CREATE TABLE goods_receipts (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      receipt_number text NOT NULL,
      -- Nullable on purpose: the small-business path confirms goods with no order at all.
      order_id uuid REFERENCES purchase_orders(id),
      supplier_party_id uuid NOT NULL REFERENCES master_records(id),
      supplier_name text NOT NULL,
      receipt_date date NOT NULL,
      delivery_note text,
      vehicle_number text,
      state text NOT NULL CHECK (state IN ('DRAFT','CONFIRMED','CANCELLED')),
      confirmed_by uuid REFERENCES users(id),
      confirmed_at timestamptz,
      cancelled_reason text,
      summary text NOT NULL,
      created_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (company_id, receipt_number)
    );
    CREATE INDEX goods_receipts_order_idx ON goods_receipts(company_id, order_id) WHERE state = 'CONFIRMED';
    CREATE INDEX goods_receipts_party_idx ON goods_receipts(company_id, supplier_party_id);

    CREATE TABLE goods_receipt_lines (
      receipt_id uuid NOT NULL REFERENCES goods_receipts(id),
      line_number integer NOT NULL,
      company_id uuid NOT NULL REFERENCES companies(id),
      order_line_number integer,
      item_id uuid NOT NULL REFERENCES master_records(id),
      description text NOT NULL,
      warehouse_id uuid NOT NULL REFERENCES master_records(id),
      batch_id uuid REFERENCES master_records(id),
      serial_numbers jsonb NOT NULL DEFAULT '[]',
      received_quantity_micro bigint NOT NULL CHECK (received_quantity_micro > 0),
      accepted_quantity_micro bigint NOT NULL CHECK (accepted_quantity_micro >= 0),
      quantity_unit text NOT NULL,
      rate_paise bigint NOT NULL CHECK (rate_paise > 0),
      rejection_reason text CHECK (rejection_reason IN ('DAMAGED','WRONG_ITEM','SHORT_SUPPLY','EXPIRED','QUALITY_BELOW_AGREED','OTHER')),
      rejection_note text,
      quality_checked_by uuid REFERENCES users(id),
      quality_checked_at timestamptz,
      quality_note text,
      quality_photo_ids jsonb NOT NULL DEFAULT '[]',
      quality_document_ids jsonb NOT NULL DEFAULT '[]',
      PRIMARY KEY (receipt_id, line_number),
      -- You cannot keep more than arrived, and turning goods away is never left unexplained.
      CONSTRAINT accepted_within_received CHECK (accepted_quantity_micro <= received_quantity_micro),
      CONSTRAINT rejection_explained CHECK (
        accepted_quantity_micro = received_quantity_micro OR rejection_reason IS NOT NULL
      )
    );

    -- What a confirmed delivery actually put on the shelf, so a cancellation reverses exactly it.
    CREATE TABLE goods_receipt_movements (
      receipt_id uuid NOT NULL REFERENCES goods_receipts(id),
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
      PRIMARY KEY (receipt_id, line_number)
    );

    -- Per company and effective-dated, so a comparison made last year is explained under the
    -- tolerance that was in force then rather than today's.
    CREATE TABLE purchase_match_tolerances (
      company_id uuid NOT NULL REFERENCES companies(id),
      effective_from date NOT NULL,
      quantity_basis_points integer NOT NULL CHECK (quantity_basis_points >= 0),
      quantity_absolute_micro bigint NOT NULL DEFAULT 0 CHECK (quantity_absolute_micro >= 0),
      price_basis_points integer NOT NULL CHECK (price_basis_points >= 0),
      price_absolute_paise bigint NOT NULL DEFAULT 0 CHECK (price_absolute_paise >= 0),
      tax_absolute_paise bigint NOT NULL DEFAULT 0 CHECK (tax_absolute_paise >= 0),
      allow_over_delivery boolean NOT NULL DEFAULT false,
      set_by uuid NOT NULL REFERENCES users(id),
      set_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (company_id, effective_from)
    );

    -- Letting a bill through that disagrees with the delivery is a decision somebody owns.
    CREATE TABLE purchase_match_approvals (
      company_id uuid NOT NULL REFERENCES companies(id),
      match_fingerprint text NOT NULL,
      purchase_id text NOT NULL,
      invoice_number text NOT NULL,
      accepted_codes jsonb NOT NULL DEFAULT '[]',
      reason text NOT NULL,
      approved_by uuid NOT NULL REFERENCES users(id),
      approved_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (company_id, match_fingerprint)
    );
    CREATE INDEX purchase_match_approvals_purchase_idx ON purchase_match_approvals(company_id, purchase_id);
  `,
  down: `
    DROP TABLE IF EXISTS purchase_match_approvals;
    DROP TABLE IF EXISTS purchase_match_tolerances;
    DROP TABLE IF EXISTS goods_receipt_movements;
    DROP TABLE IF EXISTS goods_receipt_lines;
    DROP TABLE IF EXISTS goods_receipts;
    DROP TABLE IF EXISTS purchase_order_lines;
    DROP TABLE IF EXISTS purchase_orders;
  `,
}]);
