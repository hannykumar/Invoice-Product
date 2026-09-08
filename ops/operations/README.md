# Operational administration

This module implements issue #41 without exposing customer ledgers or documents to operators.

- External calls must carry a caller-supplied correlation ID. Logs keep connector, operation and error code while the shared secure logger removes credentials and document content.
- Support diagnostics require consent from a company member with `support.access.grant`. A grant names the support actor, approved diagnostic scopes, reason and expiry (maximum 24 hours). Every diagnostic view and revocation is audited.
- Queue jobs show draft, processing, success and failure. Re-enqueue is idempotent per company, kind and key. Replay requires `queue.replay`, a failed job, and an explicit `idempotent: true` declaration; it never edits financial records.
- Incidents expose a customer-readable timeline. Feature flags are named controls with permission checks, tenant allow-lists and before/after audit events—never arbitrary database edits.

## Recurring work (issue #122)

`RecurringWorkRunner` is driven by a one-minute host tick and by the same virtual-clock `runDue`
method in tests. Each code-defined job is registered separately for each company with an explicit
service actor and the exact permissions its existing domain entry point requires. Schedule-slot
keys make duplicate ticks one outcome. A still-running copy blocks overlap only for that company
and job; other work continues in parallel.

Failures, retries and dead letters are `OperationalQueue` jobs rather than a second retry system.
Missed intervals coalesce into the latest due slot, so coming back after downtime performs one
current sweep instead of sending historical alerts. The operations workspace shows the last and
next run, duration, outcome, safe summary and error code without exposing customer records.

`standardRecurringJobs` registers the existing compliance-calendar sweep, unresolved government
call reconciliation, notification delivery, e-way-bill expiry watch and collection reminders. A
host supplies the services it has composed; the local API currently composes the notification,
e-way-bill and collections entries, while compliance/GSP hosts use the same catalogue adapters.
The host boundary and status fields are specified in
[`docs/contracts/recurring-work.v1.md`](../../docs/contracts/recurring-work.v1.md).

The in-memory services are deterministic test adapters. `migrations.ts` defines the PostgreSQL schema, tenant keys and forced RLS expected of a production repository.

## Assumptions and limits

- Platform authentication, membership, permissions and audit contracts are owned by issues #2, #3, #6 and #8.
- Secret redaction is owned by issue #40 and reused here.
- A production deployment should export metrics and traces to its chosen OpenTelemetry-compatible collector. This module deliberately does not bind the product to one vendor.
- Support diagnostics contain operational metadata only. Invoice contents, bank statements, credentials and unrelated tenant records are outside every diagnostic scope.
- The first deployment is a single-node scheduler. The database uniqueness constraints are the
  hand-off point for a later distributed lease; distributed leader election is intentionally out
  of scope for issue #122.
