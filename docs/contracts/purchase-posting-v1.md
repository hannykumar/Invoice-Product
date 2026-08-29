# Contract: `purchase-posting` v1.0.0

| | |
| --- | --- |
| **Owner** | GPT 3, issue #17 [E17] |
| **Consumes** | `purchase-validation-v1` (#16), `ledger.v1` (#4), `inventory.v1` (#12), `master-data-v1` (#5) |
| **Consumed by** | `receivables.v1` (#20 payables), GPT 3 (#18 three-way match, #26 GSTR-2B, #31 ITC), GPT 1 (#45 returns) |
| **Package** | `@invoice/purchasing` |
| **Status** | Published |

## Purpose

Turn an approved purchase bill into the three things it means: the entry in the books, the goods
in the godown, and the money owed to the supplier. This is the first module in the purchase lane
allowed to touch money — #15 receives paper and #16 decides whether it is safe.

## The one rule

**All three, or none.** There is no state in which the books show a purchase the godown does not,
or a supplier is owed money for goods that never arrived. Everything is written inside one
`LedgerStore.transaction`, so a failure anywhere leaves nothing behind.

This is possible because GPT 1 designed for it. `LedgerService.postVoucherIn` already existed for
document-owning modules; this issue adds the matching `InventoryService.recordMovementIn` and
`LedgerService.reverseVoucherIn`, and the in-memory bill store joins the ledger store as a
`TransactionParticipant`. In PostgreSQL it is one transaction and none of that is needed.

## What gets posted

| Side | Account role | Amount |
| --- | --- | --- |
| Dr | `PURCHASES_GOODS` | landed cost of goods lines: taxable value, plus GST that cannot be claimed |
| Dr | `PURCHASES_SERVICES` *(see below)* | the same, for service lines |
| Dr | `INPUT_CGST` / `INPUT_SGST` / `INPUT_IGST` / `INPUT_CESS` | only the tax that can be claimed |
| Dr/Cr | `ROUND_OFF` | the gap between the recomputed figures and the printed total |
| Cr | the supplier's own party account | what the bill asks for, carrying `partyId` |
| Cr | `REVERSE_CHARGE_PAYABLE` *(see below)* | GST the business owes the government directly |

The supplier's balance is **not a fourth store**. It is the credit on the supplier's account in
the same voucher, which is why it can never drift from the books.

## The gate: only what #16 cleared

`post` refuses unless `verdict.status === "POSTABLE"`, the verdict belongs to the same company,
and the duplicate verdict is not `CONFIRMED`. It also refuses when `verdict.taxCheck.intraState`
is undefined — meaning the rules engine could not decide whether the supply was within the state.
A purchase posted under the wrong head is a wrong GST return three weeks later, so it is refused
rather than guessed. This is rule 4 of the brief in one line of code.

## Tax

CGST and SGST are computed as "half, and whatever is left", so an odd paise is never lost and
`cgst + sgst` always equals the GST charged. Every figure is `bigint` paise rounded half-up, using
**#16's own `taxOn` and `divideRoundHalfUp`**, so the module that checks the bill and the module
that posts it can never disagree by a paise.

`itcEligibility` is stated per line by the caller, never decided here: blocked credit under
section 17(5) is a compliance ruling. `INELIGIBLE` tax is added to what the goods cost, which is
also what the stock is then valued at.

## Rounding, and the limit of it

Up to `ROUND_OFF_TOLERANCE_PAISE` (₹1, the same default #16 uses) goes to `ROUND_OFF`, because
Indian bills routinely round the payable figure. Anything larger is a real disagreement: the
posting is refused, nothing is written, and it goes back to a person.

## Stock

Only `GOODS` lines move stock, and only into a named godown — goods with no godown are refused,
never posted to a default. The quantity is converted to the item's base unit by #12 using #5's
registry, which refuses a conversion that would not land on a whole micro-unit.

`unitCost` is **cost per base unit**: the line's landed cost divided by the quantity in the unit
stock is kept in. Ten boxes of twenty-four for ₹2,400 values each of the 240 pieces at ₹10.

## Idempotency

Keyed on the **purchase id**, not only the idempotency key. Posting the same approved purchase
again returns the bill that already exists, even under a different key — that is what makes a
retry after a timeout safe. A partial unique index (`purchase_bills_one_live_idx`) enforces the
same rule in the database, so two racing requests cannot both win.

Reusing one key with genuinely different input still raises the platform's `CONFLICT`, unchanged.

## Corrections are reversals

`reverse(billId, { on, reason })` writes the mirror voucher, takes the receipts back out and
closes what was owed — all in one transaction. The original voucher is untouched; posted entries
are immutable, so a correction is always a visible new entry.

Taking stock back out can push a bin negative when the goods have already been sold. #12 refuses
that unless the caller holds `inventory.override_negative` and gives a written reason, and the
whole reversal is undone rather than leaving the books and the shelf disagreeing.

A reversed bill cannot be posted again: it must be approved afresh, so the correction stays in
the trail.

## What #20 reads

`purchaseDocumentLedger(bills, nameOf)` implements `receivables.v1`'s `DocumentLedgerPort`,
returning posted bills as `OpenDocument`s with `kind: "PURCHASE_INVOICE"` and `side: "PAYABLE"`.
A reversed bill is not an open document — the reversal took the credit back out of the books, so
leaving it would show money owed that the ledger disagrees with.

`dueDate` is the invoice date plus the supplier's credit days. Settling the bill is #20's.

## Permissions

`ledger.post.purchase` to post and `ledger.reverse` to reverse — both already exist in `ledger.v1`;
this contract adds no new permission. Moving stock additionally requires `inventory.move`, and the
negative-stock override requires `inventory.override_negative`, both enforced inside #12.

## Both proposals to GPT 1 are now settled (issue #73)

They were raised here rather than added silently, per the working agreement, and GPT 1 has since
put both roles in the standard chart:

| Code | Name | Type | Role |
| --- | --- | --- | --- |
| `5120` | Services and expenses bought | `EXPENSE` | `PURCHASES_SERVICES` |
| `2300` | GST you owe the government yourself | `LIABILITY` | `REVERSE_CHARGE_PAYABLE` |

`2300` deliberately hangs off `2000 What the business owes` rather than `2200 GST you collected`:
on a reverse-charge bill nobody collected that tax from anyone, and grouping the two together
would tell a shopkeeper they hold money they never took.

The role lookup already ran first, so this service needed no change. **`accountCodes` is now
optional and unused** — a business no longer has to nominate an account before it can record a
freight bill. The field is kept for a company whose chart genuinely differs, and the refusals
below still apply if a role resolves to nothing.

## Errors

Domain errors from `@invoice/kernel`, with codes `PURCHASE_NOT_CLEARED`, `PURCHASE_DUPLICATE`,
`PURCHASE_TAX_SPLIT_UNDECIDED`, `PURCHASE_TOTAL_DISAGREES`, `PURCHASE_NOT_POSTABLE`,
`PURCHASE_ACCOUNT_MISSING`, `PURCHASE_SERVICES_ACCOUNT_MISSING`,
`PURCHASE_REVERSE_CHARGE_ACCOUNT_MISSING`, `PURCHASE_SUPPLIER_ACCOUNT_MISSING`,
`PURCHASE_ALREADY_REVERSED`, `PURCHASE_BILL_UNKNOWN` and `PURCHASE_UNKNOWN`. Errors raised inside
#4 and #12 (`STOCK_BATCH_REQUIRED`, `STOCK_WOULD_GO_NEGATIVE`, `PERMISSION_DENIED`, …) pass
through unchanged, because their wording is already aimed at a shopkeeper.

## Known limitations

- Purchase orders and goods-receipt matching are #18; a bill posts on its own approval today.
- Reversal is whole-bill. Partial returns are #45 and will use the same receipts record.
- Bills are held in memory behind `PurchaseBillRepository`; the PostgreSQL tables exist in
  migration `…_purchasing_…_purchase_posting`, and the repository over them is the next step.
- The web preview shows the posting states in words; it is a static shell (#38) not yet wired to
  these modules.

## Try it

```sh
npm run demo:posting
```

Five approved bills, two of them refused, then a duplicate approval and a reversal — against the
real ledger and the real godown, with no database and no GST portal.
