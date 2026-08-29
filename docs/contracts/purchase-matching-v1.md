# Purchase orders, goods receipts and three-way matching — v1

Issue #18 [E18]. Owner: GPT 3. Package: `packages/purchasing`.

Compare what was ordered, what physically arrived and what the supplier charged for — without
forcing a purchase order on a business that has never raised one.

## The one rule everything else follows

**Stock moves when goods are confirmed, and it moves by the accepted quantity.**

Not the ordered quantity, which is a hope. Not the invoiced quantity, which is the supplier's
claim. If 100 boxes arrive and 10 are soaked, 90 go on the shelf and the other 10 never exist as
stock, whatever the bill says.

## The three documents

| Document | What it is | Touches the ledger? | Touches stock? |
| --- | --- | --- | --- |
| `PurchaseOrder` | A promise to buy. Optional. | No | No |
| `GoodsReceipt` | What a lorry actually brought, and what was kept. | No | **Yes, on confirm** |
| Supplier bill (#17) | What is owed and the GST on it. | Yes | Only if no receipt covered it |

A purchase order is not a financial document, so nothing about it reaches the books: agreeing to
buy something changes neither the ledger nor the godown. The delivery moves goods; the bill moves
money. Keeping them apart is what lets a delivery on Monday and a bill on Friday both be true.

### Purchase order lifecycle

```
DRAFT ──place──▶ PLACED ──goods arrive──▶ PARTIALLY_RECEIVED ──all arrived──▶ RECEIVED
                   │                              │
                   ├──cancel (nothing received)──▶ CANCELLED
                   └──────────close (rest no longer expected)──────────────▶ CLOSED
```

`CANCELLED` and `CLOSED` are different statements and are not interchangeable. An order that has
already received goods **cannot** be cancelled — cancelling would say the goods on the shelf were
never ordered. It is closed instead, which says "we are not expecting the rest".

The state is derived from the confirmed receipts every time, not nudged one step at a time, so
cancelling a delivery walks the order backwards correctly rather than leaving it stuck.

### Goods receipt lifecycle

```
DRAFT ──confirm──▶ CONFIRMED ──cancel──▶ CANCELLED
   └──────────────────cancel───────────────┘
```

`CONFIRMED` is the moment stock moves. Cancelling a confirmed receipt takes the accepted goods
back out; if some of them have already been sold the godown refuses and the whole cancellation is
undone, rather than leaving the books and the shelf disagreeing.

Every receipt line keeps `receivedQuantity` and `acceptedQuantity` apart. Turning anything away
requires a `rejectionReason`, because "10 boxes short" and "10 boxes arrived soaked" are different
conversations to have with a supplier. `QualityEvidence` holds who checked, when, the note in
their own words, and ids of photos and paperwork.

### Valuation

Accepted goods enter stock at the receipt line's `ratePaise`. With an order, that is the agreed
price. Without one, the receiver states it — a receipt with no price is **refused**, because stock
taken in at a price nobody named quietly wrecks the average cost of everything on that shelf.

## Matching

`matchPurchase(input, policy)` is a pure function: no database, no permissions, no writes. The same
three documents always give the same answer, which is what makes a retry safe and a dispute with a
supplier arguable months later.

Comparison is **per item, not per line**. The three documents almost never number their lines the
same way — one order line can arrive on three lorries and be billed on two invoices — so matching
line 1 to line 1 would find disagreements that are not there.

### Kinds

| Kind | Documents available |
| --- | --- |
| `THREE_WAY` | order + confirmed receipt(s) + bill |
| `TWO_WAY_RECEIPT` | receipt(s) + bill — the small-business path |
| `TWO_WAY_ORDER` | order + bill, nothing confirmed as arrived |
| `INVOICE_ONLY` | just the bill |

### Findings

Each `MatchFinding` carries the field it is about (`lines[2].quantity`), what each of the three
documents said, the difference, whether it fell inside tolerance, and a message written for
someone who has never studied accounting.

| Code | Severity | Meaning |
| --- | --- | --- |
| `INVOICED_ABOVE_ACCEPTED` | HOLD | Billed for more than was kept. The classic overcharge. |
| `INVOICED_BELOW_ACCEPTED` | REVIEW | Billed for less — usually the rest is on a later bill. |
| `OVER_DELIVERED` | HOLD¹ | More arrived than was ordered. |
| `UNDER_DELIVERED` | REVIEW | Less arrived; the balance is still to come. |
| `REJECTED_ON_ARRIVAL` | INFORMATION | Some of the delivery was turned away, with the reason. |
| `PRICE_ABOVE_ORDER` | HOLD | Charged more per unit than agreed. |
| `PRICE_BELOW_ORDER` | REVIEW | Charged less — in the buyer's favour, still worth a look. |
| `TAX_RATE_DIFFERS` | REVIEW | Bill's GST rate differs from the order's. |
| `ITEM_NOT_ORDERED` | HOLD | Billed for something the order never mentioned. |
| `ITEM_NOT_RECEIVED` | HOLD | Billed for something no delivery brought. |
| `ITEM_NOT_INVOICED` | INFORMATION | Received but not on this bill. Normal for split billing. |
| `UNITS_DIFFER` | HOLD | The same goods in different units. Never converted mid-comparison. |
| `NO_ORDER` | INFORMATION | Stated, not held against anyone. |
| `NO_RECEIPT` | INFORMATION | Nothing confirms the bill against what arrived. |

¹ `INFORMATION` when the company's policy sets `allowOverDelivery`.

Anything inside tolerance is still reported, with `withinTolerance: true` and severity dropped to
`INFORMATION`. The buyer sees the difference; it just does not stop the work.

### Outcomes

| Outcome | Meaning |
| --- | --- |
| `MATCHED` | The documents agree. |
| `WITHIN_TOLERANCE` | Differences exist, but none of them stops the bill being recorded. |
| `HOLD_FOR_APPROVAL` | Something real disagrees. A person must decide first. |
| `BLOCKED` | The documents cannot be compared at all (different units). |

### Tolerances

`MatchTolerancePolicy` is per company and effective-dated, and is recorded on every match, so a
decision taken last year is explained under the tolerance in force then rather than today's.

| Field | Default | Why |
| --- | --- | --- |
| `quantityBasisPoints` | 100 (1%) | Sand, steel and grain are weighed, not counted. |
| `quantityAbsoluteMicro` | 0 | A flat allowance for small orders where a percentage is nothing. |
| `priceBasisPoints` | 50 (0.5%) | Wider than this is a renegotiation, not a rounding. |
| `priceAbsolutePaise` | 100 (₹1) | |
| `taxAbsolutePaise` | 100 (₹1) | Ordinary GST rounding. |
| `allowOverDelivery` | `false` | Extra goods are extra money; the buyer decides. |

### Approvals

A held bill is cleared only by `approveMatch`, which requires the `purchase.match.approve`
permission and a reason. The approval is pinned to the match's `fingerprint` — a hash over the
three documents and the tolerance — so changing a quantity after approving means the old approval
no longer covers the new bill.

## Interaction with #17 (posting the bill)

`ApprovedPurchaseLine.receivedAgainstReceiptId` is set when a confirmed goods receipt already put
the goods on the shelf. Posting then records the money and nothing else: no second stock movement,
no warehouse required on the bill line. Receiving again would count the delivery twice, and would
count it at the supplier's claimed quantity rather than the quantity the godown accepted.

Where no receipt covers a line, #17 behaves exactly as it did before — the bill moves the stock.
That is what keeps the everyday "just enter the bill" path unchanged.

## Permissions

| Permission | Guards |
| --- | --- |
| `purchase.order.write` | Raising, placing and closing orders |
| `purchase.order.cancel` | Cancelling an order |
| `purchase.receipt.write` | Recording, confirming and cancelling deliveries |
| `purchase.match.approve` | Letting a held bill through |

Confirming a delivery also needs the godown's own `inventory.move`, because it moves stock.

All four are in the platform's `Permission` catalogue and in `PRODUCT_OWNER_PERMISSIONS`, so the
HTTP surface derives them from the signed-in session like every other permission (#80).

Tenancy comes from the repository query, never from an id the caller supplied. An order in another
business is reported as **missing**, not forbidden, so nothing is leaked by asking.

## Idempotency

| Action | Key | Behaviour on retry |
| --- | --- | --- |
| `createOrder` | order number | Returns the existing order |
| `recordReceipt` | receipt number | Returns the existing receipt |
| `confirmReceipt` | `grn:receive:<receiptId>:<line>` | Stock moves once |
| `cancelReceipt` | `grn:return:<receiptId>:<line>` | Reverses once |
| `approveMatch` | match fingerprint | Returns the existing approval |

## Storage

Migration `20260829T130536327Z_purchasing_77404f7e8b5f_three_way_matching`:
`purchase_orders`, `purchase_order_lines`, `goods_receipts`, `goods_receipt_lines`,
`goods_receipt_movements`, `purchase_match_tolerances`, `purchase_match_approvals`.

The database enforces the same two rules the service does: `accepted_quantity_micro <=
received_quantity_micro`, and a rejection always carries a reason.

Stock movement ids are stored without a foreign key, exactly as #17 does — that table belongs to
#12 and this migration must not fail because their SQL has not landed yet.

## Known limitations

1. **Inventory is not revalued when the bill disagrees with the order.** Accepted goods are valued
   at the receipt's rate. If the bill later charges more, the match reports `PRICE_ABOVE_ORDER`,
   but the stock valuation is not adjusted. Landed-cost revaluation belongs with #45.
2. **No goods-received-not-invoiced accrual.** Confirming a delivery moves stock but posts nothing
   to the ledger, so between the delivery and the bill the godown and the books are deliberately
   out of step. A GRNI account needs a home in GPT 1's chart, in the way #73 gave one to services
   bought and reverse-charge GST.
3. **Service lines are not received.** A goods receipt is for goods. Services on an order are
   matched on price and tax only.
4. **One tolerance policy per company**, not per supplier or item group.
5. **Units are never converted during a comparison.** Order in boxes and bill in pieces gives
   `BLOCKED` rather than a converted answer. Deliberate: converting a stock figure on the way into
   a comparison is how a real mismatch gets hidden by arithmetic.

## Try it

```sh
npm run demo:matching   # the whole story on a terminal, no database
npm run web             # sign in, then the "Deliveries" screen: order, delivery, bill side by side
```
