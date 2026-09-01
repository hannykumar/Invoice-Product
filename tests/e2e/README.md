# End-to-end workflow and failure tests

Issue #44 owns this directory. These tests compose the **real** domain services across package
boundaries. They do not replace feature-level tests, and they do not accept mock-only success as
completion.

## Why these exist at all

Every module here is well tested on its own, and that is exactly the problem this directory
addresses: each module's tests feed it a fixture shaped like its own idea of the modules around it.
Two modules can both be perfectly correct against their own fixtures and still disagree with each
other — and the disagreement lives in the seam neither one's tests can see.

Both regressions in the register were found that way, on the first run of a new scenario:

- a supplier bill recorded twice when two posts raced each other, because the duplicate check sat
  outside the transaction;
- no real sale could be put on GSTR-1 at all, because the adapter read a field the sales module does
  not have and expected a quantity in a shape it never produces.

Neither was findable inside a single module. Both are now pinned by a test.

## The scenarios

| File | What it holds to account |
| --- | --- |
| `business-cycle.test.ts` | Purchase → stock → sale → receipt → bank reconciliation, through refusals and retries |
| `returns-cycle.test.ts` | Sale and purchase returns: stock back, tax reversed, party balance down, damaged goods quarantined |
| `compliance-outage.test.ts` | The e-invoice seam with the portal healthy, down, timing out and recovering |
| `gst-outputs.test.ts` | GSTR-1 and 3B reconciled against the ledger the sales actually posted |
| `concurrency.test.ts` | Two tills, one last pallet; a payment button pressed twice; a bill posted twice at once |
| `backup-restore.test.ts` | A real day of trading backed up, moved on from, and restored |
| `volume.test.ts` | A month of a busy small trader, and whether anything is quietly quadratic |
| `regressions.test.ts` | That every entry in the register is still pinned by a test that exists |

`harness.ts` builds the business every scenario shares: the real ledger, inventory, purchase
posting, sales, receivables and returns services, joined to one unit-of-work store. The only
stand-ins are at the edges the product itself replaces — the government portals and the bank, which
are the synthetic connectors reached through the same gateway production uses. That is what makes
failure injection meaningful: flipping the synthetic IRP to `outage` exercises the real retry, the
real idempotency and the real recovery.

## The rules these scenarios enforce

- The books balance at the end of every scenario, without exception.
- A refusal leaves nothing behind: no voucher, no movement, no half-changed balance.
- One idempotency key never becomes two documents, whether the retry is sequential or concurrent.
- Stock never goes negative without an authorised override.
- A government service being down never costs the shopkeeper the sale, and a call that timed out is
  never shown as a registered e-invoice.
- What the GST return says is what the ledger says, checked by reading the two through different
  paths.

## The regression register

`regressions.ts` is the register the third acceptance criterion asks for. Each entry names the test
that fails if the fault returns, and `regressions.test.ts` fails the build if that test has been
renamed or deleted. Add an entry when something that used to work stops working, or when a real
user or a real integration finds something that was always broken. Do not add one for a feature that
was never built, or for a bug the module's own tests caught before it reached anybody.

## Running them

They run in CI on every push and pull request, inside `npm run verify`. On their own:

```bash
node --test --experimental-strip-types "tests/e2e/*.test.ts"
```

## Still to come

Document and WhatsApp ingestion end to end, the e-way-bill lifecycle under outage alongside the
e-invoice one, live bank-feed adapters, and the IMS/GSTR-2B reconciliation against a real inward
position rather than a stated one.
