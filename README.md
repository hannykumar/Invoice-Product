# Invoice Product

India-first accounting, inventory, GST-compliance and business-operations software for MSMEs.

## Quick start

```sh
npm run bootstrap
```

This command installs development dependencies and runs deterministic type checks and platform tests. Copy `.env.example` to `.env` only when a local service needs configuration; no production credential is needed for development or tests.

## Architecture

- `apps/api`: HTTP composition root. It depends on platform contracts, never a provider SDK.
- `packages/platform`: tenancy, permissions, approvals, audit, idempotency, exceptions, migrations and external-connector contracts.
- `packages/accounting`, `packages/sales`: GPT 1-owned modules (reserved).
- `packages/purchasing`, `packages/gst`, `packages/transport`: GPT 3-owned modules (reserved).
- `docs/contracts`: versioned contracts shared across modules.

The production persistence target is PostgreSQL, with a transactional outbox for asynchronous work. The development store is deliberately in-memory so modules and connector mocks can be tested without services. Production adapter and storage wiring must preserve the contracts in `docs/contracts`.

## Commands

- `npm run verify` — deterministic type checks plus unit and integration tests.
- `npm run db:migrate`, `npm run db:rollback`, `npm run db:seed` — migration lifecycle commands (currently documented dry-run scaffolds pending PostgreSQL wiring).
- `npm run dev` — starts the API composition root once its route layer exists.

## Collaboration rules

Do not import provider-specific code from business modules. Use `PlatformCommandService` for material changes and the connector contracts for external interactions. Each command carries authenticated tenant context and an idempotency key; callers never provide a tenant identifier to select arbitrary data.

