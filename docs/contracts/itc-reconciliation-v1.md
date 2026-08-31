# Purchase reconciliation and input-tax-credit control — v1

Issue #31 [E31]. Owner: GPT 3. Package: `packages/itc` (`@invoice/itc`).

Compare what a business bought with what its suppliers told the government, and decide — visibly,
with evidence and with a person's name where it matters — how much GST may be claimed back.

## The words, once

- **Input tax credit ("ITC")** — the GST a business already paid its suppliers, which it subtracts
  from the GST it owes on its own sales.
- **GSTR-2B** — the monthly statement the GST portal produces listing every purchase bill the
  business's suppliers filed against its GST number.
- **IMS** — the portal screen where each of those documents can be marked accepted, rejected or
  pending.

## The line this module will not cross

> A purchase the government's record does not carry is **not** credit.

It is held back, counted, and shown with the question that would release it. It leaves that state
only because a named person said so, with a reason, on the record — and even then the line stays
marked `CLAIM_AT_RISK`. This is the issue's second acceptance criterion, and it is enforced by
`assessLine` rather than by a screen: there is no other door into the credit figure.

Two non-goals are enforced the same way. Presence in GSTR-2B is never treated as a guarantee of
credit (the books' own blocked-credit figure and the portal's own "not available" flag both
override it), and no supplier is ever accused of anything: the wording states what each side
reported and what is missing.

## Three guarantees, each enforced rather than intended

| Guarantee | How it is enforced |
| --- | --- |
| Match decisions show evidence | Every line carries six `MatchEvidence` rows — GST number, bill number, date, kind, value before GST, tax — with both sides and the difference. A one-sided line still carries them. |
| A missing portal document is never silently eligible | `claimable` is zero for every status but `EXACT` unless a decision exists; the workspace total and `Gstr3bLinkage` are computed from the same lines, so no second path can add it back. |
| Recomputation preserves user actions and audit | Decisions are keyed on `lineKeyOf(gstin, normalisedNumber, kind)` — only facts that do not move — and re-attached on every read. When the figures change under a decision the fingerprint stops matching: the decision is kept, marked `decisionStale`, and not applied. |

## The data

| Type | What it is |
| --- | --- |
| `BookPurchaseDocument` | A posted purchase (#17) as this module compares it. `supplierGstin` may be `null`, and that null is load-bearing: an uncomparable bill is reported, never matched on its number alone. |
| `PortalDocument` | One document as the supplier reported it, including the portal's own `itcAvailableOnPortal` flag and reason, kept verbatim as evidence. |
| `ReconciliationLine` | One pairing: status, evidence, outcome, the claimable and held-back amounts, the decision and its staleness, and one plain sentence. |
| `ItcDecision` | `ACCEPT` / `REJECT` / `PENDING`, with reason, actor, moment, fingerprint and idempotency key. Append-only. |
| `ImportBatch` | One import: source, file name, sha256 checksum, who, when, what changed, and the rows that could not be read. |
| `Gstr3bLinkage` | The credit side of GSTR-3B — boxes 4A(3), 4A(4), 4A(5) and 4B — plus the caution sentence naming the held-back total. |

## Matching

Two passes, kept apart deliberately.

1. **Exact** — same registration, same bill number character for character, same date.
2. **Fuzzy** — same registration, and then either a bill number that agrees once punctuation and
   leading zeros are set aside (`KP/0042` meets `KP-42`), or a date within the policy's window with
   the taxable value agreeing. **Never across registrations.**

A pair whose figures are out of tolerance is reported as `CLOSE` — the same bill, different money —
not as a match. Duplicates are found before matching, because a bill recorded twice is wrong
whatever the portal says; the second copy becomes its own line, keyed with a `COPY:` discriminator
so a decision on the real line cannot attach to it.

## Outcomes

| Outcome | When |
| --- | --- |
| `CLAIM_NOW` | `EXACT`, portal does not object, not withdrawn, not an amendment, nobody rejected it. Also imports, which are paid at customs and never appear in GSTR-2B. |
| `CLAIM_AT_RISK` | A person with `itc.claim_at_risk` accepted a line that does not fully agree, giving a reason. The claim is the **lower** of the two figures. |
| `HELD_BACK` | Everything else, with the finding that says what is holding it. |
| `BLOCKED_IN_BOOKS` | The books already treated the tax as a cost (section 17(5)). There was never a credit to chase. |

## Getting the portal's list in

`parsePortalFile` reads the portal's GSTR-2B JSON (`ctin`, `inum`, `05-07-2026`) and an
accountant's CSV through one reader; `PortalRecordSource` — the GSP download — returns the file's
own text so it goes through that same reader. `parseTypedRecord` takes a row a person reads off the
portal and types in, validated exactly as strictly. What differs between the three is only the
recorded `RecordSource`, which every screen shows.

Money is read as exact decimal strings into `bigint` paise. A JSON number is converted through its
shortest decimal form and **refused** if that form carries more than two decimal places. Rows that
cannot be read are returned with their reason; nothing is dropped quietly.

## Permissions

`itc.view`, `itc.import`, `itc.decide`, `itc.claim_at_risk`. The last is separate because claiming
credit the government's record does not carry is the one act in the comparison that costs money if
it is wrong.

## Ports

| Port | Owner | Purpose |
| --- | --- | --- |
| `PurchaseBookPort` | #17 | The purchases our books hold for a period |
| `PortalRecordSource` | #8 / a GSP | Optional. Downloads the statement; absent everywhere by default |
| `PortalRecordRepository`, `ImportBatchRepository`, `ItcDecisionRepository` | this module | Its own storage; migration `…_itc_reconciliation` |
| `ItcPolicyPort` | company setting | Amount tolerance, date window, whether an at-risk claim is allowed at all |

## What other modules read

- **#30 (GST returns)** consumes `itcInwardTaxPort`, which satisfies its existing `InwardTaxPort`.
  The credit side of GSTR-3B is therefore this reconciliation's conclusion and not a second read of
  the ledger.
- **#19 (supplier risk)** consumes `gstr2bSignalPort`, the optional `Gstr2bPort` that module
  defined for this issue. It answers `null` when no statement has been imported for the month, so
  the supplier check says "not checked" rather than turning our own silence into "not reported".

## Known limitations

- The GSP download is exercised against `SyntheticPortalSource`; no production intermediary is
  wired, which is #50's work.
- Amendment chains are read one level deep: an amended document names what it amends and is held
  back for a person, but the credit already taken on the original is not automatically reversed —
  the finding tells the preparer to do it.
- Reverse-charge liability is read from the books rather than from the portal, because the business
  owes that tax whatever anybody reported.
