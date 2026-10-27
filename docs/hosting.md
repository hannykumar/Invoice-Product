# Hosting: the settings every server needs

Started by #350 so the hosting work (#356, DigitalOcean BLR1 per ADR D3) cannot miss what sign-in and
rate limiting require. #356 owns the full runbook (container, staging, rollback); add to this file
rather than starting another. `.env.example` lists the same settings for a developer's machine.

Every process that serves requests or runs jobs reads them: the API (`apps/api/src/server.ts`), the
web server (`apps/web/server.ts`) and the worker (`apps/api/src/worker.ts`). Each refuses to start
with a plain message when a required one is missing, rather than running half-configured.

| Setting | Required | What it is | If it is missing |
| --- | --- | --- | --- |
| `NODE_ENV` | Yes | `production` on a real server, `staging` on staging. Only `development` or `test` allow the demo sign-in and in-memory books. | With a database set: refuses to start (#446). |
| `DATABASE_URL` | Yes | PostgreSQL, as a login that is a member of `invoice_app` (least privilege, #368). | Refuses to start outside development (#340). |
| `SUPABASE_URL` | Yes | Supabase Auth project in Mumbai (`ap-south-1`), `https://` (ADR D1). Asymmetric JWT signing keys turned on. | Refuses to start outside development (#342). |
| `SUPABASE_ANON_KEY` | Yes | Supabase's publishable key; sign-in codes are sent and checked by the server, never the browser. | Refuses to start when `SUPABASE_URL` is set (#342). |
| `KAROBAR_RATE_LIMIT_SECRET` | Yes | At least 32 random characters, **the same on every server and worker**. Rate-limit counters are keyed with it, so the table holds no readable phone number or IP address (#350). | Refuses to start outside development. Changing it starts every count again. |
| `KAROBAR_TRUSTED_PROXY` | Behind a load balancer | `1` when a load balancer or proxy sits in front: the client's address is then taken from the last `X-Forwarded-For` hop. Leave unset when clients connect directly — otherwise a client could choose its own address. | Every customer looks like the load balancer and shares one set of sign-in limits; production logs a warning at start (#350). |
| `KAROBAR_PUBLIC_ORIGINS` | Behind a proxy | The site's own addresses (`https://…`, comma separated) for the cross-site write check (#349). | Writes from the page may be refused as cross-site when the proxy rewrites `Host`. |

## Before the first customer

- Supabase: Mumbai project, asymmetric signing keys, the email code template (`{{ .Token }}`), and the
  SMS hook to a DLT-registered Indian SMS provider. TRAI DLT registration is the business's own step.
- Generate `KAROBAR_RATE_LIMIT_SECRET` once (for example `openssl rand -base64 48`) and keep it in the
  platform's secret store, never in the repository.
- Check the daily spending caps and per-call cost estimates in `packages/platform/src/rate-limits.ts`
  against the vendors' first invoices.
