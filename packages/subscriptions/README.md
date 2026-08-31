# `@invoice/subscriptions` — plans, entitlements and usage (issue #42)

Decides **what a company is entitled to today**, counts what it has used, runs the trial and
subscription lifecycle, and issues our own invoices for the service. Contract:
[`docs/contracts/subscriptions-v1.md`](../../docs/contracts/subscriptions-v1.md).

Three rules carry the rest:

1. **A plan may withhold convenience. It may never withhold correctness.** Every compliance
   warning, the balance and negative-stock checks, the audit trail and getting your own data out
   are allowed in every plan and every state, including an expired one — and `definePlan()`
   **throws** if a plan tries to limit one.
2. **Nothing is ever deleted.** An unpaid plan ends in `READ_ONLY`: writing stops; reading,
   exporting and every warning continue. There is no delete path in this module, and a test asserts
   the trial balance is identical before and after a plan lapses.
3. **What was counted is on the record.** Every usage event carries an idempotency key; the counter
   is read and written without yielding, so a retry counts once and two tills at the same instant
   count two.

```sh
npm run demo:subscriptions   # a free plan filling up, an upgrade, a declined card, and a lapse
npm test                     # 27 tests over the real ledger, sales and reports
npm run web                  # "Your plan" in the running app
```

Not reimplemented here: #8's connector gateway carries the payment provider, #3's permissions gate
the screen, and #35's reports are what the "nothing was deleted" test reads back.
