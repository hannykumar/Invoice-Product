# Contract: `inventory` v1.0.0

| | |
| --- | --- |
| **Owner** | GPT 1, issue #12 [E12] |
| **Consumed by** | GPT 1 (#9 sales, #35 reports, #36 onboarding, #37 migration), GPT 3 (#17 purchase posting, #45 returns, #18 goods receipt) |
| **Package** | `@invoice/inventory` |
| **Depends on** | `@invoice/ledger` (#4), `packages/masters` units (#5) |
| **Status** | Published — **replaces the mock issue #9 was built against** |

## Purpose

Know what is in the godown, and refuse to sell what is not.

## Stock is a fold, never a stored number

There is no "quantity on hand" column. Stock is the sum of an append-only movement ledger, exactly
as a ledger balance is the sum of journal lines, and for the same reason: a stored count can be
edited, and once it has been, nothing in the system disagrees with it.

| Figure | Meaning |
| --- | --- |
| **Physical** | What is in the godown, from posted movements only |
| **Reserved** | Held by unfinished bills |
| **Available** | Physical minus reserved — **this is what a sale is checked against** |

A hundred boxes with seventy promised is thirty you can sell. Telling a shopkeeper otherwise is how
the same goods get sold twice.

## Overselling

Availability is checked and the hold taken **inside one transaction**, which is the whole defence.
A test fires twenty bills at the last thirty kilos and exactly one succeeds.

When any line of a bill falls short, **nothing is held** — a half-held bill quietly locks goods it
will never use. Two lines of one bill cannot both claim the last box either.

## Negative stock

Default is `BLOCK`. A business that genuinely sells ahead of its paperwork switches to
`WARN_WITH_OVERRIDE`, and then every override needs the `inventory.override_negative` permission
and a written reason, both recorded on the movement and in the audit trail. The resulting negative
balance stays **visible**, not hidden.

## Units, batches and serials

Conversion uses GPT 3's `UnitRegistry.convertExact` — item-specific factors (1 BOX = 10 KG) and a
**refusal rather than a rounding** when a quantity does not divide evenly. Movements store both what
the person typed and the base-unit figure, so a bill can be explained years later.

A batched item must name its batch; batches are counted separately, so milk in stock does not make
an empty batch sellable. A serialised item needs one serial number per piece.

**Asking for a balance is a different thing from taking stock out.** `balance()` reads the batch
the way the repositories do:

| `batchId` | Question it asks |
| --- | --- |
| omitted | every batch added together — "how much is in the godown?" |
| `null` | only stock that is in no batch |
| a string | that one batch |

The answer carries `coversAllBatches` so a caller can tell the first from the second, because
`batchId: null` alone cannot. Collapsing the omitted case into `null` made a batch-tracked item
report **zero** while its shelves were full (issue #86), and zero is the most dangerous wrong
answer stock can give: it reads as "we are out", which is what a reorder prompt or a low-stock
warning would act on. Taking stock out is unchanged and still judged against the named batch
alone.

## Returns, cancellations and transfers

- **Cancellation and returns** mirror the original movements. Nothing is deleted, so the stock
  ledger shows what happened rather than showing that nothing happened. Idempotent.
- **Transfers** are two linked movements, so both ends are traceable and the business-wide total
  does not change.
- **Adjustments** always require a reason, because the difference is unexplained by itself.

## Valuation

Weighted average only. Goods leaving are valued at the running average at the time, so the cost of
what remains does not jump. Asking for another method is refused rather than silently treated as
weighted average — changing it retrospectively changes profit already reported.

## Using it from sales

```ts
import { salesInventoryAdapter } from '@invoice/inventory';

const sales = new SalesService({ /* … */ inventory: salesInventoryAdapter(inventory, { defaultWarehouseId: 'narela' }) });
```

## Two contract changes this made necessary

1. **`InventoryPort` now takes an `ActorContext`, not a bare `companyId`.** Permissions must be
   checked against the acting user, and a port that only knew the company could not do that.
2. **`SalesService.finalise` reserves before issuing.** A bill needing no approval went straight
   from draft to final, so nothing had held its goods — it was issued and posted **no stock
   movement at all**. The books would have said the goods were sold and the godown would have said
   they were still there. Found by the integration test; fixed in `packages/sales`.

## A duplication worth removing

Two `Quantity` types mean the same thing: the kernel's `{ scaled, unit }` and master data's
`{ micro, unitCode }`. Both are integer micro-units, so `toMasterQuantity` / `toKernelQuantity` are
renames and nothing is lost. It should still be one type. Raised with GPT 3 rather than papered over.

## Known limitations

- Movements are not yet posted to the ledger as value. Stock valuation is computed here; the
  journal entries that carry it belong with #17 and #35.
- Period locks are not enforced on a movement date. The ledger enforces them on the entry, so a
  backdated movement without an entry can still be recorded. Worth closing when #17 posts value.
- Batch expiry and FEFO picking are not implemented; batches are tracked but not ordered.
- Serial numbers are recorded but not individually followed through sale and return.
