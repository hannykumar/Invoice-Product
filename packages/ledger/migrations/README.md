# Ledger migrations (issue #4 — [E04])

Migrations are plain, forward-only SQL. They are numbered and never edited once merged; a
correction is a new migration, for the same reason a posted voucher is corrected by a reversal.

| File | Adds |
| --- | --- |
| `0001_ledger.sql` | Accounts, vouchers, journal lines, fiscal periods, sequences, settings, idempotency records, and the triggers that make finished entries immutable and unbalanced entries impossible. |

## What the database enforces on its own

The service checks these before writing, and the database checks them again, because a future
write path with a bug must not be able to produce books that do not balance:

- a voucher's stored totals must be equal (`voucher_balances`);
- the sum of a voucher's lines must equal its stored totals (`voucher_balanced_check`, deferred to
  the end of the transaction so lines and header can be inserted in any order);
- a line is a debit or a credit, never both, and never negative (`journal_line_one_side`);
- a finished voucher cannot be edited or deleted (`voucher_immutable`, `voucher_no_delete`);
- the lines of a finished voucher cannot be edited or deleted (`journal_line_immutable`);
- one idempotency key produces at most one voucher per company (`voucher_idempotency_unique`);
- a voucher number is unique per company (`voucher_number_unique`);
- a system role such as `ROUND_OFF` resolves to exactly one account per company.

## Tenant isolation

Every table carries `company_id` and every index leads with it. Row-level security policies are
added by GPT 2 under issue #3, which owns authentication and the tenant boundary; this migration
deliberately does not define them, so that the two do not conflict.

## Running them

Migration tooling belongs to issue #2 (GPT 2). Until it lands, apply in order with `psql`:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/ledger/migrations/0001_ledger.sql
```
