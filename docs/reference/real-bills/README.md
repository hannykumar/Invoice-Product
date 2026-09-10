# The real bills this product is measured against

These are documents the family's businesses actually send and receive. They are the benchmark:
**match what these carry before spending effort on anything that merely looks nicer.** A bill that
is technically correct but does not read as an Indian tax invoice gets queried by the buyer's
accountant, and the businesses being asked to switch will not switch.

They are checked in so nobody has to ask for them again.

| File | What it is |
| --- | --- |
| `kk-polyplast-285.pdf` | KK Polyplast's own sales invoice, 24-02-2026. Also `.png`, because the PDF's text cannot be extracted — it uses fonts with no character map, so read the picture. |
| `blessing-export-BE-DL-25-26-0139.pdf` | Blessing Export's bill **to** KK Polyplast, 13-Mar-26. Tally output, with a live IRN, Ack number and Ack date, and the e-way bill on page 2. Text extracts cleanly with `pypdf`. |
| `eway-bill-291.pdf` | A standalone e-way bill for KK Polyplast's invoice 291, 22/03/2026. |

## Reading them

There is no `pdftotext` on this machine. What works:

```
python3 -c "from pypdf import PdfReader; print(PdfReader('blessing-export-BE-DL-25-26-0139.pdf').pages[0].extract_text())"
```

For `kk-polyplast-285.pdf`, which extracts nothing, render it instead:

```
qlmanage -t -s 2400 -o . kk-polyplast-285.pdf
```

## What they establish

Read `field-audit.md` next to this file for the field-by-field comparison against our own output.

Two things worth knowing before reading either bill:

- **Both print a ship-to box on every bill, and neither ever says "same as above".** Blessing
  repeats the buyer's name, address, GSTIN and state in full under *Consignee (Ship to)*, identical
  to the *Buyer (Bill to)* box beside it. KK Polyplast prints the delivery address alone under
  *Ship To*. The box is always there.
- **"Amount" does not mean the same thing on the two bills.** Blessing's Amount column is the
  taxable value: 2,000 KGS x Rs 72.00 = Rs 1,44,000.00, tax added below. KK Polyplast's Amount
  column *includes* the GST: 1,400 x Rs 60.00 = Rs 84,000.00 taxable, and the Amount column shows
  Rs 99,120.00. Ours follows Blessing, which is the Tally convention.
