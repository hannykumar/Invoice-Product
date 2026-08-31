# Operational administration

This module implements issue #41 without exposing customer ledgers or documents to operators.

- External calls must carry a caller-supplied correlation ID. Logs keep connector, operation and error code while the shared secure logger removes credentials and document content.
- Support diagnostics require consent from a company member with `support.access.grant`. A grant names the support actor, approved diagnostic scopes, reason and expiry (maximum 24 hours). Every diagnostic view and revocation is audited.
- Queue jobs show draft, processing, success and failure. Re-enqueue is idempotent per company, kind and key. Replay requires `queue.replay`, a failed job, and an explicit `idempotent: true` declaration; it never edits financial records.
- Incidents expose a customer-readable timeline. Feature flags are named controls with permission checks, tenant allow-lists and before/after audit events—never arbitrary database edits.

The in-memory services are deterministic test adapters. `migrations.ts` defines the PostgreSQL schema, tenant keys and forced RLS expected of a production repository.

## Assumptions and limits

- Platform authentication, membership, permissions and audit contracts are owned by issues #2, #3, #6 and #8.
- Secret redaction is owned by issue #40 and reused here.
- A production deployment should export metrics and traces to its chosen OpenTelemetry-compatible collector. This module deliberately does not bind the product to one vendor.
- Support diagnostics contain operational metadata only. Invoice contents, bank statements, credentials and unrelated tenant records are outside every diagnostic scope.
