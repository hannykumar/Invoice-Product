# Notification contract v1

Owner: GPT 2 (#39). Consumers: all business modules.

Business modules schedule a notification using a tenant context, recipient, channel, locale, template, payload, future delivery time and company-scoped deduplication key. They never call email, WhatsApp or SMS providers directly.

Preferences can disable a channel or define quiet hours. Payload keys that look like credentials are redacted before storage. Delivery attempts are rate-limited per company and channel; excess work remains scheduled. Each scheduled, suppressed, delivered, failed, retried and opened state produces an append-only delivery event. Provider failure is visible and retryable and never changes the business record that caused the notification.
