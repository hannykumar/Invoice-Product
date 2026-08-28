# Design principles and content rules (issue #46 — [E46])

## 1. Who we are designing for

A shop owner or their staff member. They know their business exactly. They do not know the words
*debit*, *credit*, *ledger*, *voucher* or *reconciliation*, and they should never have to learn
them to do their daily work. They are often on a mid-range Android phone, on a patchy connection,
standing up, with a customer waiting.

This produces four constraints that outrank visual preference:

1. **Speak about their business, not about accounting.** "ABC Traders still owes ₹50,000", never
   "Sundry debtors – ABC Traders: ₹50,000 Dr".
2. **Everyday work fits in three steps or fewer.** The budget is enforced by a test.
3. **Never remove a safety check to save a step.** The budget is met by hiding *optional* fields,
   never by hiding a consequence.
4. **Never show the computer's problem.** If something failed, say what it means for their money
   and what they can do now.

## 2. The vocabulary rule

Every accounting term the product must express has an entry in `vocabulary.json` with three parts:
the term it replaces, the words we never show, and the words we do show, in each language.

| Instead of | We say |
| --- | --- |
| Sundry debtors / accounts receivable | Money customers owe you |
| Sundry creditors / accounts payable | Money you owe suppliers |
| Voucher / journal entry / posting | Entry in your books |
| Debit ₹1,180 to the party account | ₹1,180 added to what ABC Traders owes you |
| Ageing bucket 90+ | Due for more than 90 days |
| Unapplied receipt / on account | Money received, bill not chosen yet |
| ITC | GST you already paid on purchases |
| Place of supply | The state this sale counts in |
| Period lock | Month closed |

A word may still appear when the business itself uses it. *GST*, *invoice*, *bill*, *stock*,
*godown*, *cheque*, *UPI* and *HSN* are the shopkeeper's own vocabulary and stay.

The linter (`packages/ux-vocabulary/src/lint.ts`) fails the build when a banned term, a technical
leak (`null`, `HTTP 500`, `constraint`, `rollback`), a raw internal state name (`PENDING_APPROVAL`)
or a sentence longer than 25 words reaches a user-facing string.

## 3. Progressive disclosure and guided defaults

A bill screen shows six fields, not thirty.

**Always visible:** customer, item, quantity, unit, rate, and the running total.
**Filled in for you, changeable in one tap:** date, unit, rate from the last agreed price for this
customer, godown, payment terms, place of supply derived from the customer's recorded state.
**Hidden until asked:** discount, freight and other charges, batch, narration, due date override,
tax-inclusive toggle, additional references.

Two rules keep this honest:

- **A default is never a hidden fact.** Anything that changes the money is shown in step 2 in plain
  words, even if the user never opened the field that produced it.
- **A default is never invented.** When the app does not know a fact that changes tax or money, it
  asks. There is no "probably" in this product. That is the same rule as the exception queue, seen
  from the user's side.

## 4. Anatomy of every message

Every message in the catalogue has the same four parts, because a message that only says "no" is
useless to someone who cannot diagnose it:

| Part | Rule |
| --- | --- |
| **What happened** | One sentence, their words, with the actual numbers in it. |
| **Why** | One sentence explaining the reason in terms of their business, not our architecture. |
| **What you can do** | At least one action, and the actions are filtered by what this user may actually do. |
| **Severity** | `block`, `warn`, `info`, `progress` or `success` — decides the visual weight, not the wording. |

Worked example, message `stock.not_enough`:

> **Not enough stock.** You have **30 boxes** of Apple box, 10 kg at Narela godown. This bill needs
> **70 boxes**, so **40 boxes** are missing.
>
> *We count what you can sell as what is lying in the godown minus what is already kept aside for
> other bills.*
>
> Reduce the quantity to 30 · Pick a different godown · Record the purchase that brought this stock
> in · *(only for users with permission)* Ask someone with permission to allow it and give a reason

A test asserts that every `block` and `warn` message has a "why" and at least one next step, and
that a step needing a permission is never offered to a user who does not hold it.

## 5. Showing state

Records have precise internal states. People need six:

| Group | Shown as | Example |
| --- | --- | --- |
| `draft` | Not finished | A bill you started and did not issue |
| `processing` | Working on it | Saving |
| `submitted` | Waiting | Waiting for approval, cheque not cleared |
| `accepted` | Done | Bill issued, payment recorded |
| `failed` | Did not go through | Cheque bounced, saving failed |
| `needs_attention` | Needs your attention | GST cannot be decided yet |

The mapping from every internal state to a group and to plain wording lives in
`state-labels.json`, and a test proves that no state in `docs/product/spec/states.json` is missing
from it. If GPT 1, 2 or 3 adds a state, the build fails until it has been given words.

Two states are worded with unusual care because they are easy to misread:

- **Partly paid** is never shown as *paid*. The bill shows the amount still due.
- **Saved on your phone, not in your books** is shown for offline work, because a bill that has not
  reached the server has no number, no stock effect and no tax effect.

## 6. Money, numbers and language

- Amounts are written in Indian digit grouping with the rupee sign: `₹1,00,000.00`.
- Quantities always carry their unit: `30 boxes`, never `30`.
- A total is never shown without its parts being reachable in one tap.
- Dates are written as `15 April 2026`, never `15/04/26`, because the ambiguity is a real risk.
- English and Hindi (Latin script, the way people actually type and read on phones) ship together.
  Every message in the catalogue exists in both, and a test asserts that both carry the same
  placeholders, so a translation cannot quietly drop the amount.
- Adding a language means adding a locale to the catalogue. No sentence lives in a screen, so no
  screen has to be re-translated.

## 7. What we will not do to make it simpler

These are non-goals, and they are as binding as the goals:

- We will not hide a legally required field to shorten a form.
- We will not remove an approval to reduce a step.
- We will not round, guess or auto-fill a number that changes tax or money.
- We will not mark something done when it is only partly done.
- We will not replace an explanation with a disclaimer.
