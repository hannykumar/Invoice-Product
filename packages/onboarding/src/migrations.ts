// Issue #366 (lane: GPT 2, #49) — where a half-finished setup is kept, so it survives a restart.
//
// One row per setup. The answers and step states are kept as the service holds them (jsonb),
// because a setup is read and written whole, one step at a time, and never queried by field.
//
//   - Row-level security, forced: a setup is seen only inside its own company's transaction.
//   - One setup in progress per business, and one per idempotency key, held by the database.
//   - A finished setup never changes again (`platform_freeze_posted`, #368); changes after that
//     are made in settings.
import type { Migration } from "../../platform/src/migration-definitions.ts";
import { tenantPolicy } from "../../platform/src/immutability-migrations.ts";

const STEPS = ["business", "tax_profile", "branding", "items", "rates", "opening_balances", "ready"];
const STEP_STATES = ["NOT_STARTED", "IN_PROGRESS", "NEEDS_ATTENTION", "DONE", "SKIPPED"];

export const onboardingMigrations: readonly Migration[] = Object.freeze([{
  id: "20261025T105159283Z_onboarding_39ba3e148eca_onboarding_sessions",
  up: `
    CREATE TABLE onboarding_sessions (
      seq bigint GENERATED ALWAYS AS IDENTITY,
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      idempotency_key text NOT NULL CHECK (btrim(idempotency_key) <> ''),
      state text NOT NULL CHECK (state IN ('IN_PROGRESS','COMPLETED')),
      -- Every step, and only a state the service knows, for each.
      steps jsonb NOT NULL CHECK (
        jsonb_typeof(steps) = 'object'
        AND steps ?& ARRAY[${STEPS.map((s) => `'${s}'`).join(",")}]
        AND NOT jsonb_path_exists(steps, '$.* ? (!(${STEP_STATES.map((s) => `@.state == "${s}"`).join(" || ")}))')
      ),
      answers jsonb NOT NULL CHECK (jsonb_typeof(answers) = 'object'),
      created_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL CHECK (updated_at >= created_at),
      -- Set only by finishing, and then to an opening entry of this company's own books.
      opening_voucher_id uuid,
      version integer NOT NULL CHECK (version >= 1),
      CHECK (opening_voucher_id IS NULL OR state = 'COMPLETED'),
      UNIQUE (company_id, idempotency_key),
      FOREIGN KEY (company_id, opening_voucher_id) REFERENCES voucher (company_id, id)
    );
    CREATE UNIQUE INDEX onboarding_sessions_one_open ON onboarding_sessions (company_id) WHERE state = 'IN_PROGRESS';
    CREATE TRIGGER onboarding_sessions_frozen BEFORE UPDATE OR DELETE ON onboarding_sessions
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('state', 'COMPLETED', '', '');
    CREATE TRIGGER onboarding_sessions_no_truncate BEFORE TRUNCATE ON onboarding_sessions
      FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();
${tenantPolicy("onboarding_sessions")}
  `,
  down: `DROP TABLE IF EXISTS onboarding_sessions;`,
}]);
