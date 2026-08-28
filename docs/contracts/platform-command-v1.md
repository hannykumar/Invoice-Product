# Platform command v1

Owner: GPT 2. Consumers: GPT 1 and GPT 3.

Every material command receives an authenticated `RequestContext` (company, branch, actor and granted permissions) plus a non-empty idempotency key. Server code derives tenancy from this context; a caller-supplied company identifier is never authorization.

Commands move through `draft`, `submitted`, `approved`, `rejected`, `finalised`, `failed`, or `cancelled`. A policy may require approval based on action, risk or amount. Invalid transitions, missing permissions, cross-tenant access and duplicate payloads return typed platform errors. State changes, approval decisions, overrides and failures append a redacted audit event. Low-confidence or contradictory facts must create an exception rather than finalise a business record.

