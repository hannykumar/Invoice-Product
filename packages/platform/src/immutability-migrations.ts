/**
 * Issue #368 — "posted records never change" as a database rule, and the application's
 * least-privilege role. Contract: docs/contracts/database-immutability-v1.md.
 *
 * `platform_freeze_posted` is one trigger function for every document table. Its arguments say
 * which column holds the status, which statuses freeze the row, and which columns may still change
 * after that (the lifecycle: status moves, cancellation and reversal bookkeeping). Everything else
 * on a frozen row, and the row's existence, is refused by the database — for every role, including
 * the owner. `FROZEN` below is the whole list; a new document table adds one line to its own
 * migration with the same function.
 */
import type { Migration } from "./migration-definitions.ts";

/** table, status column ('' = frozen from the moment it is written), frozen statuses, columns that may still change. */
export const FROZEN: readonly (readonly [table: string, statusColumn: string, frozenWhen: string, mayChange: string])[] = [
  // The audit trail and the platform's own records.
  ["audit_events", "", "", ""],
  ["command_records", "", "", "status"],
  ["idempotency_keys", "", "", ""],
  ["idempotency_record", "", "", ""],
  ["exception_comments", "", "", ""],
  // Purchase bills exist only as POSTED or REVERSED; a reversal is the one change (#17).
  ["purchase_bills", "", "", "state,reversed_by_voucher_id,reversal_reason,summary"],
  ["purchase_bill_lines", "", "", ""],
  ["purchase_bill_receipts", "", "", ""],
  ["purchase_match_approvals", "", "", ""],
  // A confirmed goods receipt can only be cancelled; what it moved into stock stays on record (#18).
  ["goods_receipts", "state", "CONFIRMED,CANCELLED", "state,cancelled_reason,summary"],
  ["goods_receipt_movements", "", "", ""],
  // Credit and debit notes are posted when written; only the supplier's own credit-note reference is filled in later (#45).
  ["return_notes", "", "", "supplier_credit_note_number,supplier_credit_note_date"],
  ["return_note_lines", "", "", ""],
  // A registered e-invoice keeps its IRN, acknowledgement number and date, signed QR code and document
  // particulars for good. Cancellation, and what a reconcile with the portal refreshes, may still change (#26).
  ["e_invoices", "status", "REGISTERED,CANCELLED", "status,cancelled_at,cancel_reason_code,cancel_reason,message,updated_at,eway_bill_number,signed_invoice,provider_request_id,acknowledged_at,cancellable_until"],
  // An e-way bill with a government number keeps that number, its document, value and route. Vehicle,
  // transporter, validity, cancellation, rejection and the portal's latest answer may still change (#27).
  ["eway_bills", "status", "PART_A_ONLY,ACTIVE,EXPIRED,CANCELLED,REJECTED", "status,vehicle_legs,transporter,valid_until,consolidated_trip_number,alert,cancelled_at,cancel_reason_code,cancel_reason,rejected_at,reject_reason_code,message,updated_at,generated_at,provider_request_id,failure_code,failure_message,failure_retryable"],
  ["eway_consolidated_trips", "", "", ""],
  // ITC decisions and claims are a history: a change of mind is a new row (#31).
  ["itc_decisions", "", "", ""],
  ["itc_claims", "", "", ""],
  ["itc_import_batches", "", "", ""],
  // An approved GST return keeps the figures that were approved; reopening it (never once filed) moves it back to DRAFT first (#30).
  ["gst_return_preparations", "state", "APPROVED,EXPORTED,SUBMITTING,FILED,SUBMISSION_FAILED", "state,exported_at,version"],
  ["gst_return_approvals", "", "", "withdrawn_at,withdrawn_by,withdrawn_reason"],
  ["gst_return_submissions", "outcome", "ACCEPTED", ""],
  // Our own invoice to the business for its plan: the amounts never change once issued.
  ["subscription_service_invoices", "state", "ISSUED,PAID,FAILED", "state,paid_on,provider_reference,failure_reason"],
  // Accepted supplier-risk warnings and the evidence they were accepted on (#19).
  ["supplier_risk_assessments", "", "", ""],
  ["supplier_risk_acknowledgements", "", "", ""],
];

/** Lines that cannot be changed or removed once their parent is frozen: child table, its foreign key, parent table, parent status column, frozen statuses. */
export const FROZEN_WITH_PARENT: readonly (readonly [child: string, foreignKey: string, parent: string, statusColumn: string, frozenWhen: string])[] = [
  ["goods_receipt_lines", "receipt_id", "goods_receipts", "state", "CONFIRMED,CANCELLED"],
];

/** Tenant tables of the platform core that now enforce row-level security. Identity tables looked up before the company is known (users, sessions, invitations) are not here. */
const PLATFORM_RLS = ["audit_events", "command_records", "idempotency_keys", "exception_items", "approval_policies", "memberships", "user_branch_access"] as const;

/** The only tables the application may delete from: none of them holds a financial or audit record. */
const APP_MAY_DELETE = ["user_branch_access"] as const;

const tenantPolicy = (table: string): string => `
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
    CREATE POLICY ${table}_tenant ON ${table}
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);`;

export const immutabilityMigrations: readonly Migration[] = [{
  id: "20261010T133847062Z_platform_cfc39c92b3aa_immutable_records_and_app_role",
  up: `
    CREATE FUNCTION platform_freeze_posted() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
    DECLARE
      status_column text := TG_ARGV[0];
      may_change text[] := string_to_array(COALESCE(TG_ARGV[2], ''), ',');
      was jsonb := to_jsonb(OLD);
      changed text;
    BEGIN
      IF status_column <> '' AND NOT ((was ->> status_column) = ANY (string_to_array(TG_ARGV[1], ','))) THEN
        RETURN COALESCE(NEW, OLD);
      END IF;
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'A finished record is never deleted. Correct it with a reversal or a note instead.'
          USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME;
      END IF;
      SELECT now_is.key INTO changed FROM jsonb_each(to_jsonb(NEW) - may_change) AS now_is
        WHERE now_is.value IS DISTINCT FROM (was -> now_is.key) ORDER BY now_is.key LIMIT 1;
      IF changed IS NOT NULL THEN
        RAISE EXCEPTION 'A finished record cannot be changed. Correct it with a reversal or a note instead.'
          USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME, COLUMN = changed;
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE FUNCTION platform_freeze_with_parent() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
    DECLARE
      parent_status text;
    BEGIN
      EXECUTE format('SELECT %I::text FROM %I WHERE id = ($1 ->> %L)::uuid', TG_ARGV[2], TG_ARGV[1], TG_ARGV[0])
        INTO parent_status USING to_jsonb(OLD);
      -- A parent that cannot be seen is treated as finished: the rule fails closed.
      IF parent_status IS NULL OR parent_status = ANY (string_to_array(TG_ARGV[3], ',')) THEN
        RAISE EXCEPTION 'The lines of a finished record cannot be changed or removed.'
          USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME;
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $$;

    CREATE FUNCTION platform_no_truncate() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
    BEGIN
      RAISE EXCEPTION 'Records in this table are never emptied.' USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME;
    END;
    $$;
${FROZEN.map(([table, status, when, may]) => `
    CREATE TRIGGER ${table}_frozen BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('${status}', '${when}', '${may}');
    CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table}
      FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();`).join("")}
${FROZEN_WITH_PARENT.map(([child, foreignKey, parent, status, when]) => `
    CREATE TRIGGER ${child}_frozen BEFORE UPDATE OR DELETE ON ${child}
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_with_parent('${foreignKey}', '${parent}', '${status}', '${when}');
    CREATE TRIGGER ${child}_no_truncate BEFORE TRUNCATE ON ${child}
      FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();`).join("")}
    CREATE TRIGGER voucher_no_truncate BEFORE TRUNCATE ON voucher FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();
    CREATE TRIGGER journal_line_no_truncate BEFORE TRUNCATE ON journal_line FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();
${PLATFORM_RLS.map(tenantPolicy).join("")}
    ALTER TABLE exception_comments ENABLE ROW LEVEL SECURITY;
    ALTER TABLE exception_comments FORCE ROW LEVEL SECURITY;
    CREATE POLICY exception_comments_tenant ON exception_comments
      USING (EXISTS (SELECT 1 FROM exception_items i WHERE i.id = exception_id))
      WITH CHECK (EXISTS (SELECT 1 FROM exception_items i WHERE i.id = exception_id));

    -- The application's role: not an owner, not a superuser, cannot bypass row-level security. It is
    -- a group with no login and no password; each deployment creates its own login as a member.
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'invoice_app') THEN
        CREATE ROLE invoice_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      END IF;
    END $$;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO invoice_app;
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO invoice_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO invoice_app;
    REVOKE INSERT, UPDATE ON schema_migrations FROM invoice_app;
    REVOKE UPDATE ON audit_events FROM invoice_app;
    GRANT DELETE ON ${APP_MAY_DELETE.join(", ")} TO invoice_app;
    -- Tables created by later migrations get the same: read, add and change, never delete or empty.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO invoice_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO invoice_app;
  `,
  down: `
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM invoice_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM invoice_app;
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM invoice_app;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM invoice_app;
    REVOKE ALL ON SCHEMA public FROM invoice_app;
    DROP POLICY IF EXISTS exception_comments_tenant ON exception_comments;
    ALTER TABLE exception_comments NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE exception_comments DISABLE ROW LEVEL SECURITY;
${PLATFORM_RLS.map((table) => `
    DROP POLICY IF EXISTS ${table}_tenant ON ${table};
    ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`).join("")}
    DROP TRIGGER IF EXISTS journal_line_no_truncate ON journal_line;
    DROP TRIGGER IF EXISTS voucher_no_truncate ON voucher;
${[...FROZEN.map(([table]) => table), ...FROZEN_WITH_PARENT.map(([child]) => child)].map((table) => `
    DROP TRIGGER IF EXISTS ${table}_no_truncate ON ${table};
    DROP TRIGGER IF EXISTS ${table}_frozen ON ${table};`).join("")}
    DROP FUNCTION IF EXISTS platform_no_truncate();
    DROP FUNCTION IF EXISTS platform_freeze_with_parent();
    DROP FUNCTION IF EXISTS platform_freeze_posted();
  `,
}];
