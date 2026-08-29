// Issue #26 [E26] — the tables the e-invoice lifecycle owns.
//
// The sales invoice itself belongs to #9 and is not created here; only its id is stored, so a
// registered e-invoice can be traced to the bill it reports without this migration depending on
// another module's SQL having landed. Same reasoning as #17's and #18's.

import type { Migration } from "../../platform/src/migration-definitions.ts";

export const eInvoiceMigrations: readonly Migration[] = Object.freeze([{
  id: "20260829T214047787Z_gst_beb95a52fde7_einvoice_irn_lifecycle",
  up: `
    CREATE TABLE e_invoices (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      document_id uuid NOT NULL,
      document_number text NOT NULL,
      document_date date NOT NULL,
      document_type text NOT NULL CHECK (document_type IN ('INVOICE','CREDIT_NOTE','DEBIT_NOTE')),
      supplier_gstin text NOT NULL,
      recipient_gstin text,
      financial_year text NOT NULL,
      -- A bill and a registered e-invoice are different documents. This column is the difference,
      -- and nothing outside this module may infer "registered" from anything else.
      status text NOT NULL CHECK (status IN ('NOT_APPLICABLE','PENDING','REGISTERED','CANCELLED','FAILED')),
      -- The decision, its rule and the notification behind it, so it is explainable years later.
      applicability jsonb NOT NULL,
      irn text,
      ack_number text,
      ack_date text,
      -- The government's signature over the invoice. Stored verbatim and never regenerated.
      signed_qr_code text,
      signed_invoice text,
      eway_bill_number text,
      provider_request_id text,
      acknowledged_at timestamptz,
      failure_code text,
      failure_message text,
      failure_retryable boolean,
      cancellable_until timestamptz,
      reportable_until date,
      cancelled_at timestamptz,
      cancel_reason_code text CHECK (cancel_reason_code IN ('DUPLICATE','DATA_ENTRY_MISTAKE','ORDER_CANCELLED','OTHER')),
      cancel_reason text,
      message text NOT NULL,
      created_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      idempotency_key text NOT NULL,
      -- Nothing may be called registered without the reply that proves it.
      CONSTRAINT registered_has_acknowledgement CHECK (
        status <> 'REGISTERED' OR (irn IS NOT NULL AND ack_number IS NOT NULL AND signed_qr_code IS NOT NULL)
      ),
      CONSTRAINT cancelled_has_reason CHECK (
        status <> 'CANCELLED' OR (cancel_reason_code IS NOT NULL AND cancel_reason IS NOT NULL)
      )
    );

    -- One e-invoice per sales document. This is the database's half of "submitted once"; the
    -- service catches it earlier and returns the existing record instead of submitting again.
    CREATE UNIQUE INDEX e_invoices_one_per_document_idx ON e_invoices(company_id, document_id);
    -- An IRN is unique across the whole country, so it certainly is within one company.
    CREATE UNIQUE INDEX e_invoices_irn_idx ON e_invoices(company_id, irn) WHERE irn IS NOT NULL;
    CREATE INDEX e_invoices_cancellable_idx ON e_invoices(company_id, cancellable_until)
      WHERE status = 'REGISTERED';
    -- Applicable documents not yet reported: what a deadline reminder reads.
    CREATE INDEX e_invoices_awaiting_idx ON e_invoices(company_id, reportable_until)
      WHERE status IN ('PENDING','FAILED');

    -- Per company and effective-dated, so a decision is explained under the rules of its own day.
    CREATE TABLE e_invoice_policies (
      company_id uuid NOT NULL REFERENCES companies(id),
      effective_from date NOT NULL,
      cancellation_window_hours integer NOT NULL CHECK (cancellation_window_hours > 0),
      reporting_window_days integer CHECK (reporting_window_days > 0),
      verify_irn_hash boolean NOT NULL DEFAULT true,
      set_by uuid NOT NULL REFERENCES users(id),
      set_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (company_id, effective_from)
    );

    -- The turnover facts an applicability decision needs, effective-dated per company, because
    -- turnover is stated for a financial year and changes the answer from one year to the next.
    CREATE TABLE e_invoice_supplier_facts (
      company_id uuid NOT NULL REFERENCES companies(id),
      financial_year text NOT NULL,
      aggregate_turnover_paise bigint CHECK (aggregate_turnover_paise >= 0),
      exempt_categories jsonb NOT NULL DEFAULT '[]',
      mandated_by_department boolean NOT NULL DEFAULT false,
      stated_by uuid NOT NULL REFERENCES users(id),
      stated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (company_id, financial_year)
    );
  `,
  down: `
    DROP TABLE IF EXISTS e_invoice_supplier_facts;
    DROP TABLE IF EXISTS e_invoice_policies;
    DROP TABLE IF EXISTS e_invoices;
  `,
}]);
