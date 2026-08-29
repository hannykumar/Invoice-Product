# Bank statement import contract v1

Owner: GPT 2, issue #21. Consumers: bank reconciliation (#22) and the responsive client (#38).

## Purpose and boundary

`StatementImportService` turns a CSV, native XLSX or text-based PDF statement into tenant-scoped
dated debit/credit records. Imports are drafts for review. They never create, change or reconcile a
ledger voucher; #22 owns matching and a person confirms any resulting accounting action.

## Inputs and formats

Every call receives authenticated `RequestContext`, `fileName`, `format`, source content and optional
opening/closing balances in exact paise. `csv` and `pdf-text` content is text; `xlsx` and `pdf`
content is base64. Parsers are replaceable through `BankStatementParser`.

Supported header aliases include date/transaction date/value date, description/narration/
particulars, debit/withdrawal, credit/deposit and reference/transaction ID. Dates are interpreted
as explicit ISO or Indian day-first dates. Impossible dates, negative columns, missing descriptions,
missing amounts and rows containing both debit and credit are not guessed.

## Output and states

- `ready`: all accepted rows normalized and any supplied opening/closing balances agree.
- `needs-review`: one or more rows are uncertain or the balance check fails. `reviewReasons` names
  the exact source row, sheet row or PDF page/line and explains what needs attention.
- unreadable files fail with `BANK_STATEMENT_UNREADABLE` and an audited `failed` outcome.

Every accepted transaction retains `sourceLocation`, exact debit/credit paise and a tenant-bound
fingerprint. Reimporting identical content returns the original import. Overlapping files reuse
existing transaction identities, so no transaction is counted twice.

## Permissions, audit and privacy

Creating an import requires `bank.statement.import`; reading requires that permission or
`bank.balance.read`. Cross-company reads fail with `TENANT_ISOLATION`. Audit events record actor,
format, filename, result state, counts and review reasons but never source content or bank rows.

## Known limitations

- Scanned/image-only and password-protected PDFs require a future OCR/unlock adapter and fail visibly.
- Bank-specific layouts outside the published aliases require another parser; they are not inferred.
- Live bank connectivity belongs to #24. Automatic matching and exception resolution belong to #22.
