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

Seven flows get a real-browser test, in `tests/browser/`, each driven through Chromium against
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
- **A `.skip` carries its reason in words** — where it is blocked, and what unskips it.

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

## Database connections in integration tests (#504)

A flake that says `terminating connection due to administrator command` (57P01) or `Connection
terminated unexpectedly` is a connection the server ended, reported on whichever test happens to be
running. Its causes are all fixed in shared code, so a test never has to defend against them:

- **Always get a pool from `createDatabase()`.** It handles the pool's `error` event (an idle
  connection ended by a restart, failover or `pg_terminate_backend`) and the checked-out client's
  `error` event (a connection ended mid-action), so neither becomes an uncaught exception.
  `pool-errors.integration.test.ts` kills connections on purpose, 25 rounds in one process, to keep
  this true. Never build a bare `new Pool()` in a test or in production code.
- **A test that runs a migration down and up, or needs a schema of its own, uses
  `withScratchDatabase(owner, url, prefix, work)`** from `packages/platform/test/scratch-database.ts`.
  It takes the scratch-database advisory lock so such tests take turns, closes the scratch pool
  *before* dropping the database, and drops without `WITH (FORCE)`, which would end other
  connections. Do not hand-roll `CREATE DATABASE` / `DROP DATABASE`.
- **Close every pool you open** (`await db.close()`, in `finally` or `after`). Only end connections
  you named yourself (`application_name`), never `pg_terminate_backend` on a role or database other
  files share.
- Do not add `retries`, sleeps or a catch-all `uncaughtException` handler to make this go away: find
  which connection was ended, and by whom.

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

## Tests that talk to a raw socket or to an upload the server refuses (issue #497)

`apps/api/test/http-hardening.test.ts` once never finished on macOS. A client that is still sending
when the server closes the connection sees `EPIPE`/`ECONNRESET`: Linux usually still hands over the
reply the server sent first, macOS reports the reset instead. A helper that ignored those errors left
its promise pending for ever. The server now reads and drops the rest of a refused upload (so the 413
arrives), and the test file follows these rules — copy them:

- Connect to `127.0.0.1`, never `localhost` (macOS tries `::1` first).
- Settle on **every** outcome: an `error` handler must reject, not return quietly.
- Bound every wait and give every test its own `{ timeout }`, so a stall is a named failure.
- `agent: false` (or a non-keep-alive agent) per request; in `after`, call `server.close()` and
  `server.closeAllConnections()` so teardown never waits on a client.
