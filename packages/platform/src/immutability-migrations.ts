/**
 * Issue #368 — "posted records never change" as a database rule, and the application's
 * least-privilege role. Contract: docs/contracts/database-immutability-v1.md.
 *
 * `platform_freeze_posted` is one trigger function for every document table. Its arguments say
 * which column holds the status, which statuses freeze the row, which columns may still change
 * after that (cancellation and reversal bookkeeping), and which status moves a frozen row may
 * make. Everything else on a frozen row, any other status move, and the row's existence, is
 * refused by the database. `FROZEN` below is the whole list; a new document table adds one line to
 * its own migration with the same function.
 *
 * The status moves matter as much as the columns: if a frozen row could go back to a draft status,
 * its figures could be edited there and the row moved forward again.
 */
import type { Migration } from "./migration-definitions.ts";

/**
 * table, status column ('' = none), frozen statuses ('*' = frozen from the moment it is written),
 * columns that may still change, and the status moves a frozen row may make ("FROM>TO", or "*>TO"
 * from any frozen status). Each line was checked against the module's own service.
 */
export const FROZEN: readonly (readonly [table: string, statusColumn: string, frozenWhen: string, mayChange: string, moves: string])[] = [
  // The audit trail and the platform's own records.
  ["audit_events", "", "*", "", ""],
  ["command_records", "status", "*", "", "draft>submitted,draft>cancelled,submitted>approved,submitted>rejected,submitted>cancelled,approved>finalised,approved>failed,approved>cancelled,failed>submitted,failed>cancelled"],
  ["idempotency_keys", "", "*", "", ""],
  ["idempotency_record", "", "*", "", ""],
  ["exception_comments", "", "*", "", ""],
  // The ledger (#4). Its own triggers guard the figures; this adds that a finished entry never goes
  // back to DRAFT, where its lines could be rewritten, and that nothing but the reversal marks changes.
  ["voucher", "state", "FINAL,REVERSED", "reversed_by_voucher_id,reason", "FINAL>REVERSED"],
  // Purchase bills exist only as POSTED or REVERSED; a reversal is the one change, and it is not undone (#17).
  ["purchase_bills", "state", "*", "reversed_by_voucher_id,reversal_reason,summary", "POSTED>REVERSED"],
  ["purchase_bill_lines", "", "*", "", ""],
  ["purchase_bill_receipts", "", "*", "", ""],
  ["purchase_match_approvals", "", "*", "", ""],
  // A confirmed goods receipt can only be cancelled; what it moved into stock stays on record (#18).
  ["goods_receipts", "state", "CONFIRMED,CANCELLED", "cancelled_reason,summary", "CONFIRMED>CANCELLED"],
  ["goods_receipt_movements", "", "*", "", ""],
  // Credit and debit notes are posted when written; only the supplier's own credit-note reference is filled in later (#45).
  ["return_notes", "", "*", "supplier_credit_note_number,supplier_credit_note_date", ""],
  ["return_note_lines", "", "*", "", ""],
  // A registered e-invoice keeps its IRN, acknowledgement number and date, signed QR code and document
  // particulars for good. It can be cancelled, and a reconcile with the portal can find a cancellation
  // did not go through; it never goes back to pending (#26).
  ["e_invoices", "status", "REGISTERED,CANCELLED", "cancelled_at,cancel_reason_code,cancel_reason,message,updated_at,eway_bill_number,signed_invoice,provider_request_id,acknowledged_at,cancellable_until", "REGISTERED>CANCELLED,CANCELLED>REGISTERED"],
  // An e-way bill with a government number keeps that number, its document, value and route. Vehicle,
  // transporter, validity, cancellation, rejection and the portal's latest answer may still change.
  // FAILED is reachable because a reconcile can find the portal has no such bill (#27); see the contract.
  ["eway_bills", "status", "PART_A_ONLY,ACTIVE,EXPIRED,CANCELLED,REJECTED", "vehicle_legs,transporter,valid_until,consolidated_trip_number,alert,cancelled_at,cancel_reason_code,cancel_reason,rejected_at,reject_reason_code,message,updated_at,generated_at,provider_request_id,failure_code,failure_message,failure_retryable", "*>PART_A_ONLY,*>ACTIVE,*>EXPIRED,*>CANCELLED,*>REJECTED,*>FAILED"],
  ["eway_consolidated_trips", "", "*", "", ""],
  // ITC decisions and claims are a history: a change of mind is a new row (#31).
  ["itc_decisions", "", "*", "", ""],
  ["itc_claims", "", "*", "", ""],
  ["itc_import_batches", "", "*", "", ""],
  // An approved GST return keeps the figures that were approved. It can be reopened to DRAFT — never once it is filed (#30).
  ["gst_return_preparations", "state", "APPROVED,EXPORTED,SUBMITTING,FILED,SUBMISSION_FAILED", "exported_at,version", "APPROVED>EXPORTED,APPROVED>SUBMITTING,EXPORTED>SUBMITTING,SUBMITTING>FILED,SUBMITTING>SUBMISSION_FAILED,SUBMISSION_FAILED>SUBMITTING,APPROVED>DRAFT,EXPORTED>DRAFT,SUBMITTING>DRAFT,SUBMISSION_FAILED>DRAFT"],
  ["gst_return_approvals", "", "*", "withdrawn_at,withdrawn_by,withdrawn_reason", ""],
  ["gst_return_submissions", "outcome", "ACCEPTED", "", ""],
  // Our own invoice to the business for its plan: the amounts never change once issued, and it never goes back to a draft.
  ["subscription_service_invoices", "state", "ISSUED,PAID,FAILED", "paid_on,provider_reference,failure_reason", "*>PAID,*>FAILED"],
  // Accepted supplier-risk warnings and the evidence they were accepted on (#19).
  ["supplier_risk_assessments", "", "*", "", ""],
  ["supplier_risk_acknowledgements", "", "*", "", ""],
];

/** Lines that cannot be changed, removed or moved to another parent once their parent is frozen: child table, its foreign key, parent table, parent status column, frozen statuses. */
export const FROZEN_WITH_PARENT: readonly (readonly [child: string, foreignKey: string, parent: string, statusColumn: string, frozenWhen: string])[] = [
  ["goods_receipt_lines", "receipt_id", "goods_receipts", "state", "CONFIRMED,CANCELLED"],
  ["journal_line", "voucher_id", "voucher", "state", "FINAL,REVERSED"],
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
    CREATE FUNCTION platform_freeze_posted() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
    DECLARE
      status_column text := TG_ARGV[0];
      may_change text[] := string_to_array(COALESCE(TG_ARGV[2], ''), ',');
      moves text[] := string_to_array(COALESCE(TG_ARGV[3], ''), ',');
      was jsonb := to_jsonb(OLD);
      old_status text;
      new_status text;
      changed text;
    BEGIN
      IF status_column <> '' THEN
        old_status := was ->> status_column;
      END IF;
      -- A status that is missing or unknown is treated as frozen: the rule fails closed.
      IF TG_ARGV[1] <> '*' AND old_status IS NOT NULL AND NOT (old_status = ANY (string_to_array(TG_ARGV[1], ','))) THEN
        RETURN COALESCE(NEW, OLD);
      END IF;
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'A finished record is never deleted. Correct it with a reversal or a note instead.'
          USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME;
      END IF;
      IF status_column <> '' THEN
        new_status := to_jsonb(NEW) ->> status_column;
        IF new_status IS DISTINCT FROM old_status
           AND NOT COALESCE((old_status || '>' || new_status) = ANY (moves) OR ('*>' || new_status) = ANY (moves), false) THEN
          RAISE EXCEPTION 'A finished record cannot go from % back to %.', old_status, COALESCE(new_status, 'nothing')
            USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME, COLUMN = status_column;
        END IF;
        may_change := may_change || status_column;
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

    -- The parent is looked up by its full name, and pg_temp is searched last, so a temporary table
    -- with the parent's name cannot stand in for it.
    CREATE FUNCTION platform_freeze_with_parent() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
    DECLARE
      parent_ids text[] := ARRAY[to_jsonb(OLD) ->> TG_ARGV[0]];
      parent_id text;
      parent_status text;
    BEGIN
      -- A line moved to another parent is checked against both: it can neither leave a finished record nor join one.
      IF TG_OP = 'UPDATE' THEN
        parent_ids := parent_ids || (to_jsonb(NEW) ->> TG_ARGV[0]);
      END IF;
      FOREACH parent_id IN ARRAY parent_ids LOOP
        EXECUTE format('SELECT %I::text FROM %I.%I WHERE id = $1::uuid', TG_ARGV[2], TG_TABLE_SCHEMA, TG_ARGV[1])
          INTO parent_status USING parent_id;
        -- A parent that cannot be seen is treated as finished: the rule fails closed.
        IF parent_status IS NULL OR parent_status = ANY (string_to_array(TG_ARGV[3], ',')) THEN
          RAISE EXCEPTION 'The lines of a finished record cannot be changed or removed.'
            USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME;
        END IF;
      END LOOP;
      RETURN COALESCE(NEW, OLD);
    END;
    $$;

    CREATE FUNCTION platform_no_truncate() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
    BEGIN
      RAISE EXCEPTION 'Records in this table are never emptied.' USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME;
    END;
    $$;

    -- Ending a session, and accepting or withdrawing an invitation, are final: once the date is set it is not cleared or moved.
    CREATE FUNCTION platform_refuse() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
    BEGIN
      RAISE EXCEPTION '%', TG_ARGV[0] USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME;
    END;
    $$;
    CREATE TRIGGER sessions_revocation_final BEFORE UPDATE ON sessions FOR EACH ROW
      WHEN (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
      EXECUTE FUNCTION platform_refuse('A session that was ended cannot be brought back.');
    CREATE TRIGGER invitations_decision_final BEFORE UPDATE ON invitations FOR EACH ROW
      WHEN ((OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) OR (OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS DISTINCT FROM OLD.accepted_at))
      EXECUTE FUNCTION platform_refuse('An invitation that was used or withdrawn cannot be opened again.');

    -- The ledger's own trigger functions (#4) named their tables without a schema and had no search
    -- path, so a temporary "voucher" or "journal_line" could stand in for the real one.
    ALTER FUNCTION ledger_voucher_immutable() SET search_path = pg_catalog, public, pg_temp;
    ALTER FUNCTION ledger_voucher_no_delete() SET search_path = pg_catalog, public, pg_temp;
    ALTER FUNCTION ledger_line_immutable() SET search_path = pg_catalog, public, pg_temp;
    ALTER FUNCTION ledger_voucher_balanced() SET search_path = pg_catalog, public, pg_temp;

    -- When each audit event reached the database, by the database's clock: the application cannot
    -- set it, back-date it or choose the event's place in the order (see the INSERT grant below).
    ALTER TABLE audit_events ADD COLUMN recorded_at timestamptz NOT NULL DEFAULT clock_timestamp();
    -- A session is found by the hash of its token, as an invitation is; the token itself is never stored.
    ALTER TABLE sessions ADD COLUMN token_hash text UNIQUE;
${FROZEN.map(([table, status, when, may, moves]) => `
    CREATE TRIGGER ${table}_frozen BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('${status}', '${when}', '${may}', '${moves}');
    CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table}
      FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();`).join("")}
${FROZEN_WITH_PARENT.map(([child, foreignKey, parent, status, when]) => `
    CREATE TRIGGER ${child}_frozen BEFORE UPDATE OR DELETE ON ${child}
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_with_parent('${foreignKey}', '${parent}', '${status}', '${when}');
    CREATE TRIGGER ${child}_no_truncate BEFORE TRUNCATE ON ${child}
      FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();`).join("")}
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
    -- No temporary tables: nothing in the application uses them, and they are how a table name is shadowed.
    DO $$ BEGIN EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database()); END $$;
    GRANT USAGE ON SCHEMA public TO invoice_app;
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO invoice_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO invoice_app;
    REVOKE INSERT, UPDATE ON schema_migrations FROM invoice_app;
    -- The audit trail: rows can be added, with the columns an event has. Not its order (seq) or the
    -- database's own record of when it arrived (recorded_at), and never changed.
    REVOKE INSERT, UPDATE ON audit_events FROM invoice_app;
    GRANT INSERT (id, company_id, actor_id, action, correlation_id, before_json, after_json, reason, occurred_at) ON audit_events TO invoice_app;
    -- Identity tables are read before the company is known, so no row-level policy can guard them.
    -- The application may therefore change only the columns its own work changes: it cannot extend
    -- or un-revoke a session, re-open an invitation, or change the address a person signs in with.
    REVOKE UPDATE ON sessions, invitations, users, companies, branches FROM invoice_app;
    GRANT UPDATE (revoked_at) ON sessions TO invoice_app;
    GRANT UPDATE (accepted_at, revoked_at) ON invitations TO invoice_app;
    GRANT UPDATE (display_name, active) ON users TO invoice_app;
    GRANT UPDATE (legal_name) ON companies TO invoice_app;
    GRANT UPDATE (name) ON branches TO invoice_app;
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
${[...FROZEN.map(([table]) => table), ...FROZEN_WITH_PARENT.map(([child]) => child)].map((table) => `
    DROP TRIGGER IF EXISTS ${table}_no_truncate ON ${table};
    DROP TRIGGER IF EXISTS ${table}_frozen ON ${table};`).join("")}
    DROP TRIGGER IF EXISTS invitations_decision_final ON invitations;
    DROP TRIGGER IF EXISTS sessions_revocation_final ON sessions;
    DROP FUNCTION IF EXISTS platform_refuse();
    ALTER TABLE sessions DROP COLUMN IF EXISTS token_hash;
    ALTER TABLE audit_events DROP COLUMN IF EXISTS recorded_at;
    ALTER FUNCTION ledger_voucher_balanced() RESET search_path;
    ALTER FUNCTION ledger_line_immutable() RESET search_path;
    ALTER FUNCTION ledger_voucher_no_delete() RESET search_path;
    ALTER FUNCTION ledger_voucher_immutable() RESET search_path;
    DO $$ BEGIN EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO PUBLIC', current_database()); END $$;
    DROP FUNCTION IF EXISTS platform_no_truncate();
    DROP FUNCTION IF EXISTS platform_freeze_with_parent();
    DROP FUNCTION IF EXISTS platform_freeze_posted();
  `,
}];
