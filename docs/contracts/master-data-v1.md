# Master data v1

Owner: GPT 3 (issue #5). Consumers: GPT 1 (sales, accounting) and GPT 3 (purchasing, GST, transport).

Master data is the set of records every transaction points at: parties, addresses and their
GSTINs, items, units, warehouses, batches, serials, price lists, tax defaults, transporters,
vehicles and bank accounts. This contract describes how other modules read and reference them.

## Referencing a master record

A transaction stores two things, never one:

1. the **master id**, which is stable for the life of the record and survives renames and merges; and
2. a **snapshot** of the facts the document depends on, captured at the document's date.

The id keeps reporting joinable. The snapshot is what makes a reprinted invoice, a filed GST
return or an audited voucher still show the address, name and rate that applied when it was
raised. Reading a master without a date returns today's version; reading with a date returns the
version that was in force then.

```ts
const partyId = party.record.id;                                   // store this on the document
const snapshot = masters.snapshot(context, "party", partyId, invoiceDate); // and this
```

## Resolution never guesses

`resolveParty` and `resolveItem` return one of three outcomes:

| status      | meaning                                                        | caller must |
| ----------- | -------------------------------------------------------------- | ----------- |
| `resolved`  | one record is clearly the best match                            | proceed     |
| `ambiguous` | two or more records are similarly close                         | ask the user, or raise an exception item |
| `not_found` | nothing is close enough                                         | ask the user to create the record |

A caller may not treat `ambiguous` as `resolved` by taking the first candidate. This is the
issue #5 acceptance criterion "similar names do not silently resolve to the wrong party/item".

## Duplicate control on write

Creates return `clear`, `warn` or `block`:

- **block** — a shared GSTIN, PAN, phone, email, bank account or code, or a name that normalises
  identically. The write is refused; the caller must merge or correct.
- **warn** — a close name. The write is refused *unless* the caller passes
  `acknowledgeSimilar: true`, which records that a human confirmed the businesses differ.
- **clear** — nothing similar found.

## Every write is a platform command

Each mutation opens a `PlatformCommandService` command (`platform-command-v1`) carrying the
caller's `RequestContext` and a non-empty idempotency key, and moves it
`draft → submitted → approved → finalised`. Consequences:

- retrying with the same idempotency key returns the original result and appends no second version;
- reusing one key with different input raises `IDEMPOTENCY_CONFLICT`;
- tenant isolation and the audit trail are the platform's, not a second implementation;
- adding an approval policy for a `masters.*` action makes that write require an approver with no
  change to calling code. `masters.party.merge` and `masters.item.merge` ship with such a policy.

Command actions: `masters.party.create|update|merge`, `masters.address.create`,
`masters.item.create|update|merge`, `masters.warehouse.create`, `masters.batch.create`,
`masters.serial.create`, `masters.opening_stock.set`, `masters.price_list.create`,
`masters.price.set`, `masters.tax_default.set`, `masters.transporter.create`,
`masters.vehicle.create`, `masters.bank_account.create`.

## Money, quantity and rate types

- Money is `bigint` paise. There are no floats and no rupee decimals in storage.
- Quantities are `{ micro: bigint, unitCode: string }`, six decimal places, exact.
- Rates are basis points: `1800` is 18.00%.
- Unit conversion is an exact rational. A conversion that cannot land on a whole micro-unit is
  reported as inexact, and `convertExact` refuses it rather than rounding stock.
- Item-specific conversions (one box of *this* item is 24 pieces) override universal ones
  (1 kg is 1000 g) and never leak to other items.

## Tax defaults are defaults, not rulings

`taxDefaultFor(item, date)` returns the item-level default if one exists, otherwise the
HSN-level default, otherwise `null`. It never falls back to a guessed rate. Every stored default
carries a `source` string naming the notification it came from, and is effective-dated, so a
back-dated document gets the rate that applied on its own date. The authoritative rate engine
(GPT 1) may override these defaults; it must record why.

## What this module does not do

- No live GSTIN lookup or taxpayer status check (issue #5 non-goal; see #19 for supplier risk).
- No supplier risk scoring.
- No stock balances or valuation — only opening balances. Movement is the accounting module's.
- No pricing rules beyond quantity slabs.

## Errors

`MasterDataError` carries `code` (`VALIDATION_FAILED`, `DUPLICATE_BLOCKED`, `NOT_FOUND`,
`CONFLICT`), a list of `problems` with stable machine codes, and, for duplicates, the candidate
records with the reason each one matched. Platform errors (`TENANT_ISOLATION`,
`IDEMPOTENCY_CONFLICT`, `FORBIDDEN`, …) pass through unchanged.

## Fixtures

`SAMPLE_PARTIES`, `SAMPLE_ITEMS`, `SAMPLE_TRANSPORTERS` and `SAMPLE_VEHICLES` are synthetic
Indian-business fixtures. `syntheticGstin(stateCode, pan)` builds a structurally valid GSTIN with
a correct check digit from an invented PAN, so tests never contain a real taxpayer's number.
Run `npm run demo:masters` for a printed walkthrough.
