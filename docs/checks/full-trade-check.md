# The full trade check

**This page is permanent. Do not delete it, and do not close its issue (#242), when the problems it found are fixed.**

Samay asked for it on 27 September 2026: one check of a whole trade, from buying the goods to filing the month's GST, run again after every set of changes, "to have a version to check all". Each issue is proved on its own. This page proves that everything still works **together**.

It is run on the real app (`npm run web`) by a person or an agent, and the same trade is run automatically by `tests/e2e/full-trade.test.ts` (issue #238). When the two disagree, this page is the reference, and both must be fixed in the same pull request.

## How to run it

1. `npm run web`, open `http://127.0.0.1:4173`, and sign in with the details already filled in (a made-up owner of the demo company).
2. The company is **Sampoorna Traders**, Bengaluru, Karnataka, GST number `29AAAAA0000A1ZY`. It starts with three small old bills to ABC Traders (₹1,050, ₹525 and ₹263, so ₹1,838 owed) and no stock.
3. Do the steps below in order, typing exactly what is written. After each step, compare what the screen says with **What must appear**. Write the date, the code version (`git log -1 --oneline`) and the result of every step in the run log at the bottom.

## The trade

### Step 1. Buy the goods (Purchase)

- Supplier: Shree Ram Steels Private Limited, GST number `27AAECS5678D1Z4` (Maharashtra)
- Their bill: `SRS-101`, dated today, total ₹37,760
- 500 KGS of TMT Steel Bar 12mm at ₹64, GST 18%

What must appear:
- The supplier is in Maharashtra and we are in Karnataka, so the tax is **IGST** (the tax on sales between two states). Nobody is asked which state the supplier is in; the GST number says it.
- Goods: 500 × ₹64 = ₹32,000
- IGST: 18% of ₹32,000 = ₹5,760
- Total: ₹32,000 + ₹5,760 = ₹37,760, which matches the bill
- Stock: **500 KGS**. Owed to the supplier: **₹37,760**.

### Step 2. Add the customer (Sale → Add a new customer)

- Mehta Construction Supplies, GST number `27AAACM1234K1ZN`, Plot 22, MIDC Bhosari, Pune 411026

What must appear: the state is filled in as **Maharashtra (27)** from the GST number.

### Step 3. Sell (Sale)

- Customer: Mehta Construction Supplies. Pay within 30 days.
- 450 KGS of TMT Steel Bar 12mm at ₹90
- Freight: ₹2,000
- Vehicle: `KA01AB1234`

What must appear on the review:
- Goods: 450 × ₹90 = ₹40,500
- Plus freight: ₹40,500 + ₹2,000 = ₹42,500
- IGST: 18% of ₹42,500 = ₹7,650
- Total: ₹42,500 + ₹7,650 = **₹50,150**
- "Needs an e-way bill": the goods cross a state border and are worth more than ₹50,000.
- Whether it needs an e-invoice, decided from the turnover saved in Business details (#239).
- No credit-limit warning, because nobody set a limit for this customer (#235).

After **Record once**:
- A bill number of **16 characters or fewer**, for example `INV/26-27/000004`.
- The sale form is **empty** again (#233).
- Stock: 500 − 450 = **50 KGS** (#229).
- Home screen: the bill is shown under **Mehta Construction Supplies**. "Money customers owe you" is ₹1,838 + ₹50,150 = **₹51,988** (#237).

### Step 4. Try to sell more than is in stock (Sale)

- Same customer, 600 KGS of TMT Steel Bar 12mm at ₹90

What must appear: **refused**. "You have 50 KGS … This bill asks for 600 KGS." No bill number is used up (#229).

### Step 5. Check the printed bill (the bill below the Sale screen)

Each of these must be on the A4 bill:
- TAX INVOICE and ORIGINAL FOR RECIPIENT
- Our name, full address with PIN, GST number, PAN, phone and email
- Bill number, date, due date (today + 30 days), vehicle KA01AB1234, place of supply Maharashtra (27), reverse charge "No"
- Buyer and ship-to: Mehta Construction Supplies, Plot 22, MIDC Bhosari, Pune 411026, Maharashtra (27), GST number
- The line: TMT Steel Bar 12mm, HSN 72142090, 450 KGS, ₹90.00, 18%, ₹40,500.00. Then freight ₹2,000.00.
- Taxable ₹42,500.00, IGST ₹7,650.00, total ₹50,150.00, and the total in words
- HSN summary: 72142090, ₹42,500.00, 18%, ₹7,650.00
- "For Sampoorna Traders", "Authorised Signatory"

### Step 6. E-way bill (from the finished sale, #240)

What must appear:
- The bill, the Pune address, PIN 411026 and vehicle KA01AB1234 are already filled in.
- The distance is worked out from the two PIN codes. For 840 km: 840 ÷ 200 = 4.2, and part of a day counts as a whole day, so the bill is valid for **5 days**.
- No complaint about freight (#231).
- "Valid until" is 5 days after **today**, not a date in the past (#234).
- After Raise: a 12-digit e-way bill number, and "Print for the driver".

### Step 7. Money received (Payment, #230)

- From Mehta Construction Supplies, ₹30,000, bank transfer, against the bill from step 3

What must appear:
- Only Mehta's bills are offered.
- The review names **Mehta Construction Supplies**.
- Still owed on that bill: ₹50,150 − ₹30,000 = **₹20,150**. ABC Traders is unchanged at ₹1,838.

### Step 8. Pay the supplier (Money paid, #230)

- To Shree Ram Steels, ₹37,760, bank transfer, against SRS-101

What must appear: owed to suppliers **₹0**.

### Step 9. Goods come back (Returns)

- 50 KGS returned by Mehta against the bill from step 3, accepted back into usable stock, reason "Bent bars"

What must appear:
- Credit note number of 16 characters or fewer, naming the bill it corrects
- Goods: 50 × ₹90 = ₹4,500
- IGST: 18% of ₹4,500 = ₹810
- Credit note total: ₹4,500 + ₹810 = **₹5,310**, with place of supply **Maharashtra (27)**
- Mehta now owes: ₹20,150 − ₹5,310 = **₹14,840**
- Stock: 50 + 50 = **100 KGS**, on **one** line (#229)

### Step 10. Match the purchases (Purchase check, this month)

Type the row as the government's portal shows it: GST number `27AAECS5678D1Z4`, bill `SRS-101`, today's date, taxable ₹32,000, IGST ₹5,760, total ₹37,760.

What must appear: SRS-101 agrees with the portal, and **₹5,760** is safe to claim this month.

### Step 11. The month's GST (GST returns, this month)

What must appear:
- GST on sales: ₹7,650 (the bill) − ₹810 (the credit note) = **₹6,840**, all IGST
- GST already paid on purchases, set against it: **₹5,760**
- Left to pay in cash: ₹6,840 − ₹5,760 = **₹1,080**
- No blocking question: no "line with no goods code" (#231), no "inside your own state but carries IGST" (#232)
- The credit note is listed under Maharashtra.

### Step 12. The books (Reports and Home)

What must appear:
- Stock: TMT Steel Bar 12mm **100 KGS**, on one line
- Customers owe: ₹1,838 (ABC Traders) + ₹14,840 (Mehta) = **₹16,678**. The Home screen shows the same figure.
- Suppliers owed: **₹0**
- Days late: Mehta's bill is **not yet due** (0 days), counted to today and not to 31 March (#234)
- No "stock value not in the books" warning (#229)

## Paths not yet covered

These are real ways a trade happens that this check does not walk yet. Each one gets its own step here when it is added. Until then, **passing this check does not mean these work**:

- A sale inside our own state (CGST and SGST instead of IGST)
- A cash sale to a walk-in customer with no GST number, including one over ₹1 lakh to another state (reported bill by bill in GSTR-1)
- A bill for a service (no stock, SAC code)
- Several items on one bill at different GST rates, a discount, and rounding to the rupee
- Cancelling a wrong bill before the month is filed (#233)
- A debit note (the customer owes more) and a purchase return to the supplier
- Goods sent on a delivery challan and billed later
- A business on the composition scheme ("Bill of Supply")
- The Hindi screens, the till-roll print and the phone print
- A new financial year starting on 1 April: numbers restart, no number repeats
- Two companies signed in on the same machine: nothing of one appears in the other

## Run log

Add one line per run. Never delete old lines.

| Date | Code version | Result |
|---|---|---|
| 27 Sep 2026 | `2d27618` | First run, before this page existed. Steps 1, 2, 5, 9 (the note itself) and 10 passed when the purchase was entered as "another state". Failed: step 1 lets the tax type be chosen by hand and ties every bill to one supplier (#228); step 3 does not reduce stock, leaves the form filled, gives a wrong credit warning and names the wrong customer on Home (#229, #233, #235, #237); step 4 is not refused (#229); step 6 is refused because of freight (#231) and showed a validity date in the past (#234); step 7 posts the money to ABC Traders (#230); step 8 has no screen (#230); step 9 puts returned goods on a second stock line (#229); step 11 wrongly flags the credit note and leaves freight out of the HSN table (#231, #232); step 12 counts days late to 31 March (#234). The full list is issue #227. |
| 28 Sep 2026 | `f1c1ee2` | After #228–#237 and #249 were merged. Run on the screen (in-app browser, `npm run web`). **All figures in steps 1–12 were right**: IGST ₹5,760 on SRS-101 chosen from the supplier's GST number; bill INV/26-27/000004 ₹50,150, form cleared, no credit warning, Home ₹51,988 under Mehta's name; 600 kg refused ("You have 50 KGS"); A4 bill carries every listed field, due 28 Oct 2026; e-way bill raised, valid until 03/10/2026 23:59:59, no freight complaint; receipt leaves ₹20,150; supplier paid to ₹0; CN/26-27/0000001 ₹4,500 + ₹810 = ₹5,310 under Maharashtra (27); purchase check ₹5,760 safe to claim; September return ₹6,840 on sales and ₹5,760 credit, both agreeing with the books, no questions; stock 100 KGS on one line; owed ₹16,678 on Reports and Home; Mehta 0 days late. **Not yet as written**: step 3 does not yet say whether an e-invoice is needed (#239); step 6's fields are not yet filled from the bill (#240). One stray warning: the refused 600 kg review left an unissued draft that Reports lists as "a bill waiting". |
| 28 Sep 2026 | `5197e24` + #238 | First run of the automated check `tests/e2e/full-trade.test.ts` (clock fixed at 27 Sep 2026 10:00 India time), and the same trade run against `npm run web` on the real clock. **Steps 1–12 pass with every figure as written**: IGST ₹5,760 and total ₹37,760 on SRS-101; bill INV/26-27/000004 (16 characters) ₹40,500 + ₹2,000 = ₹42,500, IGST ₹7,650, total ₹50,150; stock 50 KGS; Home ₹51,988; 600 KGS refused; A4 bill carries every listed field including vehicle KA01AB1234 and due 27 Oct 2026; e-way bill for 840 km valid 5 days, until 02/10/2026 23:59:59 (03/10/2026 on the 28 Sep screen run); receipt leaves ₹20,150; suppliers ₹0; CN/26-27/0000001 ₹5,310 under Maharashtra (27); Mehta owes ₹14,840; stock 100 KGS on one line; ₹5,760 safe to claim; September 3B IGST ₹6,840 on sales, ₹5,760 credit, ₹1,080 in cash, no questions; owed ₹16,678 on Reports and Home; Mehta 0 days late. **Still `todo` in the test**: the sale review does not say whether an e-invoice is needed (#239); the e-way bill is not filled from the bill (#240); the refused 600 KGS review leaves a "bill waiting" in Reports (#256). |
| 28 Sep 2026 | `3e05cd1` + #256 | Automated check: steps 1–12 pass and step 4's "nothing left behind" now runs for real (no longer `todo`); still `todo`: #239, #240. On the screen (`npm run web`) only step 4's ending was re-run: 600 PCS of soap with 0 in stock refused, and Reports then says "Nothing on these pages needs a second look" (before the fix: "1 bill is waiting and has not been given to anyone yet"). Three reviews of one sale (5, 6, then 7 PCS) and Record gave one bill, INV/26-27/000004 after 000003, and still nothing waiting. |
