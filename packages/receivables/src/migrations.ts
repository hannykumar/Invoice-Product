/**
 * Issue #365 — PostgreSQL tables for money in and money out: payments, cheques, what each payment
 * settled, what each bill still owes, and advances with their refund vouchers.
 * Design: docs/contracts/sales-schema-v1.md.
 *
 * Two figures are kept by the database and cannot be written by the application:
 *  - `payments.allocated_paise` — how much of a payment bills have used; never more than the payment.
 *  - `document_settlements.allocated_paise` — how much of a bill has been paid; never more than the bill.
 *    (`credited_paise`, what credit notes took off the bill, is kept the same way from `return_notes`.)
 * A trigger on `payment_allocations` moves both in the statement that records the allocation, and
 * the two CHECKs do the refusing. A bill's `status` is computed from those figures, so a part
 * payment can never mark a bill paid.
 */
import type { Migration } from '../../platform/src/migration-definitions.ts';
import { tenantPolicy } from '../../platform/src/immutability-migrations.ts';
import { linesAddUp } from '../../sales/src/migrations.ts';

const USERS = 'REFERENCES users(id)';
const TAX_HEADS = ['cgst', 'sgst', 'utgst', 'igst', 'cess'] as const;
const heads = (prefix = ''): string => TAX_HEADS.map((head) => `${prefix}${head}_paise bigint NOT NULL DEFAULT 0 CHECK (${prefix}${head}_paise >= 0),`).join('\n      ');
const ORIGIN = `origin text NOT NULL DEFAULT 'server' CHECK (origin <> ''),
      device_issued_at timestamptz,`;
const CHEQUE_STATES = `'PENDING','DEPOSITED','CLEARED','BOUNCED','CANCELLED'`;
const DOCUMENT_KINDS = `'SALES_INVOICE','PURCHASE_INVOICE','CREDIT_NOTE','DEBIT_NOTE'`;

const frozen = (table: string, statusColumn = '', mayChange = '', moves = ''): string => `
    CREATE TRIGGER ${table}_frozen BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('${statusColumn}', '*', '${mayChange}', '${moves}');
    CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table}
      FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();`;

const TABLES = ['payments', 'cheque_events', 'document_settlements', 'payment_allocations', 'advance_receipts', 'advance_tax_lines', 'advance_applications', 'refund_vouchers'];

export const receivablesMigrations: readonly Migration[] = Object.freeze([{
  id: '20261011T142837945Z_receivables_f152bb54fd54_payments_settlements_and_advances',
  up: `
    CREATE TABLE payments (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      branch_id uuid,
      direction text NOT NULL CHECK (direction IN ('RECEIPT','PAYMENT')),
      party_id uuid NOT NULL,
      mode text NOT NULL CHECK (mode IN ('CASH','CHEQUE','BANK_TRANSFER','UPI','CARD','OTHER')),
      amount_paise bigint NOT NULL CHECK (amount_paise > 0),
      payment_date date NOT NULL,
      reference text,
      bank_account_code text,
      -- Money paid back out of an earlier receipt that no bill used (#165).
      refund_of uuid,
      -- Money paid to a supplier before their bill, and what it was paid against (#261, #274).
      advance_to_supplier boolean NOT NULL DEFAULT false,
      advance_purchase_order_number text,
      advance_purchase_order_date date,
      advance_supplier_receipt_number text,
      advance_supplier_receipt_date date,
      cheque_number text,
      cheque_date date,
      cheque_bank_name text,
      -- Where the cheque stands now. How it got there is in cheque_events, which is never rewritten.
      cheque_state text CHECK (cheque_state IN (${CHEQUE_STATES})),
      -- Kept by the database from payment_allocations.
      allocated_paise bigint NOT NULL DEFAULT 0,
      state text NOT NULL CHECK (state IN ('RECORDED','REVERSED')),
      voucher_id uuid,
      reversal_voucher_id uuid,
      reversal_reason text,
      narration text,
      recorded_by uuid NOT NULL ${USERS},
      recorded_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      idempotency_key text NOT NULL CHECK (idempotency_key <> ''),
      version integer NOT NULL CHECK (version >= 0),
      ${ORIGIN}
      UNIQUE (company_id, id),
      UNIQUE (company_id, idempotency_key),
      CONSTRAINT payments_allocated_within_amount CHECK (allocated_paise BETWEEN 0 AND amount_paise),
      CONSTRAINT payments_cheque_whole CHECK ((mode <> 'CHEQUE' OR cheque_number IS NOT NULL) AND num_nulls(cheque_number, cheque_date, cheque_state) IN (0, 3) AND (cheque_number IS NOT NULL OR cheque_bank_name IS NULL)),
      CONSTRAINT payments_supplier_advance_is_paid_out CHECK (NOT advance_to_supplier OR direction = 'PAYMENT'),
      CONSTRAINT payments_advance_particulars_whole CHECK (num_nulls(advance_purchase_order_number, advance_purchase_order_date) IN (0, 2)
        AND num_nulls(advance_supplier_receipt_number, advance_supplier_receipt_date) IN (0, 2)
        AND (advance_to_supplier OR num_nulls(advance_purchase_order_number, advance_supplier_receipt_number) = 2)),
      CONSTRAINT payments_reversed_says_why CHECK (state <> 'REVERSED' OR COALESCE(length(trim(reversal_reason)), 0) > 0),
      FOREIGN KEY (company_id, branch_id) REFERENCES branches(company_id, id),
      FOREIGN KEY (company_id, party_id) REFERENCES master_records(company_id, id),
      FOREIGN KEY (company_id, refund_of) REFERENCES payments(company_id, id),
      FOREIGN KEY (company_id, voucher_id) REFERENCES voucher(company_id, id),
      FOREIGN KEY (company_id, reversal_voucher_id) REFERENCES voucher(company_id, id)
    );
    -- The list of payments, newest first, and one party's payments (statement, ageing).
    CREATE INDEX payments_list_idx ON payments(company_id, payment_date DESC, id);
    CREATE INDEX payments_party_idx ON payments(company_id, party_id, payment_date DESC);
    -- Foreign keys.
    CREATE INDEX payments_branch_idx ON payments(company_id, branch_id) WHERE branch_id IS NOT NULL;
    CREATE INDEX payments_refund_of_idx ON payments(company_id, refund_of) WHERE refund_of IS NOT NULL;
    CREATE INDEX payments_voucher_idx ON payments(company_id, voucher_id) WHERE voucher_id IS NOT NULL;
    CREATE INDEX payments_reversal_voucher_idx ON payments(company_id, reversal_voucher_id) WHERE reversal_voucher_id IS NOT NULL;
    -- Cheques in hand: taken, not yet money in the bank.
    CREATE INDEX payments_cheques_in_hand_idx ON payments(company_id, cheque_date) WHERE cheque_state IN ('PENDING','DEPOSITED');
    -- Advances to suppliers that no bill has used up yet (#261).
    CREATE INDEX payments_supplier_advances_idx ON payments(company_id, party_id) WHERE advance_to_supplier AND state = 'RECORDED';

    -- One step in a cheque's life, kept for ever ("cheque status changes do not lose history", #20).
    CREATE TABLE cheque_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES companies(id),
      payment_id uuid NOT NULL,
      seq integer NOT NULL CHECK (seq >= 1),
      state text NOT NULL CHECK (state IN (${CHEQUE_STATES})),
      on_date date NOT NULL,
      recorded_by uuid NOT NULL ${USERS},
      recorded_at timestamptz NOT NULL,
      note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (payment_id, seq),
      FOREIGN KEY (company_id, payment_id) REFERENCES payments(company_id, id)
    );

    -- What one bill or note is worth and how much of it has been paid: the row that is locked
    -- while money is applied to it (#367). #365 writes a row for each sales bill when it is
    -- issued; purchase bills and credit and debit notes join from their own lanes.
    CREATE TABLE document_settlements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES companies(id),
      document_kind text NOT NULL CHECK (document_kind IN (${DOCUMENT_KINDS})),
      document_id text NOT NULL CHECK (document_id <> ''),
      document_number text NOT NULL CHECK (document_number <> ''),
      party_id uuid NOT NULL,
      -- RECEIVABLE: the customer owes us. PAYABLE: we owe them.
      side text NOT NULL CHECK (side IN ('RECEIVABLE','PAYABLE')),
      document_date date NOT NULL,
      due_date date,
      value_paise bigint NOT NULL CHECK (value_paise >= 0),
      -- Kept by the database from payment_allocations.
      allocated_paise bigint NOT NULL DEFAULT 0,
      -- Taken off the bill by credit notes. Kept by the database from return_notes.
      credited_paise bigint NOT NULL DEFAULT 0 CHECK (credited_paise >= 0),
      -- The bill was cancelled: nothing is owed on it any more. Money already applied to it stays
      -- on its payments, as it does today.
      cancelled boolean NOT NULL DEFAULT false,
      status text NOT NULL GENERATED ALWAYS AS (CASE
        WHEN cancelled THEN 'CANCELLED'
        WHEN allocated_paise >= value_paise - credited_paise THEN 'SETTLED'
        WHEN allocated_paise > 0 THEN 'PARTLY_PAID'
        ELSE 'OPEN' END) STORED,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (company_id, document_kind, document_id),
      CONSTRAINT document_settlements_allocated_within_value CHECK (allocated_paise BETWEEN 0 AND value_paise),
      FOREIGN KEY (company_id, party_id) REFERENCES master_records(company_id, id)
    );
    -- What one party still owes or is owed (statement, ageing, collections #23), and what is overdue.
    CREATE INDEX document_settlements_open_idx ON document_settlements(company_id, party_id, document_date) WHERE status IN ('OPEN','PARTLY_PAID');
    CREATE INDEX document_settlements_due_idx ON document_settlements(company_id, due_date) WHERE status IN ('OPEN','PARTLY_PAID');
    CREATE INDEX document_settlements_party_idx ON document_settlements(company_id, party_id);

    -- The row for a sales bill is only as good as the bill it describes: it must be an issued bill
    -- of this company, for exactly the bill's value.
    CREATE FUNCTION document_settlement_matches_bill() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
    BEGIN
      IF NEW.document_kind = 'SALES_INVOICE' AND NOT EXISTS (
        SELECT FROM sales_invoices b WHERE b.company_id = NEW.company_id AND b.id::text = NEW.document_id AND b.state = 'FINAL'
          AND b.invoice_value_paise = NEW.value_paise AND b.party_id = NEW.party_id) THEN
        RAISE EXCEPTION 'This is not an issued bill of that value for that customer.'
          USING ERRCODE = 'foreign_key_violation', TABLE = 'document_settlements', CONSTRAINT = 'document_settlements_matches_bill';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER document_settlements_matches_bill BEFORE INSERT ON document_settlements
      FOR EACH ROW EXECUTE FUNCTION document_settlement_matches_bill();

    -- A credit note against a sales bill takes its value off what the bill is owed.
    CREATE FUNCTION credit_note_reduces_bill() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
    BEGIN
      UPDATE document_settlements SET credited_paise = credited_paise + NEW.total_paise, updated_at = now()
        WHERE company_id = NEW.company_id AND document_kind = 'SALES_INVOICE' AND document_id = NEW.original_document_id;
      RETURN NULL;
    END;
    $$;
    CREATE TRIGGER return_notes_reduce_bill AFTER INSERT ON return_notes
      FOR EACH ROW WHEN (NEW.kind = 'SALES_RETURN') EXECUTE FUNCTION credit_note_reduces_bill();

    -- What a payment settled, and by how much. A bounced cheque or an undone payment releases its
    -- allocations; they are never deleted, so what was once settled can still be seen.
    CREATE TABLE payment_allocations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES companies(id),
      payment_id uuid NOT NULL,
      document_kind text NOT NULL CHECK (document_kind IN (${DOCUMENT_KINDS})),
      document_id text NOT NULL CHECK (document_id <> ''),
      document_number text NOT NULL,
      amount_paise bigint NOT NULL CHECK (amount_paise > 0),
      -- An advance paid to a supplier, later set against this bill (#274).
      adjusted_from_advance boolean NOT NULL DEFAULT false,
      released_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (company_id, payment_id) REFERENCES payments(company_id, id)
    );
    CREATE INDEX payment_allocations_payment_idx ON payment_allocations(company_id, payment_id);
    -- What is settling one bill right now.
    CREATE INDEX payment_allocations_document_idx ON payment_allocations(company_id, document_kind, document_id) WHERE released_at IS NULL;

    -- Recording an allocation moves both running figures; releasing it moves them back. The CHECKs
    -- on payments and document_settlements refuse an allocation that is too large. A sales bill
    -- must have its settlement row; the other kinds get theirs when their lanes join (#365 follow-up).
    CREATE FUNCTION payment_allocation_moves_balances() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
    DECLARE
      change bigint := CASE WHEN TG_OP = 'INSERT' THEN NEW.amount_paise ELSE -NEW.amount_paise END;
      settled integer;
    BEGIN
      IF TG_OP = 'INSERT' AND NEW.released_at IS NOT NULL THEN
        RAISE EXCEPTION 'An allocation is recorded first and released later.' USING ERRCODE = 'check_violation', TABLE = 'payment_allocations';
      END IF;
      UPDATE payments SET allocated_paise = allocated_paise + change WHERE company_id = NEW.company_id AND id = NEW.payment_id
        AND (TG_OP <> 'INSERT' OR state = 'RECORDED');
      IF NOT FOUND THEN
        RAISE EXCEPTION 'A payment that was undone settles nothing.'
          USING ERRCODE = 'check_violation', TABLE = 'payment_allocations', CONSTRAINT = 'payment_allocations_payment_is_live';
      END IF;
      UPDATE document_settlements SET allocated_paise = allocated_paise + change, updated_at = now()
        WHERE company_id = NEW.company_id AND document_kind = NEW.document_kind AND document_id = NEW.document_id;
      GET DIAGNOSTICS settled = ROW_COUNT;
      IF settled = 0 AND NEW.document_kind = 'SALES_INVOICE' THEN
        RAISE EXCEPTION 'Money cannot be applied to a bill that was never issued.'
          USING ERRCODE = 'foreign_key_violation', TABLE = 'payment_allocations', CONSTRAINT = 'payment_allocations_bill_is_issued';
      END IF;
      RETURN NULL;
    END;
    $$;
    CREATE TRIGGER payment_allocations_recorded AFTER INSERT ON payment_allocations
      FOR EACH ROW EXECUTE FUNCTION payment_allocation_moves_balances();
    CREATE TRIGGER payment_allocations_released AFTER UPDATE OF released_at ON payment_allocations
      FOR EACH ROW WHEN (OLD.released_at IS NULL AND NEW.released_at IS NOT NULL) EXECUTE FUNCTION payment_allocation_moves_balances();
    CREATE TRIGGER payment_allocations_release_final BEFORE UPDATE ON payment_allocations
      FOR EACH ROW WHEN (OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at)
      EXECUTE FUNCTION platform_refuse('An allocation that was released cannot be brought back. Record a new one.');

    -- A receipt voucher for money taken against a proforma invoice (CGST Rule 50, #165).
    CREATE TABLE advance_receipts (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      branch_id uuid,
      number text NOT NULL CHECK (length(number) BETWEEN 1 AND 16),
      financial_year text NOT NULL CHECK (financial_year ~ '^\\d{4}-\\d{2}$'),
      receipt_date date NOT NULL,
      proforma_id uuid NOT NULL,
      proforma_number text NOT NULL,
      party_id uuid NOT NULL,
      supply_kind text NOT NULL CHECK (supply_kind IN ('GOODS','SERVICES')),
      place_of_supply_state_code text NOT NULL,
      -- Rule 50(e): what the advance is for.
      description text NOT NULL CHECK (length(trim(description)) > 0),
      amount_paise bigint NOT NULL CHECK (amount_paise > 0),
      -- The GST owed on the advance at once. All empty for goods: no GST is due on an advance for
      -- goods (Notification 66/2017-Central Tax).
      line_count integer NOT NULL DEFAULT 0 CHECK (line_count >= 0),
      taxable_value_paise bigint CHECK (taxable_value_paise >= 0),
      ${TAX_HEADS.map((head) => `${head}_paise bigint CHECK (${head}_paise >= 0),`).join('\n      ')}
      total_tax_paise bigint,
      payment_id uuid NOT NULL,
      tax_voucher_id uuid,
      recorded_by uuid NOT NULL ${USERS},
      recorded_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      idempotency_key text NOT NULL CHECK (idempotency_key <> ''),
      version integer NOT NULL CHECK (version >= 0),
      ${ORIGIN}
      UNIQUE (company_id, id),
      UNIQUE (company_id, number),
      UNIQUE (company_id, idempotency_key),
      CONSTRAINT advance_receipts_tax_whole CHECK (num_nulls(taxable_value_paise, cgst_paise, sgst_paise, utgst_paise, igst_paise, cess_paise, total_tax_paise) IN (0, 7)),
      CONSTRAINT advance_receipts_no_tax_on_goods CHECK (supply_kind <> 'GOODS' OR (taxable_value_paise IS NULL AND line_count = 0)),
      CONSTRAINT advance_receipts_tax_is_its_heads CHECK (total_tax_paise = cgst_paise + sgst_paise + utgst_paise + igst_paise + cess_paise),
      FOREIGN KEY (company_id, branch_id) REFERENCES branches(company_id, id),
      FOREIGN KEY (company_id, proforma_id) REFERENCES presale_documents(company_id, id),
      FOREIGN KEY (company_id, party_id) REFERENCES master_records(company_id, id),
      FOREIGN KEY (company_id, payment_id) REFERENCES payments(company_id, id),
      FOREIGN KEY (company_id, tax_voucher_id) REFERENCES voucher(company_id, id)
    );
    CREATE INDEX advance_receipts_list_idx ON advance_receipts(company_id, receipt_date DESC, id);
    -- Foreign keys, and "the advances against this proforma".
    CREATE INDEX advance_receipts_branch_idx ON advance_receipts(company_id, branch_id) WHERE branch_id IS NOT NULL;
    CREATE INDEX advance_receipts_proforma_idx ON advance_receipts(company_id, proforma_id);
    CREATE INDEX advance_receipts_party_idx ON advance_receipts(company_id, party_id, receipt_date DESC);
    CREATE INDEX advance_receipts_payment_idx ON advance_receipts(company_id, payment_id);
    CREATE INDEX advance_receipts_tax_voucher_idx ON advance_receipts(company_id, tax_voucher_id) WHERE tax_voucher_id IS NOT NULL;

    -- The tax on the advance, one row for each rate.
    CREATE TABLE advance_tax_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES companies(id),
      advance_id uuid NOT NULL,
      line_no integer NOT NULL CHECK (line_no >= 1),
      rate_bp bigint CHECK (rate_bp BETWEEN 0 AND 10000),
      reverse_charge boolean NOT NULL DEFAULT false,
      taxable_value_paise bigint NOT NULL CHECK (taxable_value_paise >= 0),
      ${heads()}
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (advance_id, line_no),
      FOREIGN KEY (company_id, advance_id) REFERENCES advance_receipts(company_id, id)
    );

    -- The advance set against the bill that followed (at most once).
    CREATE TABLE advance_applications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES companies(id),
      advance_id uuid NOT NULL,
      invoice_id uuid NOT NULL,
      invoice_number text NOT NULL,
      invoice_date date NOT NULL,
      -- Nothing, when the bill had already been covered by an earlier advance on the same proforma.
      amount_paise bigint NOT NULL CHECK (amount_paise >= 0),
      -- The tax paid on that part of the advance, now set off against the bill's own tax.
      ${heads('set_off_')}
      voucher_id uuid,
      applied_by uuid NOT NULL ${USERS},
      applied_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (advance_id),
      FOREIGN KEY (company_id, advance_id) REFERENCES advance_receipts(company_id, id),
      FOREIGN KEY (company_id, invoice_id) REFERENCES sales_invoices(company_id, id),
      FOREIGN KEY (company_id, voucher_id) REFERENCES voucher(company_id, id)
    );
    CREATE INDEX advance_applications_invoice_idx ON advance_applications(company_id, invoice_id);
    CREATE INDEX advance_applications_voucher_idx ON advance_applications(company_id, voucher_id) WHERE voucher_id IS NOT NULL;

    -- Unused advance money given back (CGST Rule 51), at most once for each advance.
    CREATE TABLE refund_vouchers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES companies(id),
      advance_id uuid NOT NULL,
      number text NOT NULL CHECK (length(number) BETWEEN 1 AND 16),
      refund_date date NOT NULL,
      amount_paise bigint NOT NULL CHECK (amount_paise > 0),
      -- The tax paid on the refunded part, taken back from what is owed to the government.
      ${heads('refunded_')}
      payment_id uuid NOT NULL,
      voucher_id uuid,
      reason text NOT NULL CHECK (length(trim(reason)) > 0),
      refunded_by uuid NOT NULL ${USERS},
      refunded_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      ${ORIGIN}
      UNIQUE (advance_id),
      UNIQUE (company_id, number),
      FOREIGN KEY (company_id, advance_id) REFERENCES advance_receipts(company_id, id),
      FOREIGN KEY (company_id, payment_id) REFERENCES payments(company_id, id),
      FOREIGN KEY (company_id, voucher_id) REFERENCES voucher(company_id, id)
    );
    CREATE INDEX refund_vouchers_payment_idx ON refund_vouchers(company_id, payment_id);
    CREATE INDEX refund_vouchers_voucher_idx ON refund_vouchers(company_id, voucher_id) WHERE voucher_id IS NOT NULL;

    -- What a bill took of an advance and what was refunded can never come to more than the advance.
    -- Checked when the transaction ends; the advance's row is locked so two uses are checked in turn.
    CREATE FUNCTION advance_not_overused() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
    DECLARE
      received bigint;
      used bigint;
    BEGIN
      SELECT amount_paise INTO received FROM advance_receipts WHERE id = NEW.advance_id FOR UPDATE;
      SELECT COALESCE((SELECT amount_paise FROM advance_applications WHERE advance_id = NEW.advance_id), 0)
           + COALESCE((SELECT amount_paise FROM refund_vouchers WHERE advance_id = NEW.advance_id), 0) INTO used;
      IF received IS NULL OR used > received THEN
        RAISE EXCEPTION 'More of this advance has been used and refunded than was received.'
          USING ERRCODE = 'check_violation', TABLE = TG_TABLE_NAME, CONSTRAINT = 'advance_not_overused';
      END IF;
      RETURN NULL;
    END;
    $$;
    CREATE CONSTRAINT TRIGGER advance_applications_not_overused AFTER INSERT ON advance_applications
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION advance_not_overused();
    CREATE CONSTRAINT TRIGGER refund_vouchers_not_overused AFTER INSERT ON refund_vouchers
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION advance_not_overused();

    -- Issue #368: money records are final when written. A payment can only be reversed; an
    -- allocation can only be released.
    ${frozen('payments', 'state', 'allocated_paise,cheque_state,reversal_voucher_id,reversal_reason,updated_at,version', 'RECORDED>REVERSED')}
    ${frozen('cheque_events')}
    ${frozen('payment_allocations', '', 'released_at,updated_at')}
    ${frozen('advance_receipts', '', 'updated_at,version')}
    ${frozen('advance_tax_lines')}
    ${frozen('advance_applications')}
    ${frozen('refund_vouchers')}
    CREATE TRIGGER document_settlements_frozen BEFORE UPDATE OR DELETE ON document_settlements
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('', '*', 'allocated_paise,credited_paise,cancelled,status,updated_at', '');
    CREATE TRIGGER document_settlements_no_truncate BEFORE TRUNCATE ON document_settlements
      FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();
    ${linesAddUp('advance_receipts', 'advance_tax_lines', 'advance_id', '', '*', 'true')}

    ${TABLES.map(tenantPolicy).join('')}

    -- The application records and reverses payments; the two running figures are the database's.
    REVOKE UPDATE ON payments, document_settlements FROM invoice_app;
    GRANT UPDATE (cheque_state, state, reversal_voucher_id, reversal_reason, updated_at, version) ON payments TO invoice_app;
    GRANT UPDATE (cancelled, updated_at) ON document_settlements TO invoice_app;
    REVOKE INSERT ON document_settlements FROM invoice_app;
    GRANT INSERT (id, company_id, document_kind, document_id, document_number, party_id, side, document_date, due_date, value_paise) ON document_settlements TO invoice_app;
    REVOKE INSERT ON payments FROM invoice_app;
    GRANT INSERT (id, company_id, branch_id, direction, party_id, mode, amount_paise, payment_date, reference, bank_account_code, refund_of,
      advance_to_supplier, advance_purchase_order_number, advance_purchase_order_date, advance_supplier_receipt_number, advance_supplier_receipt_date,
      cheque_number, cheque_date, cheque_bank_name, cheque_state, state, voucher_id, reversal_voucher_id, reversal_reason, narration,
      recorded_by, recorded_at, idempotency_key, version, origin, device_issued_at) ON payments TO invoice_app;
  `,
  down: `
    DROP TABLE IF EXISTS refund_vouchers, advance_applications, advance_tax_lines, advance_receipts, payment_allocations, document_settlements, cheque_events, payments;
    DROP TRIGGER IF EXISTS return_notes_reduce_bill ON return_notes;
    DROP FUNCTION IF EXISTS advance_not_overused(), payment_allocation_moves_balances(), credit_note_reduces_bill(), document_settlement_matches_bill();
  `,
}, {
  // Issue #367 — what is paid back out of a receipt counts against it, in the database. A refund and
  // an allocation of one receipt made at the same moment each passed the service's own check, and
  // together used more than the receipt (found by the independent review of #367).
  id: '20261016T013758641Z_receivables_2abb8324563c_refunds_count_against_the_receipt',
  up: `
    -- payments may now also change refunded_paise, the database's own figure.
    DROP TRIGGER payments_frozen ON payments;
    ${frozen('payments', 'state', 'allocated_paise,refunded_paise,cheque_state,reversal_voucher_id,reversal_reason,updated_at,version', 'RECORDED>REVERSED').replace(/\n\s*CREATE TRIGGER payments_no_truncate[\s\S]*$/, '')}
    ALTER TABLE payments ADD COLUMN refunded_paise bigint NOT NULL DEFAULT 0;
    -- Refunds recorded before this change. Row-level security is lifted for the owner only while the
    -- figure is worked out, so it sees every company's rows.
    ALTER TABLE payments NO FORCE ROW LEVEL SECURITY;
    UPDATE payments p SET refunded_paise = r.total
      FROM (SELECT company_id, refund_of, sum(amount_paise) AS total FROM payments WHERE refund_of IS NOT NULL AND state = 'RECORDED' GROUP BY company_id, refund_of) r
     WHERE p.company_id = r.company_id AND p.id = r.refund_of;
    ALTER TABLE payments FORCE ROW LEVEL SECURITY;
    -- What bills took of a receipt and what was paid back out of it never come to more than it.
    ALTER TABLE payments ADD CONSTRAINT payments_refunded_within_amount CHECK (refunded_paise >= 0 AND allocated_paise + refunded_paise <= amount_paise);

    -- A refund moves the figure on the receipt it pays back out of; undoing the refund moves it back.
    -- The UPDATE waits for, and re-reads, a receipt another transaction is changing, so the CHECK
    -- above judges the latest figure.
    CREATE FUNCTION payment_refund_moves_receipt() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
    BEGIN
      UPDATE payments SET refunded_paise = refunded_paise + CASE WHEN TG_OP = 'INSERT' THEN NEW.amount_paise ELSE -NEW.amount_paise END
        WHERE company_id = NEW.company_id AND id = NEW.refund_of;
      RETURN NULL;
    END;
    $$;
    CREATE TRIGGER payments_refund_recorded AFTER INSERT ON payments
      FOR EACH ROW WHEN (NEW.refund_of IS NOT NULL AND NEW.state = 'RECORDED') EXECUTE FUNCTION payment_refund_moves_receipt();
    CREATE TRIGGER payments_refund_reversed AFTER UPDATE OF state ON payments
      FOR EACH ROW WHEN (NEW.refund_of IS NOT NULL AND OLD.state = 'RECORDED' AND NEW.state = 'REVERSED') EXECUTE FUNCTION payment_refund_moves_receipt();
  `,
  down: `
    DROP TRIGGER IF EXISTS payments_refund_reversed ON payments;
    DROP TRIGGER IF EXISTS payments_refund_recorded ON payments;
    DROP FUNCTION IF EXISTS payment_refund_moves_receipt();
    ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_refunded_within_amount;
    DROP TRIGGER payments_frozen ON payments;
    ${frozen('payments', 'state', 'allocated_paise,cheque_state,reversal_voucher_id,reversal_reason,updated_at,version', 'RECORDED>REVERSED').replace(/\n\s*CREATE TRIGGER payments_no_truncate[\s\S]*$/, '')}
    ALTER TABLE payments DROP COLUMN IF EXISTS refunded_paise;
  `,
}, {
  // Issue #295 — the non-cash ways a bill on a receipt is settled: TDS the customer deducted, a
  // discount allowed, or a small balance written off. Like allocations, each is its own row the
  // database moves a running figure for — `document_settlements.adjusted_paise` — and can only be
  // released, never changed. Settlements do not touch `payments.allocated_paise`: that figure
  // stays money only, so a receipt's cash is never said to be more than it was.
  id: '20261026T001107193Z_receivables_b047ad5f0e27_payment_settlements',
  up: `
    CREATE TABLE payment_settlements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES companies(id),
      payment_id uuid NOT NULL,
      document_kind text NOT NULL CHECK (document_kind IN (${DOCUMENT_KINDS})),
      document_id text NOT NULL CHECK (document_id <> ''),
      document_number text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('TDS_DEDUCTED','DISCOUNT_ALLOWED','BALANCE_WRITTEN_OFF')),
      amount_paise bigint NOT NULL CHECK (amount_paise > 0),
      -- TDS only: the Income-tax Act section (194C/194J/194Q, or the Income-tax Act 2025's
      -- s.392/393 from 1 April 2026), the quarter it counts in for Form 26AS, and the certificate.
      tds_section text,
      tds_quarter text,
      tds_certificate text,
      released_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (company_id, payment_id) REFERENCES payments(company_id, id)
    );
    CREATE INDEX payment_settlements_payment_idx ON payment_settlements(company_id, payment_id);
    CREATE INDEX payment_settlements_document_idx ON payment_settlements(company_id, document_kind, document_id) WHERE released_at IS NULL;
    CREATE INDEX payment_settlements_tds_idx ON payment_settlements(company_id, tds_quarter) WHERE kind = 'TDS_DEDUCTED' AND released_at IS NULL;

    -- What TDS, a discount or a write-off settled on a bill is kept by the database like the paid
    -- figure, so money plus adjustments on one bill never come to more than it still owes.
    ALTER TABLE document_settlements ADD COLUMN adjusted_paise bigint NOT NULL DEFAULT 0 CHECK (adjusted_paise >= 0);
    ALTER TABLE document_settlements DROP CONSTRAINT document_settlements_allocated_within_value,
      ADD CONSTRAINT document_settlements_allocated_within_value CHECK (allocated_paise + adjusted_paise BETWEEN 0 AND value_paise + debited_paise);
    -- PostgreSQL 16 cannot change a generated column's expression: the column (and its two
    -- indexes) is made again. Adjusted counts toward SETTLED and PARTLY_PAID, as allocated does.
    ALTER TABLE document_settlements DROP COLUMN status;
    ALTER TABLE document_settlements ADD COLUMN status text NOT NULL GENERATED ALWAYS AS (CASE
        WHEN cancelled THEN 'CANCELLED'
        WHEN allocated_paise + adjusted_paise >= value_paise - credited_paise + debited_paise THEN 'SETTLED'
        WHEN allocated_paise + adjusted_paise > 0 THEN 'PARTLY_PAID'
        ELSE 'OPEN' END) STORED;
    CREATE INDEX document_settlements_open_idx ON document_settlements(company_id, party_id, document_date) WHERE status IN ('OPEN','PARTLY_PAID');
    CREATE INDEX document_settlements_due_idx ON document_settlements(company_id, due_date) WHERE status IN ('OPEN','PARTLY_PAID');
    DROP TRIGGER document_settlements_frozen ON document_settlements;
    CREATE TRIGGER document_settlements_frozen BEFORE UPDATE OR DELETE ON document_settlements
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('', '*', 'allocated_paise,credited_paise,debited_paise,adjusted_paise,cancelled,status,updated_at', '');

    -- Recording a settlement moves the adjusted figure; releasing it moves it back. The CHECK on
    -- document_settlements refuses one that is too large.
    CREATE FUNCTION payment_settlement_moves_balances() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
    DECLARE
      change bigint := CASE WHEN TG_OP = 'INSERT' THEN NEW.amount_paise ELSE -NEW.amount_paise END;
      settled integer;
      live text;
    BEGIN
      IF TG_OP = 'INSERT' AND NEW.released_at IS NOT NULL THEN
        RAISE EXCEPTION 'A settlement is recorded first and released later.' USING ERRCODE = 'check_violation', TABLE = 'payment_settlements';
      END IF;
      SELECT state INTO live FROM payments WHERE company_id = NEW.company_id AND id = NEW.payment_id;
      IF live IS DISTINCT FROM 'RECORDED' THEN
        RAISE EXCEPTION 'A payment that was undone settles nothing.'
          USING ERRCODE = 'check_violation', TABLE = 'payment_settlements', CONSTRAINT = 'payment_settlements_payment_is_live';
      END IF;
      UPDATE document_settlements SET adjusted_paise = adjusted_paise + change, updated_at = now()
        WHERE company_id = NEW.company_id AND document_kind = NEW.document_kind AND document_id = NEW.document_id;
      GET DIAGNOSTICS settled = ROW_COUNT;
      IF settled = 0 AND NEW.document_kind = 'SALES_INVOICE' THEN
        RAISE EXCEPTION 'A settlement cannot be applied to a bill that was never issued.'
          USING ERRCODE = 'foreign_key_violation', TABLE = 'payment_settlements', CONSTRAINT = 'payment_settlements_bill_is_issued';
      END IF;
      RETURN NULL;
    END;
    $$;
    CREATE TRIGGER payment_settlements_recorded AFTER INSERT ON payment_settlements
      FOR EACH ROW EXECUTE FUNCTION payment_settlement_moves_balances();
    CREATE TRIGGER payment_settlements_released AFTER UPDATE OF released_at ON payment_settlements
      FOR EACH ROW WHEN (OLD.released_at IS NULL AND NEW.released_at IS NOT NULL) EXECUTE FUNCTION payment_settlement_moves_balances();
    CREATE TRIGGER payment_settlements_release_final BEFORE UPDATE ON payment_settlements
      FOR EACH ROW WHEN (OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at)
      EXECUTE FUNCTION platform_refuse('A settlement that was released cannot be brought back. Record a new one.');

    ${frozen('payment_settlements', '', 'released_at,updated_at')}
    ${tenantPolicy('payment_settlements')}
    REVOKE UPDATE ON payment_settlements FROM invoice_app;
    GRANT UPDATE (released_at, updated_at) ON payment_settlements TO invoice_app;
    REVOKE INSERT ON payment_settlements FROM invoice_app;
    GRANT INSERT (id, company_id, payment_id, document_kind, document_id, document_number, kind, amount_paise, tds_section, tds_quarter, tds_certificate, released_at, created_at, updated_at) ON payment_settlements TO invoice_app;
  `,
  down: `
    DROP TABLE IF EXISTS payment_settlements;
    DROP FUNCTION IF EXISTS payment_settlement_moves_balances();
    DROP TRIGGER document_settlements_frozen ON document_settlements;
    CREATE TRIGGER document_settlements_frozen BEFORE UPDATE OR DELETE ON document_settlements
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('', '*', 'allocated_paise,credited_paise,debited_paise,cancelled,status,updated_at', '');
    ALTER TABLE document_settlements DROP COLUMN status;
    ALTER TABLE document_settlements ADD COLUMN status text NOT NULL GENERATED ALWAYS AS (CASE
        WHEN cancelled THEN 'CANCELLED'
        WHEN allocated_paise >= value_paise - credited_paise + debited_paise THEN 'SETTLED'
        WHEN allocated_paise > 0 THEN 'PARTLY_PAID'
        ELSE 'OPEN' END) STORED;
    CREATE INDEX document_settlements_open_idx ON document_settlements(company_id, party_id, document_date) WHERE status IN ('OPEN','PARTLY_PAID');
    CREATE INDEX document_settlements_due_idx ON document_settlements(company_id, due_date) WHERE status IN ('OPEN','PARTLY_PAID');
    ALTER TABLE document_settlements DROP CONSTRAINT document_settlements_allocated_within_value,
      ADD CONSTRAINT document_settlements_allocated_within_value CHECK (allocated_paise BETWEEN 0 AND value_paise + debited_paise);
    ALTER TABLE document_settlements DROP COLUMN IF EXISTS adjusted_paise;
  `,
}]);
