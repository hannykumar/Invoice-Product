# D5 — Background jobs: our queue, persisted in Postgres

- **Status:** Accepted, 7 Oct 2026
- **Decision id:** D5 (tracking issue #362, recorded by #339)
- **Who chose:** Chosen by the agent on the recommendation; the owner did not evaluate it technically — revisit if a reason appears.
- **Product impact:** none. This changes how Karobar is built underneath, not what it does for the shopkeeper.

## Context

`ops/operations` already has an `OperationalQueue` (idempotency key `company:kind:key`, max
attempts, dead-letter, replay only for idempotent jobs) and a `RecurringWorkRunner` (no overlap,
retry, dead-letter after 3). Both are in memory, so jobs are lost on restart. Its Postgres tables
exist but nothing uses them. The 60-second tick only runs under `npm run dev`. Recurring jobs
poll **per company**, which at 1,000 companies is ~1.56 million runs a day doing nothing
(system design §7.5).

## Decision

- Back the existing queue with its existing Postgres tables. A **worker process** (same code,
  different entrypoint) claims jobs with `SELECT … FOR UPDATE SKIP LOCKED`.
- Jobs are enqueued **in the same transaction** as the business action that causes them
  (outbox; the unit-of-work ADR is #363's).
- Exponential backoff with jitter, max attempts, then dead-letter shown on the Operations screen.
- Every job idempotent; external calls carry the job's idempotency key.
- Recurring work becomes **one sweep per job kind** that selects companies with due work, not a
  timer per company.
- No external call and no PDF rendering inside a database transaction.

## Alternatives

- **pg-boss.** Mature, one dependency; we would bend our queue's semantics to it.
- **Redis + BullMQ.** Another service to run and secure, and it cannot share a transaction with
  the books — a job could exist for a bill that rolled back.

## Consequences

- No new service. Jobs survive deploys. Two workers can run at once safely.
- Postgres carries the job load too; fine at year-one volume (~28,000 useful jobs a day).
