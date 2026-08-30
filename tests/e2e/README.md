# End-to-end workflow tests

Issue #44 owns this directory. These tests compose real domain services across package boundaries;
they do not replace feature-level tests and they do not accept mock-only success as completion.

The first scenario covers an approved purchase through stock, the ledger and the supplier payable,
then sells the same stock, records a bank-transfer receipt and proves the books remain balanced.
The imported bank statement is normalized and automatically matched to that real receipt. An
unexplained bank line becomes review work without silently creating a payment or changing the
books. The scenario also pins retry idempotency and the no-partial-write guarantee when an oversale
is refused.

Still to add as their dependencies finish: document/WhatsApp ingestion, returns, live bank-feed
adapters, GST-return preparation, e-invoice/e-way-bill outage recovery, backup/restore, and
target-volume performance runs.
