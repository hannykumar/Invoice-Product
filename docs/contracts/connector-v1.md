# Connector contract v1

Owner: GPT 2. Consumers: GPT 1 and GPT 3.

Business modules call `ExternalConnector.execute` using a typed provider-neutral operation, tenant context, correlation ID and idempotency key. Connectors return a provider request ID and normalized outcome or throw `ConnectorError` with retryability. Credentials are only resolved by a `CredentialVault`; raw secrets are neither accepted in commands nor emitted in audit/log payloads.

Every mock and reference adapter must satisfy the same contract tests: successful request, duplicate idempotency key, timeout/outage normalization, tenant-scoped credential access, and secret redaction.

