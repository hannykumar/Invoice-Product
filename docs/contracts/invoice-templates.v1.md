# Contract: `invoice-templates` v1.0.0

| | |
| --- | --- |
| **Owner** | GPT 1, issue #13 [E13] |
| **Consumed by** | GPT 1 (#9 sales, #36 onboarding), GPT 2 (#14 delivery, #38 web), GPT 3 (#26 e-invoice, #45 returns) |
| **Package** | `@invoice/invoice-templates` |
| **Status** | Published |

## Purpose

Print a bill that looks like the business, and that a tax officer can read.

The division is the whole design: **a template decides styling and optional content. It cannot
decide what a tax invoice must contain.** The compliance section is assembled from the document
itself, and a template has no field with which to remove it — `validateTemplate` refuses a design
that even names a mandatory field.

## Seeing it

```bash
npm run demo:invoice
```

Runs the real chain — master data, the rules engine in production, GST from business-declared
rates, a sales invoice finalised through the ledger — and writes seven bills to `tmp/invoices/`.
Open any of them; use the browser's print dialogue for PDF.

## The four papers

| Format | Width | Layout |
| --- | --- | --- |
| `A4` | 210mm | Full table, headings repeat on every printed page |
| `THERMAL_80MM` | 80mm | One item per block |
| `THERMAL_58MM` | 58mm | One item per block — about 32 characters wide |
| `MOBILE` | fluid | Reading on a phone before sending |

A nine-column table on 58mm of paper is unreadable, so the narrow formats print a list. The
compliance section survives the narrowest paper; only the arrangement changes.

## Templates that ship

`wholesale-classic`, `bakery-warm`, `counter-thermal`, `services-simple`, `transport-consignment`.
`recommendTemplates(businessType)` reorders them, best first, and hides none.

## Preserving an old bill

`captureSnapshot(template, locale, on)` copies the whole visual definition onto the invoice.
Storing the template id would not be enough: a template can be edited, and every old bill would
silently change. A test redesigns a template and asserts the old bill reprints byte-identically.

Rendering is deterministic — the same document and snapshot produce the same bytes — so any visual
change is a deliberate one and a diff can be reviewed.

## PDF

There is no PDF writer here. The renderer produces a complete, print-ready HTML document with
correct `@page` sizes; PDF comes from the browser's own print dialogue. Shipping a second rendering
engine would mean the PDF could differ from the preview the user approved.

## What this module never does

- **Decide GST liability.** It prints what #25 worked out.
- **Decide the document's title.** Whether a bill is a tax invoice or a bill of supply is a
  compliance question; the caller supplies it. Tracked as a gap in the #54 decision log.
- **Generate the government's QR code.** #26 produces the e-invoice QR; this prints what it is
  given, and shows a labelled empty slot otherwise. The one QR this module does draw is the
  pay-by-scan UPI square (#144), below, which is the business's own payment link and not a
  government record. **A styled PDF is never an e-invoice** — a bill with no government
  reference never implies one, and there is a test.

## Pay-by-scan UPI square (#144)

- `InvoiceDocument.upiId` is frozen onto the bill like the bank details. Every shipped design
  (version 1.1.0) carries the optional field `qr.upi`; snapshots taken before it do not, so old bills
  reprint unchanged.
- The square carries `upi://pay?pa=<upi id>&pn=<seller name>&am=<amount still due>&cu=INR&tn=<bill
  number>`. The amount is `totals.outstanding`, else the total less `totals.amountPaid`, else the
  total.
- No square, and no empty box, when nothing is due or on a credit note. No square on 58 mm paper.
  On 80 mm the square prints once an id is saved; the empty box does not, by the till-roll rule.
- Until an id is saved, A4 and phone show the `upi.qr` reserved slot at the square's 26 mm size.
- `validateUpiId` refuses an id no UPI app could pay to. `encodeQr` is a self-contained QR encoder
  (byte mode, level M, versions 1–15, at most 412 bytes); it throws rather than cutting text short.
- The app saves the id through `POST /api/branding/upi` (`{ upiId }` or `{ clear: true }`), and
  `GET /api/branding` returns it.

## Safety

Every value is escaped. An item called `<script>alert(1)</script>` is something a shopkeeper can
type, and there is a test that it is printed rather than executed.

## Known limitations

- The amount in words is English only, including on a Hindi bill. Hindi wording for numbers is a
  translation task, not a rendering one.
- Logos are accepted as data URIs; there is no image pipeline, resizing or format validation yet.
- Multi-page A4 repeats the column headings but does not yet print "page 1 of 3".
- Visual regression is byte-comparison, not pixel-comparison. It catches every change to the
  output; it does not catch a browser rendering it differently.
