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
  payments Razorpay. What we store stays in India (see decision 0013 for providers).
- The product is defined by `docs/gpt1-handbook.md`, `docs/gpt2-handbook.md`, `docs/gpt3-handbook.md`,
  `CLAUDE.md` and `docs/product/`. Architecture and decision records may not narrow it.
- Architecture: `docs/architecture.md`. Decisions: `docs/decisions/` — read before adding a
  dependency, a vendor or a datastore; a new choice is a new decision record.
