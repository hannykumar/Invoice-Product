# End-to-end workflow tests

Issue #44 owns this directory. These tests compose real domain services across package boundaries;
they do not replace feature-level tests and they do not accept mock-only success as completion.

The first scenario covers an approved purchase through stock, the ledger and the supplier payable,
then sells the same stock, records a part receipt and proves the books remain balanced. It also
pins retry idempotency and the no-partial-write guarantee when an oversale is refused.

Still to add as their dependencies finish: document/WhatsApp ingestion, returns, bank import and
reconciliation, GST-return preparation, e-invoice/e-way-bill outage recovery, backup/restore, and
target-volume performance runs.
