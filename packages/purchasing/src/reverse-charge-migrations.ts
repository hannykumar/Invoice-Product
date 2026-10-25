// Issue #289, part 2b — the reverse-charge register's tables (see reverse-charge-register.ts).
//
// Both are written once and never changed (#368's rule, applied with the same trigger function every
// document table uses): a reverse-charge purchase is a fact about a posted bill, and a self-invoice,
// once issued, is a tax invoice under CGST s.31(3)(f) — corrected, like any invoice, only by a note.
// The bill itself (`purchase_bills`) is referenced; its figures are not copied except as the frozen
// lines a Rule 46 invoice must print.

import type { Migration } from "../../platform/src/migration-definitions.ts";
import { enforceTenant, releaseTenant } from "./tenant-policy.ts";

const TABLES = ["purchase_reverse_charge", "purchase_self_invoices"];

const frozen = (table: string): string => `
    CREATE TRIGGER ${table}_frozen BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('', '*', '', '');
    CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table}
      FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();`;

export const reverseChargeMigrations: readonly Migration[] = Object.freeze([{
  id: "20261021T200006656Z_purchasing_134952d2c07f_reverse_charge_register",
  up: `
    -- One row per posted bill on which we pay the GST (CGST s.9(3)): the facts its time of supply
    -- turns on (s.12(3) goods, s.13(3) services) and the lines a self-invoice prints.
    CREATE TABLE purchase_reverse_charge (
      company_id uuid NOT NULL REFERENCES companies(id),
      bill_id uuid NOT NULL REFERENCES purchase_bills(id),
      supplier_party_id uuid NOT NULL REFERENCES master_records(id),
      supplier jsonb NOT NULL,
      -- false: the supplier is not registered (or only for TDS), so we issue the invoice (s.31(3)(f)).
      supplier_registered boolean NOT NULL,
      supply_kind text NOT NULL CHECK (supply_kind IN ('GOODS','SERVICES')),
      invoice_number text NOT NULL,
      invoice_date date NOT NULL,
      received_on date NOT NULL,
      entered_on date NOT NULL,
      inter_state boolean NOT NULL,
      lines jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) > 0),
      recorded_by uuid NOT NULL REFERENCES users(id),
      recorded_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (company_id, bill_id)
    );
    CREATE INDEX purchase_reverse_charge_unregistered_idx ON purchase_reverse_charge(company_id, received_on) WHERE NOT supplier_registered;

    -- Our own invoice for a purchase from an unregistered supplier: one per bill, numbered in its own
    -- series, at most 16 characters of letters, digits, hyphen and slash, unique for the financial
    -- year (CGST Rule 46(b)); issued within 30 days of receipt (Rule 47A).
    CREATE TABLE purchase_self_invoices (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      bill_id uuid NOT NULL,
      number text NOT NULL CHECK (number ~ '^[A-Za-z0-9/-]{1,16}$'),
      financial_year text NOT NULL CHECK (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
      sequence integer NOT NULL CHECK (sequence > 0),
      issued_on date NOT NULL,
      received_on date NOT NULL,
      supplier jsonb NOT NULL,
      recipient jsonb NOT NULL,
      place_of_supply jsonb NOT NULL,
      inter_state boolean NOT NULL,
      lines jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) > 0),
      taxable_value_paise bigint NOT NULL CHECK (taxable_value_paise >= 0),
      cgst_paise bigint NOT NULL DEFAULT 0 CHECK (cgst_paise >= 0),
      sgst_paise bigint NOT NULL DEFAULT 0 CHECK (sgst_paise >= 0),
      igst_paise bigint NOT NULL DEFAULT 0 CHECK (igst_paise >= 0),
      cess_paise bigint NOT NULL DEFAULT 0 CHECK (cess_paise >= 0),
      issued_by uuid NOT NULL REFERENCES users(id),
      issued_at timestamptz NOT NULL DEFAULT now(),
      idempotency_key text NOT NULL,
      -- Not before the goods arrived: it is issued for what was received (s.31(3)(f)).
      CHECK (issued_on >= received_on),
      FOREIGN KEY (company_id, bill_id) REFERENCES purchase_reverse_charge(company_id, bill_id),
      UNIQUE (company_id, bill_id),
      UNIQUE (company_id, financial_year, sequence),
      UNIQUE (company_id, number),
      UNIQUE (company_id, idempotency_key)
    );
    ${TABLES.map(frozen).join("")}
    ${enforceTenant(TABLES)}
    -- Rows are added, never changed: the triggers refuse it, and the application is not even granted it.
    REVOKE UPDATE ON ${TABLES.join(", ")} FROM invoice_app;
  `,
  down: `
    ${releaseTenant([...TABLES].reverse())}
    DROP TABLE IF EXISTS purchase_self_invoices;
    DROP TABLE IF EXISTS purchase_reverse_charge;
  `,
}]);
