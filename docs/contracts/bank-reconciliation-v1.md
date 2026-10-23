# Bank reconciliation contract v1

Version 1.1.0 (#366).

Owner: GPT 2, issue #22. Inputs: bank import (#21) and receivables/payables (#20).

`BankReconciliationService` compares immutable imported bank lines with already-recorded receipts and payments. It scores amount, date and normalized reference evidence; enumerates one-to-one, one-to-many and many-to-one groups; and automatically accepts only a unique candidate above the configured confidence threshold. Competing candidates within the ambiguity margin remain suggestions for a person.

Every result exposes the confidence, evidence and remaining difference. Missing-book bank lines produce a draft receipt/payment suggestion but never post it. Missing-bank entries, suspicious date gaps, repeated statement lines and possible reversals are visible exceptions. The original bank statement and the original payment are never modified.

Manual confirmation and unmatching require `bank.reconcile.confirm`. Automatic matches, confirmations and reasoned unmatches form an append-only tenant-scoped audit trail.

## 1.1.0 (#366) — persistence

`BankReconciliationService` takes a `ReconciliationStore` (`InMemoryReconciliationStore` by default, `PostgresReconciliationStore` for the database) and its commands are now `async`. A match has its own `id` and names the `candidateId` it came from, so an undone match stays on record and the same pair can be confirmed again as a new match. Running `reconcile` again over lines that already have a match makes no second match and reports them as neither missing nor ambiguous. Undoing a match twice keeps the first undo and audits it once. Amounts must be positive paise. Candidates, matches and audit events live in `bank_reconciliation_candidates`, `bank_reconciliation_matches` and `bank_reconciliation_events` (forced RLS, frozen; a match can only be undone, once).

