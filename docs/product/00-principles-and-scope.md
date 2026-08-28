# Principles, scope and business types (issue #1 — [E01])

## 1. What we are building

A standalone, India-first accounting, inventory, GST-compliance and business-operations product
for micro, small and medium businesses.

It is meant to **replace** an ordinary billing or accounting tool. It is not a plugin for, an
add-on to, or a sync layer over Tally, BUSY or Vyapar. We read a spreadsheet a business exports
from those tools once, during migration (issue #37), and nothing more.

A person who has never studied accounting must be able to run their business on it, by typing,
by speaking, and in their own language.

## 2. The product promise

**Accuracy is the product.** Everything else is negotiable; this is not.

AI is allowed to *understand* — a photographed supplier bill, a spoken sentence in Hinglish, a
question about last month's dues. AI is never allowed to *decide* money or law. Every rupee that
lands in the ledger and every compliance conclusion comes from deterministic, versioned,
testable rules.

### The eight non-negotiable rules

1. **The double-entry ledger is the financial source of truth.** Every posted voucher balances to
   zero. Nothing that touches money bypasses it.
2. **Final transactions are immutable.** Corrections happen by reversal, amendment, credit note or
   debit note, and the original stays visible forever.
3. **Stock cannot go negative** unless an authorised override policy allows it and records who
   allowed it and why.
4. **Compliance decisions are deterministic and effective-dated**, linked to an authoritative
   source. No model invents a threshold, a rate or a due date.
5. **Destructive, financial and government actions need preview, approval and idempotency
   protection.** A retry after a timeout must never produce a second invoice, IRN, e-way bill or
   bank posting.
6. **External services sit behind replaceable adapters.** Development and tests run entirely on
   mocks; no feature may require production credentials to be built.
7. **Every company is isolated from every other company**, and permissions are enforced on the
   server, never only in the interface.
8. **Low-confidence or contradictory input goes to the exception queue.** The product never
   silently guesses a financial or legal fact.

### What the product must actively prevent

| Must never happen | Where it is stopped |
| --- | --- |
| Selling 70 units when 30 are available, with no authorised override | `packages/inventory` (#12), checked before an invoice can be submitted |
| A duplicate purchase invoice, voucher, IRN, e-way bill or bank line created by a retry | Idempotency keys on every command (#6), enforced by each owning module |
| A two-wheeler recorded as carrying a multi-ton consignment with no warning | `packages/transport` (#28) and `packages/vehicle-verification` (#29) |
| A wrong GSTIN, HSN/SAC, rate, place of supply, total or filing period accepted without explanation | `packages/gst-calc` (#25) and `packages/rules-engine` (#7) |
| An invoice marked paid when only part of it was received | `packages/receivables-payables` (#20) |
| AI output reaching the books without passing the ledger, rules, approval and audit path | Enforced at every command boundary; AI produces drafts only |

## 3. Product principles that shape the design

**A standalone ledger.** We keep our own books. We do not mirror someone else's data model, and we
do not depend on another product being installed.

**Accuracy before convenience.** When a fact is missing, we stop and ask. Stopping is a feature.
An exception queue entry is a better outcome than a plausible wrong number.

**A simple interface over a strict engine.** The screens are for a shopkeeper. The engine is for
an auditor. The simplicity is in the wording and the number of steps, never in the controls.
See [issue #46's design system](../ux/README.md).

**AI plus deterministic rules, never AI instead of them.** The division is fixed:

| AI may | AI may never |
| --- | --- |
| Transcribe speech and read documents | Choose a GST rate or a place of supply |
| Propose a draft with per-field confidence | Post a voucher |
| Explain a rule's output in simple words | Decide a legal outcome |
| Retrieve and summarise data the user is allowed to see | Reveal data outside the user's permissions |
| Suggest an action for approval | Approve, or skip approval |

**Everything is explainable.** Any number on any screen can be traced to the records that produced
it, and any compliance decision can name the rule, its version, its effective date and its source.

## 4. Who the product is for

### Supported business types at first release

| Business type | What is distinctive about it | Example |
| --- | --- | --- |
| Trading and wholesale (goods) | Batches, multiple units, e-way bills, credit sales | Apple wholesaler in Azadpur mandi |
| Retail shop (goods) | High volume, small tickets, mostly B2C, thermal printing | Neighbourhood grocery |
| Manufacturing, light | Raw material in, finished goods out, simple job work | Bakery producing cakes and breads |
| Services | SAC codes, no stock, milestone billing | Chartered accountant, salon, repair shop |
| Transport and logistics services | Reverse charge, goods transport documentation | Small fleet owner |

### Supported registration profiles

- Registered regular GST taxpayer, monthly or quarterly filing.
- Registered composition taxpayer — recorded and reported, with composition-specific invoice
  wording and no input tax credit.
- Unregistered business keeping books without GST features enabled.

### Supported transaction scope at first release

- Domestic B2B and B2C supplies of goods and services.
- Intra-state (CGST + SGST or UTGST) and inter-state (IGST) supplies.
- Tax-inclusive and tax-exclusive pricing, discounts, freight and other charges, round-off.
- Reverse charge where the product can decide it from recorded facts.
- Nil-rated, exempt and non-GST supplies.
- Sales and purchase returns, full and partial.
- Cash, cheque, bank transfer, UPI and other payment modes, with partial and advance payments.
- Multi-branch, multi-warehouse, multi-user companies with server-side permissions.

## 5. Explicitly out of scope

Naming exclusions is part of the specification. If it is on this list, no agent should build it,
and the product must say plainly that it does not support it rather than approximating.

- **Exports, imports, SEZ supplies, deemed exports and letters of undertaking.** Refused with an
  explanation until a later release adds them.
- **Foreign currency accounting and multi-currency ledgers.** INR only.
- **Payroll, TDS, TCS returns and income-tax computation.**
- **Cost centres, budgets, consolidation and group reporting.**
- **Any live integration with Tally, BUSY, Vyapar or their databases.** Spreadsheet migration only.
- **Initiating bank transfers or making payments.** We record money; we never move it.
- **Lending, credit scoring and collections as a service.**
- **Demand forecasting, price optimisation and other predictive features.**
- **Legal advice.** The knowledge assistant explains our sourced rules and our data; it does not
  advise on matters outside them.
- **Treating a styled PDF as a registered e-invoice.** Only an IRN from the Invoice Registration
  Portal makes an invoice an e-invoice.

Rare GST scenarios not listed under supported scope are refused with a clear message and an
exception item, never approximated.

## 6. Money, quantity and time

These are product decisions, not implementation details, because they change what a user sees.

- **Currency:** Indian rupee only. Amounts are held as exact integer paise. Floating-point
  arithmetic is never used for money anywhere in the product.
- **Money rounding:** half-up at two decimal places, applied at defined points only — per tax line
  and at the invoice total. Rounding is never applied twice to the same figure.
- **Invoice round-off:** the difference to the configured rounding is posted to a dedicated
  round-off account so the voucher still balances.
- **Quantities:** exact decimals with up to six decimal places, converted to an item's base unit
  by a recorded factor. A quantity is never silently rounded.
- **Dates:** every document has a document date that decides its fiscal period, its tax period and
  which version of a rule applies to it. System timestamps are recorded separately in UTC and are
  never used in place of the document date.
- **Financial year:** 1 April to 31 March, named like `2026-27`.

## 7. Company, branch, user and permission model

Owned by GPT 2 under issue #3; stated here so all agents use the same words.

- A **company** is the isolation boundary. Every row of every table carries a company id and no
  query may cross it.
- A **branch** is a place of business inside a company, and may have its own invoice number series
  and warehouses.
- A **user** may belong to several companies with a different role in each.
- **Permissions are checked on the server** for every command, including commands raised by voice
  or by an AI agent. There is no path that reaches the ledger without a permission check.

## 8. Assumptions recorded rather than guessed

Where this specification had to choose, it chose explicitly. Each of these is open to correction
by the product owner, and each is referenced by the modules that depend on it.

| # | Assumption | Why it was needed |
| --- | --- | --- |
| A1 | INR-only, single-currency at first release | Removes exchange-rate accounting from the ledger design |
| A2 | Financial year 1 April – 31 March, invoice numbering resets per financial year | Numbering series design in #9 |
| A3 | Money held as integer paise, half-up rounding at two decimals | Ledger and tax arithmetic in #4 and #25 |
| A4 | Quantities to six decimal places | Unit conversion in #12 |
| A5 | Negative stock is blocked by default; a company may switch to warn-with-override | #12 policy design |
| A6 | Cancellation of a final invoice is allowed only inside a configurable window and only when no live IRN exists; otherwise a credit note is required | #9 cancellation policy |
| A7 | Composition dealers are supported for recording and reporting, not for input tax credit | #25 classification |
| A8 | Exports, SEZ and multi-currency are refused with an explanation rather than approximated | Scope control |
| A9 | A cheque received reduces the customer's outstanding at once and is held in a `Cheques in hand` account until it clears; a bounce posts a reversal | #20 cheque lifecycle |
| A10 | Approval requests never expire into an automatic approval | #6 consumed by #9 and #12 |

Anything not on this list and not settled by an issue must be raised, not assumed.
