// Issue #33 [E33] — the tables the authorised government channel owns.
//
// Five things about this schema are deliberate.
//
//   1. **There is no column for a portal password, anywhere.** Not encrypted, not hashed, not
//      "temporarily". What is stored is an opaque vault reference (#8 resolves it) and, while an
//      onboarding is in flight, the id of a one-time-password challenge — never its value. A schema
//      with nowhere to put a secret is the only kind that cannot leak one.
//   2. **The authorisation is keyed on (company, GSTIN).** A business with two registrations has
//      two rows, with separate consent, credentials, scopes and expiry. The unique index is what
//      makes "each GSTIN has separate authorisation state" true in the database rather than in a
//      code path somebody may later route around.
//   3. **Consent and credentials are append-only histories.** Revocation writes a withdrawal on the
//      consent and moves the credential into history; it deletes nothing. A business is entitled to
//      know what was done in its name and under which credential, long after it disconnects.
//   4. **Every call is a row, including the ones we refused to make.** "We did not send this, and
//      here is why" is exactly the record somebody needs when an invoice never reached the portal.
//      Refusals that leave no trace are how a silent integration failure lasts a month.
//   5. **An unanswered call stays unanswered.** `outcome` has no 'FAILED'. A timeout is `UNKNOWN`
//      until the government's own answer settles it, because a timeout recorded as a failure is how
//      a business ends up with two IRNs for one invoice.

import type { Migration } from "../../platform/src/migration-definitions.ts";
import { tenantPolicy } from "../../platform/src/immutability-migrations.ts";

/**
 * Issue #366 — the tables of this module that hold one company's rows and are read through
 * `tenantTransaction`. `government_webhook_events` is not here on purpose: a callback arrives with
 * no company, so it is matched and deduplicated across companies (government-access-v1,
 * "Storage"). It waits for #345.
 */
const TENANT_TABLES = ["gstin_authorisations", "gstin_consents", "gsp_credentials", "gsp_otp_challenges", "government_calls"] as const;
/** Tables the application may add to but never empty. */
const NO_TRUNCATE = ["government_calls", "gstin_consents", "gsp_credentials"] as const;

export const gspMigrations: readonly Migration[] = Object.freeze([{
  id: "20260901T080422517Z_gsp_f0f2809c30ed_government_access",
  up: `
    -- One row per GST number a business has connected. Never one row per company.
    CREATE TABLE gstin_authorisations (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      gstin text NOT NULL CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$'),
      legal_name text NOT NULL,
      status text NOT NULL CHECK (status IN ('NOT_STARTED','API_USER_PENDING','OTP_REQUESTED','ACTIVE','EXPIRED','SUSPENDED','REVOKED')),
      provider text NOT NULL,
      environment text NOT NULL CHECK (environment IN ('SANDBOX','PRODUCTION')),
      -- What the business agreed to, act by act. An empty list authorises nothing.
      scopes text[] NOT NULL DEFAULT '{}',
      -- The provider's user id for this GST number. Not a secret; useful in a support call.
      api_user_id text,
      -- A vault address, resolved by #8. Never a credential, and never a portal password.
      credential_reference text,
      credential_issued_at timestamptz,
      credential_expires_at timestamptz,
      -- The portal session's own validity, which is a different clock from the credential's.
      valid_until timestamptz,
      suspended_reason text,
      revoked_at timestamptz,
      revoked_by uuid REFERENCES users(id),
      revocation_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      -- Taking a permission back is never anonymous and never unexplained.
      CHECK (revoked_at IS NULL OR (revoked_by IS NOT NULL AND revocation_reason IS NOT NULL)),
      -- A revoked or suspended authorisation holds no live credential.
      CHECK (status NOT IN ('REVOKED') OR credential_reference IS NULL),
      UNIQUE (company_id, gstin)
    );

    -- The consent itself, append-only. The wording is stored, not referenced: the sentence on the
    -- screen is what the person agreed to, and a version pointing at edited text proves nothing.
    CREATE TABLE gstin_consents (
      id uuid PRIMARY KEY,
      authorisation_id uuid NOT NULL REFERENCES gstin_authorisations(id),
      company_id uuid NOT NULL REFERENCES companies(id),
      scopes text[] NOT NULL,
      wording_shown jsonb NOT NULL,
      method text NOT NULL CHECK (method IN ('PORTAL_OTP','SIGNED_AUTHORISATION')),
      granted_by uuid NOT NULL REFERENCES users(id),
      granted_at timestamptz NOT NULL DEFAULT now(),
      withdrawn_at timestamptz,
      withdrawn_by uuid REFERENCES users(id),
      withdrawal_reason text,
      CHECK (withdrawn_at IS NULL OR (withdrawn_by IS NOT NULL AND withdrawal_reason IS NOT NULL))
    );

    -- Every credential this GST number has ever used, by reference. "Which credential made this
    -- call" is the first question of any incident, and the call log points at these references.
    CREATE TABLE gsp_credentials (
      id uuid PRIMARY KEY,
      authorisation_id uuid NOT NULL REFERENCES gstin_authorisations(id),
      company_id uuid NOT NULL REFERENCES companies(id),
      reference text NOT NULL,
      issued_at timestamptz NOT NULL,
      expires_at timestamptz,
      rotated_by uuid REFERENCES users(id),
      rotation_reason text,
      superseded_at timestamptz
    );

    -- A one-time password in flight. The password is not here: the portal sent it to a phone, the
    -- person types it, and it passes through this product to the provider without stopping.
    CREATE TABLE gsp_otp_challenges (
      request_id text PRIMARY KEY,
      authorisation_id uuid NOT NULL REFERENCES gstin_authorisations(id),
      company_id uuid NOT NULL REFERENCES companies(id),
      requested_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      attempts_remaining integer NOT NULL CHECK (attempts_remaining >= 0),
      -- Last four digits of the phone the portal holds, so a person knows where to look.
      sent_to_hint text NOT NULL,
      settled_at timestamptz
    );

    -- Every call to the government, including the ones we refused to make.
    CREATE TABLE government_calls (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      -- Not a foreign key to the authorisation: a refused call may be for a GST number that has no
      -- authorisation at all, and that refusal is exactly the row somebody will come looking for.
      gstin text NOT NULL,
      operation text NOT NULL,
      scope text,
      idempotency_key text NOT NULL,
      correlation_id text NOT NULL,
      -- Our own reference for the thing being sent: an invoice id, a movement, a return period.
      document_ref text,
      outcome text NOT NULL CHECK (outcome IN ('ACCEPTED','REJECTED','UNKNOWN','REFUSED')),
      provider_request_id text,
      -- The government's own IRN, e-way number or acknowledgement.
      government_reference text,
      error_code text,
      error_message text,
      refusal text,
      attempts integer NOT NULL DEFAULT 0,
      credential_reference text,
      started_at timestamptz NOT NULL DEFAULT now(),
      settled_at timestamptz,
      reconciled_at timestamptz,
      actor_id uuid NOT NULL REFERENCES users(id),
      -- One call per reference. A retry after a timeout is the same call, not a second one.
      UNIQUE (company_id, idempotency_key)
    );

    CREATE INDEX gstin_authorisations_company_idx ON gstin_authorisations(company_id, status);
    CREATE INDEX gstin_consents_authorisation_idx ON gstin_consents(authorisation_id, granted_at DESC);
    CREATE INDEX gsp_credentials_authorisation_idx ON gsp_credentials(authorisation_id, issued_at DESC);
    CREATE INDEX government_calls_company_gstin_idx ON government_calls(company_id, gstin, started_at DESC);
    CREATE INDEX government_calls_document_idx ON government_calls(company_id, document_ref);
    -- What reconciliation reads: the calls whose fate we never learned.
    CREATE INDEX government_calls_unsettled_idx
      ON government_calls(company_id, started_at) WHERE outcome = 'UNKNOWN' AND reconciled_at IS NULL;
  `,
  down: `
    DROP TABLE IF EXISTS government_calls;
    DROP TABLE IF EXISTS gsp_otp_challenges;
    DROP TABLE IF EXISTS gsp_credentials;
    DROP TABLE IF EXISTS gstin_consents;
    DROP TABLE IF EXISTS gstin_authorisations;
  `,
}, {
  // Issue #123 — provider callbacks, and the index that lets one find the call it is about.
  //
  // Two things here are the whole point of the table.
  //
  //   1. **(connector, event id) is unique.** A provider that does not get a 200 sends the same
  //      acknowledgement again, and applying one twice would settle a call twice. Deduplication
  //      belongs in the database rather than in a set held by a process that restarts.
  //   2. **A callback that failed authentication is recorded by a digest of its bytes.** The fact
  //      that somebody sent it is worth knowing; what it said is not evidence and is never parsed,
  //      so there is nowhere here to put it.
  id: "20260901T083908982Z_gsp_bae8a5e29faf_government_webhook_events",
  up: `
    CREATE TABLE government_webhook_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      connector text NOT NULL,
      event_id text NOT NULL,
      provider_request_id text NOT NULL,
      -- Null when the callback matched no call of ours, which is recorded rather than acted on.
      call_id uuid REFERENCES government_calls(id),
      -- Taken from the matched call, never from the callback body.
      company_id uuid REFERENCES companies(id),
      outcome text NOT NULL CHECK (outcome IN ('SETTLED','CONFIRMED','CONFLICT','UNMATCHED','REFUSED','IGNORED')),
      government_reference text,
      received_at timestamptz NOT NULL DEFAULT now(),
      -- A callback whose company is known came from a call we made; one without a company matched
      -- nothing, and must not be able to claim a company by asserting one.
      CHECK (company_id IS NULL OR call_id IS NOT NULL),
      UNIQUE (connector, event_id)
    );

    -- Deliveries that did not authenticate. No parsed content, by design: only the shape of what
    -- arrived and when.
    CREATE TABLE government_webhook_rejections (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      connector text NOT NULL,
      -- sha256 of the bytes as they arrived.
      digest text NOT NULL,
      reason text NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now()
    );

    -- What a callback matches on. Without this the lookup is a scan of every call ever made.
    CREATE INDEX government_calls_provider_request_idx
      ON government_calls(provider_request_id) WHERE provider_request_id IS NOT NULL;
    CREATE INDEX government_calls_correlation_idx ON government_calls(correlation_id);
    CREATE INDEX government_webhook_events_call_idx ON government_webhook_events(call_id, received_at DESC);
    CREATE INDEX government_webhook_rejections_seen_idx ON government_webhook_rejections(connector, received_at DESC);
  `,
  down: `
    DROP INDEX IF EXISTS government_calls_correlation_idx;
    DROP INDEX IF EXISTS government_calls_provider_request_idx;
    DROP TABLE IF EXISTS government_webhook_rejections;
    DROP TABLE IF EXISTS government_webhook_events;
  `,
}, {
  // Issue #366 — what the PostgreSQL repositories need: row-level security, an order key, foreign
  // keys that carry the company, and the freeze rules of database-immutability-v1.
  id: "20261022T170838526Z_gsp_59f4d0dcbdf0_postgres_repositories",
  up: `
    -- A consent, a credential or a one-time-password challenge can only belong to an authorisation
    -- of its own company.
    ALTER TABLE gstin_authorisations ADD CONSTRAINT gstin_authorisations_company_id_key UNIQUE (company_id, id);
    ALTER TABLE gstin_consents ADD CONSTRAINT gstin_consents_same_company
      FOREIGN KEY (company_id, authorisation_id) REFERENCES gstin_authorisations(company_id, id);
    ALTER TABLE gsp_credentials ADD CONSTRAINT gsp_credentials_same_company
      FOREIGN KEY (company_id, authorisation_id) REFERENCES gstin_authorisations(company_id, id);
    ALTER TABLE gsp_otp_challenges ADD CONSTRAINT gsp_otp_challenges_same_company
      FOREIGN KEY (company_id, authorisation_id) REFERENCES gstin_authorisations(company_id, id);

    -- The order rows were written in. A revocation and a fresh authorisation can carry the same
    -- instant, and "the newest consent" must not be a coin toss.
    ALTER TABLE gstin_consents ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
    ALTER TABLE gsp_credentials ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
    ALTER TABLE government_calls ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
    DROP INDEX gstin_consents_authorisation_idx;
    CREATE INDEX gstin_consents_authorisation_idx ON gstin_consents(company_id, authorisation_id, seq DESC);
    DROP INDEX gsp_credentials_authorisation_idx;
    CREATE INDEX gsp_credentials_authorisation_idx ON gsp_credentials(company_id, authorisation_id, seq);

    -- The provider's request id is the provider's, not ours: two businesses can be handed the same
    -- one. It is unique within a company. At most one challenge is open per GST number.
    ALTER TABLE gsp_otp_challenges DROP CONSTRAINT gsp_otp_challenges_pkey;
    ALTER TABLE gsp_otp_challenges ADD PRIMARY KEY (company_id, request_id);
    CREATE UNIQUE INDEX gsp_otp_challenges_open_idx ON gsp_otp_challenges(company_id, authorisation_id) WHERE settled_at IS NULL;

    -- The channel writes a new row for every attempt, including a retry with the same reference
    -- after a refusal or a timeout (channel.ts), and findByIdempotencyKey answers with the first.
    -- A unique key refused that retry. It stays an index.
    ALTER TABLE government_calls DROP CONSTRAINT government_calls_company_id_idempotency_key_key;
    CREATE INDEX government_calls_idempotency_idx ON government_calls(company_id, idempotency_key, seq);
    -- For list() and its pages: one company's calls, or one GST number's, in the order they started.
    DROP INDEX government_calls_company_gstin_idx;
    CREATE INDEX government_calls_company_gstin_idx ON government_calls(company_id, gstin, started_at, seq);
    CREATE INDEX government_calls_company_started_idx ON government_calls(company_id, started_at, seq);
    DROP INDEX government_calls_unsettled_idx;
    CREATE INDEX government_calls_unsettled_idx
      ON government_calls(company_id, started_at, seq) WHERE outcome = 'UNKNOWN' AND reconciled_at IS NULL;

    -- A settled call is the record of what was done in a business's name. Once it is ACCEPTED,
    -- REJECTED or REFUSED nothing changes but the time it was last looked at (reconcile.ts and
    -- webhooks.ts mark a conflict that way), and the government's reference, filled in once by a
    -- late callback on an accepted call that carried none (webhooks.ts). An UNKNOWN call is still
    -- being settled, by the channel, reconciliation or a callback. No status moves once settled.
    CREATE TRIGGER government_calls_frozen BEFORE UPDATE OR DELETE ON government_calls
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('outcome', 'ACCEPTED,REJECTED,REFUSED', 'reconciled_at,government_reference', '');
    -- The government's reference is never written over, on any call: a disagreement goes to a
    -- person with both (reconcile.ts, webhooks.ts).
    CREATE FUNCTION gsp_government_reference_once() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
    BEGIN
      IF OLD.government_reference IS NOT NULL AND NEW.government_reference IS DISTINCT FROM OLD.government_reference THEN
        RAISE EXCEPTION 'The government''s reference for a call is never written over. A disagreement goes to a person with both.'
          USING ERRCODE = 'restrict_violation', TABLE = TG_TABLE_NAME, COLUMN = 'government_reference';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER government_calls_reference_once BEFORE UPDATE ON government_calls
      FOR EACH ROW EXECUTE FUNCTION gsp_government_reference_once();
    -- A consent is kept as given; only its withdrawal is written later.
    CREATE TRIGGER gstin_consents_frozen BEFORE UPDATE OR DELETE ON gstin_consents
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('', '*', 'withdrawn_at,withdrawn_by,withdrawal_reason', '');
    -- A credential reference is kept as issued; only the moment it was replaced is written later.
    CREATE TRIGGER gsp_credentials_frozen BEFORE UPDATE OR DELETE ON gsp_credentials
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('', '*', 'superseded_at', '');
${NO_TRUNCATE.map((table) => `
    CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table}
      FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();`).join("")}
${TENANT_TABLES.map(tenantPolicy).join("")}
  `,
  down: `
${TENANT_TABLES.map((table) => `
    DROP POLICY IF EXISTS ${table}_tenant ON ${table};
    ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`).join("")}
${NO_TRUNCATE.map((table) => `
    DROP TRIGGER IF EXISTS ${table}_no_truncate ON ${table};`).join("")}
    DROP TRIGGER IF EXISTS gsp_credentials_frozen ON gsp_credentials;
    DROP TRIGGER IF EXISTS gstin_consents_frozen ON gstin_consents;
    DROP TRIGGER IF EXISTS government_calls_reference_once ON government_calls;
    DROP FUNCTION IF EXISTS gsp_government_reference_once();
    DROP TRIGGER IF EXISTS government_calls_frozen ON government_calls;
    DROP INDEX IF EXISTS government_calls_unsettled_idx;
    CREATE INDEX government_calls_unsettled_idx
      ON government_calls(company_id, started_at) WHERE outcome = 'UNKNOWN' AND reconciled_at IS NULL;
    DROP INDEX IF EXISTS government_calls_company_started_idx;
    DROP INDEX IF EXISTS government_calls_company_gstin_idx;
    CREATE INDEX government_calls_company_gstin_idx ON government_calls(company_id, gstin, started_at DESC);
    DROP INDEX IF EXISTS government_calls_idempotency_idx;
    -- Fails, rightly, if a reference was used twice while the rule was away.
    ALTER TABLE government_calls ADD CONSTRAINT government_calls_company_id_idempotency_key_key UNIQUE (company_id, idempotency_key);
    DROP INDEX IF EXISTS gsp_otp_challenges_open_idx;
    -- Fails, rightly, if two companies were handed the same request id while the rule was away.
    ALTER TABLE gsp_otp_challenges DROP CONSTRAINT gsp_otp_challenges_pkey;
    ALTER TABLE gsp_otp_challenges ADD PRIMARY KEY (request_id);
    DROP INDEX IF EXISTS gsp_credentials_authorisation_idx;
    CREATE INDEX gsp_credentials_authorisation_idx ON gsp_credentials(authorisation_id, issued_at DESC);
    DROP INDEX IF EXISTS gstin_consents_authorisation_idx;
    CREATE INDEX gstin_consents_authorisation_idx ON gstin_consents(authorisation_id, granted_at DESC);
    ALTER TABLE government_calls DROP COLUMN IF EXISTS seq;
    ALTER TABLE gsp_credentials DROP COLUMN IF EXISTS seq;
    ALTER TABLE gstin_consents DROP COLUMN IF EXISTS seq;
    ALTER TABLE gsp_otp_challenges DROP CONSTRAINT IF EXISTS gsp_otp_challenges_same_company;
    ALTER TABLE gsp_credentials DROP CONSTRAINT IF EXISTS gsp_credentials_same_company;
    ALTER TABLE gstin_consents DROP CONSTRAINT IF EXISTS gstin_consents_same_company;
    ALTER TABLE gstin_authorisations DROP CONSTRAINT IF EXISTS gstin_authorisations_company_id_key;
  `,
}, {
  // Issue #477 — a provider callback names no company, so the call it answers is found by a
  // lookup that returns only the company id. `invoice_work_finder` (#345's no-login role for
  // cross-company discovery) sees nothing but the columns the lookup reads, and the function is
  // the only thing `invoice_app` may call. There is no bypass of row-level security: the role's
  // own permissive policy is what shows it the rows, narrowed to these columns by the grant.
  id: "20261025T233400696Z_gsp_52b70f5f3410_callback_company_lookup",
  up: `
    GRANT SELECT (company_id, provider_request_id, correlation_id, scope) ON government_calls TO invoice_work_finder;
    CREATE POLICY government_calls_work_finder ON government_calls FOR SELECT TO invoice_work_finder USING (true);
    -- The scopes argument is the caller's connector's scopes, so a callback cannot settle a call
    -- that belongs to another provider. The provider's request id answers first; our own
    -- correlation id is consulted only when no call carries that request id. A request id that
    -- names calls of two companies answers null outright — an ambiguous match must never settle
    -- anybody's call, including through the correlation fallback.
    CREATE FUNCTION government_call_company(reference text, scopes text[]) RETURNS uuid
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
        SELECT CASE WHEN count(*) = 1 THEN min(d.company_id::text)::uuid END
          FROM (
            SELECT DISTINCT c.company_id FROM government_calls c
              WHERE c.provider_request_id = reference AND c.scope = ANY (scopes)
            UNION ALL
            SELECT DISTINCT c.company_id FROM government_calls c
              WHERE c.correlation_id = reference AND c.scope = ANY (scopes)
                AND NOT EXISTS (
                  SELECT 1 FROM government_calls x
                    WHERE x.provider_request_id = reference AND x.scope = ANY (scopes))
          ) d
    $fn$;
    GRANT invoice_work_finder TO CURRENT_USER;
    ALTER FUNCTION government_call_company(text, text[]) OWNER TO invoice_work_finder;
    REVOKE ALL ON FUNCTION government_call_company(text, text[]) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION government_call_company(text, text[]) TO invoice_app;
  `,
  down: `
    DROP FUNCTION IF EXISTS government_call_company(text, text[]);
    DROP POLICY IF EXISTS government_calls_work_finder ON government_calls;
    REVOKE SELECT ON government_calls FROM invoice_work_finder;
  `,
}]);
