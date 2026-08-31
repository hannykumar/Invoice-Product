# Company formation and vendor onboarding — issue #49 [X01]

**This issue is mostly not software.** Incorporating a company needs a person with identity
documents, a chartered accountant's or company secretary's advice, and money. None of those are
things a repository can supply, and the issue's own non-goals say "implement software".

What software *can* do is stop the paperwork from being the thing that quietly fails. This module
is a register: what documents exist, who holds each provider account, when each thing expires, and
**which integration is blocked without it** — so nobody discovers at contract time that #50 was
waiting on a board resolution nobody had drafted.

```sh
npm run vendor:readiness    # what stands between us and a signed provider contract
```

It exits non-zero while anything blocking is outstanding, so it can gate a release later without
anybody having to remember to look.

## The one rule this register enforces about itself

It lives in git and everybody working on the product reads it. So it holds **status and pointers,
never contents**. "We hold the certificate of incorporation, it is in the vault at
`mca/coi.pdf`, Priya holds it and Arun is the backup" belongs here. The certificate number does
not.

`safeReference()` throws on anything shaped like a GSTIN, PAN, TAN, CIN, Aadhaar number, IFSC code,
bank account number, private key, API secret or password — on every field, not one — because the
natural way to fill in "reference" is to paste the number. A test drives all ten shapes, and
another asserts the committed state is clean.

Real identifiers live in the company's password manager or document vault, and are quoted to a
provider from there. Never here, never in a test fixture, never in an issue comment.

## The entity choice

The first line of required work is "select entity type **with professional advice**". This is a
decision aid for that conversation, not advice — I am not a chartered accountant, a company
secretary or a lawyer, and the choice has tax and liability consequences that need one.

| Form | For | Against |
| --- | --- | --- |
| **Private limited company** | What GSPs, banks and payment providers expect to contract with. Limited liability, a board-resolution mechanism they already understand, and the only form that takes outside investment without restructuring. | The most compliance: audits, annual filings, board minutes, a company secretary's time. |
| Limited liability partnership | Lighter annual compliance, still limited liability. | Several providers and most investors will not contract with an LLP; converting later is slow. |
| One person company | Limited liability for a single founder. | Turnover and capital ceilings force a conversion; some providers treat it as a proprietorship. |
| Registered partnership | Quick and cheap. | Unlimited personal liability. |
| Sole proprietorship | Nothing to form. | Unlimited liability, and every vendor account is by definition a founder's personal account — exactly what this issue's acceptance criterion exists to prevent. |

The shape of the requirement points one way: this product must sign with a GSP, a bank-feed
partner and a payment gateway, and all three contract with companies. That is an argument, not a
decision — take it to a professional.

## The order things have to happen in

Each step is a real-world action by a person. The register tracks them; it does not do them.

1. **Choose the entity type** with professional advice.
2. **DSC and DIN** for each proposed director.
3. **Name reservation and incorporation** (SPICe+ on the MCA portal for a company), which issues
   the certificate of incorporation, and with it the company's PAN and TAN.
4. **Open the current account** — the bank will want the certificate, MOA/AOA, PAN, board
   resolution and the signatories' KYC. This is the step that most often stalls; start it early.
5. **GST registration**, once there is an account and a registered address.
6. **Domain and official email** on the company's own domain, with the domain registered in the
   company's name — not a founder's.
7. **Assemble the pack** and put it in one vault with a custodian and a backup for each item.
8. **Only then** approach providers: #50 and #51 (GSP/IRP), #52 (bank feed), #53 (vehicle data).

Steps 1–6 need a person. Steps 7 and 8 are what this register is for.

## The document pack

Assembled once and reused, because seven of these are the same for every provider. `catalogue.ts`
holds the authoritative list and which provider asks for what; `npm run vendor:readiness` prints
it. What each provider actually requires is governed by its own contract — where one differs, the
catalogue is corrected rather than worked around.

## What the checks mean

| Finding | Why it blocks |
| --- | --- |
| `NO_COMPANY_YET` | Nothing can be signed with anybody. Everything else waits on this. |
| `VENDOR_PACK_INCOMPLETE` | Names the provider, the missing documents and the issues held up. |
| `DOCUMENT_EXPIRED` / `DOCUMENT_EXPIRING` | A slipped renewal is not paperwork; it is an integration that stops. Warned at 45 days. |
| `UNDOCUMENTED_PERSONAL_ACCESS` | A founder's personal account is allowed — an *undocumented* one is not. It must say why and by when it moves. |
| `PERSONAL_ACCESS_OVERDUE` | The date to move it has passed. Agree a new one in writing rather than letting it drift. |
| `SINGLE_POINT_OF_FAILURE` | One person is the only route into a provider account. This is what the recovery drill finds. |
| `NO_CONTACT` | Every provider form asks for a signatory, a technical and a billing contact. |
| `PERSONAL_CONTACT_ADDRESS` | Contract notices and outage warnings go there. It must survive a person leaving. |

See [`access-recovery-runbook.md`](access-recovery-runbook.md) for the drill itself.

## State today

`src/state.ts` is the register for the real company, and it is deliberately almost empty: **the
company does not exist yet**. Keeping the truthful empty state rather than a plausible-looking
filled-in one is the point. Edit that file as each step completes.
