// Issue #28 [E28] — the tables the vehicle suitability check owns.
//
// The shape of these tables is the acceptance criterion "an override never edits source evidence",
// written into the database rather than left to the code to remember: the evidence, the findings
// and the plate reading go in once and are never updated, and an override is a row in a separate
// table pointing at them. There is no column an override could edit even if somebody tried.

import type { Migration } from "../../platform/src/migration-definitions.ts";

export const vehicleSuitabilityMigrations: readonly Migration[] = Object.freeze([{
  id: "20260830T193008952Z_transport_b690d0e7f55e_vehicle_suitability_checks",
  up: `
    CREATE TABLE vehicle_suitability_checks (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      movement_id uuid NOT NULL,
      checked_at timestamptz NOT NULL DEFAULT now(),
      checked_by uuid NOT NULL REFERENCES users(id),
      -- CANNOT_DECIDE is its own outcome and is never stored as OK. A vehicle nobody could check
      -- is not a vehicle that passed.
      outcome text NOT NULL CHECK (outcome IN ('OK','WARN','CANNOT_DECIDE','BLOCK')),
      summary text NOT NULL,
      -- The transport details and the load exactly as they stood when the check ran.
      transport jsonb NOT NULL,
      shipment jsonb NOT NULL,
      -- Every piece of evidence read, each carrying its own source: the registering authority's
      -- record, the company's vehicle list, or a value typed in for this movement.
      evidence jsonb NOT NULL DEFAULT '[]',
      capacity jsonb,
      -- What the number-plate photograph read. The photograph itself is not stored here.
      plate jsonb,
      findings jsonb NOT NULL DEFAULT '[]',
      idempotency_key text NOT NULL,
      UNIQUE (company_id, movement_id, idempotency_key)
    );

    -- The dispatch desk's queue: what is stopped, oldest first.
    CREATE INDEX vehicle_suitability_blocked_idx ON vehicle_suitability_checks(company_id, checked_at)
      WHERE outcome IN ('BLOCK','CANNOT_DECIDE');
    CREATE INDEX vehicle_suitability_movement_idx ON vehicle_suitability_checks(company_id, movement_id, checked_at DESC);

    -- A person deciding to go ahead anyway. Append-only, and pointing at named findings: an
    -- override covers what it names and nothing else.
    CREATE TABLE vehicle_suitability_overrides (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      check_id uuid NOT NULL REFERENCES vehicle_suitability_checks(id),
      finding_codes jsonb NOT NULL,
      -- Never empty and never a default. A reason nobody wrote is not a reason.
      reason text NOT NULL CHECK (length(btrim(reason)) >= 10),
      overridden_by uuid NOT NULL REFERENCES users(id),
      overridden_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX vehicle_suitability_overrides_check_idx ON vehicle_suitability_overrides(company_id, check_id);

    -- Per company and effective-dated, like every other policy here. The class ceilings are the
    -- configurable part: a business running unusual vehicles changes data, not code.
    CREATE TABLE vehicle_suitability_policies (
      company_id uuid NOT NULL REFERENCES companies(id),
      effective_from date NOT NULL,
      class_ceiling_kg jsonb NOT NULL,
      warn_from_load_factor numeric(4,3) NOT NULL CHECK (warn_from_load_factor > 0 AND warn_from_load_factor <= 1),
      overload_severity text NOT NULL CHECK (overload_severity IN ('BLOCK','WARN','CANNOT_DECIDE')),
      plate_mismatch_severity text NOT NULL CHECK (plate_mismatch_severity IN ('BLOCK','WARN','CANNOT_DECIDE')),
      minimum_plate_confidence numeric(4,3) NOT NULL CHECK (minimum_plate_confidence >= 0 AND minimum_plate_confidence <= 1),
      expired_fitness_severity text NOT NULL CHECK (expired_fitness_severity IN ('BLOCK','WARN','CANNOT_DECIDE')),
      wrong_permit_severity text NOT NULL CHECK (wrong_permit_severity IN ('BLOCK','WARN','CANNOT_DECIDE')),
      set_by uuid NOT NULL REFERENCES users(id),
      set_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (company_id, effective_from)
    );
  `,
  down: `
    DROP TABLE IF EXISTS vehicle_suitability_policies;
    DROP TABLE IF EXISTS vehicle_suitability_overrides;
    DROP TABLE IF EXISTS vehicle_suitability_checks;
  `,
}]);
