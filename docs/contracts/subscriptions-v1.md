# Subscriptions, entitlements and usage contract v1

Owner: GPT 1, built for GPT 2's issue #42. Consumers: the API boundary, and any module that wants
to know whether a company may do something.

`packages/subscriptions` decides **what a company is entitled to today**, counts what it has used,
runs the trial and subscription lifecycle, and issues our own invoices for the service. It holds no
business data of its own and can delete none.

## The three rules the rest follows from

**1. A plan may withhold convenience. It may never withhold correctness.**
`ESSENTIAL_CAPABILITIES` — every compliance warning, the balance and negative-stock checks, the
audit trail, and getting your own data out — are allowed in **every** plan and **every** state,
including an expired one. `definePlan()` **throws** if a plan tries to limit one, so this is a
property of the catalogue rather than a rule somebody has to remember. A shopkeeper on the free
plan is warned about a cancelled GSTIN exactly as loudly as one who pays.

**2. Nothing is ever deleted.** An unpaid plan ends in `READ_ONLY`: writing stops, reading,
exporting and every essential capability continue. There is no code path in this module that
deletes, hides or degrades a financial record — the word "delete" does not appear in it, and a test
asserts the books are byte-for-byte intact after a plan has lapsed and been revived.

**3. What was counted, and why, is on the record.** Every usage event carries an idempotency key,
so a retried invoice is counted once and a duplicate is not counted at all. Counters are only
touched inside a single synchronous step, so concurrent recording cannot lose an increment.

## Lifecycle

`TRIALING → ACTIVE → PAST_DUE → GRACE → READ_ONLY`, and `CANCELLED` from anywhere. A payment moves
any of them back to `ACTIVE` immediately. The state on a given date is **derived** from the
subscription's own dates by `stateOn(subscription, today)`; nothing depends on a job having run.

| State | Writing | Reading and export | Essential capabilities |
| --- | --- | --- | --- |
| `TRIALING`, `ACTIVE` | Yes, to the plan's limits | Yes | Yes |
| `PAST_DUE`, `GRACE` | Yes, to the plan's limits — with a warning | Yes | Yes |
| `READ_ONLY` | No | Yes | Yes |
| `CANCELLED` | No | Yes | Yes |

## Meters

`invoices`, `companies`, `storage_mb`, `ai_requests`, `external_api_calls`. A limit is a number per
month or `null` for no limit. Limits are counted per company and per calendar month.

## Entitlement

`check(actor, capability, today)` returns `ALLOWED`, `BLOCKED_READ_ONLY` or `BLOCKED_LIMIT`, with a
sentence a shopkeeper can read and what remains. Essential capabilities and reads are never
blocked. The answer never depends on a stored flag: it is computed from the plan, the subscription
dates and the counters at the moment it is asked.

## Payments and our own invoices

The provider sits behind #8's `ConnectorGateway` as connector kind `payments`; development runs on
the mock. A service invoice is `DRAFT → ISSUED → PAID`, or `FAILED` on a declined charge, and a
failure moves the subscription along the lifecycle rather than touching any business record.
Webhook events are deduplicated by the provider's event id at the gateway **and** here, so a
provider that sends the same event twice pays the invoice once.

Our invoice carries net, GST at 1800 basis points and total, in paise. **It is not yet a compliant
outbound GST invoice**: that needs our own GSTIN, which is issue #49, and it must then be issued
through #25 like any other sale rather than computed here.

## Permissions

`subscription.view`, `subscription.manage`. Usage recording is server-side and takes tenancy from
the authenticated actor, never from an argument.
