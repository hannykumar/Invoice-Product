# Threat model — every way into Karobar (issue #347)

This extends the tenant-data and backup table in [`ops/security/README.md`](../../ops/security/README.md)
to every entry point of the running product. It describes `main` at commit `8b600b3` (11 October
2026). Re-read it, and re-run the release review (#348), whenever an entry point is added or a mock
is replaced by a real provider.

**How to read the ratings.** Likelihood and impact are each Low / Medium / High. A gap is rated
High when either is High and the other is at least Medium; otherwise Medium or Low. *Today* means
the demo server as it runs on `main`: in-memory state, loopback-only (`127.0.0.1`), demo users,
every government, bank, messaging and vehicle provider mocked. *At launch* means the same code
reachable from the internet (#356). Gaps are rated for launch, because that is the risk this
programme exists to remove. Every gap names the issue that closes it. Gaps that no issue owned were filed by the first release
security review (#348, recorded in `docs/security/reviews/`) as #389–#406.

## 1. Assets

| Asset | Where it lives today | Why it matters |
| --- | --- | --- |
| The books: vouchers, invoices, notes, stock, payments, returns | In-memory stores behind `apps/api/src/demo-application.ts`; Postgres is #340 | Accuracy is the product. Tampering or loss is a tax liability for the shop |
| Identity numbers: GSTIN, PAN, customer and supplier addresses, phone numbers | Master data (`packages/masters`), business details (`apps/api/src/business-details-application.ts`) | Personal data under DPDP; GSTIN routes intake and government calls |
| Bank details: account number, IFSC, UPI id, bank-feed consent | Business details, `packages/bank-feeds` | Changing a UPI id redirects a customer's payment |
| GSP / IRP / e-way bill credentials | `.env` read by `FileCredentialVault` (`packages/platform/src/credentials.ts`) | A leaked credential files or cancels e-invoices in the shop's name |
| Sessions | In-memory map, 8-hour lifetime (`packages/platform/src/auth.ts`); bearer token in browser `localStorage` | A stolen token is the whole company |
| Passwords | Demo users, unsalted SHA-256 (`apps/api/src/runtime.ts:18`) | Replaced by #342 |
| Subscription payments | `packages/subscriptions`, demo provider `alwaysPays()` | Revenue; becomes a webhook in #346 |
| Uploaded documents: supplier bills, logos, signatures, migration files | Request bodies and in-memory maps; object storage is #341 | Carry other businesses' data; carry attacker content into OCR and the browser |
| Audit trail | In-memory `AuditLog`s, one per service | The evidence behind every correction; append-only in #368 |

## 2. Trust boundaries and actors

```
 browser (owner, staff, viewer) ──HTTP──▶ web server ──in-process──▶ API ──▶ services ──▶ ledger / stores
 government provider (IRP, e-way, GST) ──signed callback──▶ /api/webhooks/government/:kind
 supplier / stranger ──WhatsApp, email, camera, upload──▶ purchase inbox (library, not yet routed)
 API ──adapters──▶ WhiteBooks sandbox, bank feed, Vahan, messaging (all mocked or sandbox-only)
```

Actors: an **owner** (all permissions), **staff** and a **read-only viewer** inside one company; a
person in **another company**; an **anonymous** internet client; a **provider** calling back; a
**stranger** who knows a shop's public GSTIN, phone number or email alias.

## 3. Controls that already hold

Each of these was checked in the code. They are why the gaps below are gaps and not disasters.

- **Tenancy comes from the session.** `runtime.authenticate` builds the `RequestContext`; no route
  takes a company id from the request except sign-in. `DemoApplication.companyOf` refuses an actor
  from another company. The webhook resolves the company from our own call log, not the payload.
- **Every POST but three has a declared permission.** Each route's `access` in the route table
  (`apps/api/src/routes/`, #344) is checked before its input is read, and
  `apps/api/test/route-permissions.test.ts` fails when a new POST has no permission (#280). The
  three without one are sign-in, the signed government callback (W1) and the public PIN-code table;
  `requirePostPermission` lets any path it does not know through, so that test is what keeps the
  list complete.
- **AI never posts.** There is no language-model call anywhere in the repository. The assistant,
  the action agent, voice parsing and OCR extraction are deterministic parsers that produce drafts.
  The ledger is reached only through the services a person uses (§4.7).
- **Bills are escaped on the server.** Every name, address, GSTIN and narration in a printed bill
  goes through `escapeHtml` (`packages/invoice-templates/src/parts.ts:20`). The browser builds
  screens with `textContent`; the one `innerHTML` (`apps/web/app.js:3186`) takes a server-drawn
  trade-mark picture, not user data.
- **Outbound government calls are allow-listed.** `assertGovernmentEndpoint`
  (`packages/gst/src/environments.ts`) only permits the WhiteBooks sandbox and local hosts;
  production is hard-off. Calls time out after 30 s. No outbound URL is user-supplied.
- **Secrets are redacted from every JSON response** (`redactSecretText`, `server.ts:22`).
- **CSRF is not reachable today**: the session is a bearer header, not a cookie, so a cross-site
  form cannot carry it. This changes with #342, which is why #349 adds the Origin check now.

## 4. Entry points and threats

OWASP Top 10 (2021): A01 Broken access control, A02 Cryptographic failures, A03 Injection (incl.
XSS and prompt injection), A04 Insecure design, A05 Security misconfiguration, A06 Vulnerable
components, A07 Identification and authentication failures, A08 Software and data integrity
failures, A09 Logging and monitoring failures, A10 SSRF.

### 4.1 HTTP API — 154 routes in `apps/api/src/routes/` (served by `apps/api/src/server.ts`), and the static web server

Every route is listed with its gate in [Appendix A](#appendix-a--every-api-route). The families:

| Family | Routes | Notes |
| --- | --- | --- |
| Before authentication | `POST /api/auth/code`, `POST /api/auth/sign-in`, `GET /api/status`, `POST /api/webhooks/government/:kind` | §4.3 for the webhook; codes are checked by the identity provider (ADR D1), rate limits are #350 |
| Session, operations, assistant | `/api/session`, `POST /api/session/company`, `POST /api/auth/sign-out`, `/api/dashboard`, `/api/reports`, `/api/operations*`, `/api/assistant/*` | |
| Setup and masters | onboarding, trade marks, branding, business details, catalogue, customers, suppliers, items, transporters, addresses, PIN code, states | Logo and signature uploads (§4.2) |
| Migration | `/api/migration/*` | §4.5 |
| Sales and returns | `/api/sales/*`, `/api/returns/*`, PDFs and previews | §4.6 |
| Government | `/api/einvoices/*`, `/api/eway/*`, `/api/challans/*`, `/api/gst-returns/*`, `/api/itc/*`, `/api/vehicles/*` | Adapters mocked; WhiteBooks sandbox |
| Purchasing | `/api/purchase-orders`, `/api/goods-receipts`, `/api/purchases/*`, `/api/suppliers/check*` | |
| Money | `/api/payments/*`, `/api/presale/*`, `/api/bank-feeds/*`, `/api/subscription*` | We record money; we never move it |
| Agent and reminders | `/api/agent/*`, `/api/reminders/*` | §4.7 |
| Static web server | `apps/web/server.ts`: any path not under `/api/` | Serves files under `apps/web` |

| # | Threat (OWASP) | Likelihood | Impact | Have | Missing | Rating | Issue |
| --- | --- | --- | --- | --- | --- | --- | --- |
| H1 | One huge or slow request exhausts memory, before sign-in (A04/A05) | High | High | Nothing: `readBody` buffers without limit; no timeouts set | 1 MB JSON limit → 413; `requestTimeout`, `headersTimeout` | **High** | #349 |
| H2 | Clickjacking; XSS with no backstop; MIME sniffing (A05) | Medium | High | Server-side escaping | CSP, `frame-ancestors`, nosniff, HSTS, Referrer-Policy, Permissions-Policy | **High** | #349 |
| H3 | Password guessing on sign-in; unsalted SHA-256; default demo passwords with no environment guard; the owner's demo password prefilled in the sign-in form (`apps/web/index.html:1547`) (A07/A02) | High | High | Constant-time compare | A real identity provider; no built-in users | **High** | #342 |
| H4 | No rate limits on sign-in, government calls, PDF generation, reminders, the webhook (A04) | High | High | — | Per-user and per-company limits, spending caps | **High** | #350 |
| H5 | A read-only viewer reads invoice PDFs and previews, notes, purchases, challans, quotations, PAN and bank details through GET routes with no permission check (A01) | Medium | Medium | Tenant check in each service | Permission on every GET | Medium | #327, #343 |
| H6 | GET routes that write: `/api/catalogue` opens an account; `/api/operations` seeds data before its permission check (A04) | Low | Low | — | GET is read-only | Low | #395 |
| H7 | Internal error text reaches the client; surprises answer 400, not 500; a JSON body of `null` returns a TypeError message (A05/A09) | Medium | Low | No stack traces; secrets redacted | One error shape, plain 500 | Medium | #344 |
| H8 | Session token in `localStorage` is stolen by any XSS; no sign-out route (A07) | Low | High | No `innerHTML` from data | HttpOnly cookie, sign-out | Medium | #342 (+ #349 CSP) |
| H9 | CSRF once the session is a cookie (A01) | Low today, High after #342 | High | Bearer header | `SameSite` cookie + Origin/Host check on every non-GET | **High** | #349 (Origin check), #342 (cookie) |
| H10 | A retry creates a second document when the client sends no idempotency key: the server invents one (`randomUUID()`, `Date.now()`, or an empty key) (A04/A08) | Medium | High | Idempotency on every command | Refuse a write that has no client key | **High** | #392 |
| H11 | The static web server serves its own source and tests (`/server.ts`, `/test/*.ts`, `/README.md`) (A05) | High | Low | Path traversal is blocked | Allow-list of served files | Medium | #393 |
| H12 | Cross-company access on any route (A01) | Low | High | Session tenancy, `companyOf` | Generated 401 / 403 / 404 tests for every route; RLS in use | Medium | #343, #340 |

### 4.2 File uploads — logos, signatures, migration files, ITC files

Wired today: `logoDataUri` on `POST /api/branding` (400 000-character cap, `data:image/*` prefix,
SVG allowed), `signatureDataUri` on `POST /api/business-details` (280 000 characters), and `content`
on `/api/migration/analyse` and `/api/itc/import` (no cap). Each cap is applied after the whole
body has been read and parsed (H1). Images are rendered only through `<img src>`, where SVG cannot
run script.

| # | Threat | Likelihood | Impact | Have | Missing | Rating | Issue |
| --- | --- | --- | --- | --- | --- | --- | --- |
| U1 | Oversized upload exhausts memory (A04) | High | High | Per-field caps after parse | Body limit; uploads go direct to storage | **High** | #349, #341 |
| U2 | SVG logo runs script if ever rendered other than by `<img>` (A03) | Low | Medium | `<img>` only | Rasterise or reject SVG on upload | Low | #341 |
| U3 | Stored files readable by another company (A01) | Medium | High | In-memory, per company | Private bucket, signed company-scoped links | **High** | #341 |

### 4.3 Government and payment webhooks

One inbound webhook exists: `POST /api/webhooks/government/:kind` (`irp`, `eway_bill`, `gst`). It
is matched before authentication and verified by `StaticWebhookVerifier`
(`packages/platform/src/connectors.ts:48`), which accepts any body whose `x-provider-signature`
header is the literal string `test-signature`. There is no HMAC, secret, timestamp or replay
window, the payload is not schema-checked, and redelivery protection is an in-memory set. No
payment webhook is routed yet (#346).

| # | Threat | Likelihood | Impact | Have | Missing | Rating | Issue |
| --- | --- | --- | --- | --- | --- | --- | --- |
| W1 | Anyone forges a government callback: settles an unknown IRP call with an IRN of their choosing, raises false conflicts, reads our stored reference back in the 202 (A07/A08) | High | High | Company comes from our call log, not the payload; the call log is empty until #51 | HMAC over the raw bytes with a per-provider secret from the vault, constant-time compare, timestamp window, schema check, and a refusal to start with the test verifier outside development | **High** | #389 |
| W2 | Replay of a genuine callback after a restart; unbounded growth of the seen-events set (A08/A04) | Medium | Medium | In-memory dedup | Durable unique `(kind, eventId)` — the SQL index exists but the app does not use it | Medium | same issue as W1 |
| W3 | Forged subscription "paid" event (A08) | — | High | Not routed | Signed webhook as the only source of truth | **High** | #346 |

### 4.4 WhatsApp, email, camera and upload purchase intake

`PurchaseInboxService` (`packages/purchasing/src/inbox.ts`) is a library; **no API route reaches it
today**. It becomes an entry point with #316 and #341. These gaps must be closed before it is
routed, because the person who sends a bill is a stranger by design.

| # | Threat | Likelihood | Impact | Have | Missing | Rating | Issue |
| --- | --- | --- | --- | --- | --- | --- | --- |
| I1 | A stranger who knows a shop's public GSTIN pushes a forged e-invoice JSON into that shop's inbox at confidence 1, whichever alias it was sent to: the buyer GSTIN printed in the file picks the company (`routing.ts:58`) (A01/A08) | High once routed | High | Nothing posts without approval | The channel binding decides the company; unsigned JSON gets no special confidence; the IRN signature is verified | **High** | #400 |
| I2 | `providerMessageId` dedup is global, so a reused id returns another company's document and draft (`inbox.ts:117`); `assignCompany` and `retry` take no tenant and clear quarantine and review flags (A01) | Medium once routed | High | — | Dedup keyed by company; tenant and permission on every inbox command | **High** | #400, #406 |
| I3 | A malicious file passes screening: size, hash and scan verdict are declared by the caller, `unscanned` passes, and the PDF active-content check is a regex over the first 8 KB (A04/A08) | Medium once routed | Medium | Type allow-list, magic bytes, extension deny-list | Measure size and hash on the server, require a scan verdict, parse PDFs, page and pixel limits | Medium | #401 |
| I4 | The sender address is self-asserted and recorded as the audit actor (A09) | High | Low | — | Provider-verified sender; a system actor in the audit | Low | same issue as I3 |

### 4.5 CSV and Excel import, and exports

Migration (`/api/migration/*`, `packages/migration`) parses CSV text from the request body. Each
migration runs in its own fresh in-memory company and commits only after the mapping is approved
and its fingerprint is unchanged. XLSX and bank-statement PDF/XLSX parsers exist but are not routed.

| # | Threat | Likelihood | Impact | Have | Missing | Rating | Issue |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M1 | Spreadsheet formula injection: the "rows to fix" CSV echoes original cells that start with `= + - @` (`packages/migration/src/csv.ts:178`) (A03) | Medium | Medium | Quoting of `" , CR LF` | Neutralise such cells | Medium | #394 |
| M2 | No row or size limit; the file is parsed four or five times per analyse and preview (A04) | Medium | Medium | — | Body limit, row limit | Medium | #349 + #396 |
| M3 | One global 8-slot store of migrations: anyone with `migration.run` evicts other companies' in-progress migrations (A04) | Medium | Low | A workspace is owned by company + actor + session | Per-company slots | Low | #396 |
| M4 | XLSX zip bomb, or a bank-statement PDF bomb, once those parsers are routed (A04/A06) | Low | Medium | Not routed | Size, sheet, page and row limits before parsing | Low | — |
| E1 | GST return and offline JSON exports leak another company's data (A01) | Low | High | Permission and `actor.companyId` in the service | — | Low | — |
| E2 | Header injection through a PDF filename (A03) | Low | Low | Filenames sanitised | — | Low | — |

### 4.6 PDF generation and printed bills

Bills, notes, challans, quotations and e-way bills are rendered as HTML on the server, shown in the
browser in `<iframe srcdoc>` frames, and turned into PDFs by launching headless Chromium
(`packages/invoice-templates/src/pdf.ts`) with JavaScript enabled and every request but `data:`
blocked.

| # | Threat | Likelihood | Impact | Have | Missing | Rating | Issue |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | An escaping miss in any template becomes same-origin XSS: the bill frames have no `sandbox` and share the app's origin and its token (A03) | Low | High | `escapeHtml` everywhere (checked) | `sandbox` on every bill frame; the #349 CSP is inherited by `srcdoc` and blocks inline script | Medium | #349 (CSP) + #399 |
| P2 | One Chromium per PDF request: repeated GETs exhaust the server; JavaScript is on in the renderer (A04) | Medium | Medium | Network blocked | A shared browser, JavaScript off, a rate limit | Medium | #350 + #398 |

### 4.7 Voice and text assistant, action agent — prompt injection

**There is no language model in the product today.** The assistant (`packages/assistant`), agent
(`packages/action-agent`), voice parser (`packages/voice-assistant`) and OCR extraction
(`packages/purchasing/src/extraction.ts`) are deterministic regex and lexicon parsers. A model can
be plugged into two ports, and both are shaped so that injected text cannot reach money:

- `QuestionUnderstandingPort` (`packages/assistant/src/ports.ts`) may only *choose* an intent from
  an allow-list. It is given the matched words, not the raw question, and is not wired.
- `TranscriptionPort` (`packages/voice-assistant/src/ports.ts`) turns audio into text, which then
  goes through the same deterministic parser. Voice is not routed.

**The rule for every future model integration** (OCR, WhatsApp, email, voice, assistant): text
from a document, a message, a transcript or a master record is *data, never instructions*. It may
fill draft fields with a confidence. It may never choose a tool, a permission, an approver, a rate
or a recipient. The deterministic layer validates the draft and a person approves it.

**Every AI path reaches the ledger the way a person does** (principles §7):

| Path | Permission | Preview | Approval | Idempotency | Can it approve itself? |
| --- | --- | --- | --- | --- | --- |
| Assistant `POST /api/assistant/ask` | `assistant.ask` at the route; reads go through `ReportService` with the asker's permissions (exception: A2) | — | — | — | It writes nothing |
| Agent `POST /api/agent/plan` → `approve` → `execute` | `agent.plan` / `agent.approve` / `agent.execute` at the route; each tool's own permission when steps are built, before execution and per step; `collections.send` checks again | The plan's fingerprint is shown and pinned | `approve` refuses an unseen or changed fingerprint; the platform command moves to `approved` only for an actor holding `approval.decide` | Company + plan + key; collections dedups by reminder key | **No.** There is no model, plans come from a fixed recipe list, and approval is a separate signed-in request by a person. The person who asked may approve their own plan (A1), exactly as they could send the same reminders by hand |
| Agent tools | Two reads, `reminders.send`, `reminders.stop`, and `sales.cancel` (prepare-only). The registry refuses a high-risk tool unless it is prepare-only and refuses a write that skips approval | | | | Filing, IRN, e-way bill and moving money are refused intents |
| Voice draft | Not routed. Produces a draft sale; tax comes from `SalesService` | Sale preview | Sale submit | Sale key | No approval path exists |
| OCR / WhatsApp / email bill | Not routed. Produces an `ExtractionDraft` and never posts; posting needs an `ApprovedPurchase` naming the approver | `/api/purchases/preview` | A person | Purchase key | No |

| # | Threat | Likelihood | Impact | Have | Missing | Rating | Issue |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | One person plans, approves and executes in one click; a bare "remind" chases every overdue customer (A04) | Medium | Medium | Preview, fingerprint, permission per step | The count shown and a cap, or a second approver for bulk sends | Medium | accepted: designed flow (#348 review) |
| A2 | "Why is this bill blocked?" reads any invoice, and stock as `setupActor`, past the asker's sales and stock permissions (`demo-application.ts:979-988`) (A01) | Medium | Medium | `assistant.ask`, tenant | Read as the asker | Medium | #397 |
| A3 | Instructions hidden in OCR text, a WhatsApp or email body, a voice transcript, or a supplier or item name steer an action (A03) | Low (no model) | High | Deterministic parsers, allow-listed intents, human approval | The rule above, enforced by a test when a model is wired | Medium | #316 must carry it |
| A4 | A stored party or item name containing "guaranteed" or "you must" makes assistant answers fail (A04) | Low | Low | — | Check the sentence template, not the data | Low | #405 |
| A5 | "Today" for the agent and for reminders comes from the client, so bills look overdue early and wording escalates (A04) | Medium | Low | — | Server clock | Low | #403 |
| A6 | Agent audit records and prepared cancellations live in the agent's own stores, not the company audit (A09) | Medium | Low | — | One audit trail | Low | #404 |

### 4.8 Outbound adapters and secrets

| # | Threat | Likelihood | Impact | Have | Missing | Rating | Issue |
| --- | --- | --- | --- | --- | --- | --- | --- |
| O1 | SSRF through a user-supplied URL (A10) | Low | High | No user-controlled outbound URL; government hosts allow-listed | The #348 review checks every new `fetch` | Low | — |
| O2 | Bank-feed `redirectUri` accepts any https host; consent completion has no `state` (A01/A07) | Medium once a real bank is wired | Medium | Synthetic provider | Allow-listed redirect; `state` bound to the session | Medium | #402 |
| O3 | One WhiteBooks credential and GSTIN shared by every company (A01/A02) | High at launch | High | Sandbox only; production hard-off | A per-company credential in a vault | **High** | #210 |
| O4 | Secrets committed, or leaked through a dependency (A06) | Medium | High | `.env` gitignored, mode 0600 | gitleaks, Dependabot | **High** | #351 |
| O5 | Personal data in logs (A09) | Medium | Medium | Recursive redaction | Structured logs with a request id | Medium | #357, #352 |

## 5. High-rated gaps and their issues

| Gap | Issue |
| --- | --- |
| H1 body limit and timeouts, H2 headers, H9 Origin check, U1 | #349 |
| H3 sign-in and passwords; H8 cookie session (Medium, listed as a launch blocker) | #342 (+ #349 CSP for H8) |
| H4 rate limits | #350 |
| H10 idempotency key invented by the server | #392 |
| H12 cross-company tests for every route (Medium, listed as a launch blocker) | #343 |
| U1, U3 uploads | #341 |
| W1 forgeable government webhook | #389 |
| W3 payment webhook | #346 |
| I1, I2 intake tenant routing | #400, #406 |
| O3 shared government credential | #210 |
| O4 secrets and dependencies | #351 |

## Appendix A — every API route

Generated from `apps/api/src/server.ts`. `apps/api/test/threat-model-coverage.test.ts` fails when a
route is added there and not here. *Gate* is the route's `access` in the route table, checked before
the handler; `service` means the route has no gate in the table and relies on the service (H5); `—`
means no permission by design (sign-in, the signed webhook, the public PIN-code table).

| Method | Path | Gate |
| --- | --- | --- |
| POST | `/api/auth/code` | — |
| POST | `/api/auth/sign-in` | — |
| POST | `/api/auth/sign-out` | — |
| POST | `/api/session/company` | — |
| GET | `/api/status` | — |
| POST | `/api/webhooks/government/:param` | — |
| GET | `/api/session` | service |
| GET | `/api/dashboard` | service |
| GET | `/api/reports` | service |
| GET | `/api/operations` | service |
| POST | `/api/operations/jobs/replay` | `queue.replay` |
| POST | `/api/operations/support-grants` | `support.access.grant` |
| POST | `/api/operations/error-check` | `queue.replay` |
| GET | `/api/assistant/examples` | service |
| POST | `/api/assistant/ask` | `assistant.ask` |
| GET | `/api/states` | service |
| POST | `/api/pincode/state` | — |
| POST | `/api/onboarding/preview` | `onboarding.run` |
| POST | `/api/onboarding/finish` | `onboarding.finish` |
| POST | `/api/trade-marks/search` | `branding.write` |
| POST | `/api/trade-marks/choose` | `branding.write` |
| GET | `/api/branding` | service |
| POST | `/api/branding` | `branding.write` |
| GET | `/api/business-details` | service |
| POST | `/api/business-details` | `business.settings.write` |
| GET | `/api/catalogue` | service |
| POST | `/api/customers` | `masters.party.write` |
| POST | `/api/suppliers` | `masters.party.write` |
| POST | `/api/items` | `masters.item.write` + `masters.item.rate.declare` |
| POST | `/api/items/code` | `masters.item.write` + `masters.item.rate.declare` |
| POST | `/api/items/edit` | `masters.item.write` + `masters.item.rate.declare` |
| POST | `/api/items/selling` | `sales.draft.write` |
| POST | `/api/delivery/choices` | `sales.draft.write` or `challan.issue` |
| POST | `/api/transporters` | `masters.party.write` |
| POST | `/api/shipping-addresses` | `masters.party.write` |
| POST | `/api/customer-address` | `masters.party.write` |
| POST | `/api/customer-address/correct` | `masters.party.write` |
| POST | `/api/branding/upi` | `payments.upi.write` |
| POST | `/api/branding/preview` | `branding.write` |
| POST | `/api/migration/start` | `migration.run` |
| POST | `/api/migration/analyse` | `migration.run` |
| POST | `/api/migration/mapping` | `migration.run` |
| POST | `/api/migration/approve` | `migration.run` |
| POST | `/api/migration/preview` | `migration.run` |
| POST | `/api/migration/commit` | `migration.commit` |
| POST | `/api/migration/rollback` | `migration.rollback` |
| GET | `/api/einvoices/invoices` | service |
| POST | `/api/einvoices/preview` | `einvoice.view` |
| POST | `/api/einvoices/register` | `einvoice.generate` |
| POST | `/api/einvoices/reconcile` | `einvoice.generate` |
| POST | `/api/einvoices/cancel` | `einvoice.cancel` |
| POST | `/api/einvoices/offline` | `einvoice.generate` |
| GET | `/api/challans/reasons` | service |
| GET | `/api/challans` | service |
| GET | `/api/challans/movable` | service |
| POST | `/api/challans/preview` | `challan.issue` |
| POST | `/api/challans/issue` | `challan.issue` |
| POST | `/api/challans/print` | `challan.issue` |
| POST | `/api/challans/eway` | `challan.issue` |
| POST | `/api/challans/link-invoice` | `challan.issue` |
| POST | `/api/challans/cancel` | `challan.cancel` |
| POST | `/api/challans/bill` | `sales.finalise` |
| GET | `/api/presale` | service |
| POST | `/api/presale/preview` | `quotation.issue` or `proforma.issue` |
| POST | `/api/presale/issue` | `quotation.issue` or `proforma.issue` |
| POST | `/api/presale/print` | `quotation.issue` or `proforma.issue` |
| POST | `/api/presale/convert` | `quotation.issue` + `sales.draft.write` |
| POST | `/api/presale/issue-sale` | `sales.draft.write` + `sales.finalise` |
| POST | `/api/presale/link-invoice` | `quotation.issue` or `proforma.issue` |
| POST | `/api/presale/cancel` | `quotation.cancel` or `proforma.cancel` |
| POST | `/api/presale/advances` | `payments.record` |
| POST | `/api/presale/advance` | `payments.record` |
| POST | `/api/presale/refund-advance` | `payments.record` |
| POST | `/api/presale/voucher` | `payments.record` |
| GET | `/api/eway/states` | service |
| GET | `/api/eway/on-the-road` | service |
| POST | `/api/eway/preview` | `eway.view` |
| GET | `/api/eway/bills` | service |
| POST | `/api/eway/for-bill` | `eway.view` |
| POST | `/api/eway/generate` | `eway.generate` |
| POST | `/api/eway/vehicle` | `eway.update` |
| POST | `/api/eway/extend` | `eway.update` |
| POST | `/api/eway/cancel` | `eway.cancel` |
| POST | `/api/eway/reject` | `eway.cancel` |
| POST | `/api/eway/reconcile` | `eway.generate` |
| POST | `/api/eway/offline` | `eway.generate` |
| POST | `/api/eway/print` | `eway.view` |
| GET | `/api/eway/:param/pdf` | service |
| GET | `/api/vehicles/choices` | service |
| GET | `/api/vehicles/held` | service |
| POST | `/api/vehicles/record` | `transport.vehicle.check` |
| POST | `/api/vehicles/check` | `transport.vehicle.check` |
| POST | `/api/vehicles/check/override` | `transport.vehicle.override` |
| GET | `/api/suppliers/choices` | service |
| POST | `/api/suppliers/check` | `supplier.risk.view` |
| POST | `/api/suppliers/check/acknowledge` | `supplier.risk.acknowledge` |
| POST | `/api/purchase-orders` | `purchase.order.write` |
| POST | `/api/goods-receipts` | `purchase.receipt.write` |
| POST | `/api/purchases/match` | `ledger.post.purchase` |
| POST | `/api/purchases/match/approve` | `purchase.match.approve` |
| GET | `/api/purchases/:param` | service |
| POST | `/api/purchases/preview` | `ledger.post.purchase` |
| POST | `/api/purchases/record` | `ledger.post.purchase` |
| POST | `/api/purchases/self-invoice` | `ledger.post.purchase` |
| POST | `/api/purchases/self-invoice/print` | `ledger.post.purchase` |
| GET | `/api/purchases/self-invoices` | service |
| GET | `/api/subscription` | service |
| POST | `/api/subscription/plan` | `subscription.manage` |
| POST | `/api/subscription/pay` | `subscription.manage` |
| POST | `/api/sales/estimate` | `sales.draft.write` |
| POST | `/api/sales/preview` | `sales.draft.write` |
| POST | `/api/sales/record` | `sales.draft.write` + `sales.finalise` |
| POST | `/api/sales/cancel/preview` | `sales.cancel` |
| POST | `/api/sales/cancel` | `sales.cancel` |
| POST | `/api/sales/print` | `sales.draft.write` |
| GET | `/api/returns/:param/pdf` | service |
| GET | `/api/sales/:param/pdf` | service |
| GET | `/api/sales/:param/preview` | service |
| POST | `/api/payments/preview` | `payments.record` |
| POST | `/api/payments/record` | `payments.record` |
| POST | `/api/payments/open-bills` | `payments.record` |
| POST | `/api/payments/voucher` | `payments.record` |
| GET | `/api/agent/capabilities` | service |
| GET | `/api/agent/history` | service |
| POST | `/api/agent/plan` | `agent.plan` |
| POST | `/api/agent/approve` | `agent.approve` |
| POST | `/api/agent/execute` | `agent.execute` |
| GET | `/api/reminders` | service |
| POST | `/api/reminders` | `collections.reminders.view` |
| POST | `/api/reminders/send` | `collections.reminders.send` |
| POST | `/api/reminders/send-all` | `collections.reminders.send` |
| POST | `/api/reminders/retry` | `collections.reminders.send` |
| POST | `/api/reminders/promise` | `collections.promise.record` |
| POST | `/api/reminders/dispute` | `collections.dispute.manage` |
| POST | `/api/reminders/dispute/resolve` | `collections.dispute.manage` |
| POST | `/api/reminders/stop` | `collections.reminders.send` |
| POST | `/api/reminders/resume` | `collections.reminders.send` |
| GET | `/api/bank-feeds` | service |
| POST | `/api/bank-feeds/consent` | `bank.feed.manage` |
| POST | `/api/bank-feeds/consent/complete` | `bank.feed.manage` |
| POST | `/api/bank-feeds/sync` | `bank.feed.sync` |
| POST | `/api/bank-feeds/disconnect` | `bank.feed.manage` |
| POST | `/api/itc` | `itc.view` |
| POST | `/api/itc/import` | `itc.import` |
| POST | `/api/itc/typed` | `itc.import` |
| POST | `/api/itc/decide` | `itc.decide` |
| POST | `/api/gst-returns` | `gst_returns.view` |
| POST | `/api/gst-returns/prepare` | `gst_returns.prepare` |
| POST | `/api/gst-returns/approve` | `gst_returns.approve` |
| POST | `/api/gst-returns/reopen` | `gst_returns.reopen` |
| POST | `/api/gst-returns/export` | `gst_returns.export` |
| GET | `/api/returns/documents` | service |
| POST | `/api/returns/preview` | `returns.create` |
| POST | `/api/returns/record` | `returns.create` |
| GET | `/api/returns/notes` | service |
| POST | `/api/returns/supplier-note` | `returns.create` |
| POST | `/api/returns/print` | `returns.create` |
