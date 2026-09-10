# Field-by-field: the two real bills against our output

Done 2026-09-10 by reading both PDFs and rendering our own `india-standard` design through
`npm run demo:invoice`. Update this file whenever either side changes.

`KK` = KK Polyplast invoice 285. `BE` = Blessing Export BE/DL/25-26/0139 (Tally).

## Present on a real bill and on ours

| Field | KK | BE | Notes |
| --- | --- | --- | --- |
| Title "Tax Invoice", centred above the frame | yes | yes | |
| Whole page as one ruled grid | yes | yes | |
| Seller name, address, GSTIN, state name + code | yes | yes | |
| Seller phone / e-mail | yes | e-mail | |
| Logo, top left | yes | no | |
| Invoice No., Date | yes | yes | |
| Place of supply | yes | no | BE carries state codes on the party blocks instead |
| Buyer (Bill to) with GSTIN and state | yes | yes | |
| Consignee (Ship to) | yes | yes | **always printed, never "same as above"** |
| Vehicle number | yes | yes | KK: "Vehicle Number". BE: "Motor Vehicle No." |
| Transporter name | yes | yes | KK: "Transport Name". BE: "Dispatched through" |
| Delivery destination | yes | yes | KK: "Delivery Location". BE: "Destination" |
| e-Way Bill No. | on the e-way bill | yes | |
| IRN, Ack No., Ack Date, QR | no | yes | BE is a registered e-invoice; ours reserves the space (#136) |
| Serial number column | yes | yes | |
| Description of goods | yes | yes | |
| HSN / SAC | yes | yes | |
| Quantity | yes | yes | BE prints 3 decimals and the unit: "2,000.000 KGS" |
| Rate per unit | yes | yes | KK: "Price/unit". BE: "Rate" + a separate "per" column |
| Number and kind of packages | no | yes | "80 Bags" |
| Amount | yes | yes | **see the warning in README.md — the two bills mean different things by it** |
| Amount in words | yes | yes | |
| Total quantity on the item table's total row | yes | yes | ours totals it where every line shares a unit; bags and metres have no sensible total, so nothing is printed |
| HSN-wise tax summary with a totals row | yes | yes | KK heads the columns CGST/SGST, BE heads them Central Tax/State Tax |
| Sub total / total / received / balance | yes | Total only | |
| Signature image above "Authorised Signature" | yes | line only | KK's is a scanned signature; ours supports the image (#138) |
| "for <company>" above the signature | yes | yes | |
| Tax amount in words | no | yes | |
| Company's PAN | no | yes | BE puts it by the declaration, not under the GSTIN |
| Declaration | no | yes | |
| Company's bank details | no | yes | |
| "E. & O.E" | no | yes | on the amount-in-words line |
| "This is a Computer Generated Invoice" | no | yes | |

## On a real bill and once missing from ours

Nothing outstanding. The seven fields #156 listed all print now:

| Field | Seen on | Done in |
| --- | --- | --- |
| Total quantity on the item table's total row | KK and BE | reference audit |
| Delivery Note number and date | BE | #156 |
| Dispatch Doc No. | BE | #156 |
| Reference No. & Date, Other References | BE | #156 |
| Terms of Delivery | BE | #156 |
| Mode / Terms of Payment, and KK's "Payment mode: Credit" | KK and BE | #156 |
| Bank details as labelled fields (Bank Name, A/c No., Branch & IFS Code) rather than free text | BE | #156 |

## Deliberate differences

- **Freight.** Neither bill has freight, so neither settles how to print it. We give it its own line
  below a goods sub-total (#131) rather than spreading it across the goods, because a goods line
  that fails quantity x rate is the first thing a customer queries.
- **"Amount" is the taxable value on ours**, following BE and Tally, not KK's tax-inclusive column.
- **Copy markings.** Neither sample is marked Original/Duplicate/Triplicate — both are single copies
  kept by the business. GST asks for the markings, and Tally prints them, so we do (#137).
- **Hindi, thermal paper, honest rate notices.** Neither bill has these and neither needs them; they
  are ours to add, after the convention above is matched.

## When the two bills disagree: required, conventional, or one company's choice

Two samples are not a survey, so a field on one bill and not the other was checked against the law
before deciding. Method agreed 2026-09-10: default to the Tally output, search for what the rule
actually says, then use judgement and record the answer here.

**Required by CGST Rule 46** — a bill without these is not a valid tax invoice:

supplier name, address and GSTIN; a consecutive number of at most 16 characters; date of issue;
recipient name, address and GSTIN; HSN/SAC; description; quantity with its unit; taxable value after
discount; rate and amount of each tax; total value; **place of supply, for an inter-state supply**;
**address of delivery, where it differs from the place of supply**; whether reverse charge applies;
and a signature or digital signature. An e-invoice additionally carries the IRN and QR under Rule
48(4).

**Required by CGST Rule 48** — the copy markings, in these exact words:

- Goods, in triplicate: `ORIGINAL FOR RECIPIENT`, `DUPLICATE FOR TRANSPORTER`, `TRIPLICATE FOR SUPPLIER`
- Services, in duplicate: `ORIGINAL FOR RECIPIENT`, `DUPLICATE FOR SUPPLIER`

Ours matches, wording included (#137).

**Conventional, not required** — Tally prints them, KK Polyplast does not, and no rule asks for them:

| Field | What it is | Ours |
| --- | --- | --- |
| E. & O.E. | Errors and omissions excepted: the seller may correct a mistake on a bill already sent. Protects the seller, costs the buyer nothing. | on by default |
| Declaration | "We declare that this invoice shows the actual price..." A statement the business makes. | printed only when the business writes one |
| Company's PAN | A registration requirement, not an invoice field. Useful because the buyer's accounts department needs it to deduct tax at source. | printed when known |
| Bank details | Furnishing them to the GST portal is a registration requirement; printing them on the bill is not. It is simply how a business gets paid. | printed when known |
| "This is a Computer Generated Invoice" | A fact about the document. | on by default |

**Judgement calls we have made, and why**

- **Place of supply prints on every bill**, not only inter-state ones. The rule requires it only
  across states, but KK Polyplast prints it on an intra-Delhi sale and it can never be wrong to
  state it.
- **The ship-to box prints on every bill.** The rule requires it only where delivery differs from
  the place of supply; both samples print it always, repeated in full, and so do we (#134).
- **An empty row is not printed.** Tally prints labelled cells with nothing in them — Blessing
  Export's bill carries an empty "Delivery Note", "Reference No. & Date" and "Dispatch Doc No." A
  row here appears only when at least one of its cells has a value, because eight empty labels make
  a header that is mostly blank paper. Within a row that does appear, an empty cell keeps its label,
  as Tally does.

**Known compliance gap**

Rule 46 requires a signature or digital signature on a printed invoice, but `footer.signature` is an
optional template field, so a design can switch it off and produce a bill that is not valid. Filed
separately.
