# Repository agent rules

## Database migrations

- Never invent or reuse a numeric migration ID. `0001` through `0008` are frozen identifiers already applied to databases.
- Before adding any new migration, run `npm run db:migration:id -- <module> <description>` and use the generated ID exactly.
- Keep the migration in its owning module's migration array. Do not rename or reorder an applied migration.
- Run `npm run verify` before pushing. The migration registry check must pass; do not bypass duplicate, format or ordering failures.

## Stack and layout (do not change without an owner decision)

- Node 22+ running `.ts` directly; no build step. `apps/api` (node:http), `apps/web` (vanilla JS),
  `packages/*` domain modules, `ops/*` service code and CLIs, `tools/*` scripts.
- One PostgreSQL database for books, jobs and rate limits; files in private object storage.
- Hosting DigitalOcean BLR1; login Supabase Auth (Mumbai); errors Sentry EU with ids only;
  payments Razorpay. Data stays in India; foreign vendors receive ids only.
- Architecture: `docs/architecture.md`. Decisions: `docs/decisions/` — read before adding a
  dependency, a vendor or a datastore; a new choice is a new decision record.
