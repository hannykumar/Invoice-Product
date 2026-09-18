# Field-by-field: the two real bills against our output

Done 2026-09-10 by reading both PDFs and rendering our own `india-standard` design through
`npm run demo:invoice`. Update this file whenever either side changes.

Re-checked 2026-09-16 against **the app's own bill**, not the demo script: `npm run web`, signed in
as Sampoorna Traders, Business details saved, one sale recorded, bill `INV/26-27/000004` printed. The
seller block now reads the business's own particulars (issue #180) rather than a town and a godown
name, so the "Seller name, address, GSTIN" and "Company's PAN" and "Company's bank details" rows
below describe what the app prints, not only what the renderer is capable of printing.

Re-checked 2026-09-17 after issue #181, on the app again: a new customer (Delhi Polymers, GSTIN
`07EEEEE4444E1ZG`, Plot 7 Bawana Industrial Area, New Delhi 110039) and two new items (PP Regrind,
HSN `39021000`, KGS; HDPE Bags, HSN `39232100`, BAG) were added on the Sale screen, and a two-line
bill `INV/26-27/000004` was issued to them. The buyer block, the description, the HSN code, the
quantity and the unit on that bill are the customer and the goods that were chosen: before #181 the
bill printed one fixed demo customer and one fixed demo product whatever was typed. The rows for
"Buyer (Bill to)", "Description of goods", "HSN / SAC", "Quantity" and "Place of supply" below
therefore describe the app's own bill.

Re-checked 2026-09-17 after issue #182, on the app again: a sale to Delhi Polymers delivered to
their own Pune godown, carried by Sharma Roadlines on vehicle `KA01AB1234` under LR
`SRL/2026/44120`, printed as `INV/26-27/000004`. Dispatched through, Vehicle No., LR/RR No.,
Transport Doc No. & Date, Destination, Buyer's Order No. and Mode / Terms of Payment all carry what
was typed, the consignee block shows the Pune address rather than repeating the buyer, and the place
of supply reads `Maharashtra (27)` with IGST. Before #182 the Sale screen could fill none of those
boxes, so every bill printed them empty.

Re-checked 2026-09-17 after issue #183, on the app again, on all three papers. The A4 bill carries
`ORIGINAL FOR RECIPIENT`, and one press of Print produces three marked sheets. The phone and
till-roll bills now carry the HSN code under each item, `Reverse Charge: No`, the HSN summary and
`for <seller> / Authorised Signatory` — all four of which the narrow layouts used to drop, on the
very layout a shopkeeper billing from a phone is served by default.

`KK` = KK Polyplast invoice 285. `BE` = Blessing Export BE/DL/25-26/0139 (Tally).

## Present on a real bill and on ours

| Field | KK | BE | Notes |
| --- | --- | --- | --- |
| Title "Tax Invoice", centred above the frame | yes | yes | |
| Whole page as one ruled grid | yes | yes | |
| Seller name, address, GSTIN, state name + code | yes | yes | typed in Business details (#180); no bill is issued without the street, town and PIN code |
| Seller phone / e-mail | yes | e-mail | typed in Business details, printed when entered |
| Logo, top left | yes | no | |
| Invoice No., Date | yes | yes | |
| Place of supply | yes | no | BE carries state codes on the party blocks instead; ours is the state of the customer's own billing address (#181), never the seller's |
| Buyer (Bill to) with GSTIN and state | yes | yes | the customer chosen on the sale, with the name, address and GSTIN saved on their record (#181) |
| Consignee (Ship to) | yes | yes | **always printed, never "same as above"**; the delivery address when the goods went elsewhere (#182) |
| Vehicle number | yes | yes | KK: "Vehicle Number". BE: "Motor Vehicle No."; typed on the sale and normalised to `KA01AB1234` (#182) |
| Transporter name | yes | yes | KK: "Transport Name". BE: "Dispatched through"; picked from the business's own transporter list (#182) |
| Delivery destination | yes | yes | KK: "Delivery Location". BE: "Destination"; suggested from the delivery address and editable (#182) |
| e-Way Bill No. | on the e-way bill | yes | typed when raised elsewhere, or layered on at print time once one is raised here (#182) |
| IRN, Ack No., Ack Date, QR | no | yes | BE is a registered e-invoice; ours reserves the space (#136) |
| Serial number column | yes | yes | |
| Description of goods | yes | yes | the item chosen on each line, one line or many (#181) |
| HSN / SAC | yes | yes | the code saved on that item (#181) |
| Quantity | yes | yes | BE prints 3 decimals and the unit: "2,000.000 KGS"; ours prints the item's own unit (#181) |
| Rate per unit | yes | yes | KK: "Price/unit". BE: "Rate" + a separate "per" column |
| Number and kind of packages | no | yes | "80 Bags" |
| Amount | yes | yes | **see the warning in README.md — the two bills mean different things by it** |
| Amount in words | yes | yes | |
| Total quantity on the item table's total row | yes | yes | ours totals it where every line shares a unit; bags and metres have no sensible total, so nothing is printed |
| HSN-wise tax summary with a totals row | yes | yes | on narrow paper it is one compact line per code and rate, never dropped (#183); KK heads the columns CGST/SGST, BE heads them Central Tax/State Tax |
| Sub total / total / received / balance | yes | Total only | |
| Signature image above "Authorised Signature" | yes | line only | KK's is a scanned signature; ours supports the image (#138), and the signing line now prints on every paper size including till roll (#183) |
| Nothing on the bill says something is missing | yes | yes | Neither real bill has a box saying "not received yet". Since #189 ours doesn't either: the signing space is blank until a signature is uploaded, the pay-by-scan square prints only once a UPI id is saved, and the government QR / IRN space appears only on a bill that is registered or meant to be. The labelled boxes stay on the Bill design preview |
| "for <company>" above the signature | yes | yes | |
| Tax amount in words | no | yes | |
| Company's PAN | no | yes | BE puts it by the declaration, not under the GSTIN; ours is typed in Business details and must match the PAN inside the GSTIN |
| Declaration | no | yes | |
| Company's bank details | no | yes | typed in Business details, held in `packages/masters`, printed as Bank Name / A/c No. / Branch & IFS Code |
| "E. & O.E" | no | yes | on the amount-in-words line |
| "This is a Computer Generated Invoice" | no | yes | |

## On a real bill and once missing from ours

Nothing outstanding. The seven fields #156 listed all print now:

| Field | Seen on | Done in |
| --- | --- | --- |
| Total quantity on the item table's total row | KK and BE | reference audit |
| Delivery Note number and date | BE | #156; since #141 filled from the delivery challan the invoice is linked to (`deliveryNoteFromChallans`) |
| Dispatch Doc No. | BE | #156 |
| Reference No. & Date, Other References | BE | #156; since #142 Reference No. & Date can be filled from the quotation or proforma behind the invoice (`invoiceReferencesFromPreSale`) |
| Terms of Delivery | BE | #156 |
| Mode / Terms of Payment, and KK's "Payment mode: Credit" | KK and BE | #156 |
| Bank details as labelled fields (Bank Name, A/c No., Branch & IFS Code) rather than free text | BE | #156 |

## Deliberate differences

- **The place of supply follows the goods, and the two cases differ.** Goods sent to the customer's
  own address in another state move the supply to that state (IGST Act, section 10(1)(a)); goods
  handed to a third person on the customer's instructions stay where the billed customer is
  (section 10(1)(b)). Neither sample shows a bill-to-ship-to sale, so neither settles it; the law
  does (#182).
- **Freight.** Neither bill has freight, so neither settles how to print it. We give it its own line
  below a goods sub-total (#131) rather than spreading it across the goods, because a goods line
  that fails quantity x rate is the first thing a customer queries.
- **"Amount" is the taxable value on ours**, following BE and Tally, not KK's tax-inclusive column.
- **Copy markings.** Neither sample is marked Original/Duplicate/Triplicate — both are single copies
  kept by the business. GST asks for the markings, and Tally prints them, so we do (#137). Since
  #183 the app itself asks for them: the screen and the customer's PDF carry the Original, and one
  press of Print produces the whole set — three sheets for goods, two for services.
- **Prescribed words are not translated.** The Hindi bill prints `ORIGINAL FOR RECIPIENT`,
  `Reverse Charge` and `Authorised Signatory` in those words, with a Hindi gloss in brackets. The
  rule prescribes the words themselves, and a buyer's accountant reads them (#183, #139).
- **The rate on a line is the rate the business declared** for that item's code (option C, #54), and
  the bill says so. No rate is guessed from an HSN code, and since #181 the app carries no fixture
  rate table at all: an item nobody has declared a rate for cannot be billed.
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
- **Empty labels print, as Tally prints them.** Blessing Export's bill carries an empty "Delivery
  Note", "Reference No. & Date" and "Dispatch Doc No." We do the same: a buyer reading a familiar
  form finds the same box in the same place on every bill, and an empty one says the seller had
  nothing to put there rather than leaving them to wonder where it went. A design can still leave a
  field out altogether; what it cannot do is show the box only sometimes.

**Signature (#158, done)**

Rule 46 requires a signature or digital signature, so it is part of the compliance section and no
design can drop it — `validateTemplate` now refuses a design that claims `footer.signature` as
optional. Two exemptions are handled rather than ignored: a registered e-invoice carrying an IRN is
digitally signed by the government and says so instead of printing a rule nobody will sign, and
58 mm till roll prints none, because a counter slip is not the copy anyone signs.

## The credit note (#186)

None of the three real documents in this folder is a credit note, so the printed credit note is
held to CGST Rule 53(1A) itself, particular by particular. Each line below is checked by
`CREDIT_NOTE_MANDATORY_FIELDS` on A4, the phone page and the till roll.

| Rule 53(1A) | Particular | On ours |
| --- | --- | --- |
| (a) | Supplier's name, address and GSTIN | the business's saved particulars, frozen when the note is issued |
| (b) | Nature of the document | "Credit Note" (a purchase return prints "Debit Note") |
| (c) | Consecutive number, at most 16 characters, unique for the financial year | `CN/26-27/0000001` (#185) |
| (d) | Date of issue | printed |
| (e), (f) | Recipient's name, address and GSTIN; delivery address for an unregistered recipient | copied from the original bill as it was printed |
| (g) | Number and date of the invoice it is against | "Against Invoice No. INV/26-27/000004 dated 15 September 2026" |
| (h) | Taxable value, rate of tax, tax credited | per line and in total, at the original bill's rates and split |
| (i) | Signature | the signature box, as on the bill |

Also printed, by convention: the HSN code, the quantity and unit returned, the reason, and the
amount in words. Not printed: copy markings (Rule 48 prescribes copies for invoices, not notes).
A credit note dated after 30 November following the end of the original bill's financial year is
refused, because section 34(2) no longer lets it reduce GST.
