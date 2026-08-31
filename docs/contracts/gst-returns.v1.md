# GSTR-1 and GSTR-3B preparation — v1

Issue #30 [E30]. Owner: GPT 3. Package: `packages/gst-returns`.

Prepare a month's outward-supply and summary returns from the books, show a non-accountant what
they are about to file and why, and let them file it whether or not they have a licensed
intermediary.

## What this is for

GST asks a business for two returns each month.

- **GSTR-1** is the list of everything sold. Not one total: the government wants the sales split
  into named tables — sales to businesses, sales to consumers, credit notes, a code-wise summary,
  and a count of the bill numbers used.
- **GSTR-3B** is the short summary that decides how much money moves: the tax collected on sales
  against the tax already paid on purchases.

A shopkeeper filing these is doing the most consequential and least forgiving thing this product
asks of them. A wrong table means a buyer never gets their credit and telephones about it; a wrong
tax split means paying the right tax a second time before getting the wrong one back; a return that
disagrees with the books is the notice that arrives eighteen months later.

## The shape

```
sales invoices (#9) ─┐
credit notes (#45) ──┼─→ OutwardSupplyPort ─→ snapshot ─┬─→ classify ─→ GSTR-1 tables
                     │                                   └─→          ─→ GSTR-3B summary
purchase postings ───→ InwardTaxPort ─────────────────────────────────↗
(#17)
ledger (#4) ─────────→ BookTaxPort ────────→ reconciliation
```

Both returns are built from **one** snapshot. That is the design's main claim: the commonest and
most expensive filing error an MSME makes is a 3B that does not agree with its own GSTR-1, and
building the two from a single read of the books makes that disagreement impossible by
construction rather than by a checklist.

## Which table a sale lands in

`classifyDocument` is a pure function of the document. Given the same bill and the same threshold
it returns the same table every time, so a filing can be re-derived years later.

| Question | Table |
| --- | --- |
| Is it a correction to a month already filed? | `B2BA` / `B2CLA` / `B2CSA` / `CDNRA` / `CDNURA` |
| Did it carry no GST — nil-rated, exempt, outside GST? | `NIL` |
| Did it leave India? | `EXP` |
| Does the buyer have a GST number? | `B2B`, or `CDNR` for a note |
| Consumer in your own state? | `B2CS` (a rate-wise total, no bill numbers) |
| Consumer in another state, above the limit? | `B2CL`, or `CDNUR` for a note |
| Consumer in another state, below the limit? | `B2CS` |

A supply to a special economic zone or a deemed export is a business sale: it goes in `B2B` with
`inv_typ` saying which kind, exactly as the form does it.

### The one number that is not arithmetic

The `B2CL` boundary is a value fixed by notification and it has moved before. It is therefore
handled the way `@invoice/gst-calc` handles a tax rate:

- **effective-dated**, so an old month uses the figure that applied then;
- carrying a **`sourceRef` and a `reviewState`**, so an unchecked figure cannot silently decide a
  filing — in `production` mode the lookup refuses it and every affected bill becomes an exception
  saying so in words;
- overridable by a **business-declared** figure, attributed to the person who declared it, so the
  product stays usable while the compliance register (#54) catches up. Every return built on one
  says whose figure it was.

The two entries shipped in `FIXTURE_B2CL_THRESHOLDS` are `DRAFT` with placeholder source refs.
They are not a statement of Indian law.

## Never guessing

A fact that is missing is a question, not a default. The classifier returns `UNRESOLVED` with the
question in a shopkeeper's words, and the document goes to the exception workspace rather than onto
the return.

| Code | The question |
| --- | --- |
| `GSTR1_GSTIN_NOT_CONFIRMED` | Has this customer no GST number, or did nobody type one in? |
| `GSTR1_NO_PLACE_OF_SUPPLY` | Which state does this sale count as made in? |
| `GSTR1_NOTE_WITHOUT_ORIGINAL` | Which bill does this credit note adjust? |
| `GSTR1_THRESHOLD_NOT_REVIEWED` | Where does the listing limit sit this month? |
| `GSTR1_SEZ_WITHOUT_GSTIN` | A special-economic-zone buyer with no GST number — which is wrong? |

All of a document's questions are returned at once. A preparer who fixes one bad GST number and is
then told about a second one has been made to do the work twice.

## The checks that run before approval

`validateDocuments` produces findings, never corrections. A bill that is wrong is wrong in the
books too, and quietly fixing it in the return alone hides the problem where it matters most.

| Code | Severity | What it catches |
| --- | --- | --- |
| `GSTR1_SPLIT_SHOULD_BE_IGST` / `_LOCAL` | Blocking | The tax split disagrees with the place of supply |
| `GSTR1_BAD_GSTIN` | Blocking | A buyer's GST number that would have the whole file rejected |
| `GSTR1_DUPLICATE_NUMBER` | Blocking | Two documents sharing a number |
| `GSTR1_WRONG_SUPPLIER` | Blocking | A bill issued under a different registration |
| `GSTR1_OUTSIDE_PERIOD` | Blocking | A bill dated outside the month |
| `GSTR1_TAX_DOES_NOT_MATCH_RATE` | Warning | Tax more than a rupee away from rate × value |
| `GSTR1_HSN_MISSING` | Warning | A line with no goods or services code |
| `GSTR1_NOTE_AGAINST_EARLIER_MONTH` | Information | The buyer's credit moves in a different month from the sale |

## Reconciliation against the books

`reconcile` compares the return's totals with the output-tax movement in the ledger, head by head,
with a one-rupee tolerance for rounding. The difference is always stated as *return minus books*,
so a positive number always means the return says more.

Two sides deliberately come from different places: `ledgerBookTaxPort` reads vouchers through
`UnitOfWork` rather than reading the same summary the return was built from. A comparison of a
number with itself proves nothing.

Where the return is short by documents that are still waiting on a decision, the finding says so
instead of sending the shopkeeper hunting for a journal entry that does not exist.

## Acceptance criteria, and where they are kept

**Every return number traces to source vouchers.** Every row of every table carries `SourceRef[]`,
including the summary rows that have no bill number on them, and each ref names the ledger voucher.
`sourcesOfSection` and `GstReturnService.sourcesOf` are the drill-down. The snapshot stores the
documents themselves, not just totals, so an approved return can be rebuilt document by document
years after the bills behind it have been edited or renumbered.

**Locked or approved periods cannot change silently.** At approval the snapshot's `fingerprint` — a
sha256 over every fact that could change a figure — is recorded against the approver and the moment.
Every later read re-reads the books, re-fingerprints them, and if they differ returns a `DriftReport`
naming what was added, removed and changed. The approved figures are *not* refreshed underneath the
approval and *not* thrown away. Reopening is allowed, needs a reason, and is refused outright once
the return is `FILED` — a filed return is corrected by an amendment on a later month, not by editing
this one.

**Manual export works without production GSP access.** `GovernmentReturnPort` is optional
everywhere. A business with no licensed intermediary prepares, checks, approves and exports exactly
as one with a GSP does; only the last button differs, and `submit` refuses with a plain sentence
pointing at the file. `toGstr1Json` and `toGstr3bJson` write the portal's own offline-utility
shape, field names and all.

## States

`docs/product/spec/states.json`, machine `gst_return`.

`SUBMITTING` is where a submission with no answer stays. A timeout is not a failure: the return may
well be filed, and telling a shopkeeper otherwise has them file it twice. The idempotency key is
derived from the approved fingerprint, so a retry reaches the portal as the same filing.

## Permissions

`gst_returns.view`, `.prepare`, `.approve`, `.export`, `.submit`, `.reopen`. Four separate acts,
four separate permissions: preparing and looking are free, and the two steps that leave the building
each need their own.

## What this module deliberately does not do

- **It does not decide the order in which leftover IGST credit is set off.** The law fixes part of
  that order and leaves part to the taxpayer, so it is a decision a person makes at payment time
  with the split in front of them. Every 3B says so on its face.
- **It does not decide what credit may be claimed.** Eligibility and the match against the
  government's GSTR-2B are issue #31.
- **It does not put a purchase return on GSTR-1.** That changes the credit claimed on the inward
  side; putting it here would report somebody else's sale.
- **It does not recompute tax.** The figures come from the bills as issued, via `@invoice/gst-calc`
  (#25). A return that recalculates its own tax can disagree with the bill the customer holds.

## Running it

```
npm run demo:gst-returns
```

Sunrise Soap Works of Pune, four bills and a credit note, from an unanswered question through
approval, drift, manual export and a timed-out submission that is retried without filing twice.
