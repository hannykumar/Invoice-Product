// Issue #27 [E27] — the tables the e-way bill lifecycle owns.
//
// The sales invoice and the delivery challan belong to #9 and #18 and are not created here; only
// the movement's own id and the document number are stored, so an e-way bill can be traced to the
// goods it permitted without this migration depending on another module's SQL having landed.

import type { Migration } from "../../platform/src/migration-definitions.ts";

/** Issue #366 — every table of this lane that holds one company's rows. The database closes each to every other company. */
const TENANT_TABLES = [
  "eway_bills", "eway_consolidated_trips", "eway_bill_policies", "eway_bill_acknowledgements",
  "vehicle_suitability_checks", "vehicle_suitability_overrides", "vehicle_suitability_policies",
  "vehicle_records", "vehicle_record_consents", "vehicle_record_freshness_policies",
] as const;

export const ewayBillMigrations: readonly Migration[] = Object.freeze([{
  id: "20260829T230150061Z_transport_f5901402df63_eway_bill_lifecycle",
  up: `
    CREATE TABLE eway_bills (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      movement_id uuid NOT NULL,
      document_number text NOT NULL,
      document_date date NOT NULL,
      -- PART_A_ONLY is a real state, not a half-finished one: the portal holds the consignment but
      -- no vehicle, and goods may not move on it. Nothing outside this module may read it as ACTIVE.
      status text NOT NULL CHECK (status IN ('NOT_REQUIRED','PENDING','PART_A_ONLY','ACTIVE','EXPIRED','CANCELLED','REJECTED','FAILED')),
      -- The decision, the facts it applied and the notification behind it, so a movement can be
      -- explained to an officer months later.
      applicability jsonb NOT NULL,
      consignment_value_paise bigint NOT NULL CHECK (consignment_value_paise >= 0),
      from_state_code text NOT NULL,
      to_state_code text NOT NULL,
      distance_km integer CHECK (distance_km >= 0 AND distance_km <= 4000),
      eway_bill_number text,
      generated_at text,
      -- Null until Part B goes in: validity does not start before the vehicle is known.
      valid_until timestamptz,
      provider_request_id text,
      alert text,
      -- Every vehicle this consignment has travelled on, oldest first.
      vehicle_legs jsonb NOT NULL DEFAULT '[]',
      transporter jsonb,
      consolidated_trip_number text,
      failure_code text,
      failure_message text,
      failure_retryable boolean,
      cancellable_until timestamptz,
      cancelled_at timestamptz,
      cancel_reason_code text CHECK (cancel_reason_code IN ('DUPLICATE','ORDER_CANCELLED','DATA_ENTRY_MISTAKE','OTHERS')),
      cancel_reason text,
      rejected_at timestamptz,
      reject_reason_code text CHECK (reject_reason_code IN ('NOT_MY_CONSIGNMENT','DATA_ENTRY_MISTAKE','OTHERS')),
      message text NOT NULL,
      created_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      idempotency_key text NOT NULL,
      -- Nothing may claim a portal state without the number that proves it.
      CONSTRAINT live_has_number CHECK (
        status NOT IN ('PART_A_ONLY','ACTIVE','EXPIRED','CANCELLED','REJECTED') OR eway_bill_number IS NOT NULL
      ),
      -- Goods may only move on a bill whose validity is running, and validity starts at Part B.
      CONSTRAINT active_has_validity CHECK (status <> 'ACTIVE' OR valid_until IS NOT NULL),
      CONSTRAINT cancelled_has_reason CHECK (
        status <> 'CANCELLED' OR (cancel_reason_code IS NOT NULL AND cancel_reason IS NOT NULL)
      )
    );

    -- One e-way bill per movement. This is the database's half of "raised once"; the service
    -- catches it earlier and returns the existing record instead of raising a second permit.
    CREATE UNIQUE INDEX eway_bills_one_per_movement_idx ON eway_bills(company_id, movement_id);
    -- An e-way bill number is unique across the country, so certainly within one company.
    CREATE UNIQUE INDEX eway_bills_number_idx ON eway_bills(company_id, eway_bill_number)
      WHERE eway_bill_number IS NOT NULL;
    -- What is on the road right now, and what runs out soonest: the dispatch desk's two questions.
    CREATE INDEX eway_bills_expiry_idx ON eway_bills(company_id, valid_until) WHERE status = 'ACTIVE';
    CREATE INDEX eway_bills_awaiting_vehicle_idx ON eway_bills(company_id, created_at)
      WHERE status IN ('PART_A_ONLY','PENDING','FAILED');

    -- One trip sheet, many consignments, one lorry. It replaces none of them: each consignment
    -- keeps its own number and its own expiry.
    CREATE TABLE eway_consolidated_trips (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      trip_number text NOT NULL,
      vehicle_number text NOT NULL,
      from_place text NOT NULL,
      from_state_code text NOT NULL,
      transport_mode text NOT NULL,
      eway_bill_numbers jsonb NOT NULL,
      message text NOT NULL,
      created_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (company_id, trip_number)
    );

    -- Per company and effective-dated, so a movement is judged under the rules of its own day.
    CREATE TABLE eway_bill_policies (
      company_id uuid NOT NULL REFERENCES companies(id),
      effective_from date NOT NULL,
      cancellation_window_hours integer NOT NULL CHECK (cancellation_window_hours > 0),
      rejection_window_hours integer NOT NULL CHECK (rejection_window_hours > 0),
      kilometres_per_day_regular integer NOT NULL CHECK (kilometres_per_day_regular > 0),
      kilometres_per_day_odc integer NOT NULL CHECK (kilometres_per_day_odc > 0),
      extension_window_hours integer NOT NULL CHECK (extension_window_hours > 0),
      set_by uuid NOT NULL REFERENCES users(id),
      set_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (company_id, effective_from)
    );

    -- The intra-state limits, per state and effective-dated, held as data rather than as code so a
    -- state changing its order is an insert. ₹1 lakh belongs to the states that set it, and the
    -- scope column is what stops it from being read as a national rule.
    CREATE TABLE eway_state_thresholds (
      state_code text NOT NULL,
      effective_from date NOT NULL,
      threshold_paise bigint NOT NULL CHECK (threshold_paise > 0),
      intra_city_exempt_any_value boolean NOT NULL DEFAULT false,
      source_ref text NOT NULL,
      note text,
      PRIMARY KEY (state_code, effective_from)
    );
  `,
  down: `
    DROP TABLE IF EXISTS eway_state_thresholds;
    DROP TABLE IF EXISTS eway_bill_policies;
    DROP TABLE IF EXISTS eway_consolidated_trips;
    DROP TABLE IF EXISTS eway_bills;
  `,
}, {
  // Issue #366 — what the PostgreSQL repositories of this lane need that the first three migrations
  // did not give them. One migration for the whole lane, because it runs after all three.
  id: "20261011T144920591Z_transport_ad4d8b8da9ec_postgres_repositories",
  up: `
    -- Issue #240 added the two PIN codes to the record after the table was made. They are part of
    -- the route, so they are fixed once the bill has a government number (they are not in the list
    -- of columns the freeze rule lets change).
    ALTER TABLE eway_bills ADD COLUMN from_pincode text, ADD COLUMN to_pincode text;
    -- The order rows were written in: what "list" returns them in, and what paging walks along.
    ALTER TABLE eway_bills ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
    ALTER TABLE eway_consolidated_trips ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
    -- For list() and its paging: one company's rows in the order they were written.
    CREATE UNIQUE INDEX eway_bills_company_seq_idx ON eway_bills(company_id, seq);
    -- For listActive(): what is on the road or waiting for a vehicle, in the same order.
    CREATE INDEX eway_bills_live_seq_idx ON eway_bills(company_id, seq) WHERE status IN ('ACTIVE','PART_A_ONLY');
    -- For the trips list() and its paging.
    CREATE UNIQUE INDEX eway_consolidated_trips_company_seq_idx ON eway_consolidated_trips(company_id, seq);

    -- A reconcile can find that the portal holds a cancellation we never made (the other party, or
    -- the portal's own screen). The service records that as CANCELLED with no reason of ours, which
    -- this check refused. A cancellation we make ourselves still carries its reason: the service
    -- will not send one without it.
    ALTER TABLE eway_bills DROP CONSTRAINT cancelled_has_reason;

    -- The portal answers a second movement carrying the same document with the bill it already
    -- holds (its duplicate reply, code 604), and the service keeps that number on both records
    -- rather than raising a second permit. A unique number per company refused exactly that.
    -- findByNumber() still reads by it, so it stays an index.
    DROP INDEX eway_bills_number_idx;
    CREATE INDEX eway_bills_number_idx ON eway_bills(company_id, eway_bill_number, seq) WHERE eway_bill_number IS NOT NULL;

    -- What the portal sent back, each time it answered, exactly as received: the number, its own
    -- timestamps, our time of receipt and the distance it counted. Append-only. The newest row for
    -- a bill is the bill's current acknowledgement; eway_bills keeps the number and the validity in
    -- its own columns for its checks and indexes.
    CREATE TABLE eway_bill_acknowledgements (
      seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      eway_bill_id uuid NOT NULL REFERENCES eway_bills(id),
      acknowledgement jsonb NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT now()
    );
    -- The newest answer for a bill (and the foreign key to the bill).
    CREATE INDEX eway_bill_acknowledgements_bill_idx ON eway_bill_acknowledgements(company_id, eway_bill_id, seq DESC);
    INSERT INTO eway_bill_acknowledgements (company_id, eway_bill_id, acknowledgement)
      SELECT company_id, id, jsonb_strip_nulls(jsonb_build_object(
          'ewayBillNumber', eway_bill_number, 'generatedAt', COALESCE(generated_at, ''),
          'validUntil', to_char(valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'providerRequestId', COALESCE(provider_request_id, ''), 'alert', alert,
          'receivedAt', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
        FROM eway_bills WHERE eway_bill_number IS NOT NULL ORDER BY seq;
    CREATE TRIGGER eway_bill_acknowledgements_frozen BEFORE UPDATE OR DELETE ON eway_bill_acknowledgements
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('', '*', '', '');
    CREATE TRIGGER eway_bill_acknowledgements_no_truncate BEFORE TRUNCATE ON eway_bill_acknowledgements
      FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();

    -- A lorry can be checked, changed for another and changed back: the third check has the facts
    -- of the first and is still a new check, and the newest one is what the dispatch desk sees. The
    -- service already returns the existing check when the newest one has the same facts; a unique
    -- key over every check of the movement refused the third.
    ALTER TABLE vehicle_suitability_checks DROP CONSTRAINT vehicle_suitability_checks_company_id_movement_id_idempoten_key;
    ALTER TABLE vehicle_suitability_checks ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
    -- Whether the movement may go: nothing blocking or undecided is left unanswered.
    ALTER TABLE vehicle_suitability_checks ADD COLUMN cleared_to_move boolean;
    UPDATE vehicle_suitability_checks c SET cleared_to_move = NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(c.findings) f
       WHERE f->>'severity' IN ('BLOCK','CANNOT_DECIDE')
         AND NOT EXISTS (SELECT 1 FROM vehicle_suitability_overrides o WHERE o.check_id = c.id AND o.finding_codes ? (f->>'code')));
    ALTER TABLE vehicle_suitability_checks ALTER COLUMN cleared_to_move SET NOT NULL;
    -- For list() and its paging.
    CREATE UNIQUE INDEX vehicle_suitability_checks_company_seq_idx ON vehicle_suitability_checks(company_id, seq);
    -- For findLatestForMovement(): the newest check of one movement, by the order they were written.
    CREATE INDEX vehicle_suitability_latest_idx ON vehicle_suitability_checks(company_id, movement_id, seq DESC);
    -- For listBlocked(): the dispatch desk's queue.
    CREATE INDEX vehicle_suitability_not_cleared_idx ON vehicle_suitability_checks(company_id, seq) WHERE NOT cleared_to_move;
    -- The order overrides were given in. Unique, so two people answering the same check at the same
    -- moment cannot both take the same place: the second is told the check has changed.
    ALTER TABLE vehicle_suitability_overrides ADD COLUMN position integer;
    UPDATE vehicle_suitability_overrides o SET position = n.position FROM (
      SELECT id, row_number() OVER (PARTITION BY check_id ORDER BY overridden_at, id) - 1 AS position FROM vehicle_suitability_overrides) n
     WHERE n.id = o.id;
    ALTER TABLE vehicle_suitability_overrides ALTER COLUMN position SET NOT NULL;
    ALTER TABLE vehicle_suitability_overrides ADD CONSTRAINT vehicle_suitability_overrides_place UNIQUE (check_id, position);

    -- The application may not delete. "Forgetting" a reading therefore empties it: every fact and
    -- the provider's reference are blanked and this is set. The vehicle number stays as the key.
    ALTER TABLE vehicle_records ADD COLUMN forgotten_at timestamptz;

    -- How long a stored reading may be reused and when it counts as stale. Per company and
    -- effective-dated, like the other policies; the in-memory port had no table behind it.
    CREATE TABLE vehicle_record_freshness_policies (
      company_id uuid NOT NULL REFERENCES companies(id),
      effective_from date NOT NULL,
      reuse_within_hours integer NOT NULL CHECK (reuse_within_hours >= 0),
      stale_after_days integer NOT NULL CHECK (stale_after_days >= 0),
      set_by uuid NOT NULL REFERENCES users(id),
      set_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (company_id, effective_from)
    );
${TENANT_TABLES.map((table) => `
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
    CREATE POLICY ${table}_tenant ON ${table}
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);`).join("")}
  `,
  down: `
${TENANT_TABLES.map((table) => `
    DROP POLICY IF EXISTS ${table}_tenant ON ${table};
    ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`).join("")}
    DROP TABLE IF EXISTS vehicle_record_freshness_policies;
    ALTER TABLE vehicle_records DROP COLUMN IF EXISTS forgotten_at;
    ALTER TABLE vehicle_suitability_overrides DROP CONSTRAINT IF EXISTS vehicle_suitability_overrides_place;
    ALTER TABLE vehicle_suitability_overrides DROP COLUMN IF EXISTS position;
    DROP INDEX IF EXISTS vehicle_suitability_not_cleared_idx;
    DROP INDEX IF EXISTS vehicle_suitability_latest_idx;
    DROP INDEX IF EXISTS vehicle_suitability_checks_company_seq_idx;
    ALTER TABLE vehicle_suitability_checks DROP COLUMN IF EXISTS cleared_to_move, DROP COLUMN IF EXISTS seq;
    -- Fails, rightly, if a movement was checked twice on the same facts while the rule was away.
    ALTER TABLE vehicle_suitability_checks ADD CONSTRAINT vehicle_suitability_checks_company_id_movement_id_idempoten_key
      UNIQUE (company_id, movement_id, idempotency_key);
    DROP TABLE IF EXISTS eway_bill_acknowledgements;
    -- NOT VALID: a cancellation found on the portal while the rule was away is left as it is.
    ALTER TABLE eway_bills ADD CONSTRAINT cancelled_has_reason CHECK (
      status <> 'CANCELLED' OR (cancel_reason_code IS NOT NULL AND cancel_reason IS NOT NULL)
    ) NOT VALID;
    DROP INDEX IF EXISTS eway_bills_number_idx;
    -- Fails, rightly, if two movements came to share a number while the rule was away.
    CREATE UNIQUE INDEX eway_bills_number_idx ON eway_bills(company_id, eway_bill_number) WHERE eway_bill_number IS NOT NULL;
    DROP INDEX IF EXISTS eway_consolidated_trips_company_seq_idx;
    DROP INDEX IF EXISTS eway_bills_live_seq_idx;
    DROP INDEX IF EXISTS eway_bills_company_seq_idx;
    ALTER TABLE eway_consolidated_trips DROP COLUMN IF EXISTS seq;
    ALTER TABLE eway_bills DROP COLUMN IF EXISTS seq, DROP COLUMN IF EXISTS to_pincode, DROP COLUMN IF EXISTS from_pincode;
  `,
}]);
