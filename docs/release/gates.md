# Financial correctness release gates

**Issue #48 [E48], owned by GPT 1.** Run by CI on every build:

```sh
npm run gates
```

It exits non-zero when a critical invariant is violated, which is what makes it a gate rather than
a report. It is part of `npm run verify`, so a release condition nobody runs cannot happen.

## What is checked

| Gate | What it means to a business | Severity |
| --- | --- | --- |
| `LEDGER_VOUCHERS_BALANCE` | Every recorded entry puts the same amount on both sides | Critical |
| `LEDGER_TRIAL_BALANCE` | The two sides of the books come to the same figure | Critical |
| `STOCK_NEVER_SILENTLY_NEGATIVE` | Stock never goes below zero without someone allowing it and saying why | Critical |
| `TAX_PARTS_SUM_TO_TOTAL` | The parts of the GST on a bill add up to the GST charged | Critical |
| `RETRY_IS_IDEMPOTENT` | Pressing the button twice records one thing | Critical |
| `APPROVED_RULES_CITE_A_SOURCE` | Every settled compliance rule names its source and effective date | Critical |
| `FINAL_RECORDS_ARE_IMMUTABLE` | A finished record is never quietly changed | Critical |
| `GOLDEN_DATASET_MATCHES` | The four example businesses still produce their exact figures | Critical |
| `UNCERTAIN_MODEL_OUTPUT_IS_ASKED_ABOUT` | Anything the app was unsure it heard is asked about, not assumed | Critical |

## How it is built, and why that shape

Each gate is a **pure function over an observation**. The runner gathers the observation by
exercising the real modules — posting entries, retrying one, taking stock below zero, replaying the
golden businesses, starting a voice session from a poor recording — and the gate judges it.

That separation is the point. A checker that gathers its own evidence can gather evidence that
suits it, and a gate nobody can feed a broken input to is a gate nobody has proved can fail. Every
invariant has a test that hands it a deliberately corrupted observation and **requires** a failure.

## Failing closed

Three ways a build is stopped even when nothing said "wrong":

1. **A gate that throws** while being evaluated is a failure, not a skip. The moment a check cannot
   run is the moment something is wrong enough to matter.
2. **A gate that examined nothing** is a failure. `0 problems found in 0 things` gives the same
   green tick as a real pass, and the two are not the same statement.
3. **An observation that cannot be gathered at all** exits non-zero from the CLI. A build we cannot
   inspect is not a build we may ship.

## Severity policy

- **Critical** — the release stops. Every financial invariant above is critical, because each one
  is a way the product could tell a business something untrue about its own money.
- **Major** — the release may proceed with the failure recorded and an owner's decision. Reserved
  for gates about degraded behaviour rather than wrong figures. None today.

There is deliberately no "warning" level. A financial check that a release may ignore is a check
that will be ignored.

## Release checklist

Before a build is released:

1. `npm run verify` is green, which includes `npm run gates`.
2. Any defect found since the last release is in `REGRESSION_REGISTER` with the test that guards
   it — checked by `packages/release-gates/test/regressions.test.ts`, so a missing test fails CI.
3. Anything unsupported is written down in the relevant contract's *Known limitations*, not left
   for a user to discover.
4. Rule changes since the last release have a source and an effective date, and the compliance
   register (#54) shows the reviewer.

## Rolling back

Roll back immediately, without waiting for a fix, if any of these is seen in production:

- The books do not balance for any company.
- A posting was recorded twice for one action.
- Stock went negative with no override recorded.
- A GST figure on an issued bill disagrees with its own parts.
- A finished record changed without a reversal beside it.

The first three are unrecoverable by the user and grow worse with every transaction after them.
A rollback is cheaper than a reconciliation, and both are cheaper than a business filing a return
on figures we got wrong.

## What this does not promise

It does not promise that no financial error is possible — that is one of the issue's stated
non-goals and it would not be true. It promises that these particular ways of being wrong are
checked on every build, that the checks have been shown to fail when they should, and that
anything found once is guarded for good.

## Known limitations

- The observation runs the modules **in memory**. It exercises the real services and the real
  rules, but not Postgres, so a defect that only appears under a real transaction is not covered
  here. That belongs with #44's end-to-end work.
- Purchases (#17), returns (#45) and government submissions (#26, #27) are not yet in the
  observation, so "duplicates an IRN on retry" from the issue's own example is guarded by the
  idempotency gate in principle but not yet exercised on an IRN. When those land, the observation
  extends; the gates do not change shape.
- The AI gate covers the voice assistant's confidence threshold. Document extraction (#15, GPT 3)
  has its own confidence handling and is not observed here.
