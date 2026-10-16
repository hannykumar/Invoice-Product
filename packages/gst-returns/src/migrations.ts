// Issue #30 [E30] — the tables the return workspace owns.
//
// Two things about this schema are deliberate and worth reading before changing it.
//
//   1. **The snapshot is stored, not just its totals.** `gst_return_preparations.snapshot` holds
//      the documents the return was built from. That is a lot of JSON, and it is the price of the
//      first acceptance criterion: an approved return has to be rebuildable, document by document,
//      years after the bills behind it have been edited, split or renumbered.
//   2. **An approval is a row that cannot be edited.** There is no `approved` flag on the
//      preparation to be flipped back. An approval is its own row with its own fingerprint, and
//      reopening writes a withdrawal rather than deleting one, so "this was approved and then
//      unapproved" stays visible.

import type { Migration } from "../../platform/src/migration-definitions.ts";

export const gstReturnMigrations: readonly Migration[] = Object.freeze([{
  id: "20260831T181418018Z_gst-returns_fb63bae0bb02_return_workspace",
  up: `
    -- One preparation per company, period and return type.
    CREATE TABLE gst_return_preparations (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      -- The registration the return is filed under. A company with two registrations files two
      -- returns, so this is part of what makes a preparation unique.
      gstin text NOT NULL,
      -- 'YYYY-MM'. Months, not quarters: a quarterly filer still reports month by month.
      period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
      return_type text NOT NULL CHECK (return_type IN ('GSTR1','GSTR3B')),
      state text NOT NULL CHECK (state IN (
        'DRAFT','NEEDS_ATTENTION','APPROVED','EXPORTED','SUBMITTING','FILED','SUBMISSION_FAILED'
      )),
      -- The photograph of the books, documents and all. See the note at the top of this file.
      snapshot jsonb NOT NULL,
      -- sha256 over every fact that could change a figure. Compared on every later read.
      fingerprint text NOT NULL,
      document_count integer NOT NULL CHECK (document_count >= 0),
      findings jsonb NOT NULL DEFAULT '[]',
      exported_at timestamptz,
      created_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      idempotency_key text NOT NULL,
      version integer NOT NULL CHECK (version > 0),
      UNIQUE (company_id, gstin, period, return_type),
      UNIQUE (company_id, idempotency_key)
    );

    -- Approvals and their withdrawals, append-only.
    --
    -- withdrawn_at being null is what makes an approval current. Reopening sets it and records who
    -- and why, so a period that was approved, reopened and approved again reads as three events
    -- rather than as one row that has been overwritten twice.
    CREATE TABLE gst_return_approvals (
      id uuid PRIMARY KEY,
      preparation_id uuid NOT NULL REFERENCES gst_return_preparations(id),
      approved_by uuid NOT NULL REFERENCES users(id),
      approved_at timestamptz NOT NULL DEFAULT now(),
      -- The fingerprint at the moment of approval. This is the figure the person actually signed.
      fingerprint text NOT NULL,
      note text,
      withdrawn_at timestamptz,
      withdrawn_by uuid REFERENCES users(id),
      withdrawn_reason text,
      CONSTRAINT gst_return_withdrawal_complete CHECK (
        (withdrawn_at IS NULL AND withdrawn_by IS NULL AND withdrawn_reason IS NULL)
        OR (withdrawn_at IS NOT NULL AND withdrawn_by IS NOT NULL AND withdrawn_reason IS NOT NULL)
      )
    );

    -- Only one live approval per preparation.
    CREATE UNIQUE INDEX gst_return_one_live_approval
      ON gst_return_approvals(preparation_id) WHERE withdrawn_at IS NULL;

    -- Every attempt to send a return, including the ones that did not come back.
    --
    -- 'UNKNOWN' is a first-class outcome and not an error state: after a timeout the return may
    -- well be filed, and a schema that only knew 'accepted' and 'failed' would force a guess.
    CREATE TABLE gst_return_submissions (
      id uuid PRIMARY KEY,
      preparation_id uuid NOT NULL REFERENCES gst_return_preparations(id),
      provider text NOT NULL,
      -- Derived from the approved fingerprint, so a retry is the same filing, not a second one.
      idempotency_key text NOT NULL,
      attempted_at timestamptz NOT NULL DEFAULT now(),
      outcome text NOT NULL CHECK (outcome IN ('ACCEPTED','REJECTED','UNKNOWN')),
      -- The government's acknowledgement reference, present only on acceptance.
      reference text,
      -- The portal's own error codes, kept verbatim. Never a credential and never a payload.
      errors jsonb NOT NULL DEFAULT '[]',
      message text NOT NULL,
      CONSTRAINT gst_return_reference_on_acceptance CHECK (
        (outcome = 'ACCEPTED' AND reference IS NOT NULL) OR outcome <> 'ACCEPTED'
      ),
      UNIQUE (provider, idempotency_key)
    );

    -- A B2CL threshold a business set for itself, when the register does not yet carry a checked
    -- one. Attribution is required by the columns, not just by the code that writes them.
    CREATE TABLE gst_return_declared_thresholds (
      company_id uuid NOT NULL REFERENCES companies(id),
      above_value_minor bigint NOT NULL CHECK (above_value_minor > 0),
      effective_from date NOT NULL,
      effective_to date,
      declared_by uuid NOT NULL REFERENCES users(id),
      declared_on date NOT NULL,
      -- Where the business says the figure came from. Never blank.
      basis text NOT NULL CHECK (btrim(basis) <> ''),
      PRIMARY KEY (company_id, effective_from)
    );

    CREATE INDEX gst_return_preparations_company_period_idx
      ON gst_return_preparations(company_id, period DESC);
    CREATE INDEX gst_return_submissions_preparation_idx
      ON gst_return_submissions(preparation_id, attempted_at DESC);
  `,
  down: `
    DROP TABLE IF EXISTS gst_return_declared_thresholds;
    DROP TABLE IF EXISTS gst_return_submissions;
    DROP TABLE IF EXISTS gst_return_approvals;
    DROP TABLE IF EXISTS gst_return_preparations;
  `,
}, {
  // Issue #366 — what the PostgreSQL repository needs that the first migration did not give it.
  id: "20261011T144926615Z_gst-returns_f477e95b6387_repository_rls_and_live_submission",
  up: `
    -- One company never sees another's returns, whatever the query forgot.
    ${["gst_return_preparations", "gst_return_declared_thresholds"].map((table) => `
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
    CREATE POLICY ${table}_tenant ON ${table}
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);`).join("")}

    -- Approvals and submissions carry no company of their own; they are reached through their
    -- preparation, which the policy above already hides from every other company.
    ${["gst_return_approvals", "gst_return_submissions"].map((table) => `
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
    CREATE POLICY ${table}_tenant ON ${table}
      USING (EXISTS (SELECT 1 FROM gst_return_preparations p WHERE p.id = preparation_id))
      WITH CHECK (EXISTS (SELECT 1 FROM gst_return_preparations p WHERE p.id = preparation_id));`).join("")}

    -- Which attempt the return is showing. A return that is reopened and prepared again starts
    -- with no submission, but the earlier attempts are history and stay: they are set aside, not
    -- deleted. Null means "this is the one on the return".
    ALTER TABLE gst_return_submissions ADD COLUMN superseded_at timestamptz;
    -- At most one attempt is on the return at a time; also the index the read joins on.
    CREATE UNIQUE INDEX gst_return_one_live_submission
      ON gst_return_submissions(preparation_id) WHERE superseded_at IS NULL;

    -- A filing key is unique within its return, not across every company. The key is built from
    -- the GST number, the month and the figures, so two companies holding the same registration
    -- (a business and its accountant, or two test companies) would otherwise block each other.
    ALTER TABLE gst_return_submissions DROP CONSTRAINT gst_return_submissions_provider_idempotency_key_key;
    ALTER TABLE gst_return_submissions ADD CONSTRAINT gst_return_submissions_filing_key
      UNIQUE (preparation_id, provider, idempotency_key);

    -- The foreign key to the preparation. The existing partial index covers only the live
    -- approval; this one serves the key itself and the history of withdrawn approvals.
    CREATE INDEX gst_return_approvals_preparation_idx ON gst_return_approvals(preparation_id);
  `,
  down: `
    DROP INDEX IF EXISTS gst_return_approvals_preparation_idx;
    ALTER TABLE gst_return_submissions DROP CONSTRAINT IF EXISTS gst_return_submissions_filing_key;
    ALTER TABLE gst_return_submissions ADD CONSTRAINT gst_return_submissions_provider_idempotency_key_key
      UNIQUE (provider, idempotency_key);
    DROP INDEX IF EXISTS gst_return_one_live_submission;
    ALTER TABLE gst_return_submissions DROP COLUMN IF EXISTS superseded_at;
    ${["gst_return_submissions", "gst_return_approvals", "gst_return_declared_thresholds", "gst_return_preparations"].map((table) => `
    DROP POLICY IF EXISTS ${table}_tenant ON ${table};
    ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`).join("")}
  `,
}]);
