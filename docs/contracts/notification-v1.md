# Notification contract v1

Owner: GPT 2 (#39). Consumers: all business modules.

Business modules schedule a notification using a tenant context, recipient role, channel, locale, sensitivity, template, payload, future delivery time and company-scoped deduplication key. They never call email, WhatsApp or SMS providers directly. Callers need `notification.send`; restricted content additionally needs `notification.sensitive.send`.

Preferences can disable a channel or define quiet hours in an IANA time zone such as `Asia/Kolkata`. Payload keys that look like credentials are recursively redacted before storage. Delivery attempts are rate-limited per company and channel; excess work remains scheduled. Each scheduled, suppressed, delivered, failed, retried and opened state produces an append-only delivery event with the actor and timestamp. Provider failure is visible and retryable and never changes the business record that caused the notification.

## Channel and role policy

| Sensitivity | Recipient roles | Channels |
| --- | --- | --- |
| Public | Owner, accountant, staff, customer | In-app, email, WhatsApp, SMS |
| Internal | Owner, accountant, staff | In-app, email |
| Restricted | Owner, accountant | In-app only |

`ChannelNotificationTransport` routes to replaceable adapters. In-app and email adapters are implemented. SMS and WhatsApp use the same transport contract and may be represented by `DeferredChannelAdapter` until a provider is configured; attempted delivery then becomes a visible, retryable failure. `NotificationTemplateRegistry` resolves an explicit template and locale and fails visibly when a translation is missing.

## Demonstration scenario

Schedule `gst_deadline` once for an owner with `recipientRole: "owner"`, `sensitivity: "internal"`, locale `en-IN`, and a company-scoped key such as `gst-deadline:2026-08-20`. Repeating the same business event returns the original notification. Delivery records `scheduled` then `delivered`; an unavailable provider records `failed`, and `retry` reschedules the same notification without creating a duplicate.

## Storage (issue #366)

Every `NotificationService` method that reads or writes a record returns a promise: `schedule`, `setPreference`, `retry`, `markOpened`, `eventsFor` and `get`, as `deliverDue` already did. The records live behind `NotificationStore`: `InMemoryNotificationStore` by default, or `PostgresNotificationStore` (`packages/platform/src/postgres-notifications.ts`), passed as the fourth constructor argument. One contract suite runs on both (`packages/platform/test/notification-store-contract.ts`).

- On PostgreSQL every write joins the caller's unit of work (`db.unitOfWork`); outside one it is refused with `NO_UNIT_OF_WORK`. Reads use `tenantTransaction`. All three tables force row-level security.
- Another company's notification is `NOT_FOUND`, exactly like a missing one (it was `TENANT_ISOLATION`): under row-level security the two cannot be told apart, and naming the other company would confirm the id exists.
- A `delivered` or `suppressed` notification is frozen in the database; the delivery timeline is append-only. Neither can be deleted.
- The rate-limit window is still counted in the server's memory, per process.
