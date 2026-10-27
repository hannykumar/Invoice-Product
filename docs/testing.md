# Testing strategy — what may be mocked, and the flows that must never break

**Issue #355.** This is the house rule for what a test is allowed to pretend, and the written map
of the browser suite. It sits next to `docs/release/gates.md` (the release conditions) and
`docs/security/threat-model.md` (what an attacker would try).

## The one rule that decides everything

**Only external providers are mocked. The database and the permission checks are never mocked.**

Government portals (GSP, IRP), banks, messaging and payment providers, and OCR sit behind
`connector-v1` adapters, and development and tests use the mock adapters. That is the whole of
what a test may fake. Everything the business is made of — the books, stock, tenancy,
permissions, preview–approve–record — is exercised for real in every layer that touches it.

Why that shape: a bug that only appears when the ledger is real, or when another company's id is
asked for, or when the second click hits an in-flight transaction, is exactly the bug a mock
hides. The cost is that tests need PostgreSQL; that cost is accepted, and CI carries a real
Postgres for it.

## The four layers

| Layer | Command | Store | What it proves |
| --- | --- | --- | --- |
| Unit | `npm test` | in-memory | Rules: arithmetic, verdicts, numbering, wording, edge cases. Fast, no setup. |
| Integration | `npm run test:integration` | real PostgreSQL | Every API route: validation, tenancy, permissions, idempotency, immutability, transactions. |
| Browser | `npm run test:browser` | real PostgreSQL + the real server | The flows below, driven as a shopkeeper drives them. |
| Release gates | `npm run gates` | real modules | The financial invariants in `docs/release/gates.md`, each proven to be able to fail. |

`npm run verify` runs lint, unit, integration and gates — what CI runs on every push. The
browser suite is a separate CI job, because it needs a Chromium install.

## The flows that must never break

Nine flows get a real-browser test, in `tests/browser/`, each driven through Chromium against
the real web server on PostgreSQL:

| Flow | Spec | What the test checks |
| --- | --- | --- |
| Sign-up and sign-in | `auth.spec.ts` | The stand-in code signs the demo owner in; a wrong code is refused; a new address signs in and is told no business has added it; the signed-in owner reaches their own screens. |
| Opening a business | `setup.spec.ts` | The setup wizard: check the answers, create the business, the books balance. |
| Make a bill | `bill.spec.ts` | Item, customer, Next, Make bill — the done screen carries the bill number and the exact total. |
| Record a purchase | `purchase.spec.ts` | A supplier bill is previewed and confirmed; the recorded box repeats the supplier, their bill number and what is owed. |
| Prepare a GST return | `gst-returns.spec.ts` | A month with real purchases and sales is prepared and approved; the figures are then fixed. |
| Upgrade plan | `plan.spec.ts` | Choosing a different plan changes the plan shown on the screen. |
| Invite a teammate | `team.spec.ts` | The Team screen produces an invite link. |
| Sale in slides | `sale-slides.spec.ts` | The sale by keyboard (₹50,150 and the e-way bill raised by itself), a three-tap walk-in sale, and the 600 KGS refusal with the purchase hand-off (#305, #311). |
| Page security | `security-headers.spec.ts` | The page under its content policy, a hostile name staying text, the bill frame's policy and sandbox (#349, #399). |

Browser tests assert what the shopkeeper reads — the bill number, the rupee total, the badge the
books earn — not implementation details.

## How a browser test is written here

- **Arrange through the API, drive through the browser.** Goods, suppliers and customers are
  created through the same routes the screens call (`tests/browser/helpers.ts`), so a test needs
  no fixture database and nothing is pre-seeded it did not make itself.
- **Sign in on `/`, then navigate.** The app loads each screen's data when the screen is opened,
  and `openView` only re-runs on navigation — going to `/#plan` before signing in leaves the
  screen empty forever.
- **Wait for the catalogue before typing.** Pickers fill when `/api/catalogue` answers; the
  specs wait on the picker's options, never on sleeps.
- **Unique names every run** (`helpers.unique`), so a re-run never trips the duplicate checks.
  The fuzzy "a similar item already exists" verdict is acknowledged with `acknowledgeSimilar`,
  which is the flag the screen itself sends.
- **Sales need the caller's `requestId`** (required since #392); purchases and returns need it
  on the same routes.
- **The demo company is on the Free plan, which covers 50 bills.** The suite makes only a few per
  run, but dozens of local runs on one database use them up and Make bill answers "Nothing was
  saved". Re-seed the test database (drop it, then `npm run db:migrate && npm run db:seed`).
- **A `.skip` carries its reason in words** — where it is blocked, and what unskips it.

## One browser driver

Every browser test is a Playwright spec in `tests/browser/`, run by `npm run test:browser` — the
only browser-test command, and what the CI `browser` job runs. There is no second driver and no
browser test inside `apps/` or `packages/`; a unit test that needs a browser is a sign it belongs
here. (`puppeteer` stays in the dependencies for one reason only: it renders the bill PDFs in
`packages/invoice-templates`, see ADR 0496.) `npm test` and `npm run verify` need no browser.

Writing one: import `helpers.ts`, arrange through the API, sign in through the dialog, and wait with
web-first assertions (`expect(locator).toHaveText(…)`, `expect.poll(…)`) — never a fixed sleep.
`offline.ts` makes a page refuse any host but the local server. Things the API cannot arrange (the
vehicle-record consent, `db.ts`) are written to the test database that `global-setup.ts` already
insists is a test one.

## What a test must do

- Cover the failure paths a shopkeeper can hit: wrong input, permission denied, another
  company's id (→ 404, never data), a retry, a duplicate, a provider outage — not just the happy
  path.
- Assert the outward fact, not the convenient one. A test that would pass if the feature broke
  is worse than no test; treat finding one as finding a bug in the suite and file an issue for
  it — do not quietly fix it (see below).
- Respect immutability: posted records are corrected by reversal, never edited.
- Concurrency invariants (numbering under a race, last-item stock, double-submit, allocations —
  #367) are tested against real PostgreSQL; they belong to this suite's contract even though
  they live in `test:integration`.

## Finding a test that lies

The suite is reviewed like the code is. The things that get an issue filed, not a quiet fix:

- a test that would still pass if the feature it names broke;
- an assertion against a mock's own reply (a test proving the mock works);
- a `.skip` with no written reason, or a flake papered over with `retries`;
- a flow or failure path with no test at all.

Real problems found in this review are filed as their own issues, one each, so nobody has to
read a changelog to know the suite still means what it says.

## Fixing a bug is a test first

A bug fix starts with the test that fails for the bug, then the change that turns it green —
the test proves it could have caught the bug. This is the same contract the release gates keep:
an invariant nobody proved can fail is an invariant nobody trusts.
