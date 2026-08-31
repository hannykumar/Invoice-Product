// Issue #29 [E29] — the two tables the vehicle-record verification owns, and what is deliberately
// not in them.
//
// The privacy promise is written into the schema rather than left to the code to remember. There is
// no column for a chassis number, an engine number, an owner's address or a registration date,
// because those are not needed to decide whether a lorry can carry a load — so even a future
// mistake in the adapter has nowhere to put them. The owner's name column is named
// `registered_owner_masked` for the same reason: a full name would be visibly the wrong thing in
// it.

import type { Migration } from "../../platform/src/migration-definitions.ts";

export const vehicleRecordMigrations: readonly Migration[] = Object.freeze([{
  id: "20260831T101408576Z_transport_a188cbfb493d_vehicle_record_verification",
  up: `
    -- A business's permission to have vehicle records looked up, and what it agreed may be read.
    -- Consent is per company and per purpose, and it is dated: an expired one is not consent.
    CREATE TABLE vehicle_record_consents (
      company_id uuid NOT NULL REFERENCES companies(id),
      purpose text NOT NULL CHECK (purpose IN ('TRANSPORT_SUITABILITY')),
      -- The fields agreed to, from the product's own allow-list. Anything else is never requested.
      fields jsonb NOT NULL,
      granted_by uuid NOT NULL REFERENCES users(id),
      granted_at timestamptz NOT NULL DEFAULT now(),
      expires_on date,
      -- A name the credential vault understands. Never a credential, a token or a key.
      credential_reference text,
      revoked_at timestamptz,
      revoked_by uuid REFERENCES users(id),
      PRIMARY KEY (company_id, purpose)
    );

    -- One reading per company per vehicle, replaced when a newer one arrives.
    --
    -- This is a cache, not a history. The movement that was decided on a reading keeps its own copy
    -- of the evidence in vehicle_suitability_checks, so nothing auditable depends on these rows
    -- surviving — which is what makes deleting them on withdrawal of consent safe.
    CREATE TABLE vehicle_records (
      company_id uuid NOT NULL REFERENCES companies(id),
      registration_number text NOT NULL,
      -- Which service answered, their reference for the answer, and when we asked. All three are
      -- required: a reading that cannot be traced back to a provider and a moment is not evidence.
      provider text NOT NULL,
      provider_reference text NOT NULL,
      retrieved_at timestamptz NOT NULL,
      -- True when the authority answered that it holds no such vehicle. Distinct from a row that is
      -- simply absent, which means we have never asked.
      not_found boolean NOT NULL DEFAULT false,
      vehicle_class text,
      body_type text,
      gross_vehicle_weight_kg integer CHECK (gross_vehicle_weight_kg > 0),
      unladen_weight_kg integer CHECK (unladen_weight_kg > 0),
      rated_payload_kg integer CHECK (rated_payload_kg > 0),
      permit_type text,
      permit_valid_upto date,
      fitness_valid_upto date,
      insurance_valid_upto date,
      -- Masked at the boundary: "S******* T****** P****** L******". Enough to tell whether the
      -- lorry at the gate belongs to the transporter who was booked, and nothing more.
      registered_owner_masked text,
      -- The authority's own status word, kept verbatim: 'ACTIVE', 'SCRAPPED', and the rest.
      registration_status text,
      -- Either we hold facts, or we hold "no such vehicle". Never both, and never neither.
      CONSTRAINT vehicle_records_answer CHECK (
        (not_found AND vehicle_class IS NULL AND gross_vehicle_weight_kg IS NULL)
        OR NOT not_found
      ),
      PRIMARY KEY (company_id, registration_number)
    );

    -- The retention sweep and the freshness check both read by age.
    CREATE INDEX vehicle_records_age_idx ON vehicle_records(company_id, retrieved_at);
  `,
  down: `
    DROP TABLE IF EXISTS vehicle_records;
    DROP TABLE IF EXISTS vehicle_record_consents;
  `,
}]);
