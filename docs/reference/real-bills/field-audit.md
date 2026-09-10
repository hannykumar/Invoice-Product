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

## On a real bill and **missing from ours**

Each is filed as an issue rather than left in this document.

| Missing | Seen on | Issue |
| --- | --- | --- |
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
