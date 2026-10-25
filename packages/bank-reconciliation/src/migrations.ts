import type { Migration } from '../../platform/src/migration-definitions.ts';

/**
 * Issue #366 — bank reconciliation on PostgreSQL. Candidates and audit events are final when written;
 * a match may only be undone, once, with who, when and why (docs/contracts/database-immutability-v1.md).
 */
export const bankReconciliationMigrations: readonly Migration[] = [{
  id: '20261023T013253095Z_bank-reconciliation_9fba03bc5c95_persist_matches_audit',
  up: `
    CREATE TABLE bank_reconciliation_candidates (
      company_id uuid NOT NULL REFERENCES companies(id), id text NOT NULL,
      bank_transaction_ids text[] NOT NULL, payment_ids text[] NOT NULL,
      confidence integer NOT NULL CHECK (confidence BETWEEN 0 AND 100),
      amount_difference_paise bigint NOT NULL CHECK (amount_difference_paise >= 0),
      reasons jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (company_id, id));
    CREATE TABLE bank_reconciliation_matches (
      id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), candidate_id text NOT NULL,
      bank_transaction_ids text[] NOT NULL, payment_ids text[] NOT NULL,
      confidence integer NOT NULL CHECK (confidence BETWEEN 0 AND 100),
      amount_difference_paise bigint NOT NULL CHECK (amount_difference_paise >= 0), reasons jsonb NOT NULL,
      status text NOT NULL CHECK (status IN ('AUTO_MATCHED', 'CONFIRMED', 'UNMATCHED')),
      remaining_bank_paise bigint NOT NULL, remaining_book_paise bigint NOT NULL,
      confirmed_by text, confirmed_at timestamptz, matched_at timestamptz NOT NULL DEFAULT now(),
      unmatched_at timestamptz, unmatched_by text, unmatch_reason text,
      CHECK ((status = 'UNMATCHED') = (unmatched_at IS NOT NULL AND unmatched_by IS NOT NULL AND btrim(coalesce(unmatch_reason, '')) <> '')),
      UNIQUE (company_id, id),
      FOREIGN KEY (company_id, candidate_id) REFERENCES bank_reconciliation_candidates(company_id, id));
    CREATE INDEX bank_reconciliation_matches_active_banks ON bank_reconciliation_matches USING gin (bank_transaction_ids) WHERE status <> 'UNMATCHED';
    CREATE INDEX bank_reconciliation_matches_active_payments ON bank_reconciliation_matches USING gin (payment_ids) WHERE status <> 'UNMATCHED';
    CREATE INDEX bank_reconciliation_matches_undone ON bank_reconciliation_matches(company_id, candidate_id) WHERE status = 'UNMATCHED';
    CREATE TABLE bank_reconciliation_events (
      id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), actor_id text NOT NULL,
      action text NOT NULL CHECK (action IN ('reconciliation.auto_matched', 'reconciliation.confirmed', 'reconciliation.unmatched')),
      match_id uuid NOT NULL, occurred_at timestamptz NOT NULL, reason text,
      seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      FOREIGN KEY (company_id, match_id) REFERENCES bank_reconciliation_matches(company_id, id));
    CREATE INDEX bank_reconciliation_events_match ON bank_reconciliation_events(company_id, match_id, seq);
    ALTER TABLE bank_reconciliation_candidates ENABLE ROW LEVEL SECURITY;
    ALTER TABLE bank_reconciliation_candidates FORCE ROW LEVEL SECURITY;
    ALTER TABLE bank_reconciliation_matches ENABLE ROW LEVEL SECURITY;
    ALTER TABLE bank_reconciliation_matches FORCE ROW LEVEL SECURITY;
    ALTER TABLE bank_reconciliation_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE bank_reconciliation_events FORCE ROW LEVEL SECURITY;
    CREATE POLICY bank_reconciliation_candidates_tenant ON bank_reconciliation_candidates USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    CREATE POLICY bank_reconciliation_matches_tenant ON bank_reconciliation_matches USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    CREATE POLICY bank_reconciliation_events_tenant ON bank_reconciliation_events USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    CREATE FUNCTION bank_reconciliation_unmatched_once() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
    BEGIN
      IF OLD.status = 'UNMATCHED' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
        RAISE EXCEPTION 'An undone bank match stays undone; confirm a new match instead.' USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME, COLUMN = 'status';
      END IF;
      RETURN NEW;
    END $$;
    CREATE FUNCTION bank_reconciliation_line_matched_once() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('bank-reconciliation:' || NEW.company_id::text, 0));
      IF EXISTS (SELECT 1 FROM bank_reconciliation_matches m
                  WHERE m.company_id = NEW.company_id AND m.status <> 'UNMATCHED' AND m.id <> NEW.id
                    AND (m.bank_transaction_ids && NEW.bank_transaction_ids OR m.payment_ids && NEW.payment_ids)) THEN
        RAISE EXCEPTION 'This bank line or book entry is already matched; undo that match first.' USING ERRCODE = 'unique_violation', TABLE = TG_TABLE_NAME;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER bank_reconciliation_matches_line_once BEFORE INSERT ON bank_reconciliation_matches FOR EACH ROW EXECUTE FUNCTION bank_reconciliation_line_matched_once();
    CREATE TRIGGER bank_reconciliation_candidates_frozen BEFORE UPDATE OR DELETE ON bank_reconciliation_candidates FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('', '*', '', '');
    CREATE TRIGGER bank_reconciliation_events_frozen BEFORE UPDATE OR DELETE ON bank_reconciliation_events FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('', '*', '', '');
    CREATE TRIGGER bank_reconciliation_matches_frozen BEFORE UPDATE OR DELETE ON bank_reconciliation_matches FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('status', '*', 'unmatched_at,unmatched_by,unmatch_reason', 'AUTO_MATCHED>UNMATCHED,CONFIRMED>UNMATCHED');
    CREATE TRIGGER bank_reconciliation_matches_unmatched_once BEFORE UPDATE ON bank_reconciliation_matches FOR EACH ROW EXECUTE FUNCTION bank_reconciliation_unmatched_once();
    CREATE TRIGGER bank_reconciliation_candidates_no_truncate BEFORE TRUNCATE ON bank_reconciliation_candidates FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();
    CREATE TRIGGER bank_reconciliation_matches_no_truncate BEFORE TRUNCATE ON bank_reconciliation_matches FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();
    CREATE TRIGGER bank_reconciliation_events_no_truncate BEFORE TRUNCATE ON bank_reconciliation_events FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();
    GRANT SELECT, INSERT, UPDATE ON bank_reconciliation_candidates, bank_reconciliation_matches, bank_reconciliation_events TO invoice_app;
    REVOKE DELETE ON bank_reconciliation_candidates, bank_reconciliation_matches, bank_reconciliation_events FROM invoice_app;
  `,
  down: `
    DROP TABLE IF EXISTS bank_reconciliation_events;
    DROP TABLE IF EXISTS bank_reconciliation_matches;
    DROP TABLE IF EXISTS bank_reconciliation_candidates;
    DROP FUNCTION IF EXISTS bank_reconciliation_unmatched_once();
    DROP FUNCTION IF EXISTS bank_reconciliation_line_matched_once();
  `,
}];
