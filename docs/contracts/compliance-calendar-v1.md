# Compliance calendar and preventive alerts — v1

Issue #32 [E32]. Owner: GPT 3. Package: `packages/compliance-calendar`
(`@invoice/compliance-calendar`).

Warn a business before a filing, IRN, e-way, correction or reconciliation deadline — early enough,
and with enough of the reason, that somebody actually acts.

## The line this module will not cross

> A calendar that only prints dates is a wall planner.

Every warning this module raises names the rule it came from and its version, the deadline, the
records that are unresolved underneath it, and the one thing to do next. An alert that cannot say
which rule produced it is an opinion, and an alert with no next action is a worry. The consequence
comes from the modules that own the facts — the purchase reconciliation (#31), the return workspace
(#30), the IRN lifecycle (#26), the e-way bills (#27) — and is repeated, never recomputed here.

## Three guarantees, each enforced rather than intended

| Guarantee | How it is enforced |
| --- | --- |
| Alerts identify rule, deadline, affected records and next action | `buildAlert` is the only way an alert exists, and it copies `code`, `version`, `reviewState`, `sourceRef`, `dueDate`, every signal's `affected` records and an `actionCode` onto the alert. The next action is taken from the most severe unresolved signal, so "review the unmatched bills" outranks "file the return". |
| Changed deadlines update without rewriting history | An occurrence's identity is `code:periodKey` and carries no date. A new deadline updates that one row and appends a `DueDateRevision` holding the previous date and version; a completed occurrence is frozen and never re-dated. Which version governs a period is decided by the period's own end date, so a rule effective in October cannot re-date July. |
| Completed obligations stop escalating | `nextLadderStep` returns nothing for a `COMPLETED` or `NOT_APPLICABLE` occurrence, at every level, permanently. Completion requires evidence (`validateEvidence`), which is why the silence is safe. |

## The words, once

- **Obligation definition** — an effective-dated, versioned rule with a due-date calculation in it,
  its notification reference, and a review state.
- **Occurrence** — one obligation, for one company, for one period. Its key carries no date.
- **Ladder** — the rungs a warning climbs: `EARLY → DUE_SOON → DUE_TODAY → OVERDUE → ESCALATED`.
- **Signal** — something unresolved elsewhere that this deadline will run into.

## The data

`ObligationDefinition` — `code`, `version`, `kind` (`STATUTORY` or `POLICY`), `cadence`,
`effectiveFrom`/`effectiveTo`, `applicability`, `dueRule`, `dueDateShift`, `ladder`, `consequence`,
`nextAction`, `actionCode`, `sourceRef`, `reviewState`, and `declaredBy`/`declaredBasis` when a
business supplied the date itself.

`ObligationOccurrence` — `key`, `period`, `dueDate`, `actionableBy`, `status`, `snooze`,
`completion`, `revisions`, `highestAlertLevel`.

`ComplianceAlert` — `level`, `audiences`, `dueDate`, `daysRemaining`, `headline`, `detail`,
`nextAction`, `actionCode`, `signals`, `affected`, `deduplicationKey`.

`ComplianceException` — an obligation that could not be placed, with the missing facts and the
question to ask.

Money is `Money` in paise. Dates are `IsoDate` calendar dates in India; instants are UTC and are
crossed exactly once, in `todayIn`.

## Deadlines, working days and time zones

- The deadline is whatever the rule says. It does **not** move because it falls on a Sunday or a
  holiday: the portal accepts filings and no notification says otherwise, and sliding the date
  would be inventing an extension nobody granted. `DueDateShift` exists for rules that genuinely
  shift and defaults to `NONE`.
- The **reminder** moves. `actionableBy` is the last working day at or before the deadline, and
  every rung at or before the due date is hung on it. Sundays are never working days; Saturdays
  follow the company. Holidays are supplied through `HolidayCalendarPort` — they differ by state,
  change every year, and a built-in list would be wrong within twelve months.
- `todayIn(clock, timeZone)` is the only bridge from an instant to a date. A sweep at 19:30 UTC on
  the 19th is already the 20th in India, and the summary return is due today.

## Applicability, and what happens when a fact is missing

Applicability is computed per obligation from the company's own profile: registration type, filing
frequency, whether e-invoices are required, whether goods move, and the state. A missing required
fact produces `CANNOT_DECIDE` — never `DOES_NOT_APPLY` — and the obligation becomes a
`ComplianceException` carrying the question to ask, in both languages. Defaulting to monthly
because most businesses are monthly would be a compliance fact invented by a computer, and the
business it is wrong for is exactly the one that needed the calendar.

`CompanyComplianceProfile.calendarFrom` marks the date from which this product is answerable for
the company. Deadlines that fell before it are not created: the returns were filed, or missed,
somewhere this product cannot see, and an accusation made out of an absence of data is not a
warning.

## The escalation ladder

One rung per occurrence per run, deduplicated by `compliance:{occurrenceKey}:{level}:{dueDate}`.

- Only the **highest** rung now due is rung, so a week of silence does not produce five messages.
- A ladder never goes backwards: `highestAlertLevel` is cleared only when the deadline moves, which
  is what makes an extension start a fresh ladder for the new date.
- A snooze silences `EARLY` and `DUE_SOON` only. `DUE_TODAY`, `OVERDUE` and `ESCALATED` cannot be
  silenced by anybody, a snooze must end, and it may never be set past the deadline itself.
- Alerts are `internal` under #39's policy, which means in-app and email. A delivery failure is a
  failure of delivery only: the alert exists, it shows in the app, and no compliance record changes.

## Completion evidence

`ARN`, `PORTAL_RECEIPT`, `IRN` and `PAYMENT_CHALLAN` require a reference. `SOURCE_MODULE` is used
when #26 or #27 reports a document resolved. `TYPED_CONFIRMATION` requires a note naming who filed
it and where they saw it — the proof is very often on a screen this product cannot reach, and the
honest options are to accept a person's word on the record or to keep shouting at a business that
has already filed. The acknowledgement number is not pattern-checked: its format has changed
before, this product cannot verify one, and a validator that rejected a real number would stop a
business recording something true.

## Permissions

`compliance.calendar.view`, `.refresh`, `.complete`, `.snooze`, `.escalate`, `.declare`. Silencing a
warning is deliberately a different permission from reading one.

## Ports this module consumes

| Port | Owner | Used for |
| --- | --- | --- |
| `ObligationDefinitionPort` | this module (#32), with declared entries per company | The rules in force |
| `CompanyProfilePort` | onboarding (#7) | Registration, filing frequency, state, time zone |
| `HolidayCalendarPort` | the business or #7 | Non-working days |
| `DeadlineEventPort` | #26, #27 | Deadlines that come from one document |
| `ComplianceSignalPort` | #30, #31, #26, #27 | What is unresolved beneath a deadline |
| `ComplianceContactPort`, `AlertTransport` | #39 | Who to tell, and sending |
| `AuditPort` | #7 / ledger | The record of every material action |

## Assumptions recorded against unfinished dependencies

- Every catalogue entry is `DRAFT`: a reading of a notification that nobody has checked against its
  source here. Draft dates are shown and alerted on, and carry the caveat written by
  `describeReviewState` wherever they appear. The compliance register (#54) approves them; nothing
  else about them changes when it does.
- The signals in `adapters.ts` are read through interfaces narrower than #30's, #31's and #26's real
  surfaces — count, amount and affected records. The fixtures mock them; replacing a mock with the
  live module is a one-line change at the composition root.
- `ITC_REVIEW` and `EINVOICE_BACKLOG` are this product's own preventive obligations, marked
  `POLICY`, and are never presented as statutory deadlines.

## Demonstration scenario

`npm run demo:calendar` — 17 August 2026 at Sunrise Hardware. July's summary return is due on the
20th, three purchase bills do not match what the suppliers told the government, two invoices never
reached the e-invoice portal. The sweep raises one rung per obligation, running it again five
minutes later raises nothing, filing the return with its acknowledgement number silences it for
good, and the shop next door — whose filing frequency nobody recorded — has no deadlines and one
question waiting.
