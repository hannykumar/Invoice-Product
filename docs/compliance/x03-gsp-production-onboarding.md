# GSP/IRP production contracting and onboarding (issue #51 — [X03])

This is the documentation the issue asks for, and like [X05](x05-vehicle-data-access.md) it is
written so that most of it can be **checked by a program** rather than believed.
`npm run gsp:golive` prints the current state of everything below and exits non-zero while
production access is unavailable; `ops/gsp-production` is where it lives, and its tests fail if this
document and the software stop agreeing.

## Where this actually stands

**Production access is not active, and this build cannot call a live government portal.** That is
enforced rather than intended: `PRODUCTION_ACCESS` in `packages/gst/src/environments.ts` is the
switch every provider call is built through, it is off, and while it is off only the sandbox address
this repository has itself probed can be reached. A connector pointed at a live host refuses to be
constructed, with a sentence saying why.

The reason it is off is a standing decision, not an unfinished task:

> This product integrates against free GST sandbox APIs only, not a paid production GSP plan. A
> sandbox proves the integration works; it issues no legally valid IRN or e-way bill, so it cannot
> serve a real shopkeeper. Moving to production is the owner's decision to make, not a step to slide
> into once the sandbox works.

Both halves of that matter. The integration is real and has been run end to end — a bill went
through the WhiteBooks sandbox on 9 September 2026 and came back with an IRN, an acknowledgement
number and NIC's signed QR code ([whitebooks-sandbox](../contracts/whitebooks-sandbox.md)). And a
sandbox IRN is not an IRN: anything shown to a customer from it must say so. If free *production*
e-invoice access is ever wanted, IRIS is the candidate worth raising, because it is a
government-appointed IRP whose core production e-invoice APIs carry no charge. That is a fact for
the owner to weigh, not a recommendation to act on.

So this issue's software half is done and its commercial half is deliberately parked. The list below
keeps the parked half honest: when somebody does pick it up, nothing has to be reconstructed.

## The thirteen conditions

`ops/gsp-production/src/checklist.ts` is the authoritative list — the table below names the same ids
and a test fails if one goes missing from this document. Each condition says who can satisfy it,
because "waiting on a person" and "waiting on us" are different kinds of blocked.

| Condition | Who can satisfy it | Why production is refused without it |
| --- | --- | --- |
| `COMPANY_AND_DOCUMENT_PACK` | a person | A GSP contracts with a legal entity and wants the incorporation certificate, PAN, GST registration, board resolution and signatory identity. [#49's register](../../ops/vendor-onboarding/README.md) holds them; it is empty, because the company does not exist yet. |
| `PROVIDER_CHOSEN` | a person | [#50](../../ops/gsp-selection) refuses a recommendation until two written quotations and the essential facts are in hand. |
| `SECURITY_REVIEW` | a person | Somebody other than the author checking, in writing and on a date, what leaves the product and where credentials live. See below for what the review has to cover. |
| `LEGAL_REVIEW` | a person | Controller and processor, sub-processors, data location, termination, and who is liable for a late filing are contract terms. |
| `AGREEMENT_AND_SLA` | a person | Stated uptime, support hours, incident response times and published rate limits are what make an outage a breach rather than a surprise. **On hold by the standing decision.** |
| `PRODUCTION_NETWORK_AND_DOMAIN` | a person | NIC ties an API session to the calling address, so production needs fixed egress addresses registered with the provider, and a domain and email owned by the company rather than a founder. |
| `CREDENTIAL_CUSTODY_AND_ROTATION` | a person | A credential one person can reach leaves with them. The software half — rotation without downtime, revocation stopping the next call — is drilled here; custody is a person's job. |
| `CUSTOMER_AUTHORISATION_PROCEDURE` | this repository | **Done.** [#33](../contracts/government-access-v1.md) implements consent per GST number, with a one-time password and revocation. Drilled on every test run. |
| `FALLBACK_WORKFLOW` | this repository | **Done.** With the connection revoked, the business still produces the government's own JSON for manual upload. Drilled on every test run. |
| `PILOT_CUSTOMER_CONSENT` | a person | The first production call is made on a real registration and produces a real IRN. That business must know it is first, what is sent, and how to stop. |
| `INCIDENT_AND_SUPPORT` | a person | Who is called when the portal rejects everything, in what order, and how customers are told. |
| `EXIT_AND_PORTABILITY` | a person | What happens to authorisations, credentials and the filing record when we stop paying — agreed before signing, or agreed from no leverage. |
| `CONTROLLED_PRODUCTION_SMOKE_TEST` | a person | The issue's own test: one real document generated and cancelled with the pilot watching. **On hold by the standing decision**; the sandbox equivalent has been run. |

## What the security review has to cover

The answers already exist in the code. The review is somebody checking them.

- **No GST portal password is stored anywhere.** There is no column, field or type for one. What is
  kept is an opaque vault reference and, while an onboarding is in flight, the id of a one-time
  password challenge, its expiry, the attempts left, and the last four digits of the phone the
  portal used. `containsSecretField` refuses a caller that tries to hand a secret in, and `redact`
  blanks anything whose field *name* looks like a secret before it reaches storage.
- **Authorisation is per GST number, never per company.** One door, `checkAuthorisation`, compares
  the number on the call with the number on the consent before anything else is considered.
- **Revoking is a different permission from authorising** (`gsp.connection.revoke` against
  `gsp.connection.authorise`), so the emergency control does not need the person who set the
  connection up.
- **Every call and every refusal is on the record**, with the actor, the time and the outcome.
  "We did not send this, and here is why" is what somebody needs when an invoice never arrived.
- **An unanswered call is `UNKNOWN`, never failed**, and reconciliation asks the government what it
  actually holds.

## How a customer authorises its own GST number

This is the procedure the issue asks for, and it is implemented rather than described. A pilot
customer is walked through exactly this; `npm run gsp:golive` runs it against the sandbox and prints
the evidence for each step.

1. **The business asks to connect a registration.** The provider creates an API user for that GST
   number. Repeatable: a provider that already has one says so.
2. **The portal sends a one-time password to the signatory's registered phone** — the number the
   government already holds, not one typed here. We see the last four digits and nothing else.
3. **The business enters the code and is shown the consent wording** naming every permission being
   granted, in English and Hindi. A wrong code says how many tries remain before the portal locks
   it; an expired one says to ask for another. Both are ordinary answers, not errors.
4. **The consent is written with the wording that was on the screen**, and a credential reference
   from the vault is stored. The connection is active from that moment.
5. **The business can take it back at any time.** Revocation clears the live credential, marks the
   consent withdrawn, and stops the next call immediately — including when the provider could not be
   told. Nothing is deleted: the consent, the credential history and every call ever made stay.

Two registrations are two authorisations. A Karnataka registration and a Maharashtra one have
separate consents, separate credentials and separate expiry dates, and neither speaks for the other.

## The drills

Three, run by `npm run gsp:golive` and asserted by `ops/gsp-production/test`:

| Drill | What it proves |
| --- | --- |
| `pilot-onboarding` | The whole authorisation dance, then one controlled operation that the government answers, logged against the GST number it was made for. |
| `credential-rotation` | Credentials are replaced under a live connection: a different reference, the old one kept with the reason, the connection still active, the next call working, the event audited and no secret written down. |
| `revocation-and-fallback` | Revoking clears the credential and refuses the very next call with a sentence a shopkeeper can act on, keeps the whole history — **and the business can still produce the file it uploads by hand**. |

Against production the only differences are whose registration it is and that the IRN is real.

## The fallback, which is the point of the last drill

A revoked authorisation, an expired one, a provider outage and an unsigned contract all end in the
same place for a shopkeeper: the portal cannot be reached through us. In every one of them the
business must still be able to invoice.

`toOfflineJson` builds the government's own bulk-upload JSON with no provider, no credential and no
network, and the file says of itself that it is not an e-invoice until the government returns an IRN
for it — because a JSON file on a desktop that looks like a registered invoice is exactly the
confusion this product must not create. The manual route is then the portal's own offline utility.

This is why the product does not become unusable while everything above is outstanding.

## Incident, support and exit

Recorded here so that the answers exist before the night they are needed. Each becomes a contractual
term once there is a contract.

- **Incidents.** A government or provider outage is not a product bug and must not be shown as one:
  affected documents sit in a state that says "not sent", the exception queue holds anything the two
  sides disagree about, and reconciliation settles what it can when the service returns. A person is
  told which documents are waiting, not that "something went wrong".
- **Support.** The provider's escalation path, its hours and its response times belong in the SLA;
  ours belongs next to it. A filing deadline does not move because a support queue is long, so the
  escalation has to be agreed rather than discovered.
- **Exit and portability.** On leaving a provider: every authorisation is revoked through the
  product (which stops calls immediately), credentials are destroyed at the provider and in the
  vault, and the call log and filing record stay with us because they are the business's evidence,
  not the provider's. Customers re-authorise with the new provider by the same one-time-password
  dance — the reason that dance is per GST number and not per provider account.

## Known limitations

- Everything above the `CUSTOMER_AUTHORISATION_PROCEDURE` line in the table needs a person, and this
  repository cannot move any of it. The gate reports it rather than working around it.
- The confirmed sandbox host list has exactly one entry, because one is what has been probed. A
  second provider's sandbox is added by calling it and writing down what it answered — not by
  matching hostnames that contain the word "sandbox".
- The drills run against `SandboxGspProvider` and #26's synthetic IRP, not against WhiteBooks'
  sandbox over the network, so they prove the product's own behaviour rather than the provider's.
  The provider's own behaviour is what `ops/gsp-selection`'s conformance harness is for, and what
  the 9 September end-to-end run demonstrated.
