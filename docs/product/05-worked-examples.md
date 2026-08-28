# Worked examples (issue #1 — [E01])

These examples exist so that the specification can be checked against something concrete. Every
number here is arithmetically verified and is reused as the seed of the golden dataset in issue
#43. All identifiers are synthetic.

> **About the tax rates below.** The rate values are *fixture* values chosen to exercise the
> arithmetic. They are illustrative until issue #54 records an authoritative source and effective
> date for each one, and issue #7 loads them as versioned rules. No module may hard-code a rate
> from this page. The point of each example is the **shape** of the result — which taxes appear,
> which accounts move, what is blocked — not the rate itself.

## The example business

**Sharma Fruit Traders**, a wholesaler in Delhi.

| Field | Value |
| --- | --- |
| Company | Sharma Fruit Traders |
| State | Delhi (state code 07) |
| GSTIN | `07AAAAA0000A1Z4` (synthetic) |
| Registration | Registered regular taxpayer, monthly filing |
| Branches | Karol Bagh shop, Narela godown |
| Financial year | 2026-27 |
| Go-live | 1 April 2026 |

Items:

| Code | Item | Base unit | Alternate unit | HSN | Fixture GST rate |
| --- | --- | --- | --- | --- | --- |
| `APL-BOX-10` | Apple box, 10 kg | BOX | 1 BOX = 10 KG | 0808 | Nil |
| `CRATE-P` | Plastic crate | PCS | — | 3923 | 18% |

Parties:

| Party | Role | State | GSTIN (synthetic) |
| --- | --- | --- | --- |
| ABC Traders | Customer | Delhi (07) | `07DDDDD3333D1ZV` |
| Gurugram Fresh Mart | Customer | Haryana (06) | `06BBBBB1111B1ZR` |
| Nashik Farms | Supplier | Maharashtra (27) | `27CCCCC2222C1Z8` |

Accounts used below are from the seeded India-ready chart of accounts (issue #4).

---

## Example 1 — Purchase of goods, nil-rated

Nashik Farms bill `NF/1187` dated 4 April 2026: 100 apple boxes at ₹500 each.

| Line | Quantity | Rate | Taxable value | GST | Total |
| --- | --- | --- | --- | --- | --- |
| Apple box, 10 kg | 100 BOX | ₹500.00 | ₹50,000.00 | Nil | ₹50,000.00 |

**Voucher** — type `PURCHASE`, date 4 April 2026, source document `NF/1187`:

| Account | Debit | Credit |
| --- | --- | --- |
| Purchases – Goods | ₹50,000.00 | |
| Nashik Farms (supplier) | | ₹50,000.00 |
| **Total** | **₹50,000.00** | **₹50,000.00** |

**Stock:** +100 BOX of `APL-BOX-10` into Narela godown, linked to `NF/1187`.
**Payable:** ₹50,000.00 to Nashik Farms.

What this example proves: a purchase invoice creates a purchase entry, a stock increase and a
supplier payable — never a sale and never a receivable. A nil rate produces no tax lines at all;
it does not produce a zero-rupee tax line and it is not the same as "tax unknown".

## Example 2 — Purchase of taxable goods, inter-state

Nashik Farms bill `NF/1191` dated 6 April 2026: 200 plastic crates at ₹200 each. Supplier is in
Maharashtra, place of supply is Delhi, so the supply is inter-state and IGST applies.

| Line | Quantity | Rate | Taxable value | IGST at 18% | Total |
| --- | --- | --- | --- | --- | --- |
| Plastic crate | 200 PCS | ₹200.00 | ₹40,000.00 | ₹7,200.00 | ₹47,200.00 |

| Account | Debit | Credit |
| --- | --- | --- |
| Purchases – Goods | ₹40,000.00 | |
| Input IGST | ₹7,200.00 | |
| Nashik Farms (supplier) | | ₹47,200.00 |
| **Total** | **₹47,200.00** | **₹47,200.00** |

The ₹7,200 input tax credit is recorded as **provisional** until the invoice appears in GSTR-2B
(issue #31). Provisional credit is visible to the owner as "waiting for the supplier to file",
not as money already saved.

## Example 3 — Intra-state sale, with round-off

Invoice `INV/KB/2026-27/00041` to ABC Traders (Delhi), dated 10 April 2026: 3 plastic crates at
₹333.33 each. Seller is in Delhi and the place of supply is Delhi, so CGST and SGST apply.

| Step | Working | Result |
| --- | --- | --- |
| Taxable value | 3 × ₹333.33 | ₹999.99 |
| CGST at 9% | ₹999.99 × 0.09 = ₹89.9991, rounded half-up | ₹90.00 |
| SGST at 9% | ₹999.99 × 0.09 = ₹89.9991, rounded half-up | ₹90.00 |
| Total before round-off | ₹999.99 + ₹90.00 + ₹90.00 | ₹1,179.99 |
| Round-off to nearest rupee | ₹1,180.00 − ₹1,179.99 | +₹0.01 |
| **Invoice value** | | **₹1,180.00** |

| Account | Debit | Credit |
| --- | --- | --- |
| ABC Traders (customer) | ₹1,180.00 | |
| Sales – Goods | | ₹999.99 |
| Output CGST | | ₹90.00 |
| Output SGST | | ₹90.00 |
| Round-off | | ₹0.01 |
| **Total** | **₹1,180.00** | **₹1,180.00** |

What this example proves: the voucher still balances after rounding, because the rounding
difference is itself posted. Rounding is applied once per tax line and once at the total, never
repeatedly.

## Example 4 — Stock check and a blocked oversale

Stock of `APL-BOX-10` at Narela godown after Example 1: 100 BOX physical, 0 reserved,
100 available.

**Sale A**, invoice `INV/KB/2026-27/00042` to ABC Traders, 12 April 2026: 70 boxes at ₹800.

| Line | Quantity | Rate | Taxable value | GST | Total |
| --- | --- | --- | --- | --- | --- |
| Apple box, 10 kg | 70 BOX | ₹800.00 | ₹56,000.00 | Nil (fixture) | ₹56,000.00 |

| Account | Debit | Credit |
| --- | --- | --- |
| ABC Traders (customer) | ₹56,000.00 | |
| Sales – Goods | | ₹56,000.00 |

Stock after: 30 BOX physical, 0 reserved, 30 available.

**Sale B**, attempted immediately after: another 70 boxes.

The product blocks it and says, in plain words:

> **Not enough stock.** You have **30 boxes** of Apple box, 10 kg at Narela godown. This bill needs
> **70 boxes**, so **40 are missing**.
> You can: reduce the quantity to 30 · pick a different godown · record the purchase that brought
> the stock in · ask someone with permission to allow a negative-stock sale and give a reason.

Nothing is posted. No partial invoice is created.

**Concurrency variant.** Two users each draft a sale for the last 30 boxes at the same moment.
The first draft reserves 30, so availability becomes 0 and the second user is blocked with the
corrected figure. Reservation happens inside the same transaction that checks availability, so a
race cannot produce two invoices for the same 30 boxes.

## Example 5 — Partial payment across two modes

Invoice `INV/KB/2026-27/00044` to ABC Traders, dated 15 April 2026: 125 apple boxes at ₹800,
nil-rated, invoice value **₹1,00,000.00**, payment terms 30 days, due 15 May 2026.

**Receipt 1** — cheque `112233` for ₹30,000 dated 20 April 2026, allocated fully to invoice 44.

| Account | Debit | Credit |
| --- | --- | --- |
| Cheques in hand | ₹30,000.00 | |
| ABC Traders (customer) | | ₹30,000.00 |

Cheque state `PENDING`. The customer's dues fall to ₹70,000 immediately, and the money is shown as
"cheque not cleared yet", not as bank balance.

**Cheque cleared** 24 April 2026:

| Account | Debit | Credit |
| --- | --- | --- |
| HDFC Current Account | ₹30,000.00 | |
| Cheques in hand | | ₹30,000.00 |

**Receipt 2** — bank transfer UTR `HDFCN26041800123` for ₹20,000 on 28 April 2026, allocated fully
to invoice 44.

| Account | Debit | Credit |
| --- | --- | --- |
| HDFC Current Account | ₹20,000.00 | |
| ABC Traders (customer) | | ₹20,000.00 |

**Position on invoice 44:** invoice value ₹1,00,000.00, allocated ₹50,000.00, **outstanding
₹50,000.00**. The invoice status is *partly paid*. It is never shown as paid.

The owner sees: **"ABC Traders still owes ₹50,000"** — not a debtor ledger extract.

**If the cheque had bounced** on 24 April: the clearing entry is not made, a reversal of the
receipt is posted, the outstanding returns to ₹80,000, the cheque moves to `BOUNCED` with the
bank's reason, and the whole history stays visible. Nothing is deleted or edited.

## Example 6 — Partial sales return

ABC Traders returns 25 of the 125 boxes on 2 May 2026. Credit note `CN/KB/2026-27/0003`.

| Line | Quantity | Rate | Value | GST | Total |
| --- | --- | --- | --- | --- | --- |
| Apple box, 10 kg | 25 BOX | ₹800.00 | ₹20,000.00 | Nil | ₹20,000.00 |

| Account | Debit | Credit |
| --- | --- | --- |
| Sales returns | ₹20,000.00 | |
| ABC Traders (customer) | | ₹20,000.00 |

**Stock:** +25 BOX back into Narela godown, linked to `CN/KB/2026-27/0003` and to invoice 44.
**Outstanding on invoice 44:** ₹50,000.00 − ₹20,000.00 = **₹30,000.00**.

Rules exercised: the return quantity cannot exceed 125 less earlier returns; the tax treatment is
the one that was effective for the original supply, not today's; and the original invoice is not
edited.

## Example 7 — Transport and vehicle plausibility

Consignment for invoice 44: 125 apple boxes, ₹1,00,000, Karol Bagh (Delhi) to Gurugram (Haryana),
by road, approximately 35 km.

The rules engine (#7) is asked a question with **facts**, and returns a **decision with evidence**:

```
facts:
  consignmentValue: 100000.00
  movement: INTER_STATE
  fromState: 07
  toState: 06
  mode: ROAD
  approxDistanceKm: 35
  documentDate: 2026-04-15
decision:
  outcome: REQUIRED | NOT_REQUIRED | CANNOT_DECIDE
  ruleId: gst.eway.applicability
  ruleVersion: <set by #7>
  effectiveFrom: <set by #54 from an official source>
  evidence: [ the facts and thresholds that produced the outcome ]
  missingFacts: [ ]
```

If any fact needed by the rule is missing, the outcome is `CANNOT_DECIDE`, an exception item is
opened, and no e-way bill is generated. The product never assumes a threshold.

**Vehicle plausibility.** The load is 125 × 10 kg = **1,250 kg**. If the user enters a two-wheeler
registration, the check compares the load against the vehicle class's capacity and blocks with:

> **This vehicle looks too small.** The goods weigh about **1,250 kg**, but the vehicle you entered
> is registered as a two-wheeler. Check the vehicle number, or record the correct vehicle.

## Cross-checks this page is required to satisfy

| Check | Where it is proved |
| --- | --- |
| A sale, a purchase, a partial payment, a return and a transport case each run end to end | Examples 1–7 |
| Every voucher shown balances to zero | Examples 1, 2, 3, 4, 5, 6 — debit and credit totals are equal |
| Rounding never breaks the balance | Example 3 |
| A partial payment never marks an invoice paid | Example 5 |
| An oversale is blocked with a plain-language explanation and safe options | Example 4 |
| A compliance question returns evidence and can refuse | Example 7 |
| Nil-rated is distinct from tax-unknown | Examples 1 and 7 |

`tools/test/spec-examples.test.ts` re-checks the arithmetic on this page so it cannot rot.
