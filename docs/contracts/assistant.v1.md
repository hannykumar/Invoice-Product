# Contract: `assistant` v1.0.0

| | |
| --- | --- |
| **Owner** | GPT 1, issue #34 [E34] |
| **Consumed by** | GPT 2 (#38 web, #47 in-app assistance), GPT 3 (#32 supplies the optional calendar port) |
| **Package** | `@invoice/assistant` |
| **Status** | Published |

## Purpose

Answer a business owner's questions about their own books and about the rules we hold, in words
they can read, with every number traceable to a report and every rule traceable to the notification
it came from.

## Seeing it

```bash
npm run demo:assistant
```

A month of real trading, then ten questions — including the one it refuses, the one it answers only
with a statute behind it, the one that tries to talk it into something, and the same question asked
by a clerk who may not see what customers owe.

In the running app: **Ask about your business** (`npm run web`).

## The shape of it

```
question → understand (a lexicon) → resolve the period → fetch reports through the asker's own
permissions → lift figures out of them → put rule questions to the rules engine → check every
sentence → answer
```

Nothing in that chain decides what the answer should be. A model, where one is plugged in at all,
may only suggest **which of a fixed list of questions** was being asked.

## What it answers

`MONEY_OWED_TO_ME`, `MONEY_I_OWE`, `SALES_IN_PERIOD`, `PURCHASES_IN_PERIOD`, `PROFIT_IN_PERIOD`,
`WHAT_I_OWN`, `STOCK_POSITION`, `GST_IN_PERIOD`, `NEEDS_ATTENTION`, `WHY_BLOCKED`,
`COMPLIANCE_QUESTION`. Anything else is `NOT_MY_QUESTION` with examples of what it does answer.

English and Hinglish, from the same lexicon issue #10 uses for `detectLanguage` and number words.

## The three guarantees, and the machinery behind each

**1. Numbers reconcile to canonical reports.** A figure enters an answer only through
`citeAmount(header, what, figure)`, which takes one of issue #35's own `Figure`s, throws
(`UncheckableFigureError`) if it no longer folds to its own records, and carries out the report id,
the **snapshot id**, the period and every contributing record. There is no arithmetic in this
package that can reach an answer. `AnswerState` is `PARTLY_ANSWERED` whenever the trial balance for
the period does not balance, because then no total from those books is settled.

**2. Answers never reveal inaccessible company data.** Every read goes through `ReportService`,
which checks the actor's permission and takes the company from the authenticated actor. A refused
report is **named on the answer** (`withheld`) and the state becomes `NEEDS_PERMISSION`; it is never
silently dropped, because a partial total read as a whole one is its own kind of leak. Naming
another company in the question text changes nothing.

**3. Compliance answers identify source, effective date and uncertainty.** A rule answer is a
`ComplianceCitation` built by `citeCompliance(decision, register, asOfDate)`, and it has exactly
three levels:

| Certainty | When | May state an obligation? |
| --- | --- | --- |
| `THE_RULE_SAYS` | An APPROVED rule, whose source in the register is a statute, rule, notification or order | Yes |
| `THE_RULE_IS_UNCLEAR` | The rule could not decide, or rests only on a circular or FAQ | No |
| `WE_CANNOT_SAY` | No approved rule, or a source the register does not hold | No — nothing is asserted |

`safeSentence` enforces that table: obligation language ("you must", "legally required",
"guaranteed", "no penalty", and the Hindi equivalents) throws `UnsupportedClaimError` unless an
approved rule with a legal source is behind the sentence, and speaking for the department or a court
throws at every level. Every rule answer carries `RULE_DISCLAIMER`.

## Prompt injection

The question is data. `looksLikeAnInstruction` flags text that tries to instruct the product; the
flag is recorded on the answer and in the audit trail, and **changes nothing else** — the intent
comes from the lexicon, the company from the actor, the permissions from the platform. When a model
port is configured, it receives only the words the lexicon matched, never the raw question.

## Ports

| Port | Owner | Absent behaviour |
| --- | --- | --- |
| `ReportService` (#35) | GPT 1 | Required. |
| `RulesEngine` (#7) + `ComplianceRegister` (#54) | GPT 1 | Rule questions are refused, not guessed. |
| `BlockedDocumentPort` | #9 / #11 / #12 will implement | "Why is this blocked?" says it cannot see, and points at the bill. |
| `ComplianceCalendarPort` | **GPT 3, #32 — not built** | Every rule answer carries a note that due dates are not visible here. |
| `ExceptionQueuePort` (#6) | GPT 2 | An unbalanced set of books is still flagged in words; no item is raised. |
| `QuestionUnderstandingPort` | optional model | The lexicon alone decides. |

## Audit

One `assistant.answered` event per question: the intent, the state, the confidence, the period, the
report ids and rule ids used, how many sections were withheld, and whether the text looked like an
instruction. **No figures** — an audit trail records what was asked, not the business's money.

## Known limitations

- The lexicon covers the questions above; a question phrased far outside it comes back as
  `NOT_MY_QUESTION` rather than being stretched to fit.
- Only one item is matched per stock question, by substring against the item name.
- Periods are resolved from words (`this month`, `pichhle mahine`, `March 2025`, `last 7 days`,
  financial years). An explicit date range in the question is not parsed yet.
- `WHY_BLOCKED` depends on a port no module implements yet; the demo and tests drive it through a
  stub, which is disclosed here and in the pull request.
- Answers are not stored. Each question is answered from the reports as they are at that moment, and
  the snapshot id on each figure is what ties an answer to what the books said then.
