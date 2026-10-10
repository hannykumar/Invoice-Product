export interface Migration { id: string; up: string; down: string; }

// Each module keeps its schema next to its code. The combined registry is sorted by ID,
// so generated timestamp IDs give fresh and upgraded databases the same global order.
import { masterDataMigrations } from "../../masters/src/migrations.ts";
import { purchasePostingMigrations } from "../../purchasing/src/posting-migrations.ts";
import { purchaseMatchingMigrations } from "../../purchasing/src/matching-migrations.ts";
import { supplierRiskMigrations } from "../../purchasing/src/supplier-risk-migrations.ts";
import { eInvoiceMigrations } from "../../gst/src/einvoice-migrations.ts";
import { gstReturnMigrations } from "../../gst-returns/src/migrations.ts";
import { itcMigrations } from "../../itc/src/migrations.ts";
import { complianceCalendarMigrations } from "../../compliance-calendar/src/migrations.ts";
import { gspMigrations } from "../../gsp/src/migrations.ts";
import { returnMigrations } from "../../returns/src/migrations.ts";
import { ledgerMigrations } from "../../ledger/src/migrations.ts";
import { ewayBillMigrations } from "../../transport/src/migrations.ts";
import { collectionMigrations } from "../../collections/src/migrations.ts";
import { bankFeedMigrations } from "../../bank-feeds/src/migrations.ts";
import { subscriptionMigrations } from "../../subscriptions/src/migrations.ts";
import { vehicleSuitabilityMigrations } from "../../transport/src/suitability-migrations.ts";
import { vehicleRecordMigrations } from "../../transport/src/vehicle-record-migrations.ts";
import { securityMigrations } from "../../../ops/security/src/migrations.ts";
import { operationsMigrations } from "../../../ops/operations/src/migrations.ts";
import { notificationMigrations } from "./notification-migrations.ts";
import { immutabilityMigrations } from "./immutability-migrations.ts";

const platformMigrations: readonly Migration[] = [{
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
}, {
  id: "0002_authentication_sessions_and_invitations",
  up: `
    CREATE TABLE user_branch_access (company_id uuid NOT NULL, user_id uuid NOT NULL, branch_id uuid NOT NULL REFERENCES branches(id), PRIMARY KEY(company_id, user_id, branch_id), FOREIGN KEY(company_id, user_id) REFERENCES memberships(company_id, user_id));
    CREATE TABLE sessions (id uuid PRIMARY KEY, company_id uuid NOT NULL, branch_id uuid NOT NULL REFERENCES branches(id), user_id uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE invitations (id uuid PRIMARY KEY, token_hash text NOT NULL UNIQUE, company_id uuid NOT NULL REFERENCES companies(id), branch_id uuid NOT NULL REFERENCES branches(id), email text NOT NULL, permissions jsonb NOT NULL, expires_at timestamptz NOT NULL, accepted_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX sessions_active_idx ON sessions(company_id, user_id) WHERE revoked_at IS NULL;
    CREATE INDEX invitations_active_idx ON invitations(company_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
  `,
  down: `
    DROP TABLE IF EXISTS invitations;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS user_branch_access;
  `,
}, {
  id: "0003_approvals_commands_and_exception_evidence",
  up: `
    CREATE TABLE command_records (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), branch_id uuid NOT NULL REFERENCES branches(id), actor_id uuid NOT NULL REFERENCES users(id), action text NOT NULL, risk text NOT NULL, amount_paise bigint, status text NOT NULL, idempotency_key text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(company_id, action, idempotency_key));
    CREATE TABLE approval_policies (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), action text NOT NULL, minimum_risk text NOT NULL, minimum_amount_paise bigint, required_permission text NOT NULL, active boolean NOT NULL DEFAULT true);
    CREATE TABLE exception_comments (id uuid PRIMARY KEY, exception_id uuid NOT NULL REFERENCES exception_items(id), actor_id uuid NOT NULL REFERENCES users(id), body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
  `,
  down: `DROP TABLE IF EXISTS exception_comments; DROP TABLE IF EXISTS approval_policies; DROP TABLE IF EXISTS command_records;`,
}, {
  id: "0004_bank_statement_imports",
  up: `
    CREATE TABLE bank_statement_imports (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), file_name text NOT NULL, source_format text NOT NULL CHECK (source_format IN ('csv', 'xlsx', 'pdf-text')), file_fingerprint text NOT NULL, opening_balance_paise bigint, closing_balance_paise bigint, computed_closing_balance_paise bigint, balance_status text NOT NULL CHECK (balance_status IN ('not-provided', 'matched', 'mismatch')), review_reasons jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(company_id, file_fingerprint));
    CREATE TABLE bank_statement_transactions (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), statement_import_id uuid NOT NULL REFERENCES bank_statement_imports(id), booked_on date NOT NULL, description text NOT NULL, debit_paise bigint NOT NULL DEFAULT 0 CHECK (debit_paise >= 0), credit_paise bigint NOT NULL DEFAULT 0 CHECK (credit_paise >= 0), reference text, source_location text NOT NULL, fingerprint text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), CHECK ((debit_paise = 0) <> (credit_paise = 0)), UNIQUE(company_id, fingerprint));
    CREATE INDEX bank_statement_transactions_import_idx ON bank_statement_transactions(statement_import_id, booked_on);
    CREATE INDEX bank_statement_imports_company_created_idx ON bank_statement_imports(company_id, created_at DESC);
  `,
  down: `DROP TABLE IF EXISTS bank_statement_transactions; DROP TABLE IF EXISTS bank_statement_imports;`,
}, {
  id: "0005_bank_statement_pdf_sources",
  up: `ALTER TABLE bank_statement_imports DROP CONSTRAINT bank_statement_imports_source_format_check; ALTER TABLE bank_statement_imports ADD CONSTRAINT bank_statement_imports_source_format_check CHECK (source_format IN ('csv', 'xlsx', 'pdf-text', 'pdf'));`,
  down: `ALTER TABLE bank_statement_imports DROP CONSTRAINT bank_statement_imports_source_format_check; ALTER TABLE bank_statement_imports ADD CONSTRAINT bank_statement_imports_source_format_check CHECK (source_format IN ('csv', 'xlsx', 'pdf-text'));`,
}, {
  id: "20260829T011306950Z_platform_44b9a0b0746b_bank_import_status",
  up: `ALTER TABLE bank_statement_imports ADD COLUMN status text; UPDATE bank_statement_imports SET status = CASE WHEN jsonb_array_length(review_reasons) > 0 THEN 'needs-review' ELSE 'ready' END; ALTER TABLE bank_statement_imports ALTER COLUMN status SET NOT NULL; ALTER TABLE bank_statement_imports ADD CONSTRAINT bank_statement_imports_status_check CHECK (status IN ('ready', 'needs-review'));`,
  down: `ALTER TABLE bank_statement_imports DROP COLUMN status;`,
}, {
  // Issue #363 — the transactional outbox. Rows are written inside the action's unit of work, so a
  // rolled-back bill never reaches the government, WhatsApp or email. See ADR 0363.
  id: "20261007T135804017Z_platform_e5d2182441c6_transactional_outbox",
  up: `
    CREATE TABLE outbox_messages (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      topic text NOT NULL CHECK (topic <> ''),
      dedupe_key text NOT NULL CHECK (dedupe_key <> ''),
      payload jsonb NOT NULL,
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      available_at timestamptz NOT NULL DEFAULT now(),
      claim_token uuid,
      sent_at timestamptz,
      dead_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT outbox_messages_dedupe UNIQUE (company_id, topic, dedupe_key),
      CONSTRAINT outbox_messages_sent_or_dead CHECK (sent_at IS NULL OR dead_at IS NULL)
    );
    CREATE INDEX outbox_messages_due_idx ON outbox_messages (company_id, available_at) WHERE sent_at IS NULL AND dead_at IS NULL;
    ALTER TABLE outbox_messages ENABLE ROW LEVEL SECURITY;
    ALTER TABLE outbox_messages FORCE ROW LEVEL SECURITY;
    CREATE POLICY outbox_messages_tenant ON outbox_messages
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
  `,
  down: `DROP TABLE IF EXISTS outbox_messages;`,
}, {
  // Issue #364 — the order things were written in, kept by the database. Two audit events or two
  // comments saved in one transaction share a timestamp, so the timestamp alone cannot order them.
  id: "20261010T133137619Z_platform_cca2b2c00eb5_platform_core_ordering",
  up: `
    ALTER TABLE audit_events ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
    CREATE UNIQUE INDEX audit_events_company_seq_idx ON audit_events(company_id, seq);
    ALTER TABLE exception_comments ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
    CREATE INDEX exception_comments_exception_seq_idx ON exception_comments(exception_id, seq);
    CREATE INDEX sessions_user_idx ON sessions(user_id);
  `,
  down: `
    DROP INDEX IF EXISTS sessions_user_idx;
    DROP INDEX IF EXISTS exception_comments_exception_seq_idx;
    ALTER TABLE exception_comments DROP COLUMN IF EXISTS seq;
    DROP INDEX IF EXISTS audit_events_company_seq_idx;
    ALTER TABLE audit_events DROP COLUMN IF EXISTS seq;
  `,
}];

export const migrations: readonly Migration[] = Object.freeze(
  [...platformMigrations, ...immutabilityMigrations, ...masterDataMigrations, ...notificationMigrations, ...securityMigrations, ...operationsMigrations, ...purchasePostingMigrations, ...purchaseMatchingMigrations, ...supplierRiskMigrations, ...eInvoiceMigrations, ...gstReturnMigrations, ...itcMigrations, ...complianceCalendarMigrations, ...gspMigrations, ...returnMigrations, ...ledgerMigrations, ...ewayBillMigrations, ...vehicleSuitabilityMigrations, ...vehicleRecordMigrations, ...collectionMigrations, ...bankFeedMigrations, ...subscriptionMigrations].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
);
