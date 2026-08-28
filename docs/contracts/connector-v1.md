# Connector contract v1

Owner: GPT 2. Consumers: GPT 1 and GPT 3.

Business modules call `ExternalConnector.execute` using a typed provider-neutral operation, tenant context, correlation ID and idempotency key. Connectors return a provider request ID and normalized outcome or throw `ConnectorError` with retryability. Credentials are only resolved by a `CredentialVault`; raw secrets are neither accepted in commands nor emitted in audit/log payloads.

`ConnectorGateway` is the required operational boundary: it resolves an opaque tenant-scoped credential reference, retries only normalized retryable failures with the same idempotency key, opens a per-tenant/per-connector circuit after repeated exhausted failures, and exposes provider health without passing provider SDKs into business modules. A webhook verifier authenticates the provider callback before `ConnectorGateway.receiveWebhook` deduplicates its event ID.

Every mock and reference adapter must satisfy the same contract tests: successful request, duplicate idempotency key, timeout/outage normalization, retry/circuit behavior, webhook authentication and deduplication, tenant-scoped credential access, and secret redaction.
