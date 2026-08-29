# Invoice Product

A standalone, India-first accounting, inventory, GST-compliance and business-operations product
for MSMEs. It is meant to replace an ordinary billing tool, not to plug into one.

**Accuracy is the product promise.** AI may read documents, understand speech and answer
questions. AI never decides money or law. Every posting and every compliance conclusion comes
from deterministic, versioned, testable rules.

## Start here

| If you are | Read |
| --- | --- |
| New to the project | [`docs/product/README.md`](docs/product/README.md) — the canonical specification |
| Looking for a word's meaning | [`docs/product/01-glossary.md`](docs/product/01-glossary.md) |
| Looking for how a flow works | [`docs/product/02-workflows.md`](docs/product/02-workflows.md) |
| Wondering who owns an issue | [`docs/product/04-ownership.md`](docs/product/04-ownership.md) |
| Writing anything a person will read | [`docs/ux/README.md`](docs/ux/README.md) |
| Consuming another module | [`docs/contracts/README.md`](docs/contracts/README.md) |

## Packages

| Package | Issue | What it is |
| --- | --- | --- |
| [`packages/kernel`](packages/kernel) | #4 | Exact money, exact quantities, rounding, identifiers, dates, the error model |
| [`packages/ledger`](packages/ledger) | #4 | The double-entry ledger: the only write path into the books |
| [`packages/rules-engine`](packages/rules-engine) | #7 | Deterministic, effective-dated, versioned rules that return explainable decisions |
| [`packages/sales`](packages/sales) | #9 | The sales invoice lifecycle: draft, approval, numbering, posting, cancellation |
| [`packages/invoice-templates`](packages/invoice-templates) | #13 | Invoice templates and the rendering engine: A4, thermal, mobile, print |
| [`packages/gst-calc`](packages/gst-calc) | #25 | Deterministic GST computation, place of supply and tax classification |
| [`packages/compliance-register`](packages/compliance-register) | #54 | The official sources behind every compliance rule, and the gate that enforces them |
| [`packages/ux-vocabulary`](packages/ux-vocabulary) | #46 | The only supported way to produce user-facing wording |
| [`packages/platform`](packages/platform) | #2, #3, #6, #8, #21 | Tenancy, permissions, approvals, audit, connectors and banking import drafts |
| [`ops/security`](ops/security) | #40 | Encryption, privacy requests, secure logging, backups and restore drills |

## Quick start

```sh
npm run bootstrap
```

This one command starts the local PostgreSQL container, installs development dependencies, migrates, seeds synthetic data, and runs deterministic checks. Copy `.env.example` to `.env` before running it. No production credential is needed for development or tests. Stop the local database with `docker compose down`; use `docker compose down -v` only when you intentionally want to discard local development data.

## Architecture

- `apps/api`: HTTP composition root. It depends on platform contracts, never a provider SDK.
- `packages/platform`: tenancy, permissions, approvals, audit, idempotency, exceptions, migrations and external-connector contracts.
- `packages/kernel`, `packages/ledger`, `packages/rules-engine`, `packages/gst-calc`,
  `packages/sales`, `packages/ux-vocabulary`: GPT 1-owned modules.
- `docs/product`: the canonical product specification, glossary, workflows and ownership map (#1).
- `docs/ux`: the plain-language design system (#46).
- `packages/masters`: GPT 3-owned business master data (issue #5).
- `packages/purchasing`: GPT 3-owned purchase intake and validation (issue #15 onwards).
- `packages/gst`, `packages/transport`: GPT 3-owned modules (reserved).
- `docs/contracts`: versioned contracts shared across modules.

The production persistence target is PostgreSQL, with a transactional outbox for asynchronous work. The development store is deliberately in-memory so modules and connector mocks can be tested without services. Production adapter and storage wiring must preserve the contracts in `docs/contracts`.

## Commands

- `npm run verify` — deterministic type checks plus unit and integration tests.
- `npm run db:migrate`, `npm run db:rollback`, `npm run db:seed` — PostgreSQL migration lifecycle commands.
- `npm run db:migration:id -- <module> <description>` — generates a collision-resistant ID for a new migration.
- `npm run dev` — starts the API composition root once its route layer exists.
- `npm run web` — starts the responsive development preview at `http://127.0.0.1:4173`.
- `npm run demo:masters` — prints a walkthrough of master data with synthetic Indian-business samples.
- `npm run demo:inbox` — prints a walkthrough of the purchase inbox: routing, duplicates, quarantine and drafts.
- `npm run demo:invoice` — issues a real bill through the ledger and prints it on A4, thermal and mobile into `tmp/invoices/`.
- `npm run demo:validate` — prints a walkthrough of purchase validation: what posts, what needs a person and what is stopped.

## Type checking the deterministic modules

The shared `tsconfig.json` is owned by issue #2. `tsconfig.strict.json` extends it with the extra
checks the deterministic financial modules need — most importantly `erasableSyntaxOnly`, because
Node runs these packages by stripping types, so any TypeScript that cannot simply be erased would
fail at run time rather than at build time:

```sh
npx tsc --noEmit -p tsconfig.strict.json
```

## Collaboration rules

Do not import provider-specific code from business modules. Use `PlatformCommandService` for material changes and the connector contracts for external interactions. Each command carries authenticated tenant context and an idempotency key; callers never provide a tenant identifier to select arbitrary data.

Never choose the next numeric database migration ID by hand. The numeric `0001`–`0008` IDs are frozen compatibility identifiers and must not be renamed or reused. Every new migration must use `npm run db:migration:id -- <module> <description>` and paste the generated ID into its module-owned migration array. The timestamp, module name and random suffix allow GPT-1, GPT-2 and GPT-3 to create migrations concurrently. The combined registry sorts these IDs into one stable global order. Runtime validation and CI reject duplicate, malformed, out-of-order and newly invented numeric IDs before database SQL runs.
