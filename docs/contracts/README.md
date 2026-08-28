# Shared platform contracts

Versioned platform contracts are the only integration point for business modules that need identity, approvals, audit/idempotency, exceptions, or external services. Contracts are intentionally provider-neutral and contain no GST, accounting or purchasing business rules.

- [`platform-command-v1.md`](platform-command-v1.md): authenticated tenant command envelope and outcome states.
- [`connector-v1.md`](connector-v1.md): external adapter lifecycle, normalized errors, and mock conformance expectations.

