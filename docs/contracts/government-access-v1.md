# Authorised government access — v1.1

Issue #33 [E33]. Owner: GPT 3. Package: `packages/gsp` (`@invoice/gsp`).

Connect approved internal workflows to live GST, IRN and e-way services through an authorised
provider, one GST number at a time, with the business's consent on the record and every call
accounted for.

## The line this module will not cross

> A company is not what the government authorises. A GST number is.

Every record, permission, credential and call in this module is keyed on a GST number. A business
with a Karnataka registration and a Maharashtra one has two authorisations, two consents, two sets
of credentials and two expiry dates, and neither speaks for the other. That is what makes the
issue's non-goal — "give one customer access to another GSTIN" — a property of the schema rather
than a promise in a document.

## Three guarantees, each enforced rather than intended

| Guarantee | How it is enforced |
| --- | --- |
| Each GSTIN has separate authorisation state | `gstin_authorisations` is unique on `(company_id, gstin)`; every service method takes a GST number and touches one row; `checkAuthorisation` compares the number on the call with the number on the consent before anything else. A call whose document does not name a registration, for a business with more than one connected, is refused rather than guessed. |
| Revocation stops new calls without deleting history | `revoke` sets the status, clears the live credential and marks the consent withdrawn. The consent row, the credential history and every call ever made stay. The channel reads the authorisation before each call, so the next one stops immediately — including when the provider could not be told. |
| Internal status matches the government's acknowledgement | An unanswered call is `UNKNOWN`, never failed. `GovernmentCallReconciler` asks the provider what the government's record says and settles it: confirmed, corrected to the government's reference, never arrived, or a conflict that goes to a person with both sides intact. |

## What is never stored

There is no column, field or type anywhere in this module for a GST portal password. What is held
is an opaque vault reference (#8 resolves it) and, while an onboarding is in flight, the id of a
one-time-password challenge — its expiry, the attempts left, and the last four digits of the phone
the portal sent it to. The password itself is typed by a person, passed to the provider and
forgotten. `containsSecretField` refuses a caller that tries to hand one in; `redact` blanks
anything whose *field name* looks like a secret before it reaches storage. Audit records name the
vault address as `vaultRef`, because it is one.

## The onboarding dance

1. `beginOnboarding` — the provider creates an API user for the GST number. Repeatable; a provider
   that already has one says so. Status `API_USER_PENDING`.
2. `requestOtp` — the portal sends a one-time password to the signatory's registered phone. Status
   `OTP_REQUESTED`, with expiry and attempts on the record.
3. `verifyOtp` — the code is verified by the provider, the consent is written with the exact wording
   the person was shown, and a credential reference is stored. Status `ACTIVE`.

Wrong codes count down and say how many tries are left before the portal locks; expired codes say
to ask for another. Both are ordinary answers, not errors.

## The channel

`GovernmentChannel.call` is the only door. In order: resolve the GST number (from the document, or
from the single connected registration, or refuse), check the authorisation and scope, reserve a
slot against our own rate limit, record the call, execute through #8's `ConnectorGateway`, settle
the record.

`AuthorisedGateway` is the same guard wearing #8's gateway as a coat. #26 and #27 already build
their IRP and e-way adapters on `ConnectorGateway`; wrapping it means those adapters get the
authorisation check, the rate limit and the call log without either module changing, and without a
second IRP adapter to keep in step.

## Scopes

`EINVOICE_GENERATE`, `EINVOICE_CANCEL`, `EINVOICE_FETCH`, `EWAY_GENERATE`, `EWAY_UPDATE`,
`EWAY_CANCEL`, `EWAY_FETCH`, `RETURN_SUBMIT`, `RETURN_FETCH`, `GSTR2B_FETCH`. `OPERATION_SCOPES`
maps each provider operation to one of them; an operation missing from that table is refused,
because an act nobody has mapped to a consent is an act nobody consented to.

## Outcomes and refusals

`ACCEPTED`, `REJECTED`, `UNKNOWN`, `REFUSED` — there is no `FAILED`. Refusals carry a reason
(`NOT_AUTHORISED`, `AUTHORISATION_REVOKED`, `AUTHORISATION_EXPIRED`, `AUTHORISATION_SUSPENDED`,
`SCOPE_NOT_GRANTED`, `UNKNOWN_OPERATION`, `PROVIDER_DOES_NOT_SUPPORT`, `RATE_LIMITED`,
`GSTIN_MISMATCH`, `CREDENTIAL_MISSING`), a sentence in both languages, whether a retry will help,
and what the business can do about it. **Every refusal is written to the call log**: "we did not
send this, and here is why" is the record somebody needs when an invoice never reached the portal.

## Ports

| Port | Owner | Used for |
| --- | --- | --- |
| `ConnectorGateway`, `CredentialVault` | GPT 2 (#8) | Making the call, resolving credentials |
| `GspProviderPort` | this module (#33) | API user, OTP, rotation, revocation, status |
| `AuthorisationRepository`, `CallLogRepository` | this module (#33) | The state and the record |
| `RateLimiterPort` | this module (#33) | Staying under the provider's published limits |
| `GovernmentExceptionSink` | #7 / #48 | Where a disagreement with the government goes |
| `AuditPort` | ledger | Every material act, with secrets redacted |

Production implementations of #30's `GovernmentReturnPort` and #31's `PortalRecordSource` ship here
(`authorisedReturnPort`, `authorisedPortalRecordSource`). #26's `IrpPort` and #27's `EwayBillPort`
are reached through `AuthorisedGateway` and their own existing adapters.

## Permissions

`gsp.connection.view`, `gsp.connection.authorise`, `gsp.connection.revoke`,
`gsp.credential.rotate`, `gsp.calls.reconcile`. Revoking is not the same permission as authorising:
it is the emergency control and must not need the person who set the connection up.

## Provider callbacks (issue #123)

A provider that could not reach us — or that acknowledges asynchronously, which the IRP does — posts
the answer back. `GovernmentWebhookReceiver.receive(kind, rawBody, signature)` takes delivery.

- **The body is not data until the signature verifies.** Nothing is read, matched or written before
  #8's `WebhookVerifier` authenticates the bytes. A delivery that fails is recorded by a sha256
  digest of what arrived and never parsed: that somebody sent it is worth knowing; what it said is
  not evidence.
- **The raw bytes must survive to the receiver.** A parsed and re-serialised body is a different
  string with the same meaning, and verifies against nothing. `handleApi` takes the raw body for
  this route alone.
- **The company comes first, through a narrow lookup (#477).** A callback names a provider
  request id or the correlation id we generated; `government_call_company`, a SECURITY DEFINER
  function returning only a company id, says which company the call belongs to. The callback is
  then handled inside that company's `unitOfWork`, and our own row gives the GST number and
  document. A forged callback cannot name a company at all.
- **Deduplication is durable.** `(connector, event_id)` is unique in the database, not a set in a
  process that restarts. A resent acknowledgement answers `DUPLICATE` and changes nothing —
  except a delivery recorded `UNMATCHED`, which is matched again every time it is redelivered:
  a callback that arrived before the call it answers is not lost as a "duplicate" (#477).
- **Outcomes**: `SETTLED` (an unknown call now has the government's answer), `CONFIRMED` (agrees
  with what we hold — the ordinary race with polling), `CONFLICT` (disagrees: both sides kept, an
  exception raised), `UNMATCHED`, `REFUSED` (the matched call's GST number is not connected here),
  `IGNORED` (no acknowledgement number to apply).
- A callback about a call made **before** an authorisation was revoked still settles it. Revocation
  stops new calls; it does not un-register an invoice the government already registered.

**Endpoint**: `POST /api/webhooks/government/{irp|eway_bill|gst}`, signature in
`x-provider-signature`, no session. `202` for anything verified and recorded, `401` for a delivery
that did not authenticate, `404` for a connector that takes no government callbacks. Polling
(`GovernmentCallReconciler`) remains the fallback when no callback ever arrives; the two agree by
construction because both read the acknowledgement with the same function.

## Storage (issue #366)

`PostgresAuthorisations` and `PostgresCallLog` (`src/postgres-repositories.ts`) implement the same
ports as the in-memory stores, and one contract suite (`test/gsp-store-contract.ts`) runs on both.
Writes join the action's unit of work (`requireUnitOfWork`); reads run in `tenantTransaction`.
Migration `…gsp_59f4d0dcbdf0_postgres_repositories`:

- **Row-level security** on `gstin_authorisations`, `gstin_consents`, `gsp_credentials`,
  `gsp_otp_challenges`, `government_calls`. A consent, credential or challenge can only point at an
  authorisation of its own company.
- **Nothing secret is stored.** A credential is a vault reference; a one-time password never
  reaches the database, only the challenge's id, expiry, tries left and phone hint.
- **Frozen.** A call is fixed once `ACCEPTED`, `REJECTED` or `REFUSED`: only `reconciled_at` may
  change, and `government_reference` may be filled in once. No call's government reference is ever
  written over. A consent may only gain its withdrawal; a credential only `superseded_at`. None of
  the three can be deleted or truncated.
- **Paging.** `CallLogRepository.list` and `listUnsettled` take an optional `Page` (keyset by start
  time, ties in the order written). `AuthorisationRepository.list` is not paged: one row per
  registration.
- **A retry under the same idempotency key is a row of its own** (as the channel always did);
  `findByIdempotencyKey` answers with the first. The unique key on `(company_id, idempotency_key)`
  became an index.
- **The OTP request id is unique per company**, not globally: it is the provider's id, not ours.
- **The callback receiver runs on these stores** when the app has a database
  (`apps/api/src/government-webhooks.ts`), beside #389's `PostgresWebhookEvents`.
- **A callback finds its company through a narrow audited lookup (#477).** It names no company,
  so before the tenant transaction opens `companyForRequest` asks
  `government_call_company(reference, scopes)` — a `SECURITY DEFINER` function owned by
  `invoice_work_finder` (#345's no-login discovery role), with a pinned `search_path`, granted
  only to `invoice_app`, returning one uuid or none. The role may read only the four columns the
  lookup matches on, through its own permissive policy: nothing here bypasses row-level
  security, and the function can never hand back a call. The reference is matched on the
  provider request id among calls of *this connector's* scopes — one company answers it, two or
  more answer null outright — and our own correlation id is consulted only when no call carries
  that request id, under the same one-company rule. Once the
  company is known the callback is handled inside that company's `unitOfWork`, where
  `findByProviderRequestId` (also connector-scoped) and `findByCorrelationId` read the call in
  its own tenant context like every other read. A request id that matches nothing stays
  `UNMATCHED` and reconciliation still settles the call by polling; a redelivery of an
  `UNMATCHED` event is matched again, so a callback that arrived before its call is not lost as
  a "duplicate". `government_webhook_events` (#389, rows with no company) stays on the pending
  list.

## Assumptions recorded against unfinished dependencies

- **#50 (provider comparison) and #51 (production contracting) are open.** No provider has been
  chosen or contracted, so `SANDBOX_PROFILE` and `SandboxGspProvider` are what ships and what every
  test runs against. The sandbox is not a stub: codes expire, wrong attempts count down and lock,
  credentials are references, outages can be switched on, and it keeps its own record of what the
  "government" holds so reconciliation is tested against a second opinion. A real provider replaces
  it by implementing `GspProviderPort` and supplying a `ProviderProfile`; every authorisation
  records which `environment` it was granted in.
- **Every authorisation is `SANDBOX` until a signed contract says otherwise.** A profile that does
  not list a scope cannot be used for it — an unlisted operation is not a permission we assume the
  contract covers.
- The exception sink is a port; until the queue (#7/#48) is wired in, `RecordingExceptionSink`
  keeps conflicts where a test and the demo can see them.
- **(v1.1, #389)** The webhook endpoint is wired with connector-v1.1's `HmacWebhookVerifier`. Each
  provider's secret comes from `GOVERNMENT_WEBHOOK_SECRET_IRP`, `GOVERNMENT_WEBHOOK_SECRET_EWAY_BILL`
  and `GOVERNMENT_WEBHOOK_SECRET_GST` (comma-separated while rotating). In development and tests a
  connector without one uses the publicly known `DEVELOPMENT_WEBHOOK_SECRET`; anywhere else it has
  no secret, every callback for it is refused (`401`), and start-up logs which variables are
  missing. With a database, seen events and rejected deliveries are written to
  `government_webhook_events` and `government_webhook_rejections` (`PostgresWebhookEvents`), so a
  resend after a restart is still `DUPLICATE`. A signed body without the callback's shape is refused
  with `401` like an unsigned one. Until the channel itself is wired into the running app (#51), the
  endpoint verifies, deduplicates and records every delivery and reports `UNMATCHED`, which is
  the right answer for a callback about a call that process never made.

## Demonstration scenario

`npm run demo:gsp` — Sunrise Hardware connects its Bengaluru registration (one mistyped code
first), registers an invoice, watches an invoice for its Maharashtra registration be refused rather
than filed under the wrong state, loses the network mid-call, learns from the government's own
record that the invoice was registered after all, and finally takes the permission back — after
which nothing more is sent and everything already done is still on the record.
