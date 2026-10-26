# ADR 0355 — Playwright for the browser suite

Status: **accepted** (issue #355).

**In plain words:** the flows that must never break — signing in, making a bill, recording a
purchase, preparing a GST return, choosing a plan, inviting a teammate — are tested the way a
shopkeeper drives them: in a real browser, against the real server, on real PostgreSQL. The tool
that drives the browser is Playwright.

## Context

Issue #355 names Playwright as the browser-test tool for the SaaS-readiness plan (Phase 4), which
is the owner's approval for the dependency. `docs/testing.md` records the rule the suite obeys:
only external providers are mocked — never the database or the permission checks.

`@playwright/test` is a devDependency only; nothing it ships runs in production.

## Decision

- `@playwright/test` drives Chromium. `playwright.config.ts` starts the real web server
  (`npm run web`) with `NODE_ENV=test` and the same `DATABASE_URL` shape CI provides, so the
  tests need no fixture build and no second composition of the app.
- Tests live in `tests/browser/` outside `apps/` and `packages/` because they span the whole
  product rather than one module.
- One worker, no retries: shared seeded data would make parallel workers race, and a retry would
  hide the flakes this suite exists to catch.
- The existing Puppeteer specs (`apps/web/test/sale-slides.test.ts`,
  `security-headers.test.ts`) stay where they are for now; consolidating the two drivers is
  tracked in #496, and the in-memory store they run on in #494.

## Consequences

- CI gained a `browser` job that installs Chromium each run (uncached, roughly a minute).
- `npm run lint` now type-checks `tests/browser/` and `playwright.config.ts`; the rest of
  `tests/` was never under tsc — that gap is #498.
- New dependencies of this kind keep needing an ADR like this one.
