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
}, {
  // Issue #186 — what the printed credit or debit note needs from the original line (Rule 53(1A)(h)),
  // kept on the note so a reprint never depends on the original bill still being readable.
  id: '20260918T092432769Z_returns_a3e6e719e4dd_note_line_hsn_rate_and_unit_price',
  up: `
    ALTER TABLE return_note_lines ADD COLUMN hsn_or_sac text;
    ALTER TABLE return_note_lines ADD COLUMN rate_percent_times100 bigint CHECK (rate_percent_times100 IS NULL OR rate_percent_times100 BETWEEN 0 AND 10000);
    ALTER TABLE return_note_lines ADD COLUMN unit_price_paise bigint;
  `,
  down: `ALTER TABLE return_note_lines DROP COLUMN IF EXISTS unit_price_paise, DROP COLUMN IF EXISTS rate_percent_times100, DROP COLUMN IF EXISTS hsn_or_sac;`,
}, {
  // Issue #249 — the supplier's own credit note for goods sent back to them, matched against the
  // government's purchase record. Known later than the return itself, so both columns are nullable
  // and are set together or not at all.
  id: '20260928T000645782Z_returns_334156bf2057_supplier_credit_note_on_purchase_returns',
  up: `
    ALTER TABLE return_notes ADD COLUMN supplier_credit_note_number text;
    ALTER TABLE return_notes ADD COLUMN supplier_credit_note_date date;
    ALTER TABLE return_notes ADD CONSTRAINT return_notes_supplier_credit_note_check CHECK (
      (supplier_credit_note_number IS NULL AND supplier_credit_note_date IS NULL)
      OR (kind = 'PURCHASE_RETURN' AND supplier_credit_note_number IS NOT NULL AND supplier_credit_note_date IS NOT NULL
          AND length(trim(supplier_credit_note_number)) BETWEEN 1 AND 16)
    );
  `,
  down: `ALTER TABLE return_notes DROP CONSTRAINT IF EXISTS return_notes_supplier_credit_note_check;
    ALTER TABLE return_notes DROP COLUMN IF EXISTS supplier_credit_note_date, DROP COLUMN IF EXISTS supplier_credit_note_number;`,
}, {
  // Issue #366 — a returned freight or other charge (issue #233) has the item id `charge:<kind>`
  // from gst-calc, which is not a master record. Such a line keeps the kind in `charge_kind` and no
  // item; every other line keeps its item and no kind. The repository reads `charge:<kind>` back.
  // The foreign keys now carry the company, so a line or note can never point at another company's
  // item, godown, batch, party or note. They rest on UNIQUE (company_id, id) on master_records,
  // added by #365 (`20261011T142835448Z_sales_…`, which runs first).
  id: '20261014T182202848Z_returns_2ef7b18c49ba_charge_lines_and_page_index',
  up: `
    ALTER TABLE return_note_lines ALTER COLUMN item_id DROP NOT NULL;
    ALTER TABLE return_note_lines ADD COLUMN charge_kind text CHECK (charge_kind ~ '^[a-z][a-z0-9_]*$');
    ALTER TABLE return_note_lines ADD CONSTRAINT return_note_lines_item_or_charge_check
      CHECK ((item_id IS NULL) <> (charge_kind IS NULL));
    -- Every note for one original bill, a page at a time in id order (\`listForOriginal\`). The older
    -- index leads with \`kind\`, which that query does not know.
    CREATE INDEX return_notes_original_document_idx ON return_notes(company_id, original_document_id, id);
    -- A company's notes a page at a time in id order (\`list\`), and the key the lines point at.
    ALTER TABLE return_notes ADD CONSTRAINT return_notes_company_id_id_key UNIQUE (company_id, id);
    ALTER TABLE return_notes DROP CONSTRAINT return_notes_party_id_fkey,
      ADD CONSTRAINT return_notes_party_same_company_fk FOREIGN KEY (company_id, party_id) REFERENCES master_records(company_id, id);
    ALTER TABLE return_note_lines
      DROP CONSTRAINT return_note_lines_return_note_id_fkey,
      DROP CONSTRAINT return_note_lines_item_id_fkey,
      DROP CONSTRAINT return_note_lines_warehouse_id_fkey,
      DROP CONSTRAINT return_note_lines_batch_id_fkey,
      ADD CONSTRAINT return_note_lines_note_same_company_fk FOREIGN KEY (company_id, return_note_id) REFERENCES return_notes(company_id, id),
      ADD CONSTRAINT return_note_lines_item_same_company_fk FOREIGN KEY (company_id, item_id) REFERENCES master_records(company_id, id),
      ADD CONSTRAINT return_note_lines_warehouse_same_company_fk FOREIGN KEY (company_id, warehouse_id) REFERENCES master_records(company_id, id),
      ADD CONSTRAINT return_note_lines_batch_same_company_fk FOREIGN KEY (company_id, batch_id) REFERENCES master_records(company_id, id);
    -- The foreign keys from lines to the item, godown and batch lists (the note key is the primary key's prefix).
    CREATE INDEX return_note_lines_item_idx ON return_note_lines(company_id, item_id) WHERE item_id IS NOT NULL;
    CREATE INDEX return_note_lines_warehouse_idx ON return_note_lines(company_id, warehouse_id) WHERE warehouse_id IS NOT NULL;
    CREATE INDEX return_note_lines_batch_idx ON return_note_lines(company_id, batch_id) WHERE batch_id IS NOT NULL;
  `,
  // Fails while a charge line is stored, rather than losing it.
  down: `DROP INDEX IF EXISTS return_note_lines_batch_idx; DROP INDEX IF EXISTS return_note_lines_warehouse_idx;
    DROP INDEX IF EXISTS return_note_lines_item_idx;
    ALTER TABLE return_note_lines
      DROP CONSTRAINT IF EXISTS return_note_lines_batch_same_company_fk,
      DROP CONSTRAINT IF EXISTS return_note_lines_warehouse_same_company_fk,
      DROP CONSTRAINT IF EXISTS return_note_lines_item_same_company_fk,
      DROP CONSTRAINT IF EXISTS return_note_lines_note_same_company_fk,
      ADD CONSTRAINT return_note_lines_return_note_id_fkey FOREIGN KEY (return_note_id) REFERENCES return_notes(id),
      ADD CONSTRAINT return_note_lines_item_id_fkey FOREIGN KEY (item_id) REFERENCES master_records(id),
      ADD CONSTRAINT return_note_lines_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES master_records(id),
      ADD CONSTRAINT return_note_lines_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES master_records(id);
    ALTER TABLE return_notes DROP CONSTRAINT IF EXISTS return_notes_party_same_company_fk,
      ADD CONSTRAINT return_notes_party_id_fkey FOREIGN KEY (party_id) REFERENCES master_records(id);
    ALTER TABLE return_notes DROP CONSTRAINT IF EXISTS return_notes_company_id_id_key;
    DROP INDEX IF EXISTS return_notes_original_document_idx;
    ALTER TABLE return_note_lines DROP CONSTRAINT IF EXISTS return_note_lines_item_or_charge_check;
    ALTER TABLE return_note_lines DROP COLUMN IF EXISTS charge_kind;
    ALTER TABLE return_note_lines ALTER COLUMN item_id SET NOT NULL;`,
}, {
  // Issue #293 — a price changed after the sale, with nothing coming back: a credit note for a lower
  // price (CGST Act s.34(1)) or a debit note to the customer for a higher one (s.34(3)). Such a note
  // is marked \`price_correction\`; its lines carry the quantity the new price applies to.
  id: '20261023T011610860Z_returns_d50ad1d404d0_sales_debit_notes_and_price_corrections',
  up: `
    ALTER TABLE return_notes DROP CONSTRAINT return_notes_kind_check;
    ALTER TABLE return_notes ADD CONSTRAINT return_notes_kind_check CHECK (kind IN ('SALES_RETURN','PURCHASE_RETURN','SALES_DEBIT_NOTE'));
    ALTER TABLE return_notes ADD COLUMN price_correction boolean NOT NULL DEFAULT false;
    -- A sales debit note only ever corrects a price; goods do not come back on one.
    ALTER TABLE return_notes ADD CONSTRAINT return_notes_debit_note_is_price_check CHECK (kind <> 'SALES_DEBIT_NOTE' OR price_correction);
    -- #365's quantity check, now counting only goods that came back: a price credit note's line
    -- names the quantity still kept, so it must fit what is left but never uses any of it up.
    CREATE OR REPLACE FUNCTION sales_return_within_original() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
    DECLARE
      note_kind text;
      original text;
      sold bigint;
      taken_back bigint;
    BEGIN
      SELECT kind, original_document_id INTO note_kind, original FROM return_notes WHERE id = NEW.return_note_id;
      IF note_kind IS DISTINCT FROM 'SALES_RETURN' OR original !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
        RETURN NEW;
      END IF;
      SELECT quantity_micro INTO sold FROM sales_invoice_lines
        WHERE company_id = NEW.company_id AND invoice_id = original::uuid AND line_id = NEW.original_line_id FOR UPDATE;
      IF sold IS NULL THEN
        IF EXISTS (SELECT FROM sales_invoices WHERE company_id = NEW.company_id AND id = original::uuid) THEN
          RAISE EXCEPTION 'This credit note names a line that is not on the bill.'
            USING ERRCODE = 'check_violation', TABLE = 'return_note_lines', CONSTRAINT = 'return_note_lines_within_original';
        END IF;
        RETURN NEW;
      END IF;
      SELECT COALESCE(sum(l.quantity_micro), 0) INTO taken_back FROM return_note_lines l JOIN return_notes n ON n.id = l.return_note_id
        WHERE l.company_id = NEW.company_id AND n.kind = 'SALES_RETURN' AND NOT n.price_correction AND n.original_document_id = original AND l.original_line_id = NEW.original_line_id;
      IF taken_back + NEW.quantity_micro > sold THEN
        RAISE EXCEPTION 'This credit note takes back more than the bill sold on that line.'
          USING ERRCODE = 'check_violation', TABLE = 'return_note_lines', CONSTRAINT = 'return_note_lines_within_original';
      END IF;
      RETURN NEW;
    END;
    $$;
  `,
  // Fails while a sales debit note is stored, rather than losing it.
  down: `
    CREATE OR REPLACE FUNCTION sales_return_within_original() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
    DECLARE
      note_kind text;
      original text;
      sold bigint;
      taken_back bigint;
    BEGIN
      SELECT kind, original_document_id INTO note_kind, original FROM return_notes WHERE id = NEW.return_note_id;
      IF note_kind IS DISTINCT FROM 'SALES_RETURN' OR original !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
        RETURN NEW;
      END IF;
      SELECT quantity_micro INTO sold FROM sales_invoice_lines
        WHERE company_id = NEW.company_id AND invoice_id = original::uuid AND line_id = NEW.original_line_id FOR UPDATE;
      IF sold IS NULL THEN
        IF EXISTS (SELECT FROM sales_invoices WHERE company_id = NEW.company_id AND id = original::uuid) THEN
          RAISE EXCEPTION 'This credit note names a line that is not on the bill.'
            USING ERRCODE = 'check_violation', TABLE = 'return_note_lines', CONSTRAINT = 'return_note_lines_within_original';
        END IF;
        RETURN NEW;
      END IF;
      SELECT COALESCE(sum(l.quantity_micro), 0) INTO taken_back FROM return_note_lines l JOIN return_notes n ON n.id = l.return_note_id
        WHERE l.company_id = NEW.company_id AND n.kind = 'SALES_RETURN' AND n.original_document_id = original AND l.original_line_id = NEW.original_line_id;
      IF taken_back + NEW.quantity_micro > sold THEN
        RAISE EXCEPTION 'This credit note takes back more than the bill sold on that line.'
          USING ERRCODE = 'check_violation', TABLE = 'return_note_lines', CONSTRAINT = 'return_note_lines_within_original';
      END IF;
      RETURN NEW;
    END;
    $$;
    ALTER TABLE return_notes DROP CONSTRAINT IF EXISTS return_notes_debit_note_is_price_check;
    ALTER TABLE return_notes DROP COLUMN IF EXISTS price_correction;
    ALTER TABLE return_notes DROP CONSTRAINT return_notes_kind_check;
    ALTER TABLE return_notes ADD CONSTRAINT return_notes_kind_check CHECK (kind IN ('SALES_RETURN','PURCHASE_RETURN'));`,
}]);
