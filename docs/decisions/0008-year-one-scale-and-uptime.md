# D8 — Year-one scale and uptime

- **Status:** Accepted, 7 Oct 2026
- **Decision id:** D8 (tracking issue #362, recorded by #339)
- **Who chose:** The owner (business answer). Uptime and recovery targets proposed by the agent; owner to confirm RPO/RTO.
- **Product impact:** none. This changes how Karobar is built underneath, not what it does for the shopkeeper.

## Context

Without a scale target nobody knows which part breaks first or what to load-test.

## Decision

| Target | Value |
| --- | --- |
| Active companies at month 12 | **1,000**; design for 10,000 without re-architecture |
| Bills per company per day | **30** average; a busy counter 300; festival days 3× |
| Uptime | **99.5%** a month (~3.6 hours), one region |
| Recovery | RPO ≤ 5 minutes, RTO ≤ 4 hours (proposed) |
| Speed | p95 < 500 ms for everyday actions; reports < 3 s or a background job |

Derived (math in `docs/system-design.md` §7): ~33 requests/s at a normal peak hour, ~100 at a
festival peak; ~110 GB database and ~275 GB files at the end of year one; first bottleneck is
**database connections**.

## Alternatives

- 99.9% uptime: needs a hot standby and zero-downtime migrations from day one; more cost than a
  new product needs.

## Consequences

- Load tests (#361) run at 100 requests/s with headroom.
- Connection pooling and "no external call inside a transaction" are required, not optional.
