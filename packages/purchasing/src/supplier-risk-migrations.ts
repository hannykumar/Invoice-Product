// Issue #19 [E19] — the tables supplier warnings own.
//
// Two things are deliberately not stored here. Bank-detail changes are read from #5's master
// version history rather than copied, so there is one account of what changed. And no account
// number is stored in any of these tables: a warning about a changed account carries the masked
// last four digits only.

import type { Migration } from "../../platform/src/migration-definitions.ts";

export const supplierRiskMigrations: readonly Migration[] = Object.freeze([{
  id: "20260829T181515430Z_purchasing_a9be7b3d2c86_supplier_risk_warnings",
  up: `
    -- What the GST department told us, and when. Kept so an outage can still show the last
    -- reading, clearly marked as old, instead of showing nothing at all.
    CREATE TABLE supplier_gstin_readings (
      company_id uuid NOT NULL REFERENCES companies(id),
      gstin text NOT NULL,
      status text NOT NULL CHECK (status IN ('ACTIVE','CANCELLED','SUSPENDED','PROVISIONAL','INACTIVE','NOT_FOUND','UNKNOWN')),
      legal_name text,
      trade_name text,
      state_code text,
      registered_on date,
      status_changed_on date,
      e_invoice_enabled boolean,
      filings jsonb NOT NULL DEFAULT '[]',
      provider_request_id text,
      observed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (company_id, gstin)
    );
    CREATE INDEX supplier_gstin_readings_stale_idx ON supplier_gstin_readings(company_id, observed_at);

    -- One row per distinct set of facts, not per page refresh: the fingerprint is the key.
    CREATE TABLE supplier_risk_assessments (
      company_id uuid NOT NULL REFERENCES companies(id),
      fingerprint text NOT NULL,
      supplier_party_id uuid NOT NULL REFERENCES master_records(id),
      supplier_name text NOT NULL,
      gstin text,
      invoice_number text,
      invoice_date date,
      level text NOT NULL CHECK (level IN ('INFORMATION','CAUTION','SERIOUS')),
      confidence text NOT NULL CHECK (confidence IN ('COMPLETE','PARTIAL')),
      -- Each warning keeps its own evidence, so the assessment can be explained to the supplier
      -- it is about, months later, exactly as it was shown.
      warnings jsonb NOT NULL DEFAULT '[]',
      sources jsonb NOT NULL DEFAULT '[]',
      policy jsonb NOT NULL,
      summary text NOT NULL,
      assessed_by uuid NOT NULL REFERENCES users(id),
      assessed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (company_id, fingerprint)
    );
    CREATE INDEX supplier_risk_assessments_party_idx ON supplier_risk_assessments(company_id, supplier_party_id, assessed_at DESC);
    CREATE INDEX supplier_risk_assessments_level_idx ON supplier_risk_assessments(company_id, level) WHERE level = 'SERIOUS';

    -- Going ahead despite a serious warning. Pinned to the exact assessment that was accepted.
    CREATE TABLE supplier_risk_acknowledgements (
      company_id uuid NOT NULL REFERENCES companies(id),
      assessment_fingerprint text NOT NULL,
      supplier_party_id uuid NOT NULL REFERENCES master_records(id),
      accepted_codes jsonb NOT NULL DEFAULT '[]',
      reason text NOT NULL,
      acknowledged_by uuid NOT NULL REFERENCES users(id),
      acknowledged_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (company_id, assessment_fingerprint)
    );
    CREATE INDEX supplier_risk_ack_party_idx ON supplier_risk_acknowledgements(company_id, supplier_party_id);

    -- Per company and effective-dated, so a warning raised last year is explained under the
    -- freshness rules that were in force then.
    CREATE TABLE supplier_risk_policies (
      company_id uuid NOT NULL REFERENCES companies(id),
      effective_from date NOT NULL,
      government_data_stale_after_days integer NOT NULL CHECK (government_data_stale_after_days > 0),
      new_registration_days integer NOT NULL CHECK (new_registration_days >= 0),
      bank_change_recent_days integer NOT NULL CHECK (bank_change_recent_days >= 0),
      missed_return_periods integer NOT NULL CHECK (missed_return_periods >= 0),
      set_by uuid NOT NULL REFERENCES users(id),
      set_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (company_id, effective_from)
    );
  `,
  down: `
    DROP TABLE IF EXISTS supplier_risk_policies;
    DROP TABLE IF EXISTS supplier_risk_acknowledgements;
    DROP TABLE IF EXISTS supplier_risk_assessments;
    DROP TABLE IF EXISTS supplier_gstin_readings;
  `,
}]);
