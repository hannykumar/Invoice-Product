# D6 — Rate-limit and cache store: Postgres

- **Status:** Accepted, 7 Oct 2026
- **Decision id:** D6 (tracking issue #362, recorded by #339)
- **Who chose:** Chosen by the agent on the recommendation; the owner did not evaluate it technically — revisit if a reason appears.
- **Product impact:** none. This changes how Karobar is built underneath, not what it does for the shopkeeper.

## Context

There is no rate limiting anywhere, including sign-in. Limits must hold across two instances and
across deploys. Peak load in year one is ~100 requests a second (system design §7.2).

## Decision

- **Postgres** fixed-window counters keyed by (scope, key, window). Short-lived request counters
  may live in an `UNLOGGED` table (losing them in a crash only resets windows). **OTP daily caps
  and paid-call quotas live in an ordinary table**, because they cost money.
- No shared application cache at launch. Any later cache key includes `company_id`.

## Alternatives

- **Redis / Valkey** (DigitalOcean offers it in BLR1). Faster, but one more service and bill for
  load we do not have.
- **In-process memory.** Resets on deploy and does not hold across instances — fails the gate.

## Consequences

- One counter write per limited request. Revisit only if a load test (#361) says Postgres is the
  limit.
