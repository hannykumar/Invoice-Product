# ADR 0363 — One business action, one database transaction (unit of work + transactional outbox)

Status: **accepted** (issue #363). Affects #364, #365, #366, #367, #340, #345.
Contract for other modules: [`unit-of-work-v1`](../contracts/unit-of-work-v1.md).

**In plain words:** a bill is either saved completely, with its stock movement, its entry in the
books and its audit record, or it is not saved at all. Messages to the government, WhatsApp or
email go out only after the bill is safely saved. A crash can never leave half a bill behind, or
an e-invoice for a bill that does not exist.

## Context

Rule 1 and the Sale workflow (`docs/product/02-workflows.md`, step 9) say that ledger posting and
stock posting succeed or fail together.

- **In memory** this already holds. `InMemoryLedgerStore.transaction` snapshots every registered
  participant (sales, inventory, purchasing) and restores them all on failure, including when a
  nested call fails (#229).
- **On PostgreSQL** only the ledger has the machinery. `PostgresLedgerStore` keeps its open
  transaction in its own `AsyncLocalStorage`. A nested call joins it under a `SAVEPOINT` (#229),
  and `withSql` lets returns join it too.

The gaps:

1. **Nothing outside the ledger can join.** `createDatabase().query` and `tenantTransaction` each
   take a fresh pooled connection. A repository built on them commits on its own, and inside a
   ledger transaction it waits on a second connection. With 5 connections in the pool, enough of
   those waits deadlock silently: PostgreSQL sees only idle connections.
2. **Work after commit is lost on a crash.** `SalesService.finalise` writes `ledger.voucher_posted`
   and `sales.invoice_finalised`, and calls the e-invoice hook, *after* the commit. A crash in
   between loses the audit rows, and the e-invoice is never requested.
3. **Phantom audit rows.** The API's "Paid now" path runs `finalise` inside an outer transaction.
   If the receipt then fails, the bill rolls back but its in-memory audit events stay.
4. **Unsafe transaction handling.** `runTransaction` sends `ROLLBACK` on a dead socket, which
   hides the real error. It also returns broken clients to the pool, and never notices that
   PostgreSQL turned a `COMMIT` into a `ROLLBACK`.

## Decision

### 1. The platform owns the transaction; the ledger's #229 design moves into it

`createDatabase()` gains `unitOfWork(companyId, work)`, and it applies to everything:

- **Open:** take one pooled connection, `BEGIN`, set `app.company_id` (row-level security), then
  `pg_advisory_xact_lock(<namespace>, hashtext(companyId))`. That lock serialises one company's
  writes across every server process. The ledger's own lock is removed, because this one replaces
  it.
- **Same company, already open:** the call joins under a `SAVEPOINT`. A failure inside it rolls
  back only that part, exactly as the in-memory store restores its snapshot, so memory and
  PostgreSQL behave the same.
- **Different company, already open:** the call is refused with `TENANT_ISOLATION`. One action
  never touches two companies.
- **`query` and `tenantTransaction` join too.** Inside an open unit of work for the same company,
  they run on its connection. So **no code path inside a unit of work can take a second
  connection**: not `ledger.read()`, not a repository that has not been moved over yet. Reads see
  the action's own uncommitted writes.
- **Writes require an open unit of work.** A write repository calls
  `db.requireUnitOfWork(companyId)`, which throws `NO_UNIT_OF_WORK` when none is open. A write can
  no longer commit on its own because a caller forgot to open the transaction.
- **A closed unit of work cannot be used.** Its executor throws once it has committed or rolled
  back. A timer or a fire-and-forget task that kept a reference can never run a query on a
  connection that has gone back to the pool and may now belong to another company.
  `AsyncLocalStorage` treats a closed unit of work as "none open".
- **`COMMIT` is checked.** If PostgreSQL answers `COMMIT` with `ROLLBACK` (an earlier statement
  failed and the error was swallowed), the call throws `UNIT_OF_WORK_ABORTED`.
- **Failure handling:**
  - The rollback is attempted, and its own error is ignored, so the original error surfaces.
  - The connection is released *with* the error, so the pool discards it.
  - Every connection has a `connectionTimeoutMillis` and a `lock_timeout`, so a stuck pool or a
    held lock fails loudly instead of hanging.
- **No automatic retry.**
  - Under READ COMMITTED, `40001` does not occur for ordinary statements.
  - The company lock rules out deadlocks inside one company.
  - Re-running `work` is not safe in this codebase anyway: sales computes time stamps and
    reservations before the transaction, and some ports are still in memory.
  - A commit whose outcome is unknown (the connection dropped during `COMMIT`) must never be
    re-run blindly.

  The error reaches the caller, and the caller retries with the same idempotency key. Every write
  command already has one, and the ledger and sales already treat a repeated key as "already
  done".
- **Isolation level stays READ COMMITTED.** Correctness comes from the company lock, constraints
  and #367's row locks, not from SERIALIZABLE.

> ponytail: a single lock per company means one write at a time per company. That is plenty for an
> MSME with a few tills. Waiters hold a pooled connection while they wait. That is bounded by
> `lock_timeout`, not deadlocked, because the holder never needs a second connection. The upgrade,
> if a single company's write volume ever matters, is an in-process per-company queue before
> checkout and #367's row locks in a fixed order.

`PostgresLedgerStore.transaction` becomes `db.unitOfWork(...)`. Its own `AsyncLocalStorage`,
savepoint counter and advisory lock are deleted. `withSql` reads through `tenantTransaction`
(which joins); `writeSql` requires the open unit of work. `PostgresReturnNoteRepository` writes
through `writeSql`.

### 2. Transactional outbox

Anything that must reach outside the database after commit is written as a row in
`outbox_messages` by `uow.enqueue(...)`, inside the transaction. That covers IRN, e-way bill,
WhatsApp and email, and bank fetch. The row commits with the bill or disappears with it.

- **The table:** `company_id` foreign key, row-level security forced,
  `UNIQUE (company_id, topic, dedupe_key)`. Enqueuing the same message twice is a no-op.
- **`OutboxRelay.drain(companyId, handlers)`** runs on its own connection, never inside the
  caller's unit of work, and never takes the company lock.
  1. It claims due rows (`FOR UPDATE SKIP LOCKED`), gives each one a `claim_token` and a lease, and
     commits the claim.
  2. It calls the handler **outside** any transaction, with an `AbortSignal` that fires before the
     lease ends.
  3. In one unit of work it saves whatever the handler returned (for example, the IRN) and marks the
     row sent, but only `WHERE claim_token` still matches. A relay whose lease lapsed cannot
     overwrite one that took over.

  Two relays never send the same row at the same time.
- **Failure:** `attempts + 1`, exponential back-off, and `last_error` recorded. After
  `max_attempts` the row is marked `dead_at`. It stays visible, to be shown on the E-invoice screen
  and raised to the exception queue by #364 and #345. It is never silently dropped.
- **At least once.** A crash after the handler succeeded but before the row was marked sent sends
  it again. Handlers must be idempotent on `dedupe_key`. The e-invoice module (#26) already treats
  the portal's duplicate-IRN reply as success and fetches the existing IRN.
- **Order:** oldest due row first, with no head-of-line blocking. A message that depends on
  another (an e-way bill by IRN) is enqueued by the handler of the first one when it succeeds,
  rather than retried until its prerequisite lands.
- **Who drains, and when:** the scheduled worker is #345. Until then nothing drains in production,
  which is harmless: production is not on PostgreSQL until #340, and #340 needs #345.
  Cross-company discovery ("which companies have pending rows") needs either a role allowed to
  read across companies or a `SECURITY DEFINER` function that returns ids only. That choice is
  left to #368 (roles) and #345.

### 3. Pilot: record a sale

- `SalesService.finalise` moves `ledger.recordPosted` (skipped when the posting was
  deduplicated), its `sales.invoice_finalised` audit record and `compliance.onInvoiceFinalised`
  **inside** its transaction. The compliance port's contract changes: it must only enqueue, never
  call out, because it now runs while the company lock is held.
- `InMemoryAuditPort` becomes a transaction participant, and `company-shop` registers it, so a
  rolled-back sale leaves no phantom audit events in memory either.
- `PostgresAuditLog` writes the ledger's `AuditPort` events to `audit_events` through the open unit
  of work. #364 completes the platform's own audit and idempotency stores on the same footing.
- **Stand-in tables.** The pilot test proves the guarantee on real PostgreSQL. The bill and stock
  tables belong to #365, so the test creates two stand-in tables (`uow_pilot_*`) behind the real
  `SalesRepository` and `InventoryPort` interfaces. #365 replaces them, and the same assertions
  must keep passing.
- **The API.** The API still passes `noComplianceHooks` and requests the e-invoice through
  `startAutomaticEInvoice` after commit. Moving it onto the outbox is a composition change for
  #340. Until then the API runs in memory, where a crash loses everything anyway.

## Consequences

- One rule for every module: the command handler opens `db.unitOfWork`, and every repository joins
  it. #365's tables, #366's repositories and #367's locks are built on this.
- A slow government portal never holds a transaction or the company lock.
- Handlers carry the idempotency burden. This is stated in the contract and tested.

## Alternatives rejected

- **Pass an explicit `tx` argument through every port.** It would change every port signature in
  GPT 1's and GPT 3's lanes. `AsyncLocalStorage` with joining reads and required writes gives the
  same guarantee. It is also the pattern the ledger already uses (#229), so nothing new is
  introduced.
- **A flat join with no savepoint.** A JavaScript error caught by an outer caller would commit the
  inner half-writes, and PostgreSQL would disagree with memory.
- **An automatic retry loop on `40001`/`40P01`.** Close to dead code at READ COMMITTED with a
  company lock, and unsafe while `work` has effects outside the database.
- **SERIALIZABLE everywhere.** Retry storms under contention, and the outbox is still needed.
- **Calling the IRP after commit, fire-and-forget.** A crash after the commit loses the request, and
  nothing ever retries it.

Reviewed before implementation by an independent planning review. Its findings decided the
savepoint join, the joining reads, the closed-executor guard, the removal of retries, the
pool and lock timeouts, the outbox claim token and dead state, and the in-memory audit rollback.
