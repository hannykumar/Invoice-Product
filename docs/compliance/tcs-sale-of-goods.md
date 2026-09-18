# No tax collected at source on the sale of goods (issue #184)

**Decision (2026-09-18):** the product does not add tax collected at source (TCS) to any sales bill.
Issue #145 had built TCS on sales to one customer above ₹50 lakh a year (0.1%, or 1% without a tax
number). It was removed completely: the calculation, the setting, the per-customer yearly total, the
line and the note on the printed bill, and the automatic posting to the books.

**Why:** that TCS stopped on **1 April 2025**. The Finance Act 2025 added a proviso to section
206C(1H) of the Income-tax Act, 1961, so that the sub-section "shall not apply from 1st April, 2025"
(Finance Bill 2025, Notes on Clauses, as introduced in Lok Sabha:
https://www.indiabudget.gov.in/budget2025-26/doc/Finance_Bill.pdf). The
Income-tax Act, 2025, in force from 1 April 2026, lists TCS in section 394 and has no entry for the
sale of goods above ₹50 lakh.

**Not the seller's to add:** the buyer's TDS on purchases of goods above ₹50 lakh (old section 194Q,
now section 393(1)) is deducted by the buyer from its payment. It never appears as an extra amount on
the seller's bill, so it was not built in place of TCS.

The ledger account `2400 Tax collected from customers for the government` stays in the chart of
accounts for the TCS cases that still exist (for example scrap), but nothing posts to it
automatically. Bills already issued are unchanged: the setting shipped switched off, so none carried
TCS.
