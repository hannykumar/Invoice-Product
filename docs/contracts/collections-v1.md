# Collections contract v1

Owner: GPT 2, issue #23. Inputs: receivables (#20), bank reconciliation (#22), delivery (#14) and notifications (#39).

## Promise

Collections helps an owner follow up on overdue customer invoices without turning a stale balance into a message. A reminder is first stored for review with its wording and balance snapshot. Immediately before delivery, the service reads receivables again. It cancels a settled reminder, cancels a reminder containing an open dispute, suppresses an opted-out channel, pauses for an active promise to pay, and rewrites the message after a partial payment.

Every attempted, suppressed or cancelled communication keeps:

- company, customer, channel, outcome and provider reference;
- the exact subject and message;
- invoice-level outstanding amounts, total outstanding and ageing at that moment;
- the actor, time and a plain-language failure or stop reason.

The original invoice and payment records are never edited by collections.

## Policy and escalation

The default policy offers a gentle reminder after one overdue day, a firmer email after 15 days and a final WhatsApp step after 30 days. The policy selects wording and channel; it never changes money. A company-scoped deduplication key makes retries return the existing scheduled reminder.

An open promise pauses delivery through its promised date. It becomes `KEPT` when the live balance falls by at least the promised amount and `BROKEN` only after the date passes without that payment. An open dispute stops reminders for its invoice until a recorded resolution.

## Notification boundary

`PlatformReminderNotificationAdapter` is the only route to a channel. It uses the published #39 notification service, so customer channel preferences, IANA-time-zone quiet hours, rate limits, tenant isolation, delivery events and provider failure handling apply unchanged. Email and in-app delivery are configured in the local application. WhatsApp remains a visible provider-not-configured failure until an authorised provider is installed.

## Permissions

- `collections.manage`: preferences, schedules, promises, disputes, review and history.
- `collections.send`: final preflight and delivery.
- The adapter additionally requires `notification.send`.

## HTTP surface

- `GET /api/collections` — reviewed schedules and communication history.
- `POST /api/collections/plan` — create one duplicate-safe review item.
- `POST /api/collections/send` — preflight and process due review items.
- `POST /api/collections/preferences` — opt-out, locale and disabled channels.
- `POST /api/collections/promises` — record a promise against the live balance.
- `POST /api/collections/disputes` — stop reminders for a named invoice with a reason.

All routes derive the company and permissions from the authenticated session.
