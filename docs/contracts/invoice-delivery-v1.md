# Invoice delivery contract v1

Owner: GPT 2 (#14). Consumers: sales, invoice templates, web and communications.

`InvoiceDeliveryService` accepts only a final document's immutable invoice id. It has no sales or ledger dependency, so sending, a provider outage, a bounce or a retry can never change financial posting or create another invoice. The caller queues a recipient/channel attempt with a company-scoped idempotency key; replay returns the original attempt. A deliberate resend uses a new key and remains evidence against the same invoice.

Email, WhatsApp and SMS use the provider-neutral `DeliveryProvider` hook. Preferences can opt a recipient out by channel. Provider outcomes are appended as queued, sent, delivered, bounced, failed and retry-queued events. Failed attempts can be retried in place, retaining the audit history.

Document links are opaque bearer tokens stored only as hashes, resolve only while unexpired, and return the immutable invoice id rather than any mutable customer data. A server adapter must authorize the requester before rendering the document for that id.
