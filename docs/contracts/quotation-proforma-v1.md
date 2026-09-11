# Quotation and proforma invoice contract v1

Issue #142, owner GPT 3. Code: `packages/sales/src/presale-*.ts`, printing in
`packages/invoice-templates/src/presale.ts`, the local app's desk in
`apps/api/src/presale-application.ts`.

A **quotation** is a price offer sent before a sale. A **proforma invoice** is an advance bill,
usually sent so the buyer pays before the goods move. Both are everyday papers for a wholesaler.

## What the law says, and what it does not

| Question | Answer | Basis |
| --- | --- | --- |
| Does GST prescribe a format for either? | No. | Neither is among the documents the CGST Act and Rules prescribe. |
| Is either a tax invoice? | No. Neither can be used to claim input tax credit, and neither goes into GSTR-1, GSTR-3B or any other return. | CGST Act section 31: the tax invoice is issued for the supply. |
| Does issuing one create a tax liability or a sale? | No. | The supply, and its tax invoice, come later. |
| Must the invoice series stay unbroken? | Yes — so neither paper ever takes a number from it. | CGST Rule 46(b): consecutive serial numbers, unique for the financial year. |
| What if money arrives against a proforma? | A receipt voucher is due (Rule 50), and for **services** GST falls due on the advance. For goods, GST is not payable on advances (Notification 66/2017-CT). | **Not built here** — recording money received is the receivables module's job. Raised as its own issue. |

Everything else these papers carry is **convention** (what Indian businesses and Tally print) or the
**business's own choice**. `PRESALE_PRINTED_FIELDS` records which is which, field by field; nothing
on it is marked as law.

## Numbering

Each has a series of its own: `QTN/26-27/00001` and `PI/26-27/00001` by default (`PreSaleSeries`).
A number is allocated in the same transaction that saves the document, so a refused document uses
none. `validatePreSaleSeries` refuses a prefix already used by the invoice, the challan or the other
paper, and a series that could print a number longer than 16 characters — not a legal limit for these
papers, but the invoice's, kept so every number fits the same box.

## States

| Kind | States |
| --- | --- |
| Quotation | `ISSUED` → `CONVERTED` (its lines became a draft bill) or `CANCELLED` (withdrawn) |
| Proforma | `ISSUED` → `INVOICED` (the tax invoice raised later was linked) or `CANCELLED` |

Whether a quotation's validity has run out is not a state: `hasLapsed(document, today)` works it out
when asked. These states are not yet in `docs/product/spec/states.json`, following the challan and
e-way bill precedent.

## Commands (`PreSaleService`)

| Command | Permission | Idempotent on | Refuses when |
| --- | --- | --- | --- |
| `preview(kind, input)` | `quotation.issue` / `proforma.issue` | — (writes nothing) | — returns every problem at once |
| `issue({ kind, idempotencyKey, input })` | same | the key | no lines; zero quantity; negative rate; "valid until" before the date; a proforma with no purpose; or the GST calculator cannot price it (unknown item or party, no HSN, no rate) |
| `convertToSale({ quotationId, documentDate? })` | `quotation.issue` **and** `sales.draft.write` (checked by the sales service) | the quotation — a second call returns the same draft | not a quotation; withdrawn |
| `linkInvoice({ proformaId, invoiceId })` | `proforma.issue` | same invoice | not a proforma; withdrawn; already linked to another invoice; invoice not issued, for another customer, or dated before the proforma |
| `cancel({ id, reason })` | `quotation.cancel` / `proforma.cancel` | already cancelled | no reason; a quotation already converted; a proforma already invoiced |

A converted quotation becomes a **draft** invoice: no number, nothing posted, no stock held. It is
checked (credit, price history, stock, approval, tax on the day of the bill) and issued exactly like
a typed sale. The person is told if the quotation had lapsed or the total has moved since.

Anything a linked invoice does differently from its proforma — a part dispatch, a changed rate, an
extra item, a different total — is recorded in `invoice.differences` in plain words, not refused.

Neither paper posts to the books, holds or moves stock, or calls a compliance hook. The service has
no ledger, inventory or compliance dependency, so it cannot.

## Printing

`toPreSalePrint(document, context)` flattens it; `renderPreSale` prints it on the invoice engine with
the invoice's own item table, totals and HSN summary. The page is titled "Quotation" or "Proforma
Invoice" with "Not a tax invoice" under it. "Valid Until", terms, the buyer's order number and payment
terms print only when the business typed them. The proforma carries bank details; the quotation does
not. Neither carries an e-invoice block, copy markings, reverse charge, transport or e-way bill boxes,
a due date, or amount paid and balance due. One copy, unmarked.

`invoiceReferencesFromPreSale` fills the invoice's "Reference No. & Date" box from the quotation it was
made from and the proforma it billed.

## HTTP (local app)

`GET /api/presale`, `POST /api/presale/preview | issue | print | convert | issue-sale | link-invoice |
cancel`. `convert` returns the draft bill with the sale screen's checks; `issue-sale` issues it.

## Known limits

- The local app has one item (soap) and one customer, like its sale screen; the buyer's address and
  the business's bank lines are typed on the form and frozen with the document.
- A proforma links to one invoice. A proforma billed across two dispatches is not supported.
- A quotation cannot be turned into a proforma directly; the proforma is issued on its own.
- Money received against a proforma, and the receipt voucher it needs, are not recorded here.
