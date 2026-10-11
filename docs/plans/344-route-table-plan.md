# Handoff notes — read this first

This file is the working plan for the session that owns **#344, #357 and #358** (SaaS-readiness
programme, tracking issue #362). It is checked in so a fresh session can continue without the
original conversation. Delete it in the PR that closes #344.

## Where things stand
- Branch `feat/344-route-table`, cut from `main`. It holds one code commit: `zod` added to
  `package.json` and the lockfile. **No route has been converted yet.** Start at "Execution / PRs", step 1.
- Order of work: #344, then #357, then #358. One branch and PR per issue, each ending "Closes #N"
  with the issue's definition of done. Do not work on other issues.

## Decisions already made (do not re-ask the owner)
The owner is not technical: decide technical questions on the recommendation, ask only plain
business questions, and never change what the product does.
- **D4 — validation: Zod, at the HTTP boundary only.** `packages/*` stay free of it. ADR 0004 is in PR #373.
- **D7 — error tracker: not decided.** #358 ships an error-reporting port with a console adapter and a
  recording test adapter. **No Sentry** until D7 and hosting (#356) are settled (ADR 0007 is in PR #373 —
  check whether it has been accepted before the last step of #358).
- **Error statuses.** A plain `Error` (constructor is exactly `Error`, no `.code`) keeps returning **400 with
  its message**: about 88 throw sites in `packages/*` use it to tell the shopkeeper what went wrong, and
  `apps/api/test/catalogue.test.ts` asserts it. Anything unexpected (`TypeError`, `RangeError`,
  `SyntaxError`, fs/pg errors, a PDF that was not produced) returns a **generic 500** with the request id;
  the detail goes to the log, never to the caller. Migrating the 88 sites to `DomainError` is a follow-up, not #344.
- **GET routes** declare `signedIn(reason)` — today's behaviour. Tightening them is #343's job.
- **Schemas are lenient on purpose**: `z.object(fields).passthrough()`, fields optional where the service
  already answers a friendly 422. The web app sends `price: 10.5`, and `bills` as both `'[]'` and an array.
  When a field's type is unclear, use `z.unknown()` and say so in the PR; never guess stricter.
- **Pagination**: `cursor` + `limit` (default 200, max 500), offset cursor over the in-memory arrays, marked
  `ponytail:` — keyset once lists come from Postgres (#340/#366). The web app ignores `nextCursor` today.
- ops CLIs and demos print terminal reports, not logs: exempt from #357's `console.*` sweep (say so in the PR).

## Two PRs for #344
- **PR A** (this branch, draft is open): `routes/route.ts`, the dispatcher and error handling in `server.ts`,
  `docs/api-conventions.md`, and `routes/core.ts`. Routes not yet converted fall through to the old `if` chain.
- **PR B** (stacked on A): four parallel general-purpose subagents, each with `isolation: "worktree"`, convert
  one group file each — **sales, gst, purchasing, money** (contents listed under "Route groups" below). Then
  merge, delete the old chain, and change the tests.

## Test changes
- `apps/api/test/route-permissions.test.ts` reads `server.ts` as text with regexes, so it cannot survive the
  refactor. Rewrite it to enumerate the exported `ROUTES` table (stronger: every route, GET too, must declare
  access). Keep its three assertions' intent. Explain the change in the PR.
- Add `apps/api/test/route-table.test.ts` (cases listed under "Tests" below).
- Every other existing test stays unchanged and green. No test is edited to make it pass.

## Things a fresh session will trip over
- `handleApi(method, pathname, body, authorization, delivery)` is called by 30+ tests and by
  `apps/web/test/shop-words.test.ts`: keep the signature. Let `pathname` carry `?query`.
- #280: the permission gate must run **before** input validation, so a viewer with an empty body gets 403.
- `apps/web/server.ts` calls `serveApi`; session S4 (#349, headers and body limit) edits the same files —
  keep changes to routing, validation and errors, and rebase on `main` often.
- `apps/api/src/branding-application 2.ts` and `trade-mark-application 2.ts` are stray copies (#337's job). Leave them.
- Read `AGENTS.md` (Rule 0 and the migration rules) before starting. Run `npm run verify` before pushing.
- Before each PR: /code-review and /simplify; then the `run` skill and the browser to confirm sign-in, a sale,
  a print and the lists still work. At the end: comment on #344/#357/#358, summarise on #362, tell #343 that
  `ROUTES` is ready.

---

# #344 / #357 / #358 — route table, structured logs, error reporting

## Context
`apps/api/src/server.ts` serves ~137 routes from one `if` chain. POST permissions live in a separate map
(`POST_PERMISSIONS`); GETs declare nothing; input is coerced by hand inside handlers; lists are unbounded;
`statusOf` turns any unknown error into a 400 carrying its raw message. #343 needs an enumerable table to
generate permission tests from. Owner decisions taken in this session: **D4 = Zod at the boundary only**;
**D7 undecided** → #358 ships a port + console adapter, no Sentry.

## #344 design (branch `feat/344-route-table` from `origin/main`)

**`apps/api/src/routes/route.ts`** — the only way to declare a route:
```ts
interface Route { method: 'GET'|'POST'; path: string /* '/api/sales/:id/pdf' */;
  input: z.ZodType;            // POST: body, GET: query (+ body, for handleApi callers)
  access: Gate | Open;         // Gate = existing need()/needAny(); Open = public(reason) | signedIn(reason)
  handle(call): Promise<unknown | ApiResult> }
```
- `access` is required by the type; `need/needAny` move here unchanged. GETs get `signedIn('…')` (today's
  behaviour — services check internally); tightening GETs is #343/#327's job, and the table makes it a one-word change.
- Helpers: `body({...})` = `z.object(fields).passthrough()`; lenient primitives (`text`, `id`, `flag`, `anyJson`)
  because the UI sends e.g. `price: 10.5` and `bills: '[]'` vs arrays. Fields stay optional where the service
  already returns a friendly 422 for a missing value, so no test's status changes.
- `page(items, input)` + `paged` query fields (`cursor`, `limit` default 200, max 500): offset cursor, base64url.
  `ponytail:` keyset cursor once lists come from Postgres (#340/#366). Response adds `nextCursor`.

**Route groups** (one file each, no merge conflicts): `routes/core.ts` (auth, status, webhook, session, dashboard,
reports, operations, assistant, states, pincode, onboarding, trade-marks, branding, business details, catalogue,
customers/suppliers/items/delivery, migration), `routes/sales.ts` (sales, print/pdf, payments, presale, challans,
returns), `routes/gst.ts` (einvoices, eway, vehicles, itc, gst-returns), `routes/purchasing.ts` (supplier check,
PO, GRN, purchases), `routes/money.ts` (subscription, agent, reminders, bank-feeds).

**`server.ts` dispatcher** `handleApi(method, pathname, body, authorization, delivery)` keeps its signature
(30+ tests call it). `pathname` may carry `?query`. Order: request id → match (literal map, then `:param` routes)
→ 404 → authenticate (unless public) → permission gate → validate input (Zod → 400) → handler.
Exports `ROUTES` (for #343) and `POST_PERMISSIONS` derived from it (back-compat).

**Errors** — one shape `{state:'failed', title, code?, message, details?, requestId}`, `x-request-id` header on every reply:
- invalid JSON / non-object body / ZodError → 400 `INVALID_INPUT`, plain message naming fields, no stack.
- existing mappings for AuthenticationError, WebhookNotAuthenticated, DomainError, PlatformError kept.
- a bare `Error` (constructor === Error, no `.code`) stays 400 + its message: 88 package throw sites use it as the
  shopkeeper message (e.g. catalogue.test "no rate" expects 400). Follow-up chip: migrate them to DomainError.
- everything else (TypeError, RangeError, SyntaxError, fs/pg errors, PDF-not-produced) → 500
  "Something went wrong on our side. Nothing was saved. Quote <requestId> if you contact us."; detail to stderr
  (becomes the logger in #357).

**`docs/api-conventions.md`** — URL naming, error shape, status codes (400/401/403/404/409/422/429/500), Zod at the
boundary, cursor pagination, RequestContext from the session only, how to add a route.

**Dependency** — `zod` added to root `package.json` (`npm install zod`, `PUPPETEER_SKIP_DOWNLOAD=1`).

**Tests**
- `route-permissions.test.ts` parses server.ts source text with regexes — it must change: it will enumerate
  `ROUTES` instead (strictly stronger: every route, GET too, must declare access). Explained in the PR.
- New `apps/api/test/route-table.test.ts`: garbage JSON → 400 shape on every POST; wrong-type field → 400;
  thrown TypeError → 500 generic + requestId, message not leaked; every list route honours `limit`/`cursor`;
  unknown route 404; duplicate method+path impossible; cross-company id → 404 for one `:param` route.
- All other existing tests unchanged and green.

**Execution / PRs**
1. PR A (`feat/344-route-table`): I write route.ts, dispatcher, errors, docs, `routes/core.ts`; remaining routes
   temporarily served by the old chain behind the table. 
2. Four parallel general-purpose subagents (`isolation: worktree`), each converting one group file from the
   PR A branch, reading each handler to type its fields; I merge, delete the chain, rewrite route-permissions test
   → PR B (stacked on A). Both "Closes #344" on B, "Part of #344" on A.
3. /code-review + /simplify on each; `npm test` + `npm run lint`; `run` skill + built-in browser: sign in, make a
   sale, print, open lists.

## #357 (branch from #344's tip)
`apps/api/src/log.ts`: `log.{debug,info,warn,error}(message, fields)` writing one JSON line to stdout/stderr via
`SecureLogger`/`redactForLog` from `ops/security/src/logging.ts`; extend its `sensitiveKey` with pan, account
number, ifsc?, phone, email. Request id + company_id + user_id carried with `AsyncLocalStorage`, so package code
logging later needs no plumbing. One `request` access line per request (method, route pattern, status, ms).
Debug off when `NODE_ENV=production`. Replace `console.*` in `apps/api/src/server.ts`, `apps/web/server.ts`;
ops CLIs and demos are terminal reports, not logs — exempt, stated in PR. Test: one request's id finds its lines;
a body with `password` never appears in output.

## #358 (branch from #357's tip)
`apps/api/src/errors.ts` port `reportError(error, context)`; console adapter = `log.error` with stack and
ids only; test adapter records. 500 path and the recurring tick (`server.ts` `.catch(() => console.error(...))`)
report with detail. Review every catch listed in the sweep (apps/api demo-application ×10, apps/web/server.ts,
packages/* ×15, web app.js `.catch(() => {})`): fix the ones that swallow real faults (report or rethrow); keep
deliberate fallbacks but give each a one-line reason. `process.on('unhandledRejection'|'uncaughtException')` in the
API entrypoint reports. Sentry adapter not built (D7 open) — noted on #358.

## Verification
`npm test` green; `npm run lint` (tsc); manual `curl` of garbage JSON, a forced TypeError route in test; web app
end-to-end in the built-in browser; example log line pasted in #357 PR. Comment on #344/#357/#358, summary on
#362, notify #343 that `ROUTES` is ready; record D4 on #339.
