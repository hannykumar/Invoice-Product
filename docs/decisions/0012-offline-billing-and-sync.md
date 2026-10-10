# D12 — Offline billing and sync: decide now, build later

- **Status:** Accepted, 7 Oct 2026
- **Decision id:** D12 (tracking issue #362, recorded by #339; feature is #317)
- **Who chose:** Chosen by the agent on the recommendation; the owner did not evaluate it technically — revisit if a reason appears.
- **Product impact:** none now. This changes how the database is shaped underneath so that #317 can
  be built later without a rebuild. When #317 is built it must obey every existing rule — in
  particular **stock never goes negative and there is no override** (rule 3, #262) and **numbers are
  unique and consecutive** (Rule 46(b)). Where an offline design would bend a rule, the rule wins.

## Context

Small-town counters lose signal daily (#317). Building offline billing is later work, but two
choices made now in Phase 2 would otherwise have to be undone: **how ids are made** (#365) and
**how invoice numbers and stock are allocated under concurrency** (#367).

Today a number is taken only at finalisation, inside the same transaction as posting and stock
(`packages/sales/src/service.ts`), from a sequence per company, branch and financial year, format
`INV/26-27/000001` (16 characters, `packages/sales/src/numbering.ts`). A series that cannot reach
99,999 bills a year is refused (`MIN_BILLS_PER_YEAR`). Stock availability is physical minus
reserved; overselling is always refused.

## Decision

**Ids.** Every record that a device could create offline (bills, lines, payments, stock
movements, parties, items) has a **UUID v7** id that the client may generate. Tables accept a
client-supplied id; the id doubles as the idempotency key for the create, so a re-sent sync is a
no-op. #365 uses `uuid` primary keys accordingly.

**Numbering — a series per device, not blocks.** Rule 46(b) allows several series. A device that
an Owner or Admin registers for offline use gets **its own number series**, exactly like a branch
series and validated by the same `validateSeries` (≤16 characters, ≥99,999 bills a year — so the
device code is short, e.g. `D1/26-27/0000001`). Bills made **offline** take the next number of the
device's series, on the device; bills made **online** keep using the branch series on the server.
Each series stays consecutive and unique with no gaps from unused blocks. #367's numbering must
allow a series to be owned by a device and keyed by (company, series code, financial year).

*Rejected:* blocks of numbers reserved per device from the shared series — unused numbers in a
returned block leave gaps and out-of-date-order numbers that would need a voided-number register.

**Stock — an allowance per device, so stock can never go negative.** While online, a device is
given a **stock allowance** per item: a **reservation** against the server's stock (availability
already is physical minus reserved). Offline, the device may sell only within its allowance, and
refuses beyond it with the same wording as an online shortage. Because allowances are reserved on
the server, the devices together can never sell more than exists, so **no exception to rule 3 is
needed**. A stock-count adjustment that would cut physical stock below what is reserved waits
until the allowances are recalled or the devices sync. #367's reservation design must allow a
reservation held by a device.

**Sync.** On reconnect the device sends its documents in order. The server re-runs the same
deterministic checks (GST rule versions, totals, stock). Anything that does not agree — a changed
rate, a price, a revoked allowance — goes to the **exception queue** (rule 8) for a person to
resolve; nothing is silently posted or silently changed. A bill already handed to a customer keeps
its number; its posting waits in the exception queue until resolved.

**Government calls** (IRN, e-way bill) made from offline bills queue in the outbox and run on
reconnect, shown as tasks on Home.

## Alternatives

- **No offline numbering** (drafts only offline, numbered on sync): the customer leaves without a
  final bill — fails #317's purpose.
- **Let stock go negative on conflict and raise an exception**: breaks rule 3 and #262. Not taken.

## Consequences

- **#365:** client-generatable UUID v7 primary keys; `origin` (server or device id) and
  `device_issued_at` beside `created_at` on documents.
- **#367:** series keyed by (company, series code, FY) where the code may belong to a branch or a
  device; reservations may be held by a device; tests for two devices plus the server.
- Offline GST calculation needs the domain packages to run in the browser; that is #317's work.
- Revisit if pilot counters find allowances too small; the fallback is "online only for
  stock-tracked items", never negative stock.

## Checked against the handbooks (10 Oct 2026)

- #9 numbers bills "by company/branch/financial year": a device series is one more series of the
  same kind, checked by the same code. Online numbering is unchanged.
- #12 and the handbooks' rule list allow negative stock only with an authorised override; the
  owner later removed the override (#262). The allowance design satisfies both: stock cannot go
  negative at all.
- #38 asks for "offline-friendly draft protection where practical": already built (unfinished
  forms are kept on the device) and unaffected.
- #26 and #27 require that a retry never creates a second IRN or e-way bill: queued government
  calls carry the document's idempotency key.
- Nothing here removes or delays a handbook feature; #317 adds one.
