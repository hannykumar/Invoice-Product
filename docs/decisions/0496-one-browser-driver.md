# ADR 0496 — One browser-test driver: Playwright

Status: **accepted**, awaiting the owner's veto (issue #496). Supersedes the last bullet of ADR 0355's Decision (that the Puppeteer specs stay where they are).

**In plain words:** the project had two tools for driving a browser in tests, Puppeteer and
Playwright. Now it has one — Playwright — so there is one way to write a browser test, one way to
sign in, one set of waits, and one place the tests run (against real PostgreSQL).

## Context

[ADR 0355](0355-playwright-browser-tests.md) added Playwright (`tests/browser/`, CI job `browser`),
and left two older Puppeteer files behind: `apps/web/test/sale-slides.test.ts` and
`security-headers.test.ts`, which signed in with `signInInBrowser` and ran on the in-memory demo
store. Issue #496 asked for them to be ported to the Playwright suite and for the Puppeteer
dependency to go once nothing used it.

## Decision

- **Playwright is the surviving driver.** Issue #496 names it ("port the two Puppeteer specs onto the
  Playwright suite"); it is already the driver of the main suite, has `playwright.config.ts`,
  auto-waiting and web-first assertions (so no fixed sleeps), traces on failure, and starts the
  real server on real PostgreSQL.
- The two files became `tests/browser/sale-slides.spec.ts` and
  `tests/browser/security-headers.spec.ts`. The one check in `security-headers` that needs no
  browser (headers on every file, server time limits) stays a unit test in `apps/web/test/`.
- `signInInBrowser` is deleted; specs use `tests/browser/helpers.ts`'s `signIn`.
- **The `puppeteer` package is not removed.** It is a runtime dependency, not a test one:
  `packages/invoice-templates/src/pdf.ts` uses it to render every bill, note and e-way PDF (#398),
  and `apps/api/test/pdf-pool.test.ts` tests that pool. The issue called it a devDependency; it is
  in `dependencies`. Replacing the PDF renderer is a separate decision (it would be a stack
  change) and is not made here.

## Consequences

- One command, `npm run test:browser`, runs every browser test; the CI `browser` job runs it. It is
  not part of `npm run verify`, as before: `verify` runs in a job with no Chromium install.
- `npm test` no longer needs a Chromium at all.
- The ported sale test now meets the real PostgreSQL company, not the in-memory demo, and that
  showed two differences: a real company has not given the consent to ask the transport department
  about a vehicle (the demo is built with it given, and there is no screen to give it yet), so
  `tests/browser/db.ts` writes the same consent row the service would; and the app flags a
  same-supplier, same-day, same-total purchase as a likely duplicate, so the spec varies its
  amounts.
