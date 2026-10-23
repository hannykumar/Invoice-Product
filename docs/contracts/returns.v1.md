# Returns and transaction adjustments v1.1

Version 1.1.0 (issue #293: price corrections and sales debit notes).

Issue #45 owns linked sales credit notes and purchase debit notes. A return never edits, cancels,
or hides its original invoice. The note stores the original document and line identifiers, the
reason, actor, date, quantities, disposition, exact proportional tax snapshot, voucher, and
compliance state.

## Supported scenarios

- Full and partial sales returns reduce the customer balance through a balanced credit note.
- Full and partial purchase returns reduce the supplier balance through a balanced debit note.
- GST is reversed proportionally from the immutable original line amounts; a one-paise proration
  remainder is assigned to taxable value so the note always equals its share of the original.
- Accepted goods enter or leave usable stock. Damaged goods enter the explicitly selected damaged
  or quarantine godown. Scrapped goods are received and removed in linked movements. Replacement
  goods leave no sellable stock until the replacement is separately received.
- Repeated and concurrent requests share the original quantity ceiling and an idempotency key.
- Registered sales documents are marked `PENDING_ADJUSTMENT`; downstream e-invoice, e-way bill,
  GSTR-1/3B and ITC work consumes that explicit state instead of this module guessing a filing.
- A return dated in an open period may reference an invoice in a filed, hard-locked period. The
  original period is never reopened. A note dated inside a hard-locked period is refused; the
  ledger's reasoned override rules apply only to soft locks.

## Price corrections and sales debit notes (v1.1.0, issue #293)

`ReturnService.previewPriceCorrection` / `postPriceCorrection` change the price of one line of an
issued sales bill with nothing coming back. The command names the bill and line and gives either
`newUnitPrice` or `amountOff` (both before GST). The difference is worked on the quantity the
customer still keeps, from the line's current value (original, less earlier price credits, plus
earlier debits); tax on it is the original line's, in the same proportion.

- Lower price: kind `SALES_RETURN` with `priceCorrection: true`, a `CN/…` number, the 30 November
  limit of s.34(2), voucher Dr Discount given + output GST, Cr customer.
- Higher price: kind `SALES_DEBIT_NOTE` (always `priceCorrection: true`), a `DN/…` number from the
  debit-note series, no time limit (s.34(3)), voucher Dr customer, Cr sales + output GST.
- No stock moves. Price notes never count against the quantity sold; goods returned later are
  credited at the price the customer finally paid. Both notes go to GSTR-1 CDNR/CDNUR against the
  original invoice (`ntty` `C` / `D`), with no quantity in the HSN summary, and to the e-invoice
  rules as `CREDIT_NOTE` / `DEBIT_NOTE`.
- Refusals: `PRICE_CORRECTION_ONE_FIGURE`, `PRICE_CORRECTION_NO_CHANGE`,
  `PRICE_CORRECTION_MORE_THAN_CHARGED`, `PRICE_CORRECTION_CHARGE_LINE`, `PRICE_CORRECTION_FREE_LINE`,
  `PRICE_CORRECTION_NOTHING_KEPT`, `PRICE_CORRECTION_REASON_REQUIRED`, `PRICE_CORRECTION_BEFORE_BILL`,
  and `RETURN_CREDIT_NOTE_TOO_LATE` for a late credit. Over HTTP: `POST /api/returns/preview|record`
  with `mode: "PRICE"`, `newRate` or `amountOff`. Migration
  `…_returns_d50ad1d404d0_sales_debit_notes_and_price_corrections` adds the kind and `price_correction`.

## Damaged goods never re-enter sellable stock (issue #292)

A `DAMAGED` sales-return line must name a location the inventory port reports as not for sale
(`ReturnInventoryPort.sellableLocation` returns `false`). An ordinary godown, or a place the
company does not have, is refused with `RETURN_DAMAGED_INTO_SELLABLE_STOCK` and nothing is posted.
A whole-bill return names its location in `wholeBillWarehouseId`. `ACCEPTED` goods go back to the
godown they can be sold from; `SCRAPPED` goods are received and written off in linked movements.
Every company in the app has a "Damaged / not for sale" location, and the web return form sends
damaged goods there. Goods sent back to a supplier leave the godown as before.

## Note numbers (issue #185)

Credit notes are numbered `CN/26-27/0000001` and debit notes `DN/26-27/0000001`: sixteen characters,
from a counter per company, series and **financial year** (1 April to 31 March), as CGST Rule
53(1A)(c) requires. The arithmetic is the one shared with invoices and challans
(`packages/sales/src/document-series.ts`), so the running number gets every character left after the
prefix and the year, and a series that cannot reach 99,999 notes a year is refused.

- `ReturnServiceDeps.noteSeries` sets the prefixes; the default is `DEFAULT_NOTE_SERIES`.
- `ReturnServiceDeps.otherDocumentPrefixes` lists the prefixes other documents use (default: `INV`,
  `DC`, `QTN`, `PI`). The constructor refuses a credit note prefix that matches any of them, and a
  debit note prefix that matches any of them or the credit note's, with
  `RETURN_NOTE_SERIES_SHARES_PREFIX`.
- The number is allocated inside the transaction that posts the note, so a failed posting burns no
  number and two simultaneous returns cannot receive the same one.
- Notes issued before this change (`CN/000001`) keep their numbers. They carry no year, so they can
  never collide with a new one.

## The printed note and the 30 November deadline (issue #186)

- Each note line keeps `hsnOrSac`, `ratePercentTimes100` and `unitPrice` from the original line,
  so a reprint never depends on the original bill still being readable. Purchase lines take the HSN
  from the item list (`purchaseReturnSource(bills, hsnOf)`) and read the rate back from the tax the
  supplier charged.
- `packages/invoice-templates/src/credit-note.ts` prints the note (`toCreditNoteDocument`,
  `renderCreditNote`, `creditNotePdf`) with every Rule 53(1A) particular, including "Against Invoice
  No. … dated …". The app freezes the page when the note is recorded and serves it at
  `POST /api/returns/print` and `GET /api/returns/:id/pdf`; `GET /api/returns/notes` lists notes.
- Section 34(2): `previewSales` and `postSales` refuse a credit note dated after 30 November
  following the end of the original bill's financial year (`RETURN_CREDIT_NOTE_TOO_LATE`), and the
  preview carries a warning in the 30 days before it (`warnings`). The annual-return date, which can
  make the deadline earlier, is not known to the product and is not guessed.

## Money and refunds

The credit or debit note changes the party subledger atomically with inventory and GST. It does
not silently move cash or bank money. If a settled customer invoice produces money owed back, the
user must approve a separate outbound `PAYMENT` through the receivables/payables contract (#20),
using its bank account, allocation, idempotency, and audit controls. Likewise, supplier money
received back is a separately approved `RECEIPT`. This separation prevents a goods-return click
from initiating an unreviewed bank refund.

## Assumptions and known limits

- Physical reverse-logistics tracking is outside this contract. A replacement disposition records
  that sellable stock has left; delivery and receipt of the replacement remain separate events.
- E-way bill (#27), GST return workspace (#30), and ITC reconciliation (#31) own submission and
  filing. Until they consume the note, `PENDING_ADJUSTMENT` is intentionally visible and auditable.
- A reverse-charge purchase return is supported. A reverse-charge bill with GST capitalised as
  ineligible ITC is refused with `RETURN_RCM_INELIGIBLE_REVIEW_REQUIRED` because the correct cost
  treatment cannot be inferred safely.
- Batch and serial facts must be supplied where the inventory master requires them. Missing facts
  refuse the whole transaction; no ledger note or stock movement remains.

## Persistence and API

`return_notes` and `return_note_lines` are tenant-isolated by company keys and forced PostgreSQL
row-level security. `GET /api/returns/documents` lists eligible originals. The preview and record
commands are `POST /api/returns/preview` and `POST /api/returns/record`; both derive company and
permissions from the authenticated session. Preview is read-only and record is atomic and
idempotent.

**A key is one return (v1.1, issue #392).** Both routes need the screen's own `requestId`; without
one they answer `RETURN_REQUEST_ID_REQUIRED` (422). The typed note `reference` is never the key. A
key seen before returns its note (`deduplicated: true`) only for the same kind, original document,
date, reason and lines; anything else is `RETURN_KEY_REUSED` (`CONFLICT`, HTTP 409) and nothing is
recorded.
