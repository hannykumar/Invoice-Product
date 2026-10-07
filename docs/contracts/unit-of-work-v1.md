# Unit of work v1

Owner: GPT 2 (#363). Extends [`platform-command-v1`](./platform-command-v1.md). Consumers: every
module that writes to PostgreSQL. Named consumers: #364, #365, #366 and #367 (repositories,
tables and locks), #340 (runtime composition) and #345 (outbox worker).
Design and reasoning: [ADR 0363](../decisions/0363-unit-of-work-and-outbox.md).

## The rule

**One business action is one database transaction.** The command handler opens it. Every
repository the handler touches joins it: document, ledger, inventory, idempotency, command
record, audit and outbox. Repositories never open a write transaction of their own.

## API (`packages/platform/src/unit-of-work.ts`, exported from `@invoice/platform`)

```ts
interface UnitOfWork {
  readonly companyId: string;
  readonly sql: SqlExecutor;                         // this transaction's connection
  enqueue(message: OutboxMessageInput): Promise<void>;
  afterCommit(callback: () => void | Promise<void>): void;
}
interface OutboxMessageInput { topic: string; dedupeKey: string; payload: Record<string, unknown>; }

db.unitOfWork<T>(companyId: string, work: (uow: UnitOfWork) => Promise<T>): Promise<T>;
currentUnitOfWork(): UnitOfWork | undefined;
requireUnitOfWork(companyId: string): UnitOfWork;  // throws NO_UNIT_OF_WORK / TENANT_ISOLATION
```

| Behaviour | Guarantee |
| --- | --- |
| Open | One pooled connection: `BEGIN`, then `app.company_id` set for the transaction (row-level security), then `pg_advisory_xact_lock(hashtext(companyId))`. |
| Same company, already open | `work` runs on the open transaction. No new connection, no savepoint, no retry of its own. |
| Different company, already open | Throws `PlatformError('TENANT_ISOLATION')` before touching the database. |
| `work` resolves | `COMMIT`. If PostgreSQL answers `ROLLBACK` (an earlier statement failed and the error was swallowed), the call throws `UNIT_OF_WORK_ABORTED`. |
| `work` rejects | `ROLLBACK`. The same error is rethrown. Outbox rows and `afterCommit` callbacks from this attempt are discarded. |
| `40001` / `40P01` (outermost unit of work only) | Rolled back and `work` re-run. At most 3 attempts. `work` must therefore have no effect outside the database except through `enqueue` or `afterCommit`. |
| After `COMMIT` | `afterCommit` callbacks run in order. A callback's failure is logged and never undoes the commit. |

## Writing a repository

```ts
class PostgresThingRepository {
  constructor(db: TransactionalExecutor) { ... }
  async insert(thing) { await requireUnitOfWork(thing.companyId).sql.query('INSERT …', [...]); }
  async findById(companyId, id) { return this.db.tenantTransaction(companyId, (sql) => …); } // joins if open
}
```

- Every write goes through `requireUnitOfWork(companyId).sql`. A write outside a unit of work is a
  bug, and it throws instead of committing on its own.
- Reads use `tenantTransaction`. Inside an open unit of work for the same company it joins, so a
  read sees the action's own uncommitted writes and never takes a second connection.
- Do not catch a database error and carry on inside a unit of work. PostgreSQL has already aborted
  the transaction. Turn the error into a domain error and rethrow it. If the error is swallowed,
  `COMMIT` returns `ROLLBACK`, which surfaces as `UNIT_OF_WORK_ABORTED`.
- Do not start parallel queries on `uow.sql` (`Promise.all`). One connection runs one statement at
  a time.

## Outbox (`outbox_messages`)

| Column | Meaning |
| --- | --- |
| `id uuid`, `company_id uuid` (FK, RLS forced) | |
| `topic text` | e.g. `einvoice.generate`, `ewaybill.generate`, `notification.send`, `bank.fetch` |
| `dedupe_key text` | `UNIQUE (company_id, topic, dedupe_key)`. A retried enqueue is a no-op. |
| `payload jsonb` | Ids and facts only. No secrets and no documents (the redaction rules of `platform-command-v1`). |
| `available_at`, `attempts`, `sent_at`, `last_error`, `created_at` | Lease and back-off bookkeeping. |

```ts
new OutboxRelay(db, { leaseSeconds?: 60, maxAttempts?: 10 })
  .drain(companyId, handlers: Record<topic, (message) => Promise<void>>, limit?): Promise<{ sent; failed }>
```

- A row is visible to the relay only once its transaction has committed. Nothing is ever sent for
  a rolled-back action.
- Claimed rows are leased with `FOR UPDATE SKIP LOCKED` and the claim commits. The handler runs
  **outside** any transaction and without the company lock. The row is then marked sent, or
  `last_error` is recorded with exponential back-off. After `maxAttempts` the row stays unsent with
  `last_error` set, for the exception queue (#364) and the worker (#345) to raise.
- **At least once.** A crash after the handler succeeds but before the row is marked sent resends
  the message when the lease expires. Handlers must be idempotent on `dedupeKey`.
- **Order:** oldest due row first, with no head-of-line blocking. A handler that needs an earlier
  message to have landed throws, and is retried.
- A topic with no handler is left untouched for a relay that has one.

## Error codes

`NO_UNIT_OF_WORK`, `TENANT_ISOLATION`, `UNIT_OF_WORK_ABORTED`, and PostgreSQL errors rethrown
unchanged after rollback.

## Contract tests

- `packages/platform/test/unit-of-work.integration.test.ts` runs against real PostgreSQL. It
  covers commit, rollback, joining, the cross-company refusal, a swallowed error detected at
  commit, a retry on a serialization failure, the outbox dedupe, relay leasing across two relays,
  and back-off.
- `packages/sales/test/record-sale.integration.test.ts` is the pilot. It kills the process after
  the ledger write and before the stock write, and asserts nothing persisted. It also shows that
  the IRN request is sent only after the sale commits.

## Pilot changes outside the platform

- `SalesService.finalise` writes its audit record and calls `ComplianceHookPort.onInvoiceFinalised`
  **inside** the transaction. That port must now only enqueue, never call out.
- `PostgresLedgerStore.transaction` opens or joins `db.unitOfWork`.
- `PostgresReturnNoteRepository` writes through the open unit of work.
