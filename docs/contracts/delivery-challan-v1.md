# Delivery challan contract v1

Issue #141, owner GPT 3. Code: `packages/sales/src/challan-*.ts`, printing in
`packages/invoice-templates/src/challan.ts`, the e-way bill document in
`packages/transport/src/challan-consignment.ts`.

A delivery challan is the paper that travels with goods when no tax invoice goes with them. CGST
Rule 55 decides when one may be used and what it must carry; this contract follows it and adds
nothing the rule does not ask for.

## When a challan may be issued

| `ChallanReason` | Allowed by | Tax printed | Invoice follows | E-way bill reason |
| --- | --- | --- | --- | --- |
| `SUPPLY_INVOICE_TO_FOLLOW` | CGST Rule 55(4) | yes | yes | `SUPPLY` |
| `LIQUID_GAS` (quantity marked provisional) | CGST Rule 55(1)(a) | yes | yes | `SUPPLY` |
| `SUPPLY_ON_APPROVAL` | CGST Act section 31(7) | yes | yes | `SUPPLY` |
| `JOB_WORK` | CGST Rule 55(1)(b) | no | no | `JOB_WORK` |
| `OWN_USE` | CGST Rule 55(1)(c) | no | no | `FOR_OWN_USE` |
| `EXHIBITION_OR_FAIRS` | CGST Rule 55(1)(c) | no | no | `EXHIBITION_OR_FAIRS` |
| `OTHER_NOT_A_SUPPLY` (reason in words required) | CGST Rule 55(1)(c) | no | no | `OTHERS` |

"Tax printed" is Rule 55(1)(vii): the tax rate and amount appear only when the goods move as a sale
to the consignee. The taxable value is on every challan (Rule 55(1)(vi)). Place of supply is printed
on a sale challan and on any challan whose goods cross a state border (Rule 55(1)(viii)).

Goods sent on approval are treated as moving for supply, so the tax prints. Printing it where it was
not strictly needed is harmless; leaving it off where it was needed is not.

## Numbering

Own series, never the invoice counter: `DC/26-27/00001` by default (`ChallanSeries`). A number is
allocated in the same transaction that saves the challan, so a refused or failed challan uses no
number. Rule 55(1) caps a number at sixteen characters; `validateChallanSeries` refuses a series
that could exceed it at its widest, and refuses a prefix equal to the invoice prefix.

## States

`ISSUED` → `INVOICED` (the tax invoice raised after delivery is linked) or `CANCELLED` (the goods
never moved; the number stays used). These are not yet in `docs/product/spec/states.json`, following
the e-way bill and return-note precedent; adding them there needs an ownership entry for #141.

## Commands (`ChallanService`)

| Command | Permission | Idempotent on | Refuses when |
| --- | --- | --- | --- |
| `preview(input)` | `challan.issue` | — (writes nothing) | — returns every problem at once |
| `issue({ idempotencyKey, input })` | `challan.issue` | the key | any problem: unknown item or party, a service item, no HSN, zero quantity, negative value, unknown destination state, missing reason note, or the GST calculator cannot price a sale challan |
| `attachEwayBill({ challanId, ewayBillNumber, source })` | `challan.issue` | same number | not twelve digits; challan not `ISSUED` |
| `linkInvoice({ challanId, invoiceId })` | `challan.issue` | same invoice | reason has no invoice following; invoice not final, other customer, dated before the challan, or missing an item the challan carried |
| `cancel({ challanId, reason, ewayBillCancelledOnPortal })` | `challan.cancel` | already cancelled | no reason; already invoiced; an e-way bill is on it and the person has not confirmed it was cancelled on the portal |

A quantity shortfall between challan and invoice is recorded in `invoice.differences`, not refused.

A challan posts nothing to the books and moves no stock. The sale is the invoice that follows it,
and that is what posts and issues the goods.

## Printing

`toChallanDocument(challan, context)` flattens it; `renderChallan`, `renderChallanCopySet` and
`renderChallanCopies` print it on the invoice engine. Three copies, marked `ORIGINAL FOR CONSIGNEE`,
`DUPLICATE FOR TRANSPORTER`, `TRIPLICATE FOR CONSIGNER` (Rule 55(2)). The page says "Not a tax
invoice" and never carries an amount payable, amount in words, due date, bank details, pay-by-scan
square or e-invoice block. `deliveryNoteFromChallans` fills the invoice's Delivery Note box from the
challans it was linked to.

## HTTP (local app)

`GET /api/challans/reasons`, `GET /api/challans`, `GET /api/challans/movable`,
`POST /api/challans/preview | issue | print | eway | link-invoice | cancel`. The e-way bill routes
accept a challan id wherever they accept an invoice id, take the reason from the challan, and put
the portal's number on the challan when one is raised.

## Known limits

- The local app has one item (soap) and one customer, like its sale screen; the consignee's address
  is typed on the form and frozen with the challan, because there is no address book yet.
- A challan billed across two invoices is not supported: each challan links to one invoice.
- A vehicle changed on the e-way bill after it was raised is not copied back onto the challan.
