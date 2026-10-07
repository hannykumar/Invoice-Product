# System design

Who uses Karobar, what it must do, how well it must do it, how big it gets in year one, and what
it will not do. Written for issue #338 from an interview with the owner on 7 Oct 2026. Product
rules and workflows are not repeated here; they live in [`docs/product/`](product/README.md) and
[`CLAUDE.md`](../CLAUDE.md). How the system is built is in `docs/architecture.md` (#339). Each
owner decision is recorded as an ADR in `docs/decisions/`.

Owner decisions recorded here: **D8** (year-one scale and uptime) and **D10** (retention, pending
legal confirmation).

**How to read the choices in this document.** The owner answered business questions — who uses
the product, how many shops in year one, how long records are kept. Technical choices (login
provider, hosting, queues, encryption, numbering) were **chosen by the agent on the
recommendation**; the owner did not evaluate them technically and they are to be revisited if a
reason appears. Nothing here changes what the product does for the shopkeeper: the eight rules,
the supported scope and the out-of-scope list in
[`00-principles-and-scope.md`](product/00-principles-and-scope.md) stand exactly as written. This
document only says how the product is run as a service underneath.

---

## 1. Problem statement

Indian micro and small businesses — a grocery counter, a mandi wholesaler, a bakery, a CA's
practice — keep books in Tally, BUSY, Vyapar or a notebook. Those tools either assume the user
knows accounting or let them make GST mistakes silently. Karobar replaces them: one product for
billing, purchases, payments, stock and GST, usable by a shopkeeper who has never studied
accounting, and **correct by construction** (balanced double-entry, deterministic GST rules,
immutable posted records).

The domain engine exists and is well tested. The **running product does not yet exist as a
SaaS**: every company's data lives in process memory, users are hard-coded, and there is no
hosting, sign-up, rate limiting or monitoring (see `docs/saas-readiness-plan.md` §1). This
document states what the SaaS has to be so the foundation work (#363–#368, #340–#345) builds the
right thing once.

---

## 2. Users and roles

One person has **one login** (phone number or email). A login is a **member** of any number of
companies, with **one role per company**. Roles are named bundles of the existing permission list
in `packages/platform/src/types.ts` (118 permissions; there are no roles in code today — #342
adds them).

| Role | Who, in a shop's words | Can | Cannot |
| --- | --- | --- | --- |
| **Owner** | The business owner | Everything, including billing the subscription, inviting and removing people, transferring ownership, closing the company | Leave if they are the last owner |
| **Admin** | A trusted manager | Everything except subscription billing, ownership transfer and closing the company | — |
| **Accountant** | In-house accountant, or the outside CA | Books, GST returns, reconciliation, reports, approvals of accounting entries | Change members or subscription |
| **Staff** | Counter or godown staff | Make bills, record purchases and payments, stock movements, all as drafts or within approval thresholds | Approve their own risky actions, see reports marked sensitive, file returns |
| **Viewer** | A partner, an investor, a bank officer | Read dashboards and reports | Change anything |

**The CA who serves many clients** is not a separate role. The CA is an ordinary login invited
into each client company, usually as Accountant. What makes it work for them:

- a **company switcher** listing every company they belong to;
- the business **owns** its company and pays for it; the CA never does at launch;
- the owner can remove the CA at any time, and every session of the CA in that company is revoked
  at once (`packages/platform/src/auth.ts` already revokes on removal);
- the company is chosen in the session, never sent by the browser (rule 6).

A CA-paid "practice" plan is out of scope at launch (§8).

---

## 3. Tenancy model

```
login (person) ──< membership (role) >── company ──< branch ──< warehouse
                                            │            └── number series (per branch, per FY)
                                            └── subscription (one per company)
```

- **Company is the isolation boundary.** Every tenant row carries `company_id NOT NULL`, every
  tenant table has row-level security keyed on `app.company_id`, and every query runs inside
  `tenantTransaction` (`packages/platform/src/database.ts`). A request for another company's
  record returns **404**, not 403, so existence is not leaked.
- **The active company comes from the session.** Switching company is a server call that checks
  membership and rewrites the session's company; the browser never supplies a company id that the
  server trusts.
- **Branches** live inside a company: own invoice number series, own godowns, same books. A role
  applies to the whole company at launch; restricting a user to one branch is out of scope (§8).
- **One subscription per company** (owner's choice). A person who owns three companies pays for
  three. *Conflict to resolve:* `packages/subscriptions` today meters `companies` per plan, which
  implies one subscription covering several companies (§9, Q1).
- **Devices** (for offline billing, D12) belong to a company and a branch, are registered by an
  Owner or Admin, and get their own number series. See the D12 ADR.

---

## 4. Core workflows at launch

All five core workflows must be live for the first paying customer, on real persisted data. Step
by step detail and owning modules are in [`docs/product/02-workflows.md`](product/02-workflows.md);
this table is the launch cut.

| Workflow | Live at launch | Not at launch |
| --- | --- | --- |
| **Sell** | Quotation → bill → PDF → share by the user's own WhatsApp (the existing `wa.me` link) or email; credit notes; returns; branch series | Offline billing (decided in D12, built later under #317) |
| **Buy** | Inbox (upload, camera, email; WhatsApp intake once a WhatsApp provider is chosen), OCR draft with confidence, validation, duplicate block, PO/GRN matching, posting, debit notes | — |
| **Pay / collect** | Receipts and payments in every mode, allocation, cheques, advances, reminders by email or a WhatsApp share link the user taps, bank statement import (CSV/PDF/XLSX) and reconciliation | Live bank feeds (account aggregator / bank APIs); initiating payments (never) |
| **GST return** | GSTR-1 and GSTR-3B prepared from the books, GSTR-2B/IMS import and ITC reconciliation, **manual JSON export** for upload to the portal | Live filing through a GSP |
| **Stock** | Movements, transfers, adjustments with reasons, batches, valuation, no negative stock | — |

**Government integrations** (e-invoice IRN, e-way bill, returns) launch on **offline JSON**: the
product builds the government JSON and the user uploads it on the portal, then records the IRN or
e-way number back. Live GSP calls switch on behind the existing adapter (`connector-v1`) once #50
has chosen a GSP; the WhiteBooks sandbox adapter already exists and stays a sandbox until then.

**Messaging:** bills and reminders are shared from the user's own WhatsApp through the click-to-chat
link the app already builds (`apps/web/done-screen.js`), or by email from an India-hosted
provider; SMS only for login OTP. All behind `notification-v1`. Sending automatically through the
WhatsApp Business API was asked for in the interview, but that service is run by Meta outside
India, so customers' phone numbers and bills would leave India — against the residency rule
(D13). The safer, simpler option is taken for launch; the Business API is a later business
decision, flagged on #362, and slots in behind the same adapter without changing any screen.

---

## 5. Functional requirements (SaaS layer)

The domain functions are specified in `docs/product/` and `docs/contracts/`. The SaaS layer must
add:

1. **Sign-up and sign-in** by phone OTP or email, through a managed identity provider in India
   (D1). Verification, recovery, logout, session expiry and revocation. No password handling in
   our code.
2. **Company lifecycle:** create (with onboarding, #36), invite with expiring links (7 days),
   accept, change role, remove (sessions revoked at once), transfer ownership, leave, close.
3. **Server-side permission check on every route**, from one table that declares method, path,
   input schema and permission (#344/#343).
4. **Persistence of everything** in Postgres: a restart or deploy loses nothing, and two API
   instances can run at once (#363–#368, #340).
5. **Files** (supplier bills, statements, logos) in private object storage, uploaded and
   downloaded through short-lived signed URLs after a permission check, keyed by company.
6. **Background work** (sending messages, reminders, e-invoice retries, expiry watches, OCR) in a
   separate worker process, from a Postgres-backed queue; every job idempotent (D5).
7. **Subscriptions** per company, monthly or yearly, with a 14-day trial; Razorpay later (D9,
   #346); a lapsed company becomes **read-only with full export**, never locked out of its own
   books.
8. **Privacy rights** (DPDP Act 2023): data export, correction, and deletion of personal data
   where the law allows — books inside the retention period are kept, the requester's personal
   data in them is minimised. Consent recorded (`ops/security/privacy.ts` exists; #55 publishes
   the notice).
9. **Audit trail** of every command, append-only, readable by Owner and Accountant.
10. **Operations screen** for failed jobs, replays and support grants (exists; must read the
    persisted queue).

---

## 6. Non-functional requirements

### 6.1 Performance

| Action | Target (server time, measured at the API) |
| --- | --- |
| Make a bill, record a purchase, record a payment, open any list (paginated) | **p95 < 500 ms** |
| Reports, GST return preparation, reconciliation | **< 3 s**, or run as a background job with progress shown |
| Bill PDF ready to share | < 3 s |
| Page usable on a ₹8,000 Android phone on 4G | First load < 3 s; works at 375 px |

### 6.2 Availability and recovery (D8)

- **Uptime 99.5%** per calendar month (about 3.6 hours of downtime allowed), measured by an
  external check on sign-in and "make a bill". One region; no multi-region.
- **RPO ≤ 5 minutes** (managed Postgres point-in-time recovery). **RTO ≤ 4 hours** (restore into
  a new cluster, repoint the app). *Proposed; owner to confirm (§9, Q3).*
- Deploys without downtime for ordinary releases; migrations that need downtime are announced.
- Government portal, GSP, WhatsApp or OCR outages never stop billing: the bill is final and
  correct in the books, the external step shows a retryable state (rule 5, `connector-v1`).

### 6.3 Security

- Tenancy as §3; permissions as §2, enforced server-side on every route.
- Session in an `HttpOnly; Secure; SameSite=Lax` cookie with an Origin check on every non-GET
  (D2). No token in `localStorage`.
- Input validated at the HTTP boundary (D4); request body limit; generic 500 with a request id for
  unknown errors.
- Rate limits on sign-in, OTP, sign-up and expensive routes, shared across instances (D6); OTP
  sends capped per number per day.
- **Field-level encryption** (AES-256-GCM, `ops/security/encryption.ts`) for bank account
  numbers, PAN, GSP and vendor credentials. GSTIN, names and invoices are protected by
  disk encryption, row-level security and access control — GSTIN is public, and encrypting names
  would break search.
- No personal data in logs or in the error tracker: ids only, through `redactForLog` (D7).
- External penetration test **before the first paying customer** (D11).

### 6.4 Data sensitivity

| Data | Sensitivity | Where it may go |
| --- | --- | --- |
| Books, invoices, vouchers, stock | Confidential business data | India only (D13) |
| Bank account numbers, PAN | Personal / financial | India only, encrypted per field |
| GSP, bank and vendor credentials | Secret | India only, encrypted, never logged |
| Phone numbers, emails, names, addresses of users and parties | Personal data (DPDP) | India only (D13) |
| GSTIN | Public identifier, but with bank details it is sensitive | India only when joined to anything else |
| Session ids, request ids, company/user ids | Internal identifiers | May go to foreign vendors (Sentry EU) |

### 6.5 Data residency (D13)

Books, documents, backups, sessions and the identity store stay in an **India region**. A vendor
outside India receives **ids only** — never names, phone numbers, GSTIN with bank details or
invoice contents. There is no exception at launch: a bill shared over WhatsApp leaves from the
user's own phone, not from our servers, and email goes through an India-hosted provider. Reading supplier bills (OCR) sends the bill's contents to
the reader, so the OCR provider must run in India too; none is chosen yet (only a mock exists). The D13 ADR lists every vendor and what it receives.

### 6.6 Retention (D10 — owner's instruction, legal to confirm)

- Books, invoices, vouchers, GST records, supplier bills and the audit trail are kept **8 years
  from the end of the financial year they belong to**, longer if under audit, appeal or a legal
  hold. (CGST Act s.36 runs to 72 months from the annual-return due date; Companies Act s.128 is
  8 years; 8 years from FY end covers both. **Not legal advice; legal confirms before launch.**)
- A company that stops paying becomes **read-only with full export** and is kept for the same
  period, then deleted.
- A person's deletion request during retention: their account and personal data outside the books
  are deleted; their name in posted records stays (books are immutable), access is removed.
- Logs: 30 days. Error-tracker events: 90 days. Backups: platform PITR window (7 days) plus
  monthly snapshots kept 12 months. *Proposed; owner to confirm (§9, Q4).*
- Code never invents a period: each one is configuration with a source note, as rules are.

### 6.7 Devices and language

Responsive web app for a phone (375 px) and a shop PC; English and Hindi. No native app at launch.
Offline billing is decided (D12) but built later (#317); it cannot let stock go negative (rule 3).

---

## 7. Year-one capacity estimate (D8)

### 7.1 Inputs (owner's answers)

| Input | Value |
| --- | --- |
| Active companies at month 12 | **1,000** (design for 10× = 10,000 without re-architecture) |
| Bills per company per day (sales + purchases) | **30** average; a busy retail counter 300 |
| Festival peak | **3×** an ordinary day |
| Uptime | 99.5% |

Assumptions (mine, open to correction): 80% of a day's traffic falls in the 10 business hours
(10:00–20:00); the busiest hour is 2× the business-hours average; 80% of bills are sales and 20%
purchases; one bill costs ~25 API requests end to end (load items and parties, search, preview,
finalise, PDF, list refresh, dashboard); half of purchase bills arrive as a file of ~500 KB;
half of sales bills are sent by WhatsApp or email.

### 7.2 Requests per second

```
bills/day            = 1,000 companies × 30            =     30,000
requests/day         = 30,000 × 25                     =    750,000
business-hours rps   = 750,000 × 0.8 / 36,000 s        ≈     16.7 req/s
peak-hour rps        = 16.7 × 2                        ≈     33 req/s
festival peak        = 33 × 3                          ≈    100 req/s
at 10× companies     =                                 ≈  1,000 req/s
```

Writes are a small slice: bill finalisations at festival peak are
`30,000 × 3 × 0.8 / 36,000 × 2 ≈ 4 bills/s`, each one transaction of ~30 rows.

### 7.3 Database size

Rows written per bill: header 1, lines ~5, ledger voucher + lines ~7, stock movements ~5, audit 2,
idempotency key 1, command record 1, outbox 1 — about **23 rows ≈ 10 KB**, **≈ 20 KB with
indexes**.

```
bills/year at month-12 run-rate = 30,000 × 365                  ≈ 11 M
size/year at run-rate           = 11 M × 20 KB                  ≈ 220 GB
year-one actual (linear ramp 0 → 1,000 companies, average 500)  ≈ 110 GB
masters, sessions, queue, rate-limit counters                    <   5 GB
```

So the database is **~110 GB at the end of year one and growing ~220 GB a year**; with 8-year
retention it is ~1.8 TB by year eight at flat volume. Plan the managed Postgres disk for 250 GB by
month 12. Old financial years are read rarely — partition the large append-only tables (ledger
lines, stock movements, audit) by financial year when they pass ~100 M rows, not before.

### 7.4 File storage

```
purchase files/day  = 1,000 × 30 × 0.2 × 0.5   = 3,000 files × 500 KB  ≈ 1.5 GB/day
per year (run-rate) = 1.5 GB × 365                                      ≈ 550 GB
year one (ramp)                                                         ≈ 275 GB
```

Generated bill PDFs are **not stored** (owner's choice): a PDF is regenerated from the immutable
record and the pinned template version. Storing them would add ~2.4 GB/day. Logos and statements
are negligible. Retained 8 years → ~4.4 TB at flat volume. Object storage is cheap at this size.

### 7.5 Background jobs

```
messages sent (WhatsApp/email) = 1,000 × 24 sales × 0.5     = 12,000/day
PDF renders for those messages                                = 12,000/day  (festival peak ≈ 1.6/s)
OCR calls                      = 3,000/day
reminders                      ≈ 1,000/day
------------------------------------------------------------------------
useful jobs                                                  ≈ 28,000/day ≈ 0.3/s average
```

But the recurring jobs as wired today are **per company**, polling whether or not there is work:

```
notification delivery every minute = 1,000 × 1,440   = 1,440,000 runs/day
e-invoice retry every 15 minutes   = 1,000 × 96      =    96,000
e-way expiry watch hourly          = 1,000 × 24      =    24,000
collection reminders daily         = 1,000           =     1,000
------------------------------------------------------------------
                                                     ≈ 1.56 M runs/day ≈ 18/s, forever
```

That is **55× the useful work**, and it grows with companies, not with bills. At 10,000 companies
it is 180 claims a second against Postgres doing nothing. Recurring work must become one global
sweep per job kind that picks only companies with due work (staff-engineer review on the #338 PR, finding 4).

### 7.6 The first bottleneck: database connections

At festival peak the API needs roughly 100 req/s × ~6 queries × ~5 ms ≈ **3 connection-seconds
per second**, more while a business action holds its transaction open. Today:

- the pool is hard-coded to **5 connections per process** (`packages/platform/src/database.ts`);
- a small managed Postgres plan allows only ~20–50 connections in total;
- two API instances plus a worker plus migrations plus an operator's console share them;
- `tenantTransaction` holds a connection for the whole business action, including any slow step
  inside it (a PDF render or an external call inside a transaction would hold it for seconds).

So connections run out before CPU, memory or disk. Fix in this order: never call an external
service or render a PDF inside a transaction (the outbox in #363 does this); put the platform's
connection pooler (PgBouncer, transaction mode) in front of Postgres; size the pool from
configuration; measure in the load test (#361). The second bottleneck is the per-company recurring
polling above; the third is headless-Chromium PDF rendering memory (~150 MB per page) on the
worker at festival peak.

---

## 8. Out of scope

For launch and year one. Building any of these needs a new owner decision. Product-level
exclusions in [`00-principles-and-scope.md` §5](product/00-principles-and-scope.md) (exports, SEZ,
multi-currency, payroll, TDS/TCS, moving money, lending, forecasting, legal advice, Tally live
sync) still apply.

- **Live GSP filing and live IRN/e-way calls** — offline JSON at launch; live after #50.
- **Live bank feeds** — statement upload only.
- **Offline billing** — decided now (D12), built later (#317).
- **Native mobile apps** — responsive web only.
- **Languages beyond English and Hindi.**
- **A CA practice plan** — a CA paying for or creating client companies; multi-company dashboards
  for CAs beyond the company switcher.
- **Branch-restricted roles** — a role applies to the whole company.
- **Per-user pricing, freemium-forever tier changes, marketplace, reseller or white-label plans.**
- **Multi-region, active-active, or uptime above 99.5%.**
- **Single sign-on (Google Workspace, SAML) and enterprise features.**
- **Public API, webhooks for customers, third-party app integrations.**
- **Redis, Kafka, Kubernetes, microservices** — one modular monolith, one Postgres (see #339).
- **Analytics warehouse and BI exports** beyond the built-in reports and CSV.
- **AI deciding anything** — unchanged: AI reads and drafts, never posts (principle §3).

---

## 9. Open questions for the owner

| # | Question | Blocks |
| --- | --- | --- |
| Q1 | Billing is per company, but `packages/subscriptions` meters `companies` per plan (Starter 2, Growth 10) as if one subscription covers several companies. Which wins? | #346 |
| Q2 | The shipped `free` plan (₹0, 50 invoices/month) exists; the interview chose trial → paid. Keep the free plan at launch? | #346 |
| Q3 | Confirm RPO ≤ 5 min and RTO ≤ 4 h. | #355, #357 |
| Q4 | Confirm log 30 days, error events 90 days, monthly snapshots 12 months. | #352, #357 |
| Q5 | Legal confirmation of the 8-year retention and of the deletion-during-retention rule. | #352, #55 |
| Q6 | Do you want bills and reminders sent automatically on WhatsApp later? It means a monthly WhatsApp bill and customers' numbers going to Meta abroad. Default: no — the shopkeeper taps "share on WhatsApp" as today. | messaging adapter |
| Q7 | SMS OTP: who registers the TRAI DLT entity, sender id and templates? | D1, #342 |
| Q8 | Should counter staff need the owner's OK before changing stock counts by hand? Default: yes, above ₹5,000 of stock value, and the owner can change the amount. | #342 role matrix |
