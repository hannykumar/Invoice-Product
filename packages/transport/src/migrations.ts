// Issue #27 [E27] — the tables the e-way bill lifecycle owns.
//
// The sales invoice and the delivery challan belong to #9 and #18 and are not created here; only
// the movement's own id and the document number are stored, so an e-way bill can be traced to the
// goods it permitted without this migration depending on another module's SQL having landed.

import type { Migration } from "../../platform/src/migration-definitions.ts";

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
}]);
