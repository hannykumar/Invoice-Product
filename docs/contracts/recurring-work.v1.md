# Recurring work host contract v1

| | |
| --- | --- |
| **Owner** | GPT 2, issue #122 |
| **Consumers** | Compliance calendar (#32), government calls (#33), notifications (#39), e-way bills (#27), collections (#23) |

The host calls `RecurringWorkRunner.runDue()` once a minute. Tests call the same method with a
virtual clock. The runner, rather than the host, owns schedule state, duplicate protection,
overlap protection, retry state and operator-visible outcomes.

## Registration

A host registers a job once per company with:

- a stable key and readable name;
- an interval of at least one minute;
- an explicit first-run instant, which allows each company's local morning to differ;
- an explicit service `RequestContext`, including actor, company, branch and permissions;
- maximum attempts, retry delay and timeout;
- an idempotent handler that accepts the schedule slot and an abort signal.

Registration fails when the service actor lacks `queue.replay` or any permission declared by the
job. No user session is captured and no implicit system trust is available.

## Delivery and recovery

Each company/job/schedule-slot combination is one `OperationalQueue` job. Duplicate ticks return
that job. A failed attempt is replayed through the queue after its retry delay and is dead-lettered
at the declared limit. An authorised operator may replay the failed queue job; the next tick picks
it up even when the ordinary next schedule is later.

Missed intervals coalesce to the latest due slot. A current compliance sweep is safer than
replaying stale sweeps that could send obsolete alerts. A running handler locks only its own
company/job pair. Timeout aborts cooperatively and records `RECURRING_JOB_TIMED_OUT`; the overlap
lock remains until the underlying promise actually settles, while every other job continues.

## Operator view

`GET /api/operations` returns recurring status scoped to the signed-in company: job name, last
scheduled/start/completion times, next run, duration, attempt count, outcome, safe summary and
error code. It never carries invoice, bank, GST, message or credential content.

## Standard catalogue

| Job | Interval | Required permission |
| --- | --- | --- |
| Compliance deadline morning sweep | daily | `compliance.calendar.refresh` |
| Government call reconciliation | hourly | `gsp.calls.reconcile` |
| Due notification delivery | every minute | `notification.send` |
| E-way-bill expiry watch | hourly | `eway.view` |
| Collection reminders | daily | `collections.reminders.send` |

The initial deployment is single-node. `recurring_work_status` and the operational queue carry
tenant keys, forced row-level security and composite tenant foreign keys so a later distributed
lease can be added without weakening isolation.
