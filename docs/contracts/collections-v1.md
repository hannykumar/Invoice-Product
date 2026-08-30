# Payment reminders and collection tracking contract v1

Owner: GPT 1, built for GPT 2's issue #23. Consumers: the web app, and any module that wants to
know whether a customer is being chased.

`packages/collections` decides **who should be reminded about which bill, at what strength, and
who must not be reminded at all**. It never posts to the ledger, never changes an invoice, and
never talks to a provider itself. Every figure it quotes is read back from receivables (#20) at
the moment it is quoted, and every message leaves through GPT 2's notification service (#39).

## The one rule the rest follows from

A reminder is a statement about money that is owed **right now**. So the outstanding amount is
never stored and re-used: it is recomputed from `ReceivablesService.position()` when the reminder
is planned, and **recomputed again at the moment of sending**. If the answer changed between the
two — the bill was paid, a dispute was raised, the customer opted out — the send is refused and
the reason is recorded. This is what makes "no reminder is sent for a settled or disputed
invoice" true rather than merely likely.

## Types

| Type | What it is |
| --- | --- |
| `ReminderPolicy` | Effective-dated ladder of steps, quiet hours, minimum gap, minimum amount, escalation thresholds |
| `ReminderStep` | `code`, `offsetDays` from the due date, `level`, `channels` in preference order |
| `ReminderLevel` | `ADVANCE` → `GENTLE` → `FIRM` → `FINAL` → `ESCALATE`. Tone only; never an accusation |
| `ContactPreference` | Per party and channel: enabled, plus a whole-party opt-out with a reason |
| `PromiseToPay` | Party, document, amount, promised date, note. Outcome is derived, not stored |
| `Dispute` | Party, optional document, reason, `OPEN` or `RESOLVED`. An open dispute silences the bill |
| `ReminderPlan` | Every open bill with either a `send` decision or a `skip` carrying a coded reason |
| `Reminder` | A scheduled or sent message with its balance snapshot, channel, level and delivery id |

## Skip reasons

`SETTLED`, `NOT_YET_DUE`, `NO_STEP_DUE`, `ALREADY_SENT`, `DISPUTED`, `PROMISED`, `OPTED_OUT`,
`QUIET_PERIOD`, `TOO_SOON`, `BELOW_MINIMUM`, `NO_CHANNEL`, `LADDER_EXHAUSTED`. Each carries an
`en-IN`/`hi-IN` sentence a shopkeeper can read. The owner sees skips as prominently as sends,
because "why did ABC not get a reminder?" is the question that follows.

## Duplicate prevention

A reminder's identity is `reminder:{documentId}:{stepCode}`, company-scoped. `schedule()` returns
the existing reminder for a repeated key rather than creating a second one, and the same key is
handed to the notification service as its deduplication key, so a duplicate cannot survive either
layer. A deliberate re-send is a different step or an explicit `resend`, and is new evidence.

## Promises and disputes

A promise to pay silences that bill until the promised date plus the policy's grace days. After
that the promise is **broken**, derived by comparing the promised amount against what receivables
still shows outstanding — no background job decides it. A broken promise raises the next
reminder's level by one. A kept promise (outstanding settled by the promised date) is visible in
the collection history and lowers nothing, because the bill is gone.

An open dispute silences the bill outright, at plan time and again at send time. Resolving the
dispute puts the bill back in the ladder at the step its ageing has reached.

## Escalation

Past the last step of the ladder, or above the escalation amount, the customer stops receiving
messages and the **owner** receives an internal notification instead. Chasing harder is a person's
decision, so the product stops and says so rather than sending a sixth message.

## Ports

| Port | Real implementation |
| --- | --- |
| `ReceivablesPositionPort` | `receivablesPositions(ReceivablesService)` — the real #20 service |
| `ReminderTransport` | `notificationReminderTransport(NotificationService)` — the real #39 service |
| `PartyContactPort` | Supplied by the host: a party's display name and reachable channels |
| `ReminderRepository` | `InMemoryReminderRepository`; a durable one replaces it unchanged |

Customer-facing reminders are scheduled as `public` sensitivity to the `customer` role, which is
the only combination #39 allows on WhatsApp and SMS. Owner escalations are `internal` to the
`owner` role, which #39 restricts to in-app and email. The policy table is theirs; this module
does not widen it.

## Permissions

`collections.reminders.view`, `collections.reminders.send`, `collections.promise.record`,
`collections.dispute.manage`. Tenancy comes from the actor's company, never from an argument.
