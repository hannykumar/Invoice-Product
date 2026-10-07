# SaaS readiness plan

How Karobar goes from "a correct accounting engine with a demo server" to "a SaaS a shopkeeper can
trust with their books". Built from the 15-layer playbook (`vibe-coding-real-saas-playbook.pdf`):
every workstream below names the playbook prompt it adapts (e.g. **P4b**), rewritten for this
repository's stack, rules and naming. **Security is the priority**: it is pulled forward to sit
straight after the foundation, and nothing goes live until its gate passes.

Status as of 2026-10-07. Owner sign-off needed on section 2 before Phase 2 starts.

---

## 1. Where we stand

The domain layer is ahead of the playbook: double-entry ledger, paise/bigint money, idempotency,
tenant context from the session, cross-company 404, signed webhooks, release gates, e2e tests
against real Postgres in CI. The **running product is not**:

| Finding | Evidence | Why it matters |
| --- | --- | --- |
| Every company's data lives in process memory | `apps/api/src/runtime.ts:117` holds a `Map` of `DemoApplication`; that wires 12 `InMemory*Repository` stores. Only `ledger` and `returns` have Postgres adapters | A restart loses every bill. Cannot run two instances |
| Users are hard-coded; no signup, verification or reset | `runtime.ts:123-140`, default password `karobar-demo` | Not a product anyone can sign up to |
| Passwords hashed with one unsalted SHA-256 | `runtime.ts:18` | Cracked instantly if ever leaked |
| Sessions and job queue in memory | `packages/platform/src/auth.ts:24`, `ops/operations` | Logged out on every deploy; jobs lost |
| Session token in `localStorage` | `apps/web/app.js:650` | Any XSS steals the session |
| No rate limiting anywhere, including login | — | Brute-force and abuse are free |
| No security headers (CSP, HSTS, frame, nosniff) | `apps/web/server.ts:35`, `apps/api/src/server.ts` | Clickjacking, weaker XSS defence |
| Unbounded request body | `apps/api/src/server.ts` `readBody` | One large POST exhausts memory |
| Unknown errors return their raw message as 400 | `server.ts` `statusOf` default + catch | Leaks internals; hides real 500s |
| Plain `console.log`, no request id, no error tracker | `server.ts:306` | Cannot debug production |
| No deploy, no environments, no env validation | no Dockerfile / hosting docs | Nothing to ship to |
| Hand-written validation; 137 routes in one `if` chain; no pagination | `apps/api/src/server.ts` | Inconsistent input handling |
| 5 tracked + ~83 untracked `"… 2.ts"` duplicate files | `git ls-files \| grep ' [0-9]\.'` | Noise; risk of editing the wrong copy |

Already good and to be **kept, not rebuilt**: `packages/platform` permissions and
`RequestContext`, `ops/security` (AES-256-GCM, log redaction, privacy export/delete, restore
runbook), `npm audit` in CI, row-level security helper `tenantTransaction`, `release-gates`.

---

## 2. Decisions the owner must make (with recommendations)

The playbook is explicit that these are yours, not the agent's. Recommendation in bold.

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | Login identity | Managed provider (Clerk / Auth0 / Supabase Auth) vs. own accounts on `node:crypto` scrypt | **Managed provider with phone-OTP + email** — shopkeepers log in by phone, and OTP/SMS/reset/MFA are exactly what P4a says not to hand-roll. Our `platform` keeps company membership and permissions. Fallback if data residency or cost rules it out: own accounts with scrypt, DB sessions, OTP via #8 messaging adapter |
| D2 | Session transport | Bearer token in `localStorage` vs. `HttpOnly; Secure; SameSite` cookie | **Cookie** + Origin check on every state-changing request (removes the XSS-steals-session risk) |
| D3 | Hosting | Managed platform vs. AWS/GCP | **Managed platform with an India region** (e.g. DigitalOcean Bangalore, Fly.io Mumbai, AWS Mumbai via a managed service) + managed Postgres with point-in-time recovery. Confirm region availability when choosing |
| D4 | Input validation | Zod (1 dependency) vs. own validator in `kernel` | **Zod** at the HTTP boundary only — 137 routes is too many to hand-validate consistently |
| D5 | Background jobs | pg-boss vs. own Postgres table with `FOR UPDATE SKIP LOCKED` | **Persist the existing `ops/operations` queue in Postgres** (no new service, keeps its semantics) |
| D6 | Rate-limit / cache store | Redis vs. Postgres | **Postgres** until load tests say otherwise (shared across instances, no new infra) |
| D7 | Error tracking & logs | Sentry / Better Stack / platform logs | **Sentry** (errors) + platform log drain; no personal data attached |
| D8 | Year-one scale & SLO | — | Owner to state: target companies, bills/day, uptime (suggest 99.5% to start) |
| D9 | Pricing & payments | Razorpay vs. other | **Razorpay**, webhooks as source of truth (#42 subscriptions already models plans) |
| D10 | Compliance | DPDP Act 2023, GST record retention (8 years) | Owner + legal to confirm retention periods; code never invents them |
| D11 | External pen test | Before go-live / later | **Before the first paying customer** — we hold financial data |
| D12 | Offline billing and sync (#317) | Server-only numbering vs. device number blocks | **Decide now, build later**: device-generated ids, invoice-number blocks reserved per device, sync conflicts to the exception queue. Phase 2 schema and numbering must follow it |
| D13 | Data residency (DPDP Act 2023) | — | **Books, documents and backups in India**; foreign vendors (identity, error tracking, email) receive ids only |

D1 note: SMS OTP in India needs TRAI DLT sender-id and template registration — an owner action.

---

## 3. How every task is run (playbook Part 0)

1. **Plan first** — the agent proposes in plan mode, the owner reviews.
2. Small branch, small commits naming the issue, PR into the default branch.
3. **Definition of done** (P0.4, required in every PR description):
   - `npm run verify` output shown (typecheck, tests, integration, gates).
   - Every file changed and why.
   - Anything skipped, stubbed, mocked or hard-coded.
   - Assumptions the owner must confirm.
   - No failing or skipped test is ever called "done"; no test is edited to make it pass (P8b).
4. Security-relevant PRs get a **second, fresh reviewer** (a new session or reviewer subagent) — P10b.
5. Record each decision as an ADR in `docs/decisions/NNNN-title.md` (P2b).

---

## 4. The plan

Seven phases in the playbook's order, security moved up. Each workstream: what to do, the adapted
prompt to hand an agent, and the **Verify** checks that must pass. Owning lane in brackets
(G1 = GPT 1, G2 = GPT 2, G3 = GPT 3) per `CLAUDE.md`.

### Phase 0 — Clean house (½ day) [any]

- Delete the duplicate `"… 2.ts"` / `"… 2.md"` files (diff each against its original first;
  keep any that hold unmerged work).
- Add to `CLAUDE.md` and `AGENTS.md` the playbook's missing sections: **Stack** (do not change
  without asking), **Commands**, **Rules** (every endpoint: validation, auth, authz, tests; every
  DB change a migration; ask before a dependency), and a pointer to `docs/decisions/`.

**Verify:** `git ls-files | grep ' [0-9]\.'` is empty; `npm run verify` green.

### Phase 1 — Plan: system design & architecture (2–3 days) [G2 + owner]

**1a — System design (adapts P1a, P1b, P1c).**
> Don't write code. Read `docs/product/`, `CLAUDE.md` and `docs/gpt3-handbook.md`. Interview me,
> one group at a time, on: roles (owner, accountant, staff, viewer, CA with many companies),
> the five core workflows (sell, buy, pay/collect, GST return, stock), tenancy (one login, many
> companies), data sensitivity (GSTIN, PAN, bank, invoices), year-one scale, plans and billing,
> DPDP and GST retention, integrations (GSP/IRP, banks, WhatsApp). Then write
> `docs/system-design.md`: problem, roles, flows, functional and non-functional requirements,
> **out of scope**, open questions. Then, as a sceptical staff engineer, list missing
> requirements, scaling and security risks ranked by severity, and a back-of-envelope estimate of
> peak requests/sec, DB size, file storage and job volume with the math shown. Name the first
> bottleneck.

**1b — Architecture and ADRs (adapts P2a, P2b).**
> From `docs/system-design.md`, write `docs/architecture.md` for the modular monolith we already
> have: a Mermaid component diagram (web, API, Postgres, object storage, job worker, GSP/IRP,
> bank, messaging, identity provider), the stack per layer with one rejected alternative, the
> folder structure as it is, where background jobs run, third-party services with cost at our
> scale, and the three riskiest decisions. Then one ADR per decision in section 2 of
> `docs/saas-readiness-plan.md`. Do not create code.

**Verify:** tenancy model and out-of-scope list are written down; every box in the diagram can
be explained by the owner; every dependency in `package.json` has a stated reason.

### Phase 2 — Foundation: database, auth, permissions, APIs (3–4 weeks) [G2, with G1/G3 for their repositories]

This is the largest phase and the one everything else depends on.

**Foundation review (7 Oct 2026).** Moving to Postgres is not "swap each in-memory store". The
product's rules — a sale's bill, ledger entry and stock move together; numbers are unique;
stock never goes negative; posted records never change — hold today only because everything runs
in one process. On Postgres with two servers each rule must be enforced again by the database.
Findings: the ledger adapter opens its own transaction per operation
(`packages/ledger/src/adapters/postgres.ts:233`); the audit log, idempotency keys, command
records, exception queue and members are in memory (`packages/platform/src/platform.ts:27-84`);
there are **no tables** for sales bills, stock movements, payments, advances, challans or
quotations; most existing tables have no code writing to them; only the ledger enforces
immutability in the database. So 2a is done in this order:

| Order | Issue | What |
| --- | --- | --- |
| 1 | #363 | Unit of work: one business action = one transaction; transactional outbox for IRN/e-way/messages. **Blocks the rest** |
| 2 | #364 | Platform core in Postgres: audit, idempotency, command records, exceptions, members, sessions |
| 3 | #365 | New tables: sales, stock movements, payments/allocations, advances, challans, quotations |
| 4 | #366 | Postgres repositories for every module, by lane |
| 5 | #367 | Concurrency on Postgres: numbering, last-item stock, double-submit, allocations — tested with parallel connections on two processes |
| 6 | #368 | Database-enforced immutability, append-only audit, least-privilege app role, no fallback DB URL in production |
| 7 | #340 | Switch the running app to Postgres; separate demo composition from production |

**2a — Persist every store (adapts P3a, P3b).**
> For each `InMemory*Repository` wired in `apps/api/src/demo-application.ts`, add a Postgres
> repository beside it following `packages/ledger/src/adapters/postgres.ts` and
> `packages/returns/src/postgres-repository.ts`. Rules: every tenant table has `company_id NOT
> NULL` with a foreign key and row-level security; every table has `id uuid`, `created_at`,
> `updated_at`; soft delete only where a user may recover (never on posted records — they are
> immutable); an index on every foreign key and every filtered/sorted column; constraints in the
> database, not app code; money `bigint` paise. All access goes through `tenantTransaction`. Each
> change is a new migration (`npm run db:migration:id`). Run the same repository contract tests
> against memory and Postgres. Then switch `runtime.ts` to Postgres when `DATABASE_URL` is set,
> keep memory only for tests and demos. Extend `packages/platform/src/seed.ts` to two companies ×
> three users with realistic synthetic data (`syntheticGstin()`).

**2b — File storage (adapts P3c).** Purchase-inbox attachments, PDFs and branding images go to a
private object store via pre-signed upload, type and size checked server-side
(`packages/purchasing/src/safety.ts` already has the rules), keys scoped by `company_id`,
downloads only via short-lived signed URLs after a permission check. Tests: wrong type, too large,
other company's file.

**2c — Authentication (adapts P4a; depends on D1, D2).**
> Replace the hard-coded credentials in `apps/api/src/runtime.ts` with [the chosen provider].
> Do not hand-roll hashing or sessions. Include signup, phone-OTP and email login, verification,
> reset, logout, expiry and revocation. Sessions live in Postgres (or the provider) so a restart
> keeps users logged in. Move the session to an `HttpOnly; Secure; SameSite=Lax` cookie and remove
> it from `localStorage`. Every route except `/api/auth/*`, `/api/status`, `/api/health*` and
> signed webhooks requires a session. The middleware attaches `RequestContext` — company and
> actor from the session, never from the request body. Delete the demo credentials from the
> production path.

**2d — Authorization (adapts P4b, P4c, P4d).**
> Write `docs/permissions.md` as a role × action matrix generated from `packages/platform`'s
> permission list (Owner, Admin, Accountant, Staff, Viewer, and a CA invited to many companies).
> Confirm every route goes through the one central check. Then generate integration tests **from
> the matrix** for every one of the 137 routes: no session → 401; missing permission → 403;
> another company's id → 404; each role can do exactly what the matrix says. Team features:
> invite, accept, change role, remove (sessions revoked immediately), transfer ownership, leave;
> the last owner cannot leave; invites expire in 7 days (already in `auth.ts`).

**2e — API conventions (adapts P5a, P5b).**
> Write `docs/api-conventions.md`: URL naming, one error shape (we have `{state, title, code,
> message}` — keep it), Zod validation of every body at the boundary, cursor pagination on every
> list, how `RequestContext` is read, status codes (400 invalid, 401, 403, 404, 409, 422, 429,
> 500). Replace the `if` chain in `apps/api/src/server.ts` with a route table where each entry
> declares method, path, schema and permission, so a route cannot be added without them. Unknown
> errors return **500** with a generic message and a request id; the detail goes to the log.

**2f — Background jobs (adapts P5c; D5).** Persist the `ops/operations` queue in Postgres; run the
recurring tick (`server.ts:306`) and GSP/IRP/messaging calls in a separate worker process. Every
job idempotent, exponential backoff, max attempts, failures visible on the Operations screen
(already exists).

**2g — Payments (adapts P5d; D9). Moved to Phase 4 (#346)** — not foundation; a pilot can be invoiced by hand. Razorpay subscriptions behind #42: signature-verified webhooks
are the source of truth, processed event ids stored, one `hasFeature(company, feature)` helper,
tests replay every event twice. Test-mode keys only.

**Verify (playbook 3, 4, 5):** restart the server — data and sessions survive; log in as company
A, change an id to company B's — 404; a Viewer calling a write route directly — 403; garbage JSON
— clean 400 in our error shape, no stack trace; replay a webhook twice — no duplicate; no file
contains custom password hashing; restore a backup into a separate database at least once.

### Phase 3 — Security hardening (2 weeks) [G2] — **the main gate**

Runs as soon as 2c–2e land. Nothing is deployed to production until every check below passes.

**3a — Threat model (adapts P10a).**
> Extend the threat model in `ops/security/README.md` into `docs/security/threat-model.md`. List
> assets (books, GSTIN/PAN, bank details, invoices, GSP credentials in the vault, sessions),
> every entry point (all API routes, uploads, government and payment webhooks, WhatsApp/email
> intake, CSV/Excel import, the voice assistant), and for each the relevant OWASP Top 10 threats
> with likelihood, impact, mitigations present and missing.

**3b — Security review, before every release (adapts P10b).** Run in a fresh session or reviewer
subagent; report only, file + line + severity + exploit + fix; then fix in separate PRs:
> Audit for: missing company scoping; unsafe raw SQL; XSS in `apps/web/app.js` (every
> `innerHTML` and template string); CSRF on state-changing routes once cookies are in; open
> redirect and SSRF (any server fetch of a user-supplied URL, e.g. intake links); insecure
> uploads, including spreadsheet formula injection in exports; zip/PDF bombs in intake; secrets
> or personal data in logs; missing security headers; verbose errors; cookie flags.

**3c — Fixes we already know are needed.**
- Security headers on both servers: `Content-Security-Policy` (no inline script), HSTS,
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
  `Permissions-Policy`.
- Request body limit (e.g. 1 MB JSON; uploads go direct to storage per 2b) and request timeouts.
- CSRF: `SameSite` cookie + `Origin`/`Host` check on every non-GET.
- Generic 500 for unknown errors (from 2e).
- Login response identical for "no such user" and "wrong password" (already true — keep a test).

**3d — Rate limiting (adapts P11a, P11b, P11c; D6).**
> Implement rate limiting with a Postgres-backed counter so it works across instances and
> survives deploys. Limits: login, OTP, signup, reset — 5 per 15 min per IP **and** per phone or
> email; OTP sends capped per number per day (SMS costs money); expensive routes (PDF, GST
> return prepare/export, e-invoice and e-way calls, OCR intake, voice assistant) — N per minute
> per company, by plan; general API — N per minute per user; unauthenticated — N per minute per
> IP. Return 429 with `Retry-After` in our error shape. Limits configurable per plan. Paid
> calls (OCR, LLM, GSP, SMS) get per-company daily/monthly quotas stored in the DB, a global
> spending cap that turns the feature off, and an alert at 80%. Tests exceed every limit.
> Then review abuse: signup spam, invite and OTP flooding, enumeration, webhook flooding.

**3e — Secrets and dependencies (adapts P7a, P10c, P6d).** gitleaks in a pre-commit hook and in
CI; scan full git history and report; Dependabot for npm and GitHub Actions; keep `npm audit` in
CI; confirm no secret reaches `apps/web` (only public config is served).

**3f — Data protection (adapts P10d).** Wire `ops/security` into the real app: encrypt bank
account numbers, GSP credentials and PAN at rest; the log redactor on every log line; account
deletion and data export through the existing privacy module, respecting GST retention (D10);
a privacy policy and terms published (playbook 16).

**Verify (playbook 10, 11):** paste `<script>alert(1)</script>` into every text field — nothing
runs; a loop of 20 logins is blocked, and still blocked after a redeploy; search logs for
"password", tokens, GSTIN-with-bank — zero; security headers present on every response
(`curl -I`); review run by a session that did not write the code; external pen test booked (D11).

### Phase 4 — Ship: frontend, CI/CD, testing, hosting (2–3 weeks) [G2 for CI/hosting, G1 for frontend]

**4a — Frontend states and accessibility (adapts P6a–P6c).**
> Inventory the base pieces `apps/web` already repeats (button, input, table, modal, toast,
> empty, error, skeleton) and add a `/design` page showing each in every state. Every
> data-driven screen handles loading, empty (helpful message + next action), error (message +
> retry) and success. Forms: client validation mirroring the server schema, submit disabled
> while pending, inline errors. Works at 375 px. WCAG 2.1 AA pass and an automated axe check.

**4b — CI (adapts P7b).** Already strong. Add: gitleaks, Dependabot, a build step, the
generated authorization tests (2d), a coverage report on business logic (target 70–80%),
branch protection requiring CI on the default branch.

**4c — Testing (adapts P8a–P8d).**
> Write `docs/testing.md`: unit for domain packages; integration for every route against real
> Postgres; Playwright end-to-end for signup, login, make a bill, record a purchase, prepare a
> GST return, upgrade plan, invite a teammate; only external providers are mocked — never our
> database or our permission checks. Then review the suite critically: tests that would pass if
> the feature broke, tests that only assert on mocks, skipped tests, flaky tests. Bugs are fixed
> test-first (P8c): failing test shown, then the fix.

**4d — Hosting and environments (adapts P9a–P9c, P7c; D3).**
> Write `docs/hosting.md`: provider, plan and monthly cost for web/API, worker, Postgres, object
> storage, email/SMS, at launch and at 10×. Add a Dockerfile, `.env.example` with every
> variable explained, and **startup validation that refuses to start** on a missing or malformed
> variable. Separate local, staging and production — different databases and keys. Bind
> `0.0.0.0` behind the platform's TLS, custom domain, HTTPS, graceful shutdown on SIGTERM.
> CD: preview per PR, merge → staging automatically, production behind manual approval,
> migrations run before new code and fail the deploy if they fail. Write
> `docs/runbooks/deploy.md` and `docs/runbooks/rollback.md`.

**Verify (playbook 6–9):** a PR with a failing test is blocked; removing a required env var stops
startup with a clear message; staging and production use different databases and keys; billing
alerts set on every provider; a rollback practised once; the app used end to end with only a
keyboard and on a real phone; turning off the network shows a sensible error on every screen.

### Phase 5 — Operate: error tracking, logs, monitoring (1–2 weeks) [G2]

**5a — Structured logging (adapts P13a).** Replace `console.*` with a JSON logger (levels; debug
off in production) built on `ops/security/src/logging.ts` redaction. Every request gets an id,
returned as `x-request-id` and on every line with `company_id` and `user_id`.

**5b — Error tracking (adapts P13b, P13c; D7).** Sentry on API, worker and web; ids only, no
personal data; source maps uploaded, not served; staging and production separated; a
staging-only route that throws. Remove empty or swallowing `catch` blocks (e.g. the recurring tick
in `server.ts`) — every error is handled or reported, users see friendly words.

**5c — Health and monitoring (adapts P14a–P14d).** `/api/health/live` (process up) and
`/api/health` (Postgres, object store, job queue, with timeouts, per-component status).
`docs/monitoring.md`: uptime on home, login, health and "make a bill"; error rate, p95 per
route, DB connections, queue depth and failures, GSP/IRP failure rate; business metrics
(signups, active companies, bills issued, failed payments, e-invoice failures near the 30-day
limit). Alert only on what needs a human; each alert links a runbook in `docs/runbooks/`.
`docs/runbooks/incident.md` and a simple public status page.

**Verify (playbook 13, 14):** an error in staging reaches Sentry in under a minute with a
readable stack; a request id finds every log line for that request; stopping staging's database
alerts within the agreed time; every alert has a runbook.

### Phase 6 — Caching and scaling (after launch traffic, ~1 week) [G2]

**6a — Caching (adapts P12a–P12c).** Write `docs/caching.md`. Keep `no-store` on every
authenticated response (already true). Static assets: content-hashed names and long
`Cache-Control` via a CDN. Application caching only for proven-slow reads (reports, HSN/rate
lookups, GSP master data), keys always include `company_id`, invalidated on write, tests that two
companies never see each other's cached data. Compliance rules are effective-dated — cache by
version, never by "latest".

**6b — Scaling (adapts P15a–P15d).** k6 load tests for login, make a bill, record a purchase,
reports and GST return prepare against staging; report p50/p95/p99 and the breaking point.
Readiness review: stateless instances (true after Phase 2), connection pooling, `EXPLAIN` on top
queries, heavy work in the worker, every list paginated. Fix the measured bottleneck only, with
before/after numbers. Cost at 10× and 100×.

**Verify (playbook 12, 15):** two instances run at once without breakage; two users from
different companies in two browsers never see each other's data; a load-test result with real
numbers; every optimisation has before/after.

### Phase 7 — The rest (playbook 16), as needed

Transactional email/SMS with SPF/DKIM/DMARC; product analytics; feature flags; an internal admin
with audit log (support grants exist in `/api/operations/support-grants`); onboarding with sample
data (#onboarding exists); Hindi and regional languages (partly done); a tested disaster-recovery
plan for "provider down" and "data deleted".

---

## 5. Pre-launch gate (playbook Appendix B)

No paying customer until every box is ticked:

- [ ] One business action commits as one transaction; a crash mid-way leaves nothing (#363)
- [ ] Unique gap-free numbers and non-negative stock under parallel load on two servers (#367)
- [ ] Posted records and audit cannot be changed even with the app's DB access (#368)
- [ ] Cross-company access tested and blocked on every route (generated tests, 2d)
- [ ] Login via a proven provider; no custom password handling (2c)
- [ ] Every route validates input and checks permission on the server (2e)
- [ ] Payments driven by verified, idempotent webhooks (2g)
- [ ] CI blocks merges on failure; production deploy has a practised rollback (4b, 4d)
- [ ] Critical flows covered by Playwright end-to-end tests (4c)
- [ ] Separate staging and production environments and databases (4d)
- [ ] Backups on and a restore actually tested (2a, `ops/security/restore-runbook.md`)
- [ ] Security review by a fresh reviewer done; dependencies audited; pen test done (Phase 3)
- [ ] Rate limits on login, OTP, signup and expensive routes (3d)
- [ ] No company data cached at a shared layer (6a)
- [ ] Errors reach Sentry; logs structured and redacted (5a, 5b)
- [ ] Uptime checks and alerts, each with a runbook (5c)
- [ ] Load tested at expected launch traffic (6b)
- [ ] Billing alerts on every provider (4d)
- [ ] Terms of service and privacy policy published (3f)

## 6. Rough timeline

| Phase | Effort | Can start |
| --- | --- | --- |
| 0 Clean house | ½ day | now |
| 1 System design & architecture | 2–3 days | now |
| 2 Foundation | 5–7 weeks | after section 2 decisions; #363 first |
| 3 Security | 2 weeks | as 2c–2e land |
| 4 Ship | 2–3 weeks | 4a/4b in parallel with 2; 4d after 2 |
| 5 Operate | 1–2 weeks | with 4d |
| 6 Cache & scale | ~1 week | after staging has traffic |

Roughly **10–14 weeks** to the pre-launch gate with the three agents working in parallel. New
features should pause until Phase 3 passes — the playbook's order exists because each layer is
built on the one before it. **Correctness bugs are not features and continue** (accuracy is the
product).

## 7. Issue map

Tracking issue: **#362**. Phase 0: #337. Phase 1: #338, #339. Phase 2: #363 → #364, #365 →
#366 → #367, #368 → #340; then #341, #342, #344 → #343, #345. Phase 3: #347–#352. Phase 4: #346,
#353–#356. Phase 5: #357–#359. Phase 6: #360, #361.
