# D9 — Payments: Razorpay, webhooks as the source of truth

- **Status:** Accepted, 7 Oct 2026
- **Decision id:** D9 (tracking issue #362, recorded by #339)
- **Who chose:** Chosen by the agent on the recommendation; the owner did not evaluate it technically — revisit if a reason appears.
- **Product impact:** none. This changes how Karobar is built underneath, not what it does for the shopkeeper.

## Context

`packages/subscriptions` models plans and states (TRIALING, ACTIVE, PAST_DUE, GRACE, READ_ONLY,
CANCELLED) with a mock payment provider. Payments are Phase 4 (#346); a pilot can be invoiced by
hand.

## Decision

- **Razorpay Subscriptions** (UPI autopay, cards, netbanking), behind the existing payments
  connector.
- **Signature-verified webhooks are the source of truth** for subscription state; the browser's
  "payment succeeded" is never trusted. Processed event ids are stored; a replayed event changes
  nothing ([Razorpay subscription webhooks](https://razorpay.com/docs/webhooks/subscriptions/)).
- Test-mode keys only until launch. One `hasFeature(company, feature)` check.
- A lapsed company becomes read-only with full export (D10), never locked out of its own books.

## Alternatives

- **Cashfree.** Comparable; Razorpay has the wider subscription tooling.
- **Manual invoicing for year one.** Acceptable for a pilot only.

## Consequences

- Razorpay is an Indian company; it receives the paying owner's billing details, which D13
  allows. Fee ≈ 2% per transaction.
