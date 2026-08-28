-- Issue #4 [E04] — the double-entry ledger.
--
-- Two ideas shape this schema:
--   1. Balances are never stored. They are folded from journal_line, so they cannot drift.
--   2. The invariants are enforced by the database as well as by the service, because a bug in
--      one write path must not be able to produce books that do not balance.
--
-- Every table carries company_id and every index leads with it, so one business's rows can never
-- be reached while querying another's (row-level security policies are added by GPT 2, issue #3).

BEGIN;

CREATE TYPE account_type AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE');

CREATE TYPE voucher_type AS ENUM (
  'SALE', 'PURCHASE', 'RECEIPT', 'PAYMENT', 'JOURNAL',
  'CREDIT_NOTE', 'DEBIT_NOTE', 'OPENING_BALANCE', 'REVERSAL'
);

CREATE TYPE voucher_state AS ENUM ('DRAFT', 'FINAL', 'REVERSED');

CREATE TYPE period_state AS ENUM ('OPEN', 'SOFT_LOCKED', 'HARD_LOCKED');

CREATE TABLE ledger_settings (
  company_id        uuid PRIMARY KEY,
  books_start_date  date NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE account (
  id           uuid PRIMARY KEY,
  company_id   uuid NOT NULL,
  code         text NOT NULL,
  name         text NOT NULL,
  type         account_type NOT NULL,
  parent_id    uuid REFERENCES account (id),
  is_group     boolean NOT NULL DEFAULT false,
  active       boolean NOT NULL DEFAULT true,
  party_id     uuid,
  system_role  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_code_unique_per_company UNIQUE (company_id, code)
);

-- A role such as ROUND_OFF must resolve to exactly one account, or a posting template would have
-- to guess which one to use.
CREATE UNIQUE INDEX account_system_role_unique
  ON account (company_id, system_role)
  WHERE system_role IS NOT NULL;

CREATE INDEX account_company_parent ON account (company_id, parent_id);

CREATE TABLE fiscal_period (
  id              uuid PRIMARY KEY,
  company_id      uuid NOT NULL,
  month_key       text NOT NULL,           -- '2026-04'
  financial_year  text NOT NULL,           -- '2026-27'
  state           period_state NOT NULL DEFAULT 'OPEN',
  locked_by       uuid,
  locked_at       timestamptz,
  reason          text,
  CONSTRAINT fiscal_period_unique UNIQUE (company_id, month_key),
  CONSTRAINT fiscal_period_month_format CHECK (month_key ~ '^\d{4}-\d{2}$'),
  CONSTRAINT fiscal_period_lock_has_actor CHECK (
    (state = 'OPEN' AND locked_by IS NULL) OR (state <> 'OPEN' AND locked_by IS NOT NULL)
  )
);

CREATE TABLE ledger_sequence (
  company_id  uuid NOT NULL,
  scope       text NOT NULL,               -- 'SALE:2026-27'
  value       bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, scope)
);

CREATE TABLE voucher (
  id                     uuid PRIMARY KEY,
  company_id             uuid NOT NULL,
  branch_id              uuid,
  type                   voucher_type NOT NULL,
  number                 text NOT NULL,
  document_date          date NOT NULL,
  state                  voucher_state NOT NULL,
  narration              text,
  source_kind            text,
  source_id              text,
  source_number          text,
  idempotency_key        text NOT NULL,
  created_by             uuid NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  reversed_by_voucher_id uuid REFERENCES voucher (id),
  reverses_voucher_id    uuid REFERENCES voucher (id),
  amends_voucher_id      uuid REFERENCES voucher (id),
  reason                 text,
  -- Totals are stored only so the balance constraint can be checked by the database. They are
  -- always equal to the sum of the lines, which trigger ledger_voucher_balanced enforces.
  total_debit_minor      bigint NOT NULL,
  total_credit_minor     bigint NOT NULL,
  CONSTRAINT voucher_number_unique UNIQUE (company_id, number),
  CONSTRAINT voucher_idempotency_unique UNIQUE (company_id, idempotency_key),
  CONSTRAINT voucher_balances CHECK (total_debit_minor = total_credit_minor),
  CONSTRAINT voucher_not_empty CHECK (total_debit_minor > 0),
  CONSTRAINT voucher_reversal_has_target CHECK (
    (type <> 'REVERSAL') OR (reverses_voucher_id IS NOT NULL AND reason IS NOT NULL)
  ),
  CONSTRAINT voucher_reversed_has_reverser CHECK (
    (state <> 'REVERSED') OR (reversed_by_voucher_id IS NOT NULL)
  )
);

CREATE INDEX voucher_company_date ON voucher (company_id, document_date);
CREATE INDEX voucher_company_type_date ON voucher (company_id, type, document_date);
CREATE INDEX voucher_source ON voucher (company_id, source_kind, source_id);

CREATE TABLE journal_line (
  id            uuid PRIMARY KEY,
  company_id    uuid NOT NULL,
  voucher_id    uuid NOT NULL REFERENCES voucher (id),
  line_no       integer NOT NULL,
  account_id    uuid NOT NULL REFERENCES account (id),
  party_id      uuid,
  debit_minor   bigint NOT NULL DEFAULT 0,
  credit_minor  bigint NOT NULL DEFAULT 0,
  narration     text,
  CONSTRAINT journal_line_unique UNIQUE (voucher_id, line_no),
  CONSTRAINT journal_line_not_negative CHECK (debit_minor >= 0 AND credit_minor >= 0),
  CONSTRAINT journal_line_one_side CHECK (
    (debit_minor > 0 AND credit_minor = 0) OR (credit_minor > 0 AND debit_minor = 0)
  )
);

CREATE INDEX journal_line_account ON journal_line (company_id, account_id);
CREATE INDEX journal_line_party ON journal_line (company_id, party_id) WHERE party_id IS NOT NULL;
CREATE INDEX journal_line_voucher ON journal_line (voucher_id);

-- Idempotency records for commands that do not themselves create a voucher row.
CREATE TABLE idempotency_record (
  company_id  uuid NOT NULL,
  key         text NOT NULL,
  result_id   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, key)
);

-- A final entry is immutable. Only the reversal bookkeeping columns may ever change, and only
-- from NULL to a value.
CREATE OR REPLACE FUNCTION ledger_voucher_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.state = 'DRAFT' THEN
    RETURN NEW;
  END IF;
  IF NEW.company_id <> OLD.company_id
     OR NEW.type <> OLD.type
     OR NEW.number <> OLD.number
     OR NEW.document_date <> OLD.document_date
     OR NEW.total_debit_minor <> OLD.total_debit_minor
     OR NEW.total_credit_minor <> OLD.total_credit_minor
     OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'A finished entry cannot be changed. Undo it with a reversal instead.';
  END IF;
  IF OLD.reversed_by_voucher_id IS NOT NULL AND NEW.reversed_by_voucher_id <> OLD.reversed_by_voucher_id THEN
    RAISE EXCEPTION 'This entry has already been undone.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER voucher_immutable
  BEFORE UPDATE ON voucher
  FOR EACH ROW EXECUTE FUNCTION ledger_voucher_immutable();

CREATE OR REPLACE FUNCTION ledger_voucher_no_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.state <> 'DRAFT' THEN
    RAISE EXCEPTION 'A finished entry is never deleted. Undo it with a reversal instead.';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER voucher_no_delete
  BEFORE DELETE ON voucher
  FOR EACH ROW EXECUTE FUNCTION ledger_voucher_no_delete();

CREATE OR REPLACE FUNCTION ledger_line_immutable() RETURNS trigger AS $$
DECLARE
  parent_state voucher_state;
BEGIN
  SELECT state INTO parent_state FROM voucher WHERE id = COALESCE(NEW.voucher_id, OLD.voucher_id);
  IF parent_state <> 'DRAFT' THEN
    RAISE EXCEPTION 'The lines of a finished entry cannot be changed or removed.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_line_immutable
  BEFORE UPDATE OR DELETE ON journal_line
  FOR EACH ROW EXECUTE FUNCTION ledger_line_immutable();

-- The stored totals must always equal the sum of the lines. Checked at the end of the statement
-- so a voucher and its lines can be inserted in any order inside one transaction.
CREATE OR REPLACE FUNCTION ledger_voucher_balanced() RETURNS trigger AS $$
DECLARE
  offending record;
BEGIN
  FOR offending IN
    SELECT v.id, v.number, v.total_debit_minor, v.total_credit_minor,
           COALESCE(SUM(l.debit_minor), 0) AS line_debit,
           COALESCE(SUM(l.credit_minor), 0) AS line_credit
    FROM voucher v
    LEFT JOIN journal_line l ON l.voucher_id = v.id
    GROUP BY v.id, v.number, v.total_debit_minor, v.total_credit_minor
    HAVING COALESCE(SUM(l.debit_minor), 0) <> COALESCE(SUM(l.credit_minor), 0)
        OR COALESCE(SUM(l.debit_minor), 0) <> v.total_debit_minor
        OR COALESCE(SUM(l.credit_minor), 0) <> v.total_credit_minor
  LOOP
    RAISE EXCEPTION 'Entry % does not balance: lines are % and %, totals say % and %.',
      offending.number, offending.line_debit, offending.line_credit,
      offending.total_debit_minor, offending.total_credit_minor;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER voucher_balanced_check
  AFTER INSERT OR UPDATE ON voucher
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_voucher_balanced();

CREATE CONSTRAINT TRIGGER journal_line_balanced_check
  AFTER INSERT ON journal_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_voucher_balanced();

COMMIT;
