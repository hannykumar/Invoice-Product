import type { Migration } from '../../platform/src/migration-definitions.ts';

/**
 * Issue #42 [E42] — the schema.
 *
 * Two things are load-bearing here. `subscription_usage_events` has a unique key on
 * `(company_id, idempotency_key)`, which is what makes concurrent recording safe in PostgreSQL the
 * way "no `await` between read and write" makes it safe in memory. And there is **no** cascade
 * delete anywhere: a lapsed subscription must not be able to take a business's records with it.
 */
export const subscriptionMigrations: readonly Migration[] = [{
  id: '20260831T105438036Z_subscriptions_899e8d5e22bc_plans_entitlements_and_usage',
  up: `
    CREATE TABLE subscriptions (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL UNIQUE REFERENCES companies(id),
      plan_id text NOT NULL,
      started_on date NOT NULL,
      trial_ends_on date NOT NULL,
      paid_through date,
      cancelled_on date,
      cancellation_reason text,
      history jsonb NOT NULL DEFAULT '[]',
      updated_at timestamptz NOT NULL,
      updated_by text NOT NULL
    );
    CREATE TABLE subscription_usage_events (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      meter text NOT NULL CHECK (meter IN ('invoices','companies','storage_mb','ai_requests','external_api_calls')),
      quantity bigint NOT NULL CHECK (quantity > 0),
      period text NOT NULL,
      idempotency_key text NOT NULL,
      note text NOT NULL,
      recorded_at timestamptz NOT NULL,
      recorded_by text NOT NULL
    );
    -- The whole of "usage is concurrency safe": two tills recording the same bill collide here.
    CREATE UNIQUE INDEX subscription_usage_once_idx ON subscription_usage_events(company_id, idempotency_key);
    CREATE INDEX subscription_usage_period_idx ON subscription_usage_events(company_id, meter, period);
    CREATE TABLE subscription_service_invoices (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      plan_id text NOT NULL,
      period text NOT NULL,
      net_paise bigint NOT NULL CHECK (net_paise >= 0),
      gst_paise bigint NOT NULL CHECK (gst_paise >= 0),
      total_paise bigint NOT NULL CHECK (total_paise >= 0),
      state text NOT NULL CHECK (state IN ('DRAFT','ISSUED','PAID','FAILED')),
      issued_on date NOT NULL,
      due_on date NOT NULL,
      paid_on date,
      provider_reference text,
      failure_reason text
    );
    CREATE UNIQUE INDEX subscription_invoice_period_idx ON subscription_service_invoices(company_id, period);
    CREATE TABLE subscription_payment_events (
      company_id uuid NOT NULL REFERENCES companies(id),
      event_id text NOT NULL,
      invoice_id uuid NOT NULL REFERENCES subscription_service_invoices(id),
      outcome text NOT NULL CHECK (outcome IN ('PAID','FAILED')),
      received_at timestamptz NOT NULL,
      PRIMARY KEY (company_id, event_id)
    );
    ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
    ALTER TABLE subscription_usage_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE subscription_usage_events FORCE ROW LEVEL SECURITY;
    ALTER TABLE subscription_service_invoices ENABLE ROW LEVEL SECURITY;
    ALTER TABLE subscription_service_invoices FORCE ROW LEVEL SECURITY;
    ALTER TABLE subscription_payment_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE subscription_payment_events FORCE ROW LEVEL SECURITY;
  `,
  down: `
    DROP TABLE IF EXISTS subscription_payment_events;
    DROP TABLE IF EXISTS subscription_service_invoices;
    DROP TABLE IF EXISTS subscription_usage_events;
    DROP TABLE IF EXISTS subscriptions;
  `,
}];
