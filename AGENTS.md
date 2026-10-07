# Repository agent rules

## Stack — do not change without asking the owner

- TypeScript run directly by Node (>= 22.18) type-stripping. No build step, no bundler.
  `tsconfig` sets `erasableSyntaxOnly`: no enums, no parameter properties.
- npm workspaces: `apps/*` (API server, browser workspace), `packages/*` (domain modules),
  `ops/*` (operational tooling). Shared contracts live in `docs/contracts/`.
- PostgreSQL 16 through `pg`; the local database comes from `compose.yaml`.
- The browser workspace is plain JavaScript, HTML and CSS served by `apps/web/server.ts`.
- Tests use `node:test`.
- Money is `bigint` paise, quantities `bigint` micro-units, rates basis points. No floats.

## Commands

```sh
npm run bootstrap    # first run: database up, install, migrate, seed, verify
npm run dev          # API server
npm run web          # browser workspace
npm test             # unit tests, no database needed
npm run verify       # typecheck + tests + integration tests + release gates (what CI runs)
npm run db:migrate   # apply migrations (needs DATABASE_URL)
npm run db:seed      # load synthetic demo data
```

## Rules

- Every API endpoint has input validation, authentication, a server-side permission check, and
  tests. Tenancy comes from the session, never from a company id in the request.
- Every database change is a migration (see below).
- Ask the owner before adding a dependency.
- One concern per pull request. Small commits, each naming its issue. Never push to `main`.
- Decisions are recorded as ADRs in `docs/decisions/NNNN-title.md`.

## Database migrations

- Never invent or reuse a numeric migration ID. `0001` through `0008` are frozen identifiers already applied to databases.
- Before adding any new migration, run `npm run db:migration:id -- <module> <description>` and use the generated ID exactly.
- Keep the migration in its owning module's migration array. Do not rename or reorder an applied migration.
- Run `npm run verify` before pushing. The migration registry check must pass; do not bypass duplicate, format or ordering failures.
