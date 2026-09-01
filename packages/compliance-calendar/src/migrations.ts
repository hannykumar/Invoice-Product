// Issue #32 [E32] — the tables the compliance calendar owns.
//
// Four things about this schema are deliberate.
//
//   1. **Definitions are effective-dated rows, never edited.** A changed deadline is a new version
//      with a later `effective_from`. The unique index is on (code, version), so an amendment
//      cannot overwrite the rule a return was filed under, and a period's governing version is
//      found by the period's own end date rather than by today.
//   2. **An occurrence's identity carries no date.** The unique key is (company, code, period_key).
//      A deadline that moves updates that one row and appends to `compliance_deadline_revisions`;
//      it never leaves a second row behind for the same month, which is how a business ends up
//      warned twice about one return and then ignoring both.
//   3. **Alerts are append-only and deduplicated by rule, level and due date.** The unique index is
//      what makes running the sweep five times before lunch send one message, and what lets an
//      extended deadline start a fresh ladder instead of staying silent.
//   4. **A completion carries evidence or it is not a completion.** The check constraint requires a
//      reference for anything the portal issued and a note for a person's typed confirmation.
//      Marking an obligation done is the one act that permanently silences a warning, so it is the
//      one act that must leave something a later reader can check.

import type { Migration } from "../../platform/src/migration-definitions.ts";

export const complianceCalendarMigrations: readonly Migration[] = Object.freeze([{
  id: "20260831T195358113Z_compliance-calendar_86a8c633263c_compliance_calendar",
  up: `
    -- The obligations, as effective-dated readings of notifications. Never edited in place.
    CREATE TABLE compliance_obligation_definitions (
      id uuid PRIMARY KEY,
      -- NULL for the built-in catalogue; set when one business declared a date for itself.
      company_id uuid REFERENCES companies(id),
      code text NOT NULL,
      version integer NOT NULL CHECK (version >= 1),
      kind text NOT NULL CHECK (kind IN ('STATUTORY','POLICY')),
      cadence text NOT NULL CHECK (cadence IN ('MONTHLY','QUARTERLY','ANNUAL','EVENT')),
      title jsonb NOT NULL,
      description jsonb NOT NULL,
      effective_from date NOT NULL,
      effective_to date,
      applicability jsonb NOT NULL,
      due_rule jsonb NOT NULL,
      due_date_shift text NOT NULL DEFAULT 'NONE' CHECK (due_date_shift IN ('NONE','NEXT_WORKING_DAY')),
      ladder jsonb NOT NULL,
      consequence jsonb NOT NULL,
      next_action jsonb NOT NULL,
      action_code text NOT NULL,
      -- The notification this reading rests on, as the compliance register (#54) holds it.
      source_ref text,
      -- DRAFT until a person has checked the entry against that source. A draft date is still shown
      -- and still alerted on; it is labelled unchecked everywhere it appears.
      review_state text NOT NULL CHECK (review_state IN ('DRAFT','APPROVED','SUPERSEDED','WITHDRAWN')),
      declared_by uuid REFERENCES users(id),
      declared_basis text,
      CHECK (effective_to IS NULL OR effective_to >= effective_from),
      -- A business-declared date must say whose it is; nothing here may be anonymous.
      CHECK (company_id IS NULL OR declared_by IS NOT NULL),
      UNIQUE (company_id, code, version)
    );

    -- One obligation, for one company, for one period.
    CREATE TABLE compliance_occurrences (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      code text NOT NULL,
      -- '2026-07', '2026-Q2', '2026-27', or a document key for an event deadline.
      period_key text NOT NULL,
      period_kind text NOT NULL CHECK (period_kind IN ('MONTH','QUARTER','YEAR','EVENT')),
      period_from date NOT NULL,
      period_to date NOT NULL,
      period_label jsonb,
      definition_version integer NOT NULL,
      review_state text NOT NULL,
      source_ref text,
      title jsonb NOT NULL,
      obligation_kind text NOT NULL CHECK (obligation_kind IN ('STATUTORY','POLICY')),
      -- The deadline the rule gives, whether or not it is a working day.
      due_date date NOT NULL,
      -- The last working day at or before it: where the reminders are hung.
      actionable_by date NOT NULL,
      status text NOT NULL CHECK (status IN ('OPEN','COMPLETED','NOT_APPLICABLE')),
      not_applicable_reason jsonb,
      snooze_until date,
      snooze_reason text,
      snoozed_by uuid REFERENCES users(id),
      snoozed_at timestamptz,
      -- The highest rung already rung for the current deadline. Cleared when the deadline moves,
      -- so an extension starts the ladder again rather than leaving the business unwarned.
      highest_alert_level text CHECK (highest_alert_level IN ('EARLY','DUE_SOON','DUE_TODAY','OVERDUE','ESCALATED')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (snooze_until IS NULL OR (snooze_reason IS NOT NULL AND snoozed_by IS NOT NULL)),
      -- A reminder may never be pushed past the deadline it is about.
      CHECK (snooze_until IS NULL OR snooze_until <= due_date),
      UNIQUE (company_id, code, period_key)
    );

    -- Deadlines that moved. Append-only; a completed obligation never gets one.
    CREATE TABLE compliance_deadline_revisions (
      id uuid PRIMARY KEY,
      occurrence_id uuid NOT NULL REFERENCES compliance_occurrences(id) ON DELETE CASCADE,
      company_id uuid NOT NULL REFERENCES companies(id),
      previous_due_date date NOT NULL,
      due_date date NOT NULL,
      previous_version integer NOT NULL,
      version integer NOT NULL,
      reason jsonb NOT NULL,
      source_ref text,
      recorded_at timestamptz NOT NULL DEFAULT now(),
      CHECK (previous_due_date <> due_date)
    );

    -- Proof that the work was done. One live completion per occurrence.
    CREATE TABLE compliance_completions (
      id uuid PRIMARY KEY,
      occurrence_id uuid NOT NULL REFERENCES compliance_occurrences(id) ON DELETE CASCADE,
      company_id uuid NOT NULL REFERENCES companies(id),
      evidence_kind text NOT NULL CHECK (evidence_kind IN ('ARN','PORTAL_RECEIPT','IRN','PAYMENT_CHALLAN','SOURCE_MODULE','TYPED_CONFIRMATION')),
      -- The acknowledgement number as the portal gave it. Not pattern-checked: the format has
      -- changed before, this product cannot verify one, and a validator that rejected a real
      -- number would stop a business recording something true.
      reference text NOT NULL DEFAULT '',
      note text NOT NULL DEFAULT '',
      filed_on date NOT NULL,
      completed_by uuid NOT NULL,
      completed_at timestamptz NOT NULL DEFAULT now(),
      -- A person's word is evidence when it says who saw what; a portal reference stands alone.
      CHECK (
        (evidence_kind = 'TYPED_CONFIRMATION' AND length(btrim(note)) >= 10)
        OR (evidence_kind <> 'TYPED_CONFIRMATION' AND length(btrim(reference)) >= 4)
      ),
      UNIQUE (occurrence_id)
    );

    -- Every warning that was raised, and when. Append-only: what a business was told is evidence.
    CREATE TABLE compliance_alerts (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      occurrence_id uuid NOT NULL REFERENCES compliance_occurrences(id) ON DELETE CASCADE,
      occurrence_key text NOT NULL,
      code text NOT NULL,
      definition_version integer NOT NULL,
      review_state text NOT NULL,
      source_ref text,
      level text NOT NULL CHECK (level IN ('EARLY','DUE_SOON','DUE_TODAY','OVERDUE','ESCALATED')),
      audiences text[] NOT NULL,
      due_date date NOT NULL,
      days_remaining integer NOT NULL,
      headline jsonb NOT NULL,
      detail jsonb NOT NULL,
      next_action jsonb NOT NULL,
      action_code text NOT NULL,
      -- What was unresolved underneath, and which records it was about. An alert that cannot show
      -- its affected records is an opinion.
      signals jsonb NOT NULL DEFAULT '[]',
      affected jsonb NOT NULL DEFAULT '[]',
      deduplication_key text NOT NULL,
      raised_at timestamptz NOT NULL DEFAULT now(),
      raised_by uuid NOT NULL REFERENCES users(id),
      manual_reason text,
      -- One alert per obligation, per level, per deadline.
      UNIQUE (company_id, deduplication_key)
    );

    -- Obligations that could not be placed because a company fact is missing. Never a guess and
    -- never silence: a question, in words, waiting for one answer.
    CREATE TABLE compliance_calendar_exceptions (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      code text NOT NULL,
      period_key text NOT NULL,
      missing_facts text[] NOT NULL,
      question jsonb NOT NULL,
      raised_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz,
      UNIQUE (company_id, code, period_key)
    );

    CREATE INDEX compliance_occurrences_due_idx
      ON compliance_occurrences(company_id, due_date, status);
    CREATE INDEX compliance_occurrences_open_idx
      ON compliance_occurrences(company_id, status, due_date) WHERE status = 'OPEN';
    CREATE INDEX compliance_alerts_occurrence_idx
      ON compliance_alerts(company_id, occurrence_key, raised_at DESC);
    CREATE INDEX compliance_deadline_revisions_occurrence_idx
      ON compliance_deadline_revisions(occurrence_id, recorded_at DESC);
    CREATE INDEX compliance_definitions_lookup_idx
      ON compliance_obligation_definitions(code, effective_from DESC);
  `,
  down: `
    DROP TABLE IF EXISTS compliance_calendar_exceptions;
    DROP TABLE IF EXISTS compliance_alerts;
    DROP TABLE IF EXISTS compliance_completions;
    DROP TABLE IF EXISTS compliance_deadline_revisions;
    DROP TABLE IF EXISTS compliance_occurrences;
    DROP TABLE IF EXISTS compliance_obligation_definitions;
  `,
}]);
