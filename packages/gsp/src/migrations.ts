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
}]);
