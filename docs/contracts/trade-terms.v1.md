# Contract: `trade-terms` v1.0.0

| | |
| --- | --- |
| **Owner** | GPT 1, issue #11 [E11] |
| **Consumed by** | GPT 1 (#9 sales, #10 voice, #34 assistant), GPT 2 (#38 web) |
| **Package** | `@invoice/trade-terms` |
| **Depends on** | `@invoice/rules-engine` (#7), `@invoice/receivables` (#20), sales history (#9), price lists and party terms (#5, GPT 3), stock cost (#12) |
| **Status** | Published |

## Purpose

The three questions asked while a bill is being written: **what price**, **how much discount**, and
**should this customer be given more credit at all**.

## Three refusals

1. **A price is never invented.** If neither this customer's own history nor a price list has a
   figure, the answer is "we do not know", not a guess. The person types what they agreed.
2. **A price is never shown without saying where it came from.** Every suggestion carries its
   source and the evidence behind it — the invoice number and date it was last charged on, or the
   price list it was read from. That is the acceptance criterion *"price source is visible"*.
3. **Credit is never decided on unpaid bills alone.** Exposure is what they already owe **plus**
   bills started and not yet issued **plus** this one. Leaving out the unfinished bills is how two
   people at two tills put the same customer over their limit twice in a minute.

## Where a price comes from, in order

| Order | Source | Evidence carried |
| --- | --- | --- |
| 1 | `LAST_AGREED` — what this customer was actually charged last | invoice number and date |
| 2 | `PRICE_LIST` — the business's standard rate for the item | price list name, and the slab when one applies |
| 3 | `NONE` — nothing on record | nothing; the field stays empty and says so |

The customer's own last price wins because it is what was actually agreed with them, and a
shopkeeper who quoted ₹800 last week will be asked about ₹800 this week. Both are **suggestions**:
nothing is applied until a person accepts it.

`asOf` matters. A price is resolved as of the document's own date, so back-dating a bill to March
suggests March's price and not today's. A price agreed *after* the document date is not evidence
for it and is ignored.

## Discounts

A discount inside the business's own threshold is simply allowed. Beyond it, the sale needs
approval — it is not blocked and the draft is not thrown away, because the person may well be
right; someone with `sales.approve_discount` has to say so.

**Margin** is a warning, never a block. If the item's average cost is known and the price after
discount is below it, the page says so in money terms — *"you would be selling at ₹40 below what
these cost you"* — because that is a decision for the owner, not for the software. When the cost
is not known, no margin claim is made at all.

## Credit

`CreditDecision` is `ALLOW`, `WARN` or `BLOCK`, and it is the approved `sales.credit_limit` rule
(#7) that decides over-limit — this package supplies facts and applies the business's policy to
the rule's verdict. It does not do arithmetic the rules engine owns.

```
exposure = what they already owe + bills started but not issued + this bill
excess   = exposure - credit limit
```

Two things escalate a warning to a block, both configured by the business, never assumed:

- `creditAction: 'BLOCK'` — over the limit stops the bill outright.
- `blockWhenOverdueByDays` — a customer whose oldest unpaid bill is later than this is blocked
  regardless of the limit, because a limit means little when the last bill was never paid.

**No credit limit on file is not a limit of zero, and not unlimited either.** It is unknown: the
decision is `ALLOW` with a note saying no limit has been set, so nobody is stopped by a fact
nobody entered.

## Overrides

An override needs the permission (`sales.override_credit_limit`, or `sales.approve_discount` for a
discount) **and** a written reason. Both travel to the audit record with the actor and the figures
that were overridden. Refusing without the permission names the permission rather than saying no.

## Shape

```ts
interface TradeTermsQuote {
  readonly lines: readonly LineTerms[];      // price suggestion, discount, margin, per line
  readonly credit: CreditDecision;
  readonly outcome: 'ALLOW' | 'NEEDS_APPROVAL' | 'BLOCK';
  readonly reasons: readonly Bilingual[];    // what a person is told, in order of severity
}
```

`outcome` is the worst of the parts: any `BLOCK` blocks, otherwise any `NEEDS_APPROVAL` needs
approval, otherwise it is allowed.

## Permissions

`sales.override_credit_limit` (already in #9's `SALES_PERMISSIONS`) and `sales.approve_discount`
(new). Reading a quote needs no permission of its own: it decides nothing and writes nothing.

## Errors

| Code | Meaning |
| --- | --- |
| `TRADE_TERMS_OVERRIDE_NOT_ALLOWED` | The person may not override this, and it names which permission is missing |
| `TRADE_TERMS_OVERRIDE_REASON_REQUIRED` | Overriding a limit is deliberate, so it is written down |
| `TRADE_TERMS_QUANTITY_INVALID` | A price cannot be resolved for a quantity of zero or less |

## Known limitations

- **Price lists come through `PriceListPort`.** GPT 3's #5 owns them and has no effective dates on
  entries, so a price list rate is "current" with no history. Last-agreed prices, which this
  package derives from issued invoices, are effective-dated properly.
- **Cost for margin comes from #12's weighted average**, which is only as good as what purchases
  have recorded. While purchase posting is incomplete the cost is often unknown, and the margin
  warning correctly stays silent rather than claiming a loss.
- **Concurrency is handled by counting unissued drafts, not by locking.** Two tills writing bills
  for one customer both see each other's drafts in `pending`, so the second is warned. Two bills
  *issued* in the same instant are a ledger-level concern and are not serialised here.
- Nothing here posts, prices tax, or changes a document. It answers questions.
