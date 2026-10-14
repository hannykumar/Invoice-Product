# D11 — External penetration test before the first paying customer

- **Status:** Accepted, 7 Oct 2026
- **Decision id:** D11 (tracking issue #362, recorded by #339)
- **Who chose:** Chosen by the agent on the recommendation; the owner did not evaluate it technically — revisit if a reason appears.
- **Product impact:** none. This changes how Karobar is built underneath, not what it does for the shopkeeper.

## Context

We hold books, bank details and PAN for other businesses. Internal review by a fresh session
catches a lot but not everything.

## Decision

- A **CERT-In-empanelled** tester tests **staging** after Phase 3 (security) passes and before the
  first paying customer. High and critical findings are fixed and retested before launch.
- Repeated yearly and after any major change to sign-in, tenancy or payments.

## Alternatives

- Within three months of launch; before the 100th customer. Both put real customer data at risk
  first.

## Consequences

- Estimated ₹1.5–4 lakh per test for a web app and API (estimate; get quotes).
- Blocks the pre-launch gate on #362.
