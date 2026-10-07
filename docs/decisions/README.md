# Decision records

One file per decision: Context, Decision, Alternatives, Consequences. A decision is changed by a
new record that supersedes the old one, never by editing an accepted record.

**Every record here changes how Karobar is built underneath, not what it does for the
shopkeeper.** The eight rules, the supported scope and the out-of-scope list in
[`docs/product/00-principles-and-scope.md`](../product/00-principles-and-scope.md) are unchanged
by all of them. A decision that would change the product's behaviour or scope is not taken here;
it is raised on #362.

**Who chose.** D8 and D10 are business answers from the owner. Every other record was **chosen by
the agent on the recommendation in #339; the owner did not evaluate it technically — revisit if a
reason appears.** The owner's clicks during the interview are treated as provisional for the same
reason.

| # | Record | Decision | Blocks |
| --- | --- | --- | --- |
| D1 | [0001](0001-login-identity.md) | Supabase Auth in Mumbai; phone OTP + email; our own session and permissions | #342 |
| D2 | [0002](0002-session-cookie.md) | Opaque session id in an `HttpOnly; Secure; SameSite=Lax` cookie, Origin check | #342 |
| D3 | [0003](0003-hosting-india-region.md) | DigitalOcean Bangalore (BLR1), managed Postgres with point-in-time recovery | #356 |
| D4 | [0004](0004-input-validation-zod.md) | Zod at the HTTP boundary only | #344 |
| D5 | [0005](0005-background-jobs-postgres-queue.md) | Our existing queue, persisted in Postgres, run by a worker process | #345 |
| D6 | [0006](0006-rate-limit-store-postgres.md) | Postgres counters | #350 |
| D7 | [0007](0007-errors-and-logs.md) | Sentry (EU region), ids only; JSON logs in the platform | #358 |
| D8 | [0008](0008-year-one-scale-and-uptime.md) | 1,000 companies, 30 bills/day, 99.5% uptime | #361 |
| D9 | [0009](0009-payments-razorpay.md) | Razorpay; verified webhooks are the source of truth | #346 |
| D10 | [0010](0010-retention.md) | 8 years from the end of the financial year (legal to confirm) | #352 |
| D11 | [0011](0011-pen-test.md) | External pen test before the first paying customer | #362 gate |
| D12 | [0012](0012-offline-billing-and-sync.md) | Device ids, a number series per device, stock allowances per device; build later | #365, #367, #317 |
| D13 | [0013](0013-data-residency.md) | Books, files, backups and identity in India; foreign vendors get ids only | #352, all vendors |

The unit-of-work decision (one business action = one transaction, transactional outbox) is
recorded with #363, not here.
