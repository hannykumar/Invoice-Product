# D4 — Input validation: Zod at the HTTP boundary

- **Status:** Accepted, 7 Oct 2026
- **Decision id:** D4 (tracking issue #362, recorded by #339)
- **Who chose:** Chosen by the agent on the recommendation; the owner did not evaluate it technically — revisit if a reason appears.
- **Product impact:** none. This changes how Karobar is built underneath, not what it does for the shopkeeper.

## Context

About 150 routes in `apps/api/src/server.ts` validate input by hand, inconsistently. Unknown
errors can leak their message as a 400.

## Decision

- **Zod**, at the HTTP boundary only. Each entry in the new route table (#344) declares method,
  path, permission and a Zod schema; a route cannot be added without one.
- Domain packages stay dependency-free and keep their own invariants (paise as `bigint`, balanced
  vouchers). Zod checks shape; the domain checks meaning.
- Validation failures return 400 in the existing error shape `{state, title, code, message}`.

## Alternatives

- **Our own validator in `packages/kernel`.** No dependency, but we would build and maintain a
  schema library.

## Consequences

- One new production dependency, with no dependencies of its own.
- Money still arrives as strings of paise and is converted to `bigint` by the schema; no floats.
