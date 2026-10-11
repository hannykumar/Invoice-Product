/**
 * Issue #365 — PostgreSQL tables for what a business sells: bills, quotations and proforma
 * invoices, and delivery challans. Design: docs/contracts/sales-schema-v1.md.
 *
 * Every rule the sales services enforce is also a rule here, so a bug in one write path cannot
 * leave a bill the others would have refused:
 *  - a row can only point at a party, item, godown, bill or ledger entry of its own company
 *    (the foreign keys carry `company_id`);
 *  - a number exists exactly when the bill is issued, and an issued bill has its ledger entry;
 *  - an issued document never changes and is never deleted (#368's `platform_freeze_posted`);
 *  - its lines add up to its totals when the transaction ends (`document_lines_add_up`);
 *  - a credit note cannot take back more than the bill's line sold (`sales_return_within_original`).
 */
import type { Migration } from '../../platform/src/migration-definitions.ts';
import { tenantPolicy } from '../../platform/src/immutability-migrations.ts';

const USERS = 'REFERENCES users(id)';
const TAX_HEADS = ['cgst', 'sgst', 'utgst', 'igst', 'cess'] as const;
const headColumns = (nullable: boolean): string =>
  TAX_HEADS.map((head) => `${head}_paise bigint ${nullable ? '' : 'NOT NULL DEFAULT 0 '}CHECK (${head}_paise >= 0),`).join('\n      ');
const HEADS_SUM = TAX_HEADS.map((head) => `${head}_paise`).join(' + ');

/** Offline billing (ADR 0012, built in #317): where the document was made, and when the device says it was. */
const ORIGIN = `origin text NOT NULL DEFAULT 'server' CHECK (origin <> ''),
      device_issued_at timestamptz,`;

/** What a bill, a quotation and a proforma invoice all say about the sale itself. */
const saleParticulars = (priced: 'ALWAYS' | 'WHEN_ISSUED'): string => `
      party_id uuid NOT NULL,
      customer_type text NOT NULL CHECK (customer_type IN ('B2B','B2C')),
      supply_kind text NOT NULL CHECK (supply_kind IN ('GOODS','SERVICES')),
      delivery_state_code text,
      place_of_supply_state_code text,
      freight_paise bigint NOT NULL DEFAULT 0 CHECK (freight_paise >= 0),
      other_charges_paise bigint NOT NULL DEFAULT 0 CHECK (other_charges_paise >= 0),
      round_to_whole_rupee boolean NOT NULL,
      narration text,
      -- The calculator's whole answer (explanations, rule decisions), kept so an issued document
      -- never recomputes. The figures below repeat its totals so lists and checks need not parse it.
      pricing jsonb${priced === 'ALWAYS' ? ' NOT NULL' : ''},
      line_count integer NOT NULL DEFAULT 0 CHECK (line_count >= 0),
      taxable_value_paise bigint${priced === 'ALWAYS' ? ' NOT NULL' : ''} CHECK (taxable_value_paise >= 0),
      ${headColumns(priced === 'WHEN_ISSUED')}
      total_tax_paise bigint${priced === 'ALWAYS' ? ' NOT NULL' : ''},
      reverse_charge_tax_paise bigint${priced === 'ALWAYS' ? ' NOT NULL DEFAULT 0' : ''} CHECK (reverse_charge_tax_paise >= 0),
      round_off_paise bigint${priced === 'ALWAYS' ? ' NOT NULL DEFAULT 0' : ''},
      invoice_value_paise bigint${priced === 'ALWAYS' ? ' NOT NULL' : ''} CHECK (invoice_value_paise >= 0),`;

const saleParticularsChecks = (table: string): string => `
      CONSTRAINT ${table}_priced_together CHECK (num_nulls(pricing, taxable_value_paise, cgst_paise, sgst_paise, utgst_paise, igst_paise, cess_paise, total_tax_paise, reverse_charge_tax_paise, round_off_paise, invoice_value_paise) IN (0, 11)),
      CONSTRAINT ${table}_tax_is_its_heads CHECK (total_tax_paise = ${HEADS_SUM}),
      CONSTRAINT ${table}_value_adds_up CHECK (invoice_value_paise = taxable_value_paise + total_tax_paise + round_off_paise),
      FOREIGN KEY (company_id, branch_id) REFERENCES branches(company_id, id),
      FOREIGN KEY (company_id, party_id) REFERENCES master_records(company_id, id),`;

/** One line of a bill, quotation or proforma: what the person typed, and what the calculator made of it. */
/**
 * `strict` is for documents that are issued the moment they are written. A draft bill's lines are
 * saved as typed, even when wrong (the service marks the bill NEEDS_INFO); `ISSUED_LINE` below is
 * what they must satisfy once the bill is issued.
 */
const saleLines = (table: string, parent: string, foreignKey: string, strict: boolean): string => `
    CREATE TABLE ${table} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES companies(id),
      ${foreignKey} uuid NOT NULL,
      line_id text NOT NULL CHECK (line_id <> ''),
      line_no integer NOT NULL CHECK (line_no >= 1),
      -- GOODS is anything that was sold (goods or a service); CHARGE is freight or another charge on the document.
      kind text NOT NULL DEFAULT 'GOODS' CHECK (kind IN ('GOODS','CHARGE')),
      charge_kind text CHECK (charge_kind IN ('FREIGHT','OTHER')),
      item_id uuid,
      warehouse_id uuid,
      quantity_micro bigint NOT NULL${strict ? ' CHECK (quantity_micro > 0)' : ''},
      unit_code text NOT NULL CHECK (unit_code <> ''),
      unit_price_paise bigint NOT NULL${strict ? ' CHECK (unit_price_paise >= 0)' : ''},
      price_basis text CHECK (price_basis IN ('EXCLUSIVE','INCLUSIVE')),
      discount_kind text CHECK (discount_kind IN ('PERCENT','AMOUNT')),
      discount_bp bigint${strict ? ' CHECK (discount_bp BETWEEN 0 AND 10000)' : ''},
      discount_paise bigint${strict ? ' CHECK (discount_paise >= 0)' : ''},
      note text,
      -- Filled in when the document is priced; always present once it is issued.
      item_name text,
      hsn_or_sac text,
      rate_bp bigint CHECK (rate_bp BETWEEN 0 AND 10000),
      taxable_value_paise bigint${strict ? ' CHECK (taxable_value_paise >= 0)' : ''},
      ${headColumns(false)}
      reverse_charge boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (${foreignKey}, line_id),
      UNIQUE (${foreignKey}, line_no),
      CONSTRAINT ${table}_charge_has_kind CHECK ((kind = 'CHARGE') = (charge_kind IS NOT NULL)),
      CONSTRAINT ${table}_sold_line_has_item CHECK ((kind = 'GOODS') = (item_id IS NOT NULL)),
      CONSTRAINT ${table}_one_discount CHECK (
        (discount_kind IS NULL AND discount_bp IS NULL AND discount_paise IS NULL)
        OR (discount_kind = 'PERCENT' AND discount_bp IS NOT NULL AND discount_paise IS NULL)
        OR (discount_kind = 'AMOUNT' AND discount_paise IS NOT NULL AND discount_bp IS NULL)),
      FOREIGN KEY (company_id, ${foreignKey}) REFERENCES ${parent}(company_id, id),
      FOREIGN KEY (company_id, item_id) REFERENCES master_records(company_id, id),
      FOREIGN KEY (company_id, warehouse_id) REFERENCES master_records(company_id, id)
    );
    -- Foreign keys: "which documents sold this item", "what left this godown", and re-pointing after a master merge (#5).
    CREATE INDEX ${table}_item_idx ON ${table}(company_id, item_id) WHERE item_id IS NOT NULL;
    CREATE INDEX ${table}_warehouse_idx ON ${table}(company_id, warehouse_id) WHERE warehouse_id IS NOT NULL;`;

const ISSUED_LINE = 'quantity_micro > 0 AND unit_price_paise >= 0 AND taxable_value_paise >= 0 AND COALESCE(discount_bp, 0) BETWEEN 0 AND 10000 AND COALESCE(discount_paise, 0) >= 0';

/** The list screens: newest first, by customer, and by state. `id` breaks ties so paging by key is stable. */
const listIndexes = (table: string): string => `
    CREATE INDEX ${table}_list_idx ON ${table}(company_id, document_date DESC, id);
    CREATE INDEX ${table}_party_idx ON ${table}(company_id, party_id, document_date DESC);
    CREATE INDEX ${table}_state_idx ON ${table}(company_id, state, document_date DESC);
    CREATE INDEX ${table}_branch_idx ON ${table}(company_id, branch_id) WHERE branch_id IS NOT NULL;`;

const frozen = (table: string, statusColumn: string, when: string, mayChange: string, moves: string): string => `
    CREATE TRIGGER ${table}_frozen BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('${statusColumn}', '${when}', '${mayChange}', '${moves}');
    CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table}
      FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();`;

const frozenWithParent = (table: string, foreignKey: string, parent: string, when: string): string => `
    CREATE TRIGGER ${table}_frozen BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_with_parent('${foreignKey}', '${parent}', 'state', '${when}');
    CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table}
      FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();`;

/** Checked when the transaction ends, so a document and its lines can be written in any order. */
export const linesAddUp = (header: string, lines: string, foreignKey: string, statusColumn: string, when: string, billable: string, everyLine = 'true'): string => `
    CREATE CONSTRAINT TRIGGER ${header}_lines_add_up AFTER INSERT OR UPDATE ON ${header}
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION document_lines_add_up('${lines}', '${foreignKey}', '${header}', '${statusColumn}', '${when}', '${billable}', '${everyLine}');
    CREATE CONSTRAINT TRIGGER ${lines}_add_up AFTER INSERT OR UPDATE ON ${lines}
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION document_lines_add_up('${lines}', '${foreignKey}', '${header}', '${statusColumn}', '${when}', '${billable}', '${everyLine}');`;

const INVOICE_LINK = `
      invoice_id uuid,
      invoice_number text,
      invoice_date date,
      linked_by uuid ${USERS},
      linked_at timestamptz,
      link_differences jsonb,`;
const CANCELLATION = `
      cancelled_by uuid ${USERS},
      cancelled_at timestamptz,
      cancel_reason text,`;
const linkAndCancelChecks = (table: string): string => `
      CONSTRAINT ${table}_invoiced_has_bill CHECK ((state = 'INVOICED') = (invoice_id IS NOT NULL)),
      CONSTRAINT ${table}_bill_link_whole CHECK (num_nulls(invoice_id, invoice_number, invoice_date, linked_by, linked_at, link_differences) IN (0, 6)),
      CONSTRAINT ${table}_cancelled_says_why CHECK ((state = 'CANCELLED') = (cancelled_at IS NOT NULL) AND num_nulls(cancelled_by, cancelled_at) IN (0, 2)
        AND (cancelled_at IS NULL) = (cancel_reason IS NULL) AND (cancel_reason IS NULL OR length(trim(cancel_reason)) > 0)),
      FOREIGN KEY (company_id, invoice_id) REFERENCES sales_invoices(company_id, id),`;

export const salesMigrations: readonly Migration[] = Object.freeze([{
  id: '20261011T142835448Z_sales_d8b249ca27fa_sales_documents',
  up: `
    -- So a foreign key can carry the company: a row can then never point at another company's record.
    ALTER TABLE branches ADD CONSTRAINT branches_company_id_id_key UNIQUE (company_id, id);
    ALTER TABLE master_records ADD CONSTRAINT master_records_company_id_id_key UNIQUE (company_id, id);
    ALTER TABLE voucher ADD CONSTRAINT voucher_company_id_id_key UNIQUE (company_id, id);

    -- Issue #368 asks every document with lines to be born with this: a row trigger cannot refuse
    -- a line added later to a finished document, but the totals are frozen, so the lines must still
    -- add up to them when the transaction ends. Arguments: lines table, its foreign key, header
    -- table, status column ('' = none), statuses in which the document is finished ('*' = always),
    -- which lines' tax is billed (the tax on a reverse-charge line is not in the document's total),
    -- and what must be true of every line of a finished document.
    -- The header is read FOR SHARE: a line changed by another transaction while the document was
    -- being issued waits for that to finish and is then checked against the issued document, so
    -- the rule does not depend on our own per-company lock.
    CREATE FUNCTION document_lines_add_up() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
    DECLARE
      header_id uuid := CASE WHEN TG_TABLE_NAME = TG_ARGV[2] THEN (to_jsonb(NEW) ->> 'id')::uuid ELSE (to_jsonb(NEW) ->> TG_ARGV[1])::uuid END;
      status text;
      expected_lines integer;
      expected_taxable bigint;
      expected_tax bigint;
      found_lines integer;
      found_taxable bigint;
      found_tax bigint;
      wrong_lines integer;
    BEGIN
      EXECUTE format('SELECT %s, line_count, COALESCE(taxable_value_paise, 0), COALESCE(total_tax_paise, 0) FROM %I.%I WHERE id = $1 FOR SHARE',
        CASE WHEN TG_ARGV[3] = '' THEN 'NULL::text' ELSE format('%I::text', TG_ARGV[3]) END, TG_TABLE_SCHEMA, TG_ARGV[2])
        INTO status, expected_lines, expected_taxable, expected_tax USING header_id;
      -- No header: an unissued draft that was discarded in this same transaction.
      IF expected_lines IS NULL THEN RETURN NULL; END IF;
      IF TG_ARGV[4] <> '*' AND NOT COALESCE(status = ANY (string_to_array(TG_ARGV[4], ',')), true) THEN RETURN NULL; END IF;
      EXECUTE format('SELECT count(*), COALESCE(sum(taxable_value_paise), 0), COALESCE(sum(${HEADS_SUM}) FILTER (WHERE %s), 0), count(*) FILTER (WHERE (%s) IS NOT TRUE) FROM %I.%I WHERE %I = $1',
        TG_ARGV[5], TG_ARGV[6], TG_TABLE_SCHEMA, TG_ARGV[0], TG_ARGV[1])
        INTO found_lines, found_taxable, found_tax, wrong_lines USING header_id;
      IF wrong_lines > 0 THEN
        RAISE EXCEPTION 'A finished record has % line(s) with a quantity or an amount that cannot be.', wrong_lines
          USING ERRCODE = 'check_violation', TABLE = TG_ARGV[0], CONSTRAINT = TG_ARGV[0] || '_issued_line';
      END IF;
      IF found_lines <> expected_lines OR found_taxable <> expected_taxable OR found_tax <> expected_tax THEN
        RAISE EXCEPTION 'The lines of this record do not add up to its totals: % lines, % taxable and % tax, against % lines, % and %.',
          found_lines, found_taxable, found_tax, expected_lines, expected_taxable, expected_tax
          USING ERRCODE = 'check_violation', TABLE = TG_ARGV[2], CONSTRAINT = TG_ARGV[2] || '_lines_add_up';
      END IF;
      RETURN NULL;
    END;
    $$;

    CREATE TABLE sales_invoices (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      branch_id uuid,
      state text NOT NULL CHECK (state IN ('DRAFT','PENDING_APPROVAL','NEEDS_INFO','FINAL','CANCELLED')),
      -- Given only when the bill is issued, so an unfinished bill never uses up a number (Rule 46(b)).
      number text CHECK (length(number) BETWEEN 1 AND 16),
      financial_year text CHECK (financial_year ~ '^\\d{4}-\\d{2}$'),
      document_date date NOT NULL,
      due_date date,
      ${saleParticulars('WHEN_ISSUED')}
      zero_rated text CHECK (zero_rated IN ('WITH_TAX','WITHOUT_TAX')),
      problems jsonb NOT NULL DEFAULT '[]',
      voucher_id uuid,
      cancellation_voucher_id uuid,
      created_by uuid NOT NULL ${USERS},
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      finalised_by uuid ${USERS},
      finalised_at timestamptz,
      approved_by uuid ${USERS},
      approved_at timestamptz,
      ${CANCELLATION}
      idempotency_key text NOT NULL CHECK (idempotency_key <> ''),
      version integer NOT NULL CHECK (version >= 0),
      ${ORIGIN}
      UNIQUE (company_id, id),
      UNIQUE (company_id, number),
      UNIQUE (company_id, idempotency_key),
      CONSTRAINT sales_invoices_number_when_issued CHECK ((state IN ('FINAL','CANCELLED')) = (number IS NOT NULL) AND (number IS NULL) = (financial_year IS NULL)),
      CONSTRAINT sales_invoices_issued_is_complete CHECK (state NOT IN ('FINAL','CANCELLED')
        OR num_nulls(voucher_id, finalised_by, finalised_at, pricing) = 0),
      CONSTRAINT sales_invoices_approved_together CHECK (num_nulls(approved_by, approved_at) IN (0, 2)),
      CONSTRAINT sales_invoices_cancelled_says_why CHECK ((state = 'CANCELLED') = (cancelled_at IS NOT NULL)
        AND num_nulls(cancellation_voucher_id, cancelled_by, cancelled_at, cancel_reason) IN (0, 4) AND (cancel_reason IS NULL OR length(trim(cancel_reason)) > 0)),
      ${saleParticularsChecks('sales_invoices')}
      FOREIGN KEY (company_id, voucher_id) REFERENCES voucher(company_id, id),
      FOREIGN KEY (company_id, cancellation_voucher_id) REFERENCES voucher(company_id, id)
    );
    ${listIndexes('sales_invoices')}
    -- Foreign keys: from an entry in the books back to its bill.
    CREATE INDEX sales_invoices_voucher_idx ON sales_invoices(company_id, voucher_id) WHERE voucher_id IS NOT NULL;
    CREATE INDEX sales_invoices_cancellation_voucher_idx ON sales_invoices(company_id, cancellation_voucher_id) WHERE cancellation_voucher_id IS NOT NULL;
    ${saleLines('sales_invoice_lines', 'sales_invoices', 'invoice_id', false)}

    CREATE TABLE presale_documents (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      branch_id uuid,
      kind text NOT NULL CHECK (kind IN ('QUOTATION','PROFORMA')),
      state text NOT NULL CHECK (state IN ('ISSUED','CONVERTED','INVOICED','CANCELLED')),
      number text NOT NULL CHECK (length(number) BETWEEN 1 AND 16),
      financial_year text NOT NULL CHECK (financial_year ~ '^\\d{4}-\\d{2}$'),
      document_date date NOT NULL,
      valid_until date,
      ${saleParticulars('ALWAYS')}
      declared_rate_notice jsonb,
      terms text,
      purpose text,
      buyer_order_number text,
      payment_terms text,
      -- A quotation that became a sale. The bill starts as a draft and a draft may be discarded
      -- (#256), so this is a plain id, not a foreign key.
      converted_invoice_id uuid,
      converted_by uuid ${USERS},
      converted_at timestamptz,
      -- A proforma closed by the tax invoice that followed it.
      ${INVOICE_LINK}
      ${CANCELLATION}
      created_by uuid NOT NULL ${USERS},
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      idempotency_key text NOT NULL CHECK (idempotency_key <> ''),
      version integer NOT NULL CHECK (version >= 0),
      ${ORIGIN}
      UNIQUE (company_id, id),
      UNIQUE (company_id, number),
      UNIQUE (company_id, idempotency_key),
      CONSTRAINT presale_documents_valid_after_date CHECK (valid_until >= document_date),
      CONSTRAINT presale_documents_proforma_says_what_for CHECK (kind <> 'PROFORMA' OR COALESCE(length(trim(purpose)), 0) > 0),
      -- A quotation is closed by a sale, a proforma by its tax invoice; never the other way round.
      CONSTRAINT presale_documents_closed_by_its_kind CHECK ((state <> 'CONVERTED' OR kind = 'QUOTATION') AND (state <> 'INVOICED' OR kind = 'PROFORMA')),
      CONSTRAINT presale_documents_converted_has_sale CHECK ((state = 'CONVERTED') = (converted_invoice_id IS NOT NULL) AND num_nulls(converted_invoice_id, converted_by, converted_at) IN (0, 3)),
      ${linkAndCancelChecks('presale_documents')}
      ${saleParticularsChecks('presale_documents').trim().replace(/,$/, '')}
    );
    ${listIndexes('presale_documents')}
    -- Foreign key, and "which proforma did this bill close".
    CREATE INDEX presale_documents_invoice_idx ON presale_documents(company_id, invoice_id) WHERE invoice_id IS NOT NULL;
    CREATE INDEX presale_documents_converted_idx ON presale_documents(company_id, converted_invoice_id) WHERE converted_invoice_id IS NOT NULL;
    ${saleLines('presale_document_lines', 'presale_documents', 'document_id', true)}

    CREATE TABLE delivery_challans (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      branch_id uuid,
      state text NOT NULL CHECK (state IN ('ISSUED','INVOICED','CANCELLED')),
      number text NOT NULL CHECK (length(number) BETWEEN 1 AND 16),
      financial_year text NOT NULL CHECK (financial_year ~ '^\\d{4}-\\d{2}$'),
      document_date date NOT NULL,
      party_id uuid NOT NULL,
      reason text NOT NULL CHECK (reason IN ('SUPPLY_INVOICE_TO_FOLLOW','LIQUID_GAS','SUPPLY_ON_APPROVAL','JOB_WORK','OWN_USE','EXHIBITION_OR_FAIRS','OTHER_NOT_A_SUPPLY')),
      reason_note text,
      delivery_state_code text,
      from_state_code text NOT NULL,
      to_state_code text,
      inter_state boolean NOT NULL,
      place_of_supply_state_code text,
      shows_tax boolean NOT NULL,
      split text CHECK (split IN ('CGST_SGST','CGST_UTGST','IGST')),
      line_count integer NOT NULL CHECK (line_count >= 1),
      taxable_value_paise bigint NOT NULL CHECK (taxable_value_paise >= 0),
      ${headColumns(false)}
      total_tax_paise bigint NOT NULL,
      declared_rate_notice jsonb,
      narration text,
      eway_bill_number text CHECK (eway_bill_number ~ '^\\d{12}$'),
      eway_bill_date date,
      eway_bill_transporter text,
      eway_bill_vehicle_number text,
      eway_bill_source text CHECK (eway_bill_source IN ('PORTAL','TYPED')),
      eway_bill_recorded_by uuid ${USERS},
      eway_bill_recorded_at timestamptz,
      ${INVOICE_LINK}
      ${CANCELLATION}
      created_by uuid NOT NULL ${USERS},
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      idempotency_key text NOT NULL CHECK (idempotency_key <> ''),
      version integer NOT NULL CHECK (version >= 0),
      ${ORIGIN}
      UNIQUE (company_id, id),
      UNIQUE (company_id, number),
      UNIQUE (company_id, idempotency_key),
      CONSTRAINT delivery_challans_other_says_why CHECK (reason <> 'OTHER_NOT_A_SUPPLY' OR COALESCE(length(trim(reason_note)), 0) > 0),
      CONSTRAINT delivery_challans_tax_is_its_heads CHECK (total_tax_paise = ${HEADS_SUM}),
      CONSTRAINT delivery_challans_eway_bill_whole CHECK (num_nulls(eway_bill_number, eway_bill_source, eway_bill_recorded_by, eway_bill_recorded_at) IN (0, 4)
        AND (eway_bill_number IS NOT NULL OR num_nulls(eway_bill_date, eway_bill_transporter, eway_bill_vehicle_number) = 3)),
      ${linkAndCancelChecks('delivery_challans')}
      FOREIGN KEY (company_id, branch_id) REFERENCES branches(company_id, id),
      FOREIGN KEY (company_id, party_id) REFERENCES master_records(company_id, id)
    );
    ${listIndexes('delivery_challans')}
    -- Foreign key, and "which challans did this bill close".
    CREATE INDEX delivery_challans_invoice_idx ON delivery_challans(company_id, invoice_id) WHERE invoice_id IS NOT NULL;

    CREATE TABLE delivery_challan_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES companies(id),
      challan_id uuid NOT NULL,
      line_id text NOT NULL CHECK (line_id <> ''),
      line_no integer NOT NULL CHECK (line_no >= 1),
      item_id uuid NOT NULL,
      item_name text NOT NULL,
      hsn_or_sac text NOT NULL,
      quantity_micro bigint NOT NULL CHECK (quantity_micro > 0),
      unit_code text NOT NULL CHECK (unit_code <> ''),
      -- Liquid gas: the quantity is not known until it is delivered (Rule 55(1)(a)).
      quantity_provisional boolean NOT NULL DEFAULT false,
      unit_price_paise bigint NOT NULL CHECK (unit_price_paise >= 0),
      taxable_value_paise bigint NOT NULL CHECK (taxable_value_paise >= 0),
      rate_bp bigint CHECK (rate_bp BETWEEN 0 AND 10000),
      ${headColumns(false)}
      exempt_supply boolean NOT NULL DEFAULT false,
      warehouse_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (challan_id, line_id),
      UNIQUE (challan_id, line_no),
      FOREIGN KEY (company_id, challan_id) REFERENCES delivery_challans(company_id, id),
      FOREIGN KEY (company_id, item_id) REFERENCES master_records(company_id, id),
      FOREIGN KEY (company_id, warehouse_id) REFERENCES master_records(company_id, id)
    );
    CREATE INDEX delivery_challan_lines_item_idx ON delivery_challan_lines(company_id, item_id);
    CREATE INDEX delivery_challan_lines_warehouse_idx ON delivery_challan_lines(company_id, warehouse_id) WHERE warehouse_id IS NOT NULL;

    -- A credit note cannot take back more of a line than the bill sold, less what earlier notes
    -- took back. The bill's line is locked first, so two credit notes written at the same moment
    -- are checked one after the other. A bill that is not in sales_invoices (bills made before the
    -- running app moved to PostgreSQL, #340) is left to the returns service, as before.
    CREATE FUNCTION sales_return_within_original() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
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
    CREATE TRIGGER return_note_lines_within_original BEFORE INSERT ON return_note_lines
      FOR EACH ROW EXECUTE FUNCTION sales_return_within_original();

    -- Issue #368: an issued document never changes. A bill may only be cancelled; a quotation,
    -- proforma or challan may only be closed by its bill or withdrawn.
    ${frozen('sales_invoices', 'state', 'FINAL,CANCELLED', 'cancellation_voucher_id,cancelled_by,cancelled_at,cancel_reason,updated_at,version', 'FINAL>CANCELLED')}
    ${frozenWithParent('sales_invoice_lines', 'invoice_id', 'sales_invoices', 'FINAL,CANCELLED')}
    ${frozen('presale_documents', 'state', '*', 'converted_invoice_id,converted_by,converted_at,invoice_id,invoice_number,invoice_date,linked_by,linked_at,link_differences,cancelled_by,cancelled_at,cancel_reason,updated_at,version', 'ISSUED>CONVERTED,ISSUED>INVOICED,ISSUED>CANCELLED')}
    ${frozen('presale_document_lines', '', '*', '', '')}
    ${frozen('delivery_challans', 'state', '*', 'eway_bill_number,eway_bill_date,eway_bill_transporter,eway_bill_vehicle_number,eway_bill_source,eway_bill_recorded_by,eway_bill_recorded_at,invoice_id,invoice_number,invoice_date,linked_by,linked_at,link_differences,cancelled_by,cancelled_at,cancel_reason,updated_at,version', 'ISSUED>INVOICED,ISSUED>CANCELLED')}
    ${frozen('delivery_challan_lines', '', '*', '', '')}
    ${linesAddUp('sales_invoices', 'sales_invoice_lines', 'invoice_id', 'state', 'FINAL,CANCELLED', 'NOT reverse_charge', ISSUED_LINE)}
    ${linesAddUp('presale_documents', 'presale_document_lines', 'document_id', '', '*', 'NOT reverse_charge')}
    ${linesAddUp('delivery_challans', 'delivery_challan_lines', 'challan_id', '', '*', 'true')}

    ${['sales_invoices', 'sales_invoice_lines', 'presale_documents', 'presale_document_lines', 'delivery_challans', 'delivery_challan_lines'].map(tenantPolicy).join('')}

    -- A bill that was never issued may be discarded (#256), and a draft's lines are replaced when it
    -- is edited. The application has no right to delete from these tables (#368: never on a table
    -- that holds posted records), so it asks this function, which removes only what belongs to an
    -- unissued bill of the current company. It runs with the owner's rights, so the company is
    -- named in every statement rather than left to row-level security.
    CREATE FUNCTION sales_discard_draft(bill uuid, lines_only boolean) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
    DECLARE
      company uuid := nullif(current_setting('app.company_id', true), '')::uuid;
    BEGIN
      PERFORM 1 FROM sales_invoices WHERE id = bill AND company_id = company AND state NOT IN ('FINAL','CANCELLED') FOR UPDATE;
      IF NOT FOUND THEN RETURN false; END IF;
      DELETE FROM sales_invoice_lines WHERE invoice_id = bill AND company_id = company;
      IF NOT lines_only THEN
        DELETE FROM sales_invoices WHERE id = bill AND company_id = company;
      END IF;
      RETURN true;
    END;
    $$;
    REVOKE ALL ON FUNCTION sales_discard_draft(uuid, boolean) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION sales_discard_draft(uuid, boolean) TO invoice_app;
  `,
  down: `
    DROP TRIGGER IF EXISTS return_note_lines_within_original ON return_note_lines;
    DROP FUNCTION IF EXISTS sales_return_within_original();
    DROP FUNCTION IF EXISTS sales_discard_draft(uuid, boolean);
    DROP TABLE IF EXISTS delivery_challan_lines, delivery_challans, presale_document_lines, presale_documents, sales_invoice_lines, sales_invoices;
    DROP FUNCTION IF EXISTS document_lines_add_up();
    ALTER TABLE voucher DROP CONSTRAINT IF EXISTS voucher_company_id_id_key;
    ALTER TABLE master_records DROP CONSTRAINT IF EXISTS master_records_company_id_id_key;
    ALTER TABLE branches DROP CONSTRAINT IF EXISTS branches_company_id_id_key;
  `,
}]);
