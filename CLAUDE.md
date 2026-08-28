# Invoice Product — standing brief

India-first accounting, inventory, GST-compliance and business-operations software for Indian
MSMEs. It replaces ordinary billing and accounting tools; it is **not** a plugin for Tally, BUSY
or Vyapar. A shopkeeper who has never studied accounting must be able to run it.

Three agents build this in parallel on separate branches. **This file is the brief for GPT 3.**
Read it, then read `docs/gpt3-handbook.md` — the handbook is the authoritative statement of scope
for every GPT 3 issue, and the GitHub issue text is authoritative alongside it. Where they
disagree, raise it rather than choosing silently.

## Who owns what

| Agent | Lane | Issues |
| --- | --- | --- |
| GPT 1 | Accounting, sales, deterministic rules, user experience | 1, 4, 7, 9, 10, 11, 12, 13, 20, 25, 34, 35, 36, 37, 43, 46, 48, 54 |
| GPT 2 | Platform, banking, communications, security, operations | 2, 3, 6, 8, 14, 21, 22, 23, 24, 38, 39, 40, 41, 42, 47, 49, 52, 55 |
| **GPT 3** | **Purchasing, GST, transport, government integrations** | **5, 15, 16, 17, 18, 19, 26, 27, 28, 29, 30, 31, 32, 33, 44, 45, 50, 51, 53** |

GPT 3 works on branch `codex/gpt3-purchase-gst` and owns `packages/masters`,
`packages/purchasing`, `packages/gst` and `packages/transport`.

**Do not reimplement another agent's module.** If an assigned issue needs the ledger,
authentication, notifications or a generic connector, consume the documented contract or build a
mock against it, and record the assumption in the pull request.

## The rules that are not negotiable

1. The double-entry ledger is the financial source of truth. Every posted voucher balances.
2. Posted transactions are immutable. Corrections are reversals, amendments, credit notes or
   debit notes, always with an audit trail.
3. Stock never goes negative unless an authorised override policy allows it and records why.
4. Compliance decisions are deterministic, versioned, effective-dated and linked to the
   notification they came from. AI may read a document; it may never invent a rate or a threshold.
5. Government, bank, messaging and vehicle providers sit behind replaceable adapters. Development
   works against mocks; no production credential is needed to run or test anything.
6. Every company is isolated from every other. Permissions are enforced server-side, and tenancy
   is derived from the authenticated context — never from a company id supplied by the caller.
7. Destructive, financial and government actions need preview, approval and idempotency.
8. Low-confidence or contradictory input goes to an exception queue. It is never silently posted.
9. Money is `bigint` paise. Quantities are `bigint` micro-units. Rates are basis points. No floats
   anywhere near a financial figure.
10. No production GSTIN, bank credential, vendor secret or personal data in tests or fixtures.
    `syntheticGstin()` builds structurally valid, invented GST numbers for fixtures.

## Working agreement

- Small commits, each naming its issue. Never push to the default branch; open reviewable PRs.
- Publish the data model, commands, API contract, error model and fixtures in `docs/contracts/`
  before substantial implementation, so the other agents can build against them.
- Never change a shared contract silently: propose it, name the affected issues, update the
  contract tests.
- An issue is not done until its acceptance criteria pass, real dependencies have replaced mocks,
  and the PR documents assumptions, supported scenarios and known limitations.
- Tests must cover duplicates, retries, wrong GST numbers, missing invoices, partial receipts,
  returns, provider outages and concurrency — not just the happy path.
- User-facing wording is aimed at a shopkeeper. "This GST number does not match the rest of it, so
  a digit was probably mistyped", not "GSTIN checksum validation failed".

**Dependency correction from the handbook:** the published graph lists #19 and #31 as mutual
blockers. For execution, **#19 ships baseline supplier-risk warnings without #31**; #31 may later
supply reconciliation and ITC signals through an optional interface. #31 depends on #19, not the
reverse.

## Contracts in play

| Contract | Owner | Purpose |
| --- | --- | --- |
| `docs/contracts/platform-command-v1.md` | GPT 2 | `RequestContext`, idempotency, `draft → submitted → approved → finalised`, typed errors, redacted audit |
| `docs/contracts/connector-v1.md` | GPT 2 | External adapters, `ConnectorError` with retryability, `CredentialVault`, mock conformance |
| `docs/contracts/master-data-v1.md` | GPT 3 | Master ids, document snapshots, resolution outcomes, duplicate verdicts, money/quantity types |
| `docs/contracts/purchase-intake-v1.md` | GPT 3 | Inbox lifecycle, routing precedence, dedup layers, field evidence and confidence |

Every GPT 3 write goes through GPT 2's `PlatformCommandService`. Tenant isolation, idempotency
and audit are theirs — do not write a second implementation of any of them.

## State of GPT 3's work

| Issue | State | Notes |
| --- | --- | --- |
| #5 master data | **Done, tests green** | `packages/masters`. Parties/addresses/GSTINs, items/HSN/UoM, warehouses/batches/serials/opening stock, price lists, tax defaults, transporters, vehicles, bank accounts, duplicate control, merges, effective-dated versions, document snapshots, PostgreSQL migration `0003_master_data`. |
| #15 purchase inbox | **Done, tests green** | `packages/purchasing`. WhatsApp/email/camera/upload/e-invoice-JSON intake, attachment screening, company routing, file and channel dedup, OCR behind `connector-v1`, per-field confidence and evidence, quarantine. Posts nothing. |
| #50 GSP/IRP comparison | **Blocked on the owner** | Needs a real company to request quotations and sandbox access from IRIS, MasterGST, Clear and FinAGG. The checklist, RFP text, scoring matrix and sandbox conformance harness can be built without them. |
| #16, #17, #18, #29 | Next | #16 validation and duplicate detection consumes `ExtractionDraft` and `logicalKey()`. #17 needs GPT 1's ledger and stock interface — mock it against their documented contract. |
| #19, #26–#33, #44, #45, #51, #53 | Later waves | See `docs/gpt3-handbook.md` section 6. |

Known local limitation: `npm install` may be blocked in some sandboxes, so `npm run lint` (tsc)
and the migrations test that imports `pg` cannot run there. `npm test` needs no dependencies and
must stay green. CI runs the full `npm run verify`.

## Try it without a database

```sh
npm test              # every module's unit tests, no dependencies needed
npm run demo:masters  # master data walkthrough with synthetic Indian sample data
npm run demo:inbox    # five documents through four channels: routing, duplicates, quarantine
```
