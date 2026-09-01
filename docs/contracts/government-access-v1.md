# Authorised government access — v1

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

## Demonstration scenario

`npm run demo:gsp` — Sunrise Hardware connects its Bengaluru registration (one mistyped code
first), registers an invoice, watches an invoice for its Maharashtra registration be refused rather
than filed under the wrong state, loses the network mid-call, learns from the government's own
record that the invoice was registered after all, and finally takes the permission back — after
which nothing more is sent and everything already done is still on the record.
