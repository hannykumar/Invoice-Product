# Contract: `gst-calc` v1.0.0

| | |
| --- | --- |
| **Owner** | GPT 1, issue #25 [E25] |
| **Consumed by** | GPT 1 (#9 sales, #13 templates, #35 reports), GPT 3 (#17 purchase posting, #30 GSTR-1/3B, #45 returns) |
| **Package** | `@invoice/gst-calc` |
| **Depends on** | [`rules-engine`](./rules-engine.v1.md) (#7, published), [`master-data-ports`](./master-data-ports.v1.md) (#5, **mocked**) |
| **Status** | Published |

## Purpose

Work out GST for a document, deterministically, and say why.

The division of labour matters: **this module does the arithmetic, the rules engine makes the
judgements.** Whether a supply is intra-state, whether a union territory is involved, and whether a
composition dealer may charge GST are all rule decisions delegated to #7 and returned with the
answer. This module knows how to multiply, apportion and round. It does not know the law, and no
model is involved in any part of it.

## Calling it

```ts
const result = calculator.compute({
  companyId, documentDate, partyId,
  supplyKind: 'GOODS',
  deliveryStateCode: '06',          // or placeOfSupplyStateCode when a person has confirmed it
  lines: [{ lineId, itemId, quantity, unitPrice, priceBasis: 'EXCLUSIVE', discount }],
  freight, otherCharges,
  roundToWholeRupee: true,
  source: { kind: 'sales_invoice', id: 'si-44' },
});
```

`result.status` is `COMPUTED` or `CANNOT_COMPUTE`. **There is no third possibility and no partial
answer.** A caller must handle both; a bill that cannot be taxed is never posted.

## What is supported

| | |
| --- | --- |
| Splits | CGST + SGST, CGST + UTGST, IGST — chosen by rule, never by this file |
| Treatments | `TAXABLE`, `NIL_RATED`, `EXEMPT`, `NON_GST`, and `UNKNOWN` which blocks |
| Pricing | Tax-exclusive and tax-inclusive, with the parts adding back to exactly the quoted price |
| Discounts | Percentage and amount, applied before tax |
| Charges | Freight and other charges apportioned across lines by value, then taxed with them |
| Cess | Percentage of value, fixed amount per unit, or the higher of the two |
| Reverse charge | Tax is computed and reported separately, and is **not** billed to the customer |
| Composition | No GST is charged, and the bill says so in plain words |
| Rounding | One rounding, at the end, half-up to the whole rupee, with the difference reported |

## Refusals — the important half

Every one of these stops the computation and produces plain-language reasons plus exception drafts.
**Every problem on the document is reported at once**, so a person fixes four things in one pass.

| Code | When |
| --- | --- |
| `PLACE_OF_SUPPLY_UNKNOWN` | We do not know which state the sale counts in (`messageId: tax.place_of_supply_missing`) |
| `TAX_SPLIT_UNKNOWN` | The rule could not decide which taxes apply |
| `ITEM_NOT_CLASSIFIED` | The item's treatment is `UNKNOWN` — never defaulted to taxable |
| `HSN_MISSING` | A taxable item has no government code |
| `RATE_NOT_FOUND` | No rate entry covers the code on that date |
| `RATE_NOT_REVIEWED` | A rate exists but its source has not been checked (production mode) |
| `GSTIN_STATE_MISMATCH` | The GST number and the state disagree; we will not choose between them |
| `INCLUSIVE_WITH_CESS_UNSUPPORTED` | Tax-inclusive pricing on a line carrying cess |
| `COMPOSITION_UNDECIDED` | The rule could not decide whether GST may be charged |
| `COMPANY_NOT_FOUND`, `PARTY_NOT_FOUND`, `ITEM_NOT_FOUND` | Master data is missing |

## Rounding, stated precisely

1. Quantity × unit price is one exact multiplication, rounded half-up once.
2. Discount is applied to that.
3. Freight and other charges are apportioned by value; the shares add back to exactly the charge.
4. **CGST and SGST are each computed at half the rate**, matching Indian practice, and the line's
   total tax is their sum. It is not computed at the full rate and halved.
5. On a tax-inclusive line the components are computed first and the taxable value is whatever is
   left, so the parts always add back to exactly the price that was quoted.
6. Totals are the sum of line values, never re-rounded.
7. One rounding at the very end, half-up to the whole rupee, with `roundOff` reported so the ledger
   can post it and stay balanced.

## Effective-dated rate data

`RateTable` entries carry `effectiveFrom`, `effectiveTo`, `sourceRef` and `reviewState`, and are
matched by **longest code prefix** among entries effective on the document date. The rate that
applies is the one in force on the document's own date, never the newest.

**Every shipped entry is `DRAFT` with a placeholder source**, so `production` mode refuses all of
them. Issue #54 supplies the sources; when it does, only `reviewState` and `sourceRef` change. No
module may copy a percentage out of `src/rate-table.ts`.

## Permissions and tenant isolation

The calculator holds no data. Every master-data read is scoped by `companyId` from the caller.
**A caller must pass the company of the acting user**, and must have applied its own permission
checks first — the calculator is arithmetic, not an authorisation boundary.

## Idempotency

Pure. Computing twice returns identical lines, totals and explanations, and writes nothing.
Exception drafts carry an idempotency key derived from the rule decision, so refusing the same
document twice queues one item.

## Known limitations

- Exports, SEZ supplies and imports are not supported and are refused rather than approximated.
- Services place of supply falls back to the delivery state; the rule set has no services-specific
  rule yet, so unusual service cases return `CANNOT_DECIDE`.
- Tax-inclusive pricing is not supported on a line carrying cess.
- Rate data is code, not configuration. When #54 makes it data, `RateTable` gains a loader.
