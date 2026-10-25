# Connector contract v1.1

Owner: GPT 2. Consumers: GPT 1 and GPT 3.

Business modules call `ExternalConnector.execute` using a typed provider-neutral operation, tenant context, correlation ID and idempotency key. Connectors return a provider request ID and normalized outcome or throw `ConnectorError` with retryability. Credentials are only resolved by a `CredentialVault`; raw secrets are neither accepted in commands nor emitted in audit/log payloads.

`ConnectorGateway` is the required operational boundary: it resolves an opaque tenant-scoped credential reference, retries only normalized retryable failures with the same idempotency key, opens a per-tenant/per-connector circuit after repeated exhausted failures, and exposes provider health without passing provider SDKs into business modules. A webhook verifier authenticates the provider callback before `ConnectorGateway.receiveWebhook` deduplicates its event ID.

Every mock and reference adapter must satisfy the same contract tests: successful request, duplicate idempotency key, timeout/outage normalization, retry/circuit behavior, webhook authentication and deduplication, tenant-scoped credential access, and secret redaction.

## Webhook verification (v1.1, issue #389)

Additive; nothing existing changed meaning.

- **`HmacWebhookVerifier`** is the verifier for any callback that reaches a running server. The
  provider signs `x-provider-signature: t=<unix seconds>,v1=<hex HMAC-SHA256>`, the HMAC taken with
  that provider's own secret over `<t>.<raw body>`. Signatures are compared in constant time; a
  timestamp more than `WEBHOOK_TOLERANCE_SECONDS` (300) from our clock, either way, is refused;
  several `v1=` values and several secrets are accepted so a secret can be rotated. A real
  provider's header is mapped onto this by its adapter (#51). `signWebhook` builds the header for
  tests and mocks.
- **`WebhookSigningSecrets.webhookSecrets(kind)`** supplies each provider's secrets. A connector
  with none refuses every callback.
- **`parseConnectorWebhook`** is the schema every verified body must pass before anything reads it:
  non-empty `eventId` and `providerRequestId` of at most 200 characters, an ISO `occurredAt`, an
  object `payload`. Anything else is `ConnectorError("INVALID_REQUEST")`.
- **`StaticWebhookVerifier`** (the literal `test-signature`) throws when constructed outside
  `NODE_ENV` development or test, so a server cannot start with it. **`NoWebhooksVerifier`** is for
  a gateway that only makes calls: it refuses every callback.
- `ConnectorGateway`'s own seen-events set is a per-process first line, capped at 10 000 entries.
  Durable deduplication belongs to the receiver's repository (for government callbacks,
  `government_webhook_events` with its unique `(connector, event_id)`).
