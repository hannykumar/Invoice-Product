# Contract: `ledger` v1.0.0

| | |
| --- | --- |
| **Owner** | GPT 1, issue #4 [E04] |
| **Consumed by** | GPT 1 (#9 sales, #12 inventory valuation, #20 receivables and payables, #35 reports, #36 opening balances, #37 migration), GPT 3 (#17 purchase posting, #45 returns) |
| **Package** | `@invoice/ledger` |
| **Depends on** | [`platform-ports`](./platform-ports.v1.md) — currently mocked |
| **Status** | Published |

## Purpose

The financial source of truth. Every rupee that exists in this product exists because a balanced
voucher was posted here. There is no other write path into the books, and there is no way to edit
or delete what has been posted.

## Data model

```
company ──< account ──< journal_line >── voucher
                             │
company ──< fiscal_period    └── party_id (optional)
company ──< ledger_sequence
company ──< ledger_settings (books_start_date)
```

| Entity | Key facts |
| --- | --- |
| `Account` | `code` unique per company, one of five `AccountType`s, `isGroup` accounts cannot be posted to, `systemRole` resolves an account by purpose so renaming is safe, `partyId` set when the account belongs to one customer or supplier |
| `Voucher` | Immutable once `FINAL`; carries `type`, `date`, `number`, `source`, `idempotencyKey`, `createdBy`, and the links `reversesVoucherId` / `reversedByVoucherId` / `amendsVoucherId` |
| `JournalLine` | Exactly one of `debit` / `credit` is non-zero, neither is negative, and every line names an account |
| `FiscalPeriod` | One row per company and month, `OPEN` / `SOFT_LOCKED` / `HARD_LOCKED` |

Amounts are `Money` from `@invoice/kernel`: exact integer paise. **Never a float, never a string
parsed at the boundary without `fromDecimalString`.**

## Commands

| Command | Permission | Idempotent | Effect |
| --- | --- | --- | --- |
| `initialiseCompany(actor, { booksStartDate, accounts })` | `ledger.setup` | Refuses a second run | Seeds the chart of accounts and the books start date |
| `postVoucher(actor, command)` | `ledger.post.<type>` | Yes, by `idempotencyKey` | Posts one balanced `FINAL` voucher |
| `reverseVoucher(actor, command)` | `ledger.reverse` | Yes, by `idempotencyKey` | Posts the mirror and marks the original `REVERSED` |
| `amendVoucher(actor, command)` | `ledger.reverse` + `ledger.post.<type>` | Yes, derived keys | Reverses then posts the corrected voucher, linked |
| `setPeriodState(actor, { monthKey, state, reason })` | `periods.lock` / `periods.reopen` / `periods.hard_lock` | Naturally | Opens, soft-locks or hard-locks a month |

### `postVoucher`

```ts
interface PostVoucherCommand {
  idempotencyKey: string;                        // required, per company
  type: 'SALE' | 'PURCHASE' | 'RECEIPT' | 'PAYMENT' | 'JOURNAL'
      | 'CREDIT_NOTE' | 'DEBIT_NOTE' | 'OPENING_BALANCE';
  date: IsoDate;                                 // the document date, not "now"
  narration?: string | null;
  source?: { kind: string; id: string; number: string | null } | null;
  lines: { accountId; partyId?; debit: Money; credit: Money; narration? }[];
  periodOverride?: { reason: string };           // only for a soft-locked month
}
```

Returns `{ voucher, deduplicated }`. `deduplicated: true` means this call matched an earlier one
and nothing new was written — the caller should treat it as success, not as an error.

`REVERSAL` is deliberately **not** an accepted type. A reversal is produced by `reverseVoucher`,
never posted directly.

## Queries

| Query | Returns |
| --- | --- |
| `getVoucher(actor, id)` | One voucher with its lines, or `null` when it is not this company's |
| `accountBalance(uow, companyId, accountId, range)` | Debit and credit totals and the balance on the account's normal side |
| `partyBalance(uow, companyId, partyId, range)` | What one customer owes, or what is owed to one supplier |
| `trialBalance(uow, companyId, range)` | Every posted account, the totals, and the difference (always zero) |

Every one of these folds journal lines. **There is no stored balance anywhere**, which is what lets
#35 drill from any total down to the entries that produced it.

## Errors

All failures are `DomainError` with a `kind`, a stable `code`, and often a `messageId` pointing at
the issue #46 catalogue so the same failure is worded identically everywhere.

| Code | Kind | Meaning |
| --- | --- | --- |
| `LEDGER_UNBALANCED` | INVALID | The two sides differ; `details.difference` says by how much |
| `LEDGER_BOTH_SIDES`, `LEDGER_EMPTY_LINE`, `LEDGER_NEGATIVE_AMOUNT`, `LEDGER_TOO_FEW_LINES` | INVALID | Malformed lines |
| `LEDGER_UNKNOWN_ACCOUNT`, `LEDGER_GROUP_ACCOUNT`, `LEDGER_INACTIVE_ACCOUNT`, `LEDGER_PARTY_MISMATCH` | INVALID | The account cannot take this line |
| `LEDGER_MIXED_CURRENCY` | INVALID | One entry cannot mix currencies |
| `LEDGER_PERIOD_SOFT_LOCKED` | NOT_ALLOWED | Closed month; `messageId: period.closed` |
| `LEDGER_PERIOD_HARD_LOCKED` | NOT_ALLOWED | Closed for good; `messageId: period.closed_permanently` |
| `LEDGER_BEFORE_BOOKS_START` | NOT_ALLOWED | Dated before the business started keeping books here |
| `LEDGER_ALREADY_REVERSED`, `LEDGER_REVERSE_DRAFT` | NOT_ALLOWED | This entry cannot be undone again |
| `LEDGER_REASON_REQUIRED`, `LEDGER_OVERRIDE_REASON_REQUIRED` | INVALID | `messageId: override.reason_required` |
| `LEDGER_VOUCHER_NOT_FOUND` | NOT_FOUND | Not this company's, or does not exist |
| `LEDGER_WRONG_COMPANY` | FORBIDDEN | Cross-tenant attempt |
| `PERMISSION_DENIED` | FORBIDDEN | `messageId: permission.not_allowed` |
| `LEDGER_ALREADY_SET_UP`, `LEDGER_DUPLICATE_NUMBER`, `IDEMPOTENCY_KEY_TAKEN`, `LEDGER_IDEMPOTENCY_DANGLING` | CONFLICT | Retryable |

`error.retryable` is true only for `CONFLICT`.

## Idempotency

Every write command requires an `idempotencyKey`, unique per company. Sending it again returns the
original result with `deduplicated: true`. A command that fails and rolls back frees its key, so a
caller that fixes the input may reuse it. `UNIQUE (company_id, idempotency_key)` on `voucher`
enforces this in the database as well as in the service.

## Permissions and tenant isolation

Permissions are named in the table above and checked before anything is read or written. Every
repository call is scoped by `companyId` taken from the actor, never from the request. Row-level
security policies are added by GPT 2 under issue #3.

## Guarantees a consumer may rely on

1. A voucher that exists is balanced. There is no state in which it is not.
2. A `FINAL` voucher never changes and is never deleted.
3. `deduplicated: true` means no second entry was created.
4. A failed command writes nothing at all, including the sequence number it would have used.
5. Balances always equal the fold over journal lines.
6. Concurrent postings never share a voucher number and never leave a gap in the sequence.

## What this contract deliberately does not do

- **Document numbering.** `voucher.number` is the ledger's own sequence. Invoice numbers by
  company, branch and financial year belong to issue #9.
- **Posting templates.** Deciding that a sale debits the customer and credits income belongs to
  the module that owns the document. The ledger takes the lines it is given and checks them.
- **Tax.** The ledger never computes GST. Issue #25 does, and hands the resulting lines over.
- **Stock.** Issue #12 owns quantities. The ledger records value only.
- **Approvals.** Approval happens before the ledger is called.

## Change policy

Adding a voucher type, an error code or a query is a minor version. Changing the meaning of a
field, removing an error code, or changing an idempotency guarantee is a **major** version and
must name every consuming issue.
