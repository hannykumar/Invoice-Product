# D7 — Errors and logs: Sentry EU, ids only

- **Status:** Accepted, 7 Oct 2026
- **Decision id:** D7 (tracking issue #362, recorded by #339)
- **Who chose:** Chosen by the agent on the recommendation; the owner did not evaluate it technically — revisit if a reason appears.
- **Product impact:** none. This changes how Karobar is built underneath, not what it does for the shopkeeper.

## Context

The API logs with `console.log`, has no request id and no error tracker. Sentry stores data only
in the US or the EU (Frankfurt), never India
([Sentry data location](https://www.sentry.help/en/articles/13965013-where-are-your-data-servers-located)).
D13 gives a tool that does not need customer data ids only.

## Decision

- **Sentry, EU region**, on API, worker and web. `sendDefaultPii` off; every event passes through
  `ops/security` `redactForLog` before sending; context carries request id, company id and user
  id only. Source maps uploaded, not served.
- **Logs:** structured JSON to stdout, one line per event, with request id, company id and user
  id, through the existing redactor. Kept in the platform's own logs (in India). A log drain to
  another service is added only if it receives the same ids-only lines.
- Staging and production are separate Sentry environments.

## Alternatives

- **Self-hosted GlitchTip in BLR1.** Full residency; one more thing to operate.
- **Platform logs only.** Cheapest; much slower to debug.

## Consequences

- An error reaches the tracker with a readable stack but no names, phone numbers, GSTINs or
  amounts. Debugging uses the ids to look up the record in our own database.
- Cost: Sentry Team ≈ US$26/month.

## Checked against the handbooks (10 Oct 2026)

Handbook #41 asks for structured logs, metrics, traces, health checks, queue and dead-letter
visibility, and support access by consent; every issue says "without logging secrets". This
record adds an error tracker and a log format underneath; the Operations screen, support grants
and status page from #41 are unchanged.
