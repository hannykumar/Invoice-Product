# Session S4 hand-off — #347, #348, #349

Written 11 October 2026 so a fresh session can continue. **Delete this file in the last PR of the
session.** Tracking issue: #362. This session owns exactly #347, #348 and #349.

Standing rules: the owner is not technical — decide, and record why in the PR or issue; never
change what the product does; `CLAUDE.md`, `AGENTS.md` (read Rule 0) and `docs/product` stay as
they are; the three Delivery Handbooks define scope.

## Where things stand

| Issue | Branch | State |
| --- | --- | --- |
| #347 threat model | `security/347-threat-model` | Draft PR open. `docs/security/threat-model.md` written, with all 150 routes; `apps/api/test/threat-model-coverage.test.ts` keeps the appendix honest. **Not finished**: the "to be filed (#348)" cells need issue numbers |
| #348 release review | not started | — |
| #349 headers, body limit, CSRF, timeouts | not started | — |

## Findings so far

Verified by reading the code on `main` at `8b600b3` (and where marked, by running the server):

1. **The web server serves its own source.** `apps/web/server.ts:20-28` serves any file under
   `apps/web`. Confirmed with curl: `/server.ts`, `/test/web.test.ts`, `/README.md` return 200.
2. **The government webhook accepts a fixed signature.** `StaticWebhookVerifier`
   (`packages/platform/src/connectors.ts:48-52`) accepts `x-provider-signature: test-signature`;
   wired at `apps/api/src/government-webhooks.ts:52`. No HMAC, timestamp or durable dedup.
3. **No security headers on any response.** Confirmed with `curl -I` on `/` and `/api/status`:
   only `content-type` and `cache-control`. No timeouts set; `readBody` (`server.ts:447`) is unbounded.
4. **The owner's demo password is prefilled on the sign-in page** (`apps/web/index.html:1547`,
   `value="karobar-demo"`), reported by S1. Defaults are in `apps/api/src/runtime.ts:126,134`;
   passwords are unsalted SHA-256 (`runtime.ts:18`). Owned by #342. S1 reported a second finding
   that was not passed on to this session — ask the coordinating session or read S1's summary on #362.
5. Agent plan can be approved by the person who asked (`packages/action-agent/src/service.ts:201-218`).
6. Assistant "why blocked" reads invoices and stock as `setupActor` (`demo-application.ts:979-988`).
7. CSV formula injection in the migration error file (`packages/migration/src/csv.ts:178-183`).
8. Global 8-slot migration workspace store (`apps/api/src/migration-application.ts:59-60`).
9. Inbox `providerMessageId` dedup is global (`packages/purchasing/src/inbox.ts:117-121`).
10. GET PDF and preview routes have no permission check (`demo-application.ts:3160` `invoicePrint`) — #327.

Reported by the explorer subagents and **not yet verified line by line** (verify before filing):
inbox routing by buyer GSTIN in JSON (`routing.ts:58-62`), `assignCompany` / `retry` without a
tenant (`inbox.ts:274,308`), screening trusting declared size / hash / verdict (`safety.ts`),
server-invented idempotency keys (`demo-application.ts:2316, 3326, 4067`), client-supplied "today"
(`demo-application.ts:3309, 1946`), bank-feed `redirectUri` and missing `state`
(`packages/bank-feeds/src/service.ts:30,46`), one Chromium per PDF with JavaScript on
(`packages/invoice-templates/src/pdf.ts:15-30`), unsandboxed `srcdoc` bill frames
(`apps/web/index.html`, ten sinks in `app.js`), GETs that write (`/api/catalogue`,
`/api/operations`), names containing "guaranteed" breaking assistant answers
(`packages/assistant/src/citations.ts:74-88`), agent audit kept apart from the company audit.

Useful facts: no LLM call exists anywhere; the purchase inbox and voice are libraries with no API
route; the session is a bearer token in `localStorage` (no cookie, so no CSRF today); the web page
has no inline script or inline handlers, but loads Google Fonts and uses `style=` on six iframes,
and every bill template uses `<style>` and `style=` inside `srcdoc` (which inherits the page CSP).

## Remaining plan

### #347
1. After #348 files its issues, replace every "to be filed (#348)" in `threat-model.md` with the
   issue number.
2. Run `npm run verify`, run `/code-review`, mark the PR ready. Body ends `Closes #347` and carries
   the definition of done (verify output, files changed and why, anything skipped, assumptions).

### #348 — branch `security/348-release-review` from `main`
1. Save the issue's prompt verbatim as `.claude/commands/security-review-release.md` (the issue
   says `security-review.md`; that name collides with the built-in `/security-review`, so note the
   rename in the PR). The repository has no Codex prompt directory — say so in the PR.
2. Run `/security-review`, and spawn a fresh general-purpose reviewer subagent with the prompt
   verbatim. The reviewer must not be the session that wrote the code.
3. Merge and de-duplicate against the list above; verify each finding by reading the code.
4. `gh issue create` one issue per confirmed finding: labels `saas-readiness`, `security`; title
   prefixed by the owning lane (`[GPT 1]` assistant, migration, sales; `[GPT 2]` platform, web
   server, agent, bank feeds, reminders; `[GPT 3]` purchasing, GST, transport); body: file, line,
   severity, exploit scenario, fix, "Found by #348", "Part of #362". Do not re-file what #327,
   #341, #342, #343, #344, #346, #349, #350, #351, #210 already own — link them.
5. Add "security review run, findings linked" to `docs/release/gates.md`.
6. Report only: fix nothing outside #349's scope. PR ends `Closes #348`.

### #349 — branch `security/349-headers-limits` from `main`
1. One shared helper used by both servers: CSP (`default-src 'self'`; `script-src 'self'`;
   `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`; `font-src https://fonts.gstatic.com`;
   `img-src 'self' data: blob:`; `frame-ancestors 'none'`; `base-uri 'self'`; `form-action 'self'`;
   `object-src 'none'`), HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
   `Referrer-Policy`, `Permissions-Policy` (camera stays allowed for self: the barcode scanner).
   `'unsafe-inline'` for styles is needed by the bill templates; record it as a known limitation.
2. `readBody`: stop at 1 MB → 413 in the usual error shape; check that logo (400 000 characters)
   and signature uploads still fit.
3. Origin/Host check on every non-GET except the signed webhook; note in the PR that the
   `SameSite` cookie arrives with #342.
4. `requestTimeout` and `headersTimeout` on both servers.
5. A test for each, in `apps/api/test` and `apps/web/test`.
6. Verify with `curl -I` on the page and an API route, a 10 MB POST (413, server stays up), a
   cross-origin POST (refused), and the built-in browser: sign in, open a bill preview, check the
   console for CSP violations, paste `<script>alert(1)</script>` into text fields.
7. `/code-review`, then PR ending `Closes #349`.

### Last
Comment progress on each issue; summarise on #362 with the list of new finding issues.

## Running the app locally

The worktree needs its own `npm ci` (otherwise it resolves the main checkout's packages).
`PORT=4391 node --experimental-strip-types apps/web/server.ts` serves the page and the API.
