# Platform command v1

Owner: GPT 2. Consumers: GPT 1 and GPT 3.

Every material command receives an authenticated `RequestContext` (company, branch, actor and granted permissions) plus a non-empty idempotency key. Server code derives tenancy from this context; a caller-supplied company identifier is never authorization.

Commands move through `draft`, `submitted`, `approved`, `rejected`, `finalised`, `failed`, or `cancelled`. A policy may require approval based on action, risk or amount. Invalid transitions, missing permissions, cross-tenant access and duplicate payloads return typed platform errors. State changes, approval decisions, overrides and failures append a redacted audit event. Low-confidence or contradictory facts must create an exception rather than finalise a business record.


## PostgreSQL implementations (#364)

`packages/platform/src/postgres-platform.ts` and `postgres-audit.ts` hold a PostgreSQL twin of each in-memory class: `PostgresAuditLog`, `PostgresCommandService`, `PostgresExceptionQueue`, `PostgresAccessControl` and `PostgresAuthenticationService`. Methods have the same names and meaning and return promises. One suite, `packages/platform/test/platform-contract.ts`, runs against both.

- Every write runs in the unit of work of [`unit-of-work-v1`](./unit-of-work-v1.md). Called inside a business action, the command record, its idempotency key and its audit event commit with that action or not at all.
- Idempotency is decided by the database: `INSERT … ON CONFLICT (company_id, action, key) DO NOTHING` on `idempotency_keys`. Two servers receiving the same retry at once create one command; the same key with different input is `IDEMPOTENCY_CONFLICT`.
- Asking for another company's command or exception answers `NOT_FOUND` on PostgreSQL (the in-memory classes answer `TENANT_ISOLATION`). Either way nothing is returned; PostgreSQL does not reveal that the id exists.
- Audit events are redacted exactly as in memory before they are stored, and are read back in the order they were written (`audit_events.seq`).
- Invitations are stored by the hash of their token only. A session's company comes from the stored session, never from the caller.
