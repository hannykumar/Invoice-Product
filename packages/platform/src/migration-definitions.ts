export interface Migration { id: string; up: string; down: string; }

export const migrations: readonly Migration[] = [{
  id: "0001_platform_foundation",
  up: `
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE companies (id uuid PRIMARY KEY, legal_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE branches (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(company_id, name));
    CREATE TABLE users (id uuid PRIMARY KEY, email text NOT NULL UNIQUE, display_name text NOT NULL, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE memberships (company_id uuid NOT NULL REFERENCES companies(id), user_id uuid NOT NULL REFERENCES users(id), permissions jsonb NOT NULL DEFAULT '[]', active boolean NOT NULL DEFAULT true, PRIMARY KEY(company_id, user_id));
    CREATE TABLE audit_events (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), actor_id uuid NOT NULL REFERENCES users(id), action text NOT NULL, correlation_id text NOT NULL, before_json jsonb, after_json jsonb, reason text, occurred_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE idempotency_keys (company_id uuid NOT NULL REFERENCES companies(id), action text NOT NULL, key text NOT NULL, payload_hash text NOT NULL, result_json jsonb, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id, action, key));
    CREATE TABLE exception_items (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), status text NOT NULL CHECK (status IN ('open','resolved','dismissed')), summary text NOT NULL, evidence jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX audit_events_company_occurred_idx ON audit_events(company_id, occurred_at DESC);
    CREATE INDEX exception_items_company_status_idx ON exception_items(company_id, status);
  `,
  down: `
    DROP TABLE IF EXISTS exception_items;
    DROP TABLE IF EXISTS idempotency_keys;
    DROP TABLE IF EXISTS audit_events;
    DROP TABLE IF EXISTS memberships;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS branches;
    DROP TABLE IF EXISTS companies;
  `,
}];
