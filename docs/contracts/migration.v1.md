# Contract: `migration` v1.0.0

| | |
| --- | --- |
| **Owner** | GPT 1, issue #37 [E37] |
| **Consumed by** | GPT 2 (#38 web), GPT 1 (#36 onboarding hands over to it) |
| **Package** | `@invoice/migration` |
| **Status** | Published |

## Purpose

Let a business leave Tally, BUSY, Vyapar or Marg without retyping everything it has: read the Excel
or CSV export it already has, show what would happen, and — once a person has approved it — create
the same records the product would have made if they had been typed in.

## Seeing it

```bash
npm run demo:migration
```

Four files go in — a Vyapar party list, a BUSY item list, a Tally stock summary, a trial balance —
and the books come out balanced with stock in the godown. Then the same file is sent twice and
refused, and one import is taken back out.

In the running app: **Bring your data** (`npm run web`), which drives this service on a fresh
company and prints the trial balance the ledger gives back.

## The four rules that shape it

1. **Never guess a number.** A cell that cannot be read exactly is a refused row with a reason, not
   a rounded figure. `readMoney` refuses three decimal places rather than rounding them; `readDate`
   refuses a date it cannot read; a quantity is never silently shortened.
2. **Never commit a mapping nobody looked at.** `analyse` proposes; a person approves; the approval
   is pinned to `fingerprintOf(columns)`. A mapping that changed after approval cannot be committed.
3. **Never leave half an import.** Everything a batch wrote is remembered on the batch. A commit
   that fails part way takes its own writes back out before raising; `rollback` takes a finished one
   back out, and checks every stock line first so it never starts something it cannot finish.
4. **Never import the same file twice.** The batch carries the SHA-256 of the file's bytes. A second
   analyse of the same bytes comes back `REJECTED_DUPLICATE` naming the import that already has them.

## Lifecycle

```
analyse ──► ANALYSED ──approveMapping──► MAPPING_APPROVED ──commit──► COMMITTED ──rollback──► ROLLED_BACK
   │
   └── same bytes as a committed batch ──► REJECTED_DUPLICATE
```

`preview` may be called in any state before commit and writes nothing. `commit` on a `COMMITTED`
batch returns what it did the first time.

## What can be brought in

| `EntityKind` | Required fields | Writes through |
| --- | --- | --- |
| `customers` / `suppliers` | `name` | `MasterWriter` → `MasterDataService` (#5) |
| `items` | `name` (and an HSN/SAC code on every row) | `MasterWriter` → `MasterDataService` (#5) |
| `opening_stock` | `item_ref`, `quantity` | `OpeningStockWriter` → `InventoryService` (#12) |
| `opening_balances` | a target (`account_code` or `party_ref`) and an amount | `LedgerService.postVoucher` (#4) |

**Historical vouchers are not in this route.** A file whose headings look like a bill register —
an invoice or voucher number, a date and an amount — is refused by name with
`MIGRATION_TRANSACTIONS_NOT_SUPPORTED`. Past bills would put figures into the accounts that nothing
has checked; they come in only through a separately validated voucher format, which is not part of
this release.

## Reading a file

`readDelimited` handles what these exports actually are: a BOM, CRLF, comma/tab/semicolon/pipe
(sniffed by column-count consistency), quoted fields containing commas and newlines, ragged rows,
and the report title Tally writes above the headings. `SpreadsheetReader` is the seam for `.xlsx`;
`adapters/xlsx.ts` implements it over `read-excel-file`, loaded only when a workbook arrives, so
nothing else in the module depends on it.

Row numbers in every message are the line numbers the person sees in Excel.

## Mapping

`proposeMapping(headers, entity)` returns, per column, a canonical `field` or `null`, a
`confidence` and the runners-up. A field is claimed by the strongest column that wants it.

- `CLAIM_FLOOR` (0.7): below this the column is left unmapped rather than guessed at.
- `CONFIRM_BELOW` (0.8): between the two, the screen must ask rather than state
  (`needsConfirmation`).

`approveMapping` refuses an incomplete mapping (`MIGRATION_MAPPING_INCOMPLETE`, naming the fields in
plain words), an unknown field, and any mismatch between the columns and the fingerprint.

## Duplicates

Three different things, three answers:

| Kind | Answer |
| --- | --- |
| The same file again | The batch is refused entirely (`REJECTED_DUPLICATE`). |
| The same **name** twice in one file | Parties and items: the later row is skipped. |
| The same **account or item** twice in a stock or balance file | Refused: two figures for one account are never added together. |
| A row matching something the business already has | Skipped, never overwritten. |
| A row that looks similar but is not certainly the same | Imported, and listed under `duplicates.needsALook`. |

The matching is GPT 3's `checkForDuplicates` from `packages/masters`, so an imported record faces
exactly the rules a typed one does. Master data may still refuse a row at write time as a
near-identical name; that comes back as `WriteOutcome.refused_as_duplicate`, is counted as skipped,
and never fails the rest of the file.

## Opening balances

Rows are resolved in this order, and only then posted as one `OPENING_BALANCE` voucher:

1. an account code, when the file gives one;
2. a customer or supplier, when the file says so (a "Sundry Debtors" group);
3. an account of that name in the chart — `Cash in hand` on a trial balance is an account;
4. otherwise a customer or supplier, whose account is opened by `LedgerService.openPartyAccount`.

Balance checking and its wording are issue #36's `checkOpeningBalances` / `withAcceptedDifference`,
not a second implementation. An unbalanced file is refused (`MIGRATION_OPENING_UNBALANCED`, naming
the amount) unless a person supplies `acceptDifference.reason`, in which case the difference is
posted visibly to `3900 Opening balance difference` with that reason.

The reconciliation reads the posted voucher **back out of the ledger**, and the stock reconciliation
reads the change in stock value **back out of the stock ledger**, rather than repeating the input.

## Errors

| Code | Kind | Meaning |
| --- | --- | --- |
| `MIGRATION_NO_HEADINGS` | INVALID | No heading row could be found. |
| `MIGRATION_TRANSACTIONS_NOT_SUPPORTED` | NOT_ALLOWED | The file is a bill register. |
| `MIGRATION_MAPPING_NOT_APPROVED` | NOT_ALLOWED | Nobody has approved the columns. |
| `MIGRATION_MAPPING_CHANGED` | CONFLICT | The columns and the fingerprint disagree. |
| `MIGRATION_MAPPING_INCOMPLETE` | INVALID | A required field has no column. |
| `MIGRATION_ALREADY_IMPORTED` | CONFLICT | These bytes are already in the books. |
| `MIGRATION_NOTHING_TO_IMPORT` | NOT_ALLOWED | Every row needs fixing first. |
| `MIGRATION_OPENING_UNBALANCED` | NOT_ALLOWED | The two sides do not agree and nobody has accepted the difference. |
| `MIGRATION_ITEM_UNKNOWN` / `MIGRATION_WAREHOUSE_UNKNOWN` | INVALID | A stock file names something the books do not have. Nothing moves. |
| `MIGRATION_ACCOUNT_UNKNOWN` / `MIGRATION_ACCOUNT_IS_HEADING` | INVALID | A balance names an account that does not exist or cannot hold a balance. |
| `MIGRATION_UNIT_UNKNOWN` | INVALID | A unit the books do not have. Units are never invented. |
| `MIGRATION_STOCK_ALREADY_USED` | NOT_ALLOWED | Part of the imported stock has been sold; the import cannot be undone. |
| `MIGRATION_BATCH_NOT_FOUND` / `MIGRATION_WRONG_COMPANY` | NOT_FOUND / FORBIDDEN | Tenancy. |

## Permissions

`migration.run` (analyse, approve, preview), `migration.commit`, `migration.rollback`. Tenancy comes
from the authenticated actor; a batch id from another company is `NOT_FOUND`.

## Idempotency

- Batch: keyed on the file digest per company.
- Parties, items and stock lines: `migration:<batchId>:<kind>:<rowNumber>`.
- The opening voucher: `migration:opening:<batchId>`, so the ledger itself refuses a second posting.
- Rollback: `migration:undo:<id>`.

## Known limitations

- Duplicate control is quadratic in the number of existing records, because it compares every new
  name with every existing one. Five hundred rows is comfortable; tens of thousands would need
  blocking keys before matching.
- `.xlsx` numeric cells arrive as numbers. Rupees and paise survive that exactly; a cell holding
  more decimals than it displays is refused by `readMoney` rather than rounded.
- Batches and file contents are in memory (`InMemoryMigrationStore`). The PostgreSQL store lands
  with the migration that carries the `migration_batches` table.
- Opening balances carried on a *party* file (the `opening_balance` column) are read and reported,
  but are not posted from there — they belong on a trial balance, where both sides can be checked.
