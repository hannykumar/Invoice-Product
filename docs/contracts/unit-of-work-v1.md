# Unit of work v1

Owner: GPT 2 (#363). Extends [`platform-command-v1`](./platform-command-v1.md). Consumers: every
module that writes to PostgreSQL. Named consumers: #364, #365, #366 and #367 (repositories,
tables and locks), #340 (runtime composition) and #345 (outbox worker).
Design and reasoning: [ADR 0363](../decisions/0363-unit-of-work-and-outbox.md).

## The rule

**One business action is one database transaction.** The command handler opens it. Every
repository the handler touches joins it: document, ledger, inventory, idempotency, command
record, audit and outbox. Repositories never open a write transaction of their own.

## API (`packages/platform/src/database.ts`)

```ts
interface UnitOfWork {
  readonly companyId: string;
  readonly sql: SqlExecutor;                         // this transaction's connection
  enqueue(message: OutboxMessageInput): Promise<void>;
}
interface OutboxMessageInput { topic: string; dedupeKey: string; payload: Record<string, unknown>; }

db.unitOfWork<T>(companyId, work: (uow: UnitOfWork) => Promise<T>): Promise<T>;  // command handlers
db.requireUnitOfWork(companyId): UnitOfWork;                                       // write repositories
db.tenantTransaction<T>(companyId, work: (sql: SqlExecutor) => Promise<T>);        // reads
db.query(sql, values);                                                             // joins when a unit of work is open
outsideUnitOfWork(work);                                                           // the outbox relay only
```

| Behaviour | Guarantee |
| --- | --- |
| `unitOfWork`, none open | One pooled connection: `BEGIN`, `app.company_id` set for the transaction (row-level security), then `pg_advisory_xact_lock(363, hashtext(companyId))`. One write at a time per company, across every server process. |
| `unitOfWork`, same company already open | Joins under a `SAVEPOINT`. If `work` rejects, only its own writes are rolled back and the error is rethrown; the outer action decides what happens next. |
| Any call for a different company while one is open | Throws `PlatformError('TENANT_ISOLATION')` before touching the database. |
| `tenantTransaction` / `query` inside an open unit of work | Run on its connection. Nothing inside a unit of work takes a second connection, and reads see the action's own uncommitted writes. |
| `requireUnitOfWork`, none open | Throws `PlatformError('NO_UNIT_OF_WORK')`. |
| `work` resolves | `COMMIT`. If PostgreSQL answers `ROLLBACK` (an earlier statement failed and the error was swallowed), the call throws `UNIT_OF_WORK_ABORTED` and nothing is saved. |
| `work` rejects | `ROLLBACK`; the same error is rethrown. Outbox rows written by the action disappear with it. |
| After commit or rollback | `uow.sql` throws `UNIT_OF_WORK_ABORTED`. A timer or background task that kept a reference cannot use the connection. |
| Retries | **None.** The caller retries with the same idempotency key. A commit whose outcome is unknown is never re-run by the platform. |
| Waiting | A connection or the company lock not obtained within 15 seconds is an error, not a hang. |

## Writing a repository

```ts
class PostgresThingRepository {
  constructor(db: TransactionalExecutor) { ... }
  async insert(thing) { await this.db.requireUnitOfWork(thing.companyId).sql.query('INSERT …', [...]); }
  async findById(companyId, id) { return this.db.tenantTransaction(companyId, (sql) => …); }
}
```

- Every write goes through `requireUnitOfWork(companyId).sql`. A write outside a unit of work is a
  bug, and it throws instead of committing on its own.
- Reads use `tenantTransaction`.
- Do not catch a **database** error and carry on. PostgreSQL has already aborted the transaction (or
  the savepoint, if the failing call was a nested `unitOfWork`). Turn it into a domain error and
  rethrow.
- Do not run nested `unitOfWork` calls in parallel (`Promise.all`): savepoints nest, they do not
  interleave. Parallel reads on `tenantTransaction` are fine; the connection queues them.
- Do not call out (HTTP, a government portal, a message provider) inside a unit of work. The
  company lock is held. Enqueue instead.
- The module's audit event is written inside the unit of work, so it commits with the action.
  `PostgresAuditLog` (`packages/platform/src/postgres-audit.ts`) joins the open unit of work.
- Every tenant table has `company_id`, forced row-level security and the policy on
  `app.company_id` that `return_notes` and `outbox_messages` use.

## Outbox (`outbox_messages`)

| Column | Meaning |
| --- | --- |
| `id uuid`, `company_id uuid` (FK, RLS forced) | |
| `topic text` | e.g. `einvoice.generate`, `ewaybill.generate`, `notification.send`, `bank.fetch` |
| `dedupe_key text` | `UNIQUE (company_id, topic, dedupe_key)`. A repeated enqueue is a no-op. |
| `payload jsonb` | Ids and facts only. No secrets and no documents (the redaction rules of `platform-command-v1`). `bigint` values are stored as strings. |
| `attempts`, `available_at`, `claim_token` | Lease and back-off bookkeeping. |
| `sent_at` / `dead_at` / `last_error` | Delivered; given up after `maxAttempts` and waiting for a person; the last failure. Never both sent and dead. |

```ts
type OutboxHandler = (message: OutboxMessage, signal: AbortSignal) => Promise<void | ((uow: UnitOfWork) => Promise<void>)>;

new OutboxRelay(db, { leaseSeconds?: 60, maxAttempts?: 10 })
  .drain(companyId, handlers: Record<topic, OutboxHandler>, limit = 20): Promise<{ sent; failed }>
```

- A row is visible to the relay only once its transaction has committed. Nothing is ever sent for
  a rolled-back action.
- `drain` never joins the caller's transaction and never holds the company lock while a handler
  runs. Rows are claimed with `FOR UPDATE SKIP LOCKED`, a lease and a claim token; two relays never
  send the same row at the same time.
- The handler's `signal` aborts at half the lease. A handler must pass it to its HTTP call.
- A handler may return a `save` step (for example, storing the IRN). It runs in the same unit of
  work that marks the row sent, and only if this relay still holds the claim.
- Failure: `last_error` recorded, back-off of 30 s doubling to at most an hour, and `dead_at` set
  after `maxAttempts`. A dead row is never dropped; #364 and #345 raise it to a person.
- **At least once.** A crash after the handler succeeded but before the row was marked sent sends
  it again. Handlers must be idempotent on `dedupeKey`.
- **Order:** oldest due row first, with no head-of-line blocking. A message that depends on
  another is enqueued (through `save`) by the handler of the first.
- A topic with no handler in the call is left untouched.
- The scheduled worker that calls `drain` for every company is #345.

## Error codes

`NO_UNIT_OF_WORK`, `TENANT_ISOLATION`, `UNIT_OF_WORK_ABORTED` (all `PlatformError`), and
PostgreSQL errors rethrown unchanged after rollback.

## Contract tests

- `packages/platform/test/unit-of-work.integration.test.ts`, on real PostgreSQL: commit, rollback,
  joining under a savepoint, reads joining, the cross-company refusal, a write outside a unit of
  work, a swallowed database error caught at commit, a finished executor, the outbox dedupe, two
  relays, back-off and the dead state, and `save` committing with the sent mark.
- `packages/sales/test/record-sale.integration.test.ts`, the pilot: the process is killed after the
  ledger write and before the stock write and nothing is persisted; the IRN request is sent only
  after the sale commits.

## Changes to other contracts

- `sales.v1` — `ComplianceHookPort.onInvoiceFinalised` now runs **inside** the bill's transaction.
  An implementation must only enqueue; it must never call out.
- `ledger.v1` — `PostgresLedgerStore.transaction` opens or joins `db.unitOfWork`. `withSql` is for
  reads; `writeSql` requires the open unit of work.
