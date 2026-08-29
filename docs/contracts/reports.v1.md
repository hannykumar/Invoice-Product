# Contract: `reports` v1.0.0

| | |
| --- | --- |
| **Owner** | GPT 1, issue #35 [E35] |
| **Consumed by** | GPT 1 (#34 assistant, #48 release gates), GPT 2 (#38 web surfaces, #39 exports) |
| **Package** | `@invoice/reports` |
| **Depends on** | `@invoice/ledger` (#4), `@invoice/sales` (#9), `@invoice/inventory` (#12), `@invoice/receivables` (#20), `@invoice/gst-calc` (#25), purchases (#17, GPT 3) through `PurchaseReadPort` |
| **Status** | Published |

## Purpose

Every report a business owner looks at, derived from the same records the books are made of, with
each total traceable to the entries that produced it.

## Three refusals

1. **A report never posts anything.** The package exposes no write path and holds no service that
   can reach one. Its only ledger dependency is `LedgerStore.read()`, which returns a read-only
   unit of work. This is issue #35's stated non-goal, enforced by construction.
2. **A total is never presented without its records.** Every `Figure` carries the
   `Contribution` rows it was folded from. Nothing stores a balance, so the rows are already in
   hand; carrying them is cheaper than recomputing them and is what makes a figure checkable.
3. **A missing fact is never filled in.** When the books cannot answer — stock that has been
   counted but never valued into the ledger, a bill priced without a rate, money received against
   no bill — the figure is not adjusted to look right. The gap is named in the exception list
   with the records behind it.

## Filters are explicit, always

```ts
interface ReportFilter {
  readonly from: IsoDate;        // required
  readonly to: IsoDate;          // required
  readonly branchId?: BranchId | null;   // undefined = every branch; null = entries with no branch
  readonly includeDrafts?: false;        // reserved; drafts never count towards a figure
}
```

There is no "current period" default and no implicit company. The company comes from
`ActorContext`, never from an argument, so one business's figures cannot be asked for from
another's session. `financialYearRange()` and `monthRange()` from the kernel build the common
ranges; the report itself takes the dates.

`branchId: undefined` and `branchId: null` mean different things and the difference is load-bearing:
a business with one shop posts vouchers with a branch, and a journal entry made by the accountant
may have none. Asking for "the Karol Bagh shop" must not silently include the second.

## Reports

| Report | Question it answers | Reconciles to |
| --- | --- | --- |
| `trialBalanceReport` | Do the books balance? | Itself: debits equal credits, or the report says they do not |
| `profitAndLossReport` | Did the business make money this period? | Trial balance income and expense rows |
| `balanceSheetReport` | What does the business own and owe? | Trial balance asset, liability and equity rows, plus the period's profit |
| `salesRegister` | What was billed, to whom, with how much tax? | The sale vouchers in the ledger for the same range |
| `purchaseRegister` | What was bought? | The purchase vouchers, once #17 supplies them |
| `stockReport` | What is left, and what is it worth? | Stock movements; **not** yet to the ledger — see below |
| `ageingReport` | Who owes us, who do we owe, how late? | The receivable and payable control accounts |
| `gstSummaryReport` | What tax was collected and paid this period? | The output and input tax accounts |
| `exceptionsReport` | What needs a person before any of this can be trusted? | — |

Each returns a `Report<T>` — a header (company, filter, when it was built, the snapshot id) and a
body. The header is what an export carries, so a printed page always says what it was filtered to.

## Drill-down

```ts
interface Contribution {
  readonly sourceKind: string;      // "voucher", "sales_invoice", "stock_movement", "payment"
  readonly sourceId: string;
  readonly sourceNumber: string | null;   // what a person would recognise
  readonly date: IsoDate;
  readonly branchId: BranchId | null;
  readonly partyId: PartyId | null;
  readonly description: string;
  readonly amount: Money;
}

interface Figure {
  readonly amount: Money;
  readonly contributors: readonly Contribution[];
}
```

`figureOf(contributions)` is the only way to build one, so a figure and its records cannot drift
apart. `reconciles(figure)` asserts the amount equals the sum of the rows; the test suite runs it
over every figure of every report.

## The stock figure is not a ledger figure yet

`stockReport` values stock by weighted average from the movements. **Those values are not posted to
the ledger** — that belongs with #17 and the purchase side. So the balance sheet shows the
*ledger's* stock account, the stock report shows the *movements'* valuation, and when the two
disagree `exceptionsReport` raises `STOCK_VALUE_NOT_IN_BOOKS` with the difference and the movements
behind it. It is never quietly plugged into the balance sheet, because a plugged figure is a figure
nobody can check.

## Exceptions

| Code | What it means |
| --- | --- |
| `BOOKS_DO_NOT_BALANCE` | Debits and credits differ. Nothing else in the pack can be trusted first. |
| `STOCK_VALUE_NOT_IN_BOOKS` | Counted stock is worth one figure; the books say another |
| `BILL_WITHOUT_TAX_DECISION` | A bill was priced without a rate the product could source or the business declared |
| `BILL_STUCK_BEFORE_ISSUE` | A bill has sat unissued in the period being reported |
| `MONEY_WITHOUT_A_BILL` | Money received or paid that no bill has claimed |
| `CHEQUE_NOT_CLEARED` | Cheques counted as taken but not yet money |
| `STOCK_WENT_NEGATIVE` | An authorised override let stock go below zero, with its reason |

An exception carries its own contributions, so it drills like any other figure. Exceptions are
**reported, never resolved here** — this package changes nothing.

## Export and snapshots

`exportReport(report, 'CSV' | 'JSON')` writes the header first — company, dates, branch, when it
was produced, the snapshot id — then the rows. A snapshot id is
deterministic — the report id, the filter and the as-at instant, folded together — so asking twice
for the same period as at the same instant produces the same id and the same bytes. Retrying an export
therefore cannot produce a second, subtly different document.

## Permissions

`reports.view.financial`, `reports.view.sales`, `reports.view.purchase`, `reports.view.stock`,
`reports.view.dues`, `reports.view.gst`, `reports.view.exceptions`, `reports.export`.

`ReportService` requires the permission before it reads anything, and records an audit event
naming the report, the filter and the actor — never the figures, because a figure is business data
and an audit trail is not a place to copy it to.

## Errors

| Code | Meaning |
| --- | --- |
| `REPORT_RANGE_INVALID` | The closing date is before the opening date |
| `REPORT_RANGE_BEFORE_BOOKS` | The whole range ends before the business began keeping books here |

A branch that this company does not have, and a purchase side that is not built, are **not**
errors. The first returns an empty, correctly-labelled report; the second returns an empty register
whose `available` flag is false and whose note says why. A report that refuses to render is a
report an owner cannot learn anything from.

## Known limitations

- **Purchases are behind `PurchaseReadPort`, currently a mock.** GPT 3's #17 owns purchase
  posting. The register, the GST input figures and the payables ageing are built against the port's
  documented shape; when #17 lands, the adapter is written and nothing else here changes.
- **Stock value is not in the books.** As above.
- **The balance sheet computes the period's profit rather than reading a closing entry.** Year-end
  closing is not built; until it is, retained earnings shows what has been posted to it and the
  period result is shown separately so the two are never confused.
- **`Contribution.description` is one language.** Every heading, column, note and sentence is
  bilingual; the one-line description of an individual record is built by joining names and is
  English-shaped. Making it bilingual means giving every contributing module a bilingual
  description, which is a change to their contracts, not this one.
- **The balance sheet shows the ledger's stock account, which is currently zero for most
  businesses.** See "The stock figure is not a ledger figure yet".
- **`pack()` asks for every permission**, because it is every report. A user who may see stock but
  not the books asks for the reports they hold, not the pack.
- Ageing counts lateness from the report's closing date, not today, so a statement printed for
  March does not get later every time it is reopened.
- Figures are held in memory. Everything folds over the in-memory stores; a Postgres reader is #4's
  adapter work and is not written yet.
