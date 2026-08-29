# Contract: `onboarding` v1.0.0

| | |
| --- | --- |
| **Owner** | GPT 1, issue #36 [E36] |
| **Consumed by** | GPT 2 (#38 web, #3 company creation), GPT 1 (#37 migration, #13 branding) |
| **Package** | `@invoice/onboarding` |
| **Status** | Published |

## Purpose

Get a business that has never used accounting software to the point where it can issue its first
bill, without asking it anything the product can work out and without telling it anything the
product does not actually know.

## Seeing it

```bash
npm run demo:onboarding
```

Sets up a bakery for real: she mistypes her GST number, a customer walks in, she closes the app,
comes back, her opening figures do not add up, she fixes them, and the books balance. Four
checklist screens are written to `tmp/onboarding/`.

## The two rules that shape it

**1. She will stop halfway.** Every step is validated and saved the moment it is given; nothing
waits for a submit at the end, because there is no end for someone serving a customer. `resume()`
returns the session exactly as it was. **A wrong answer is kept, not thrown away** — the step is
marked `NEEDS_ATTENTION` with the problems attached, and correcting one field leaves the rest of
the step intact.

**2. A default that looks like a fact is worse than a blank.** A business type suggests a template,
units, likely expense accounts and bill fields. It never suggests a GST rate, an HSN code, a
turnover threshold, a filing frequency or a registration type. `NEVER_SUGGESTED` is a data list and
a test walks every profile against it, including a check that no profile contains a percentage.

## Steps

`business` → `tax_profile` → `branding` → `items` → `rates` → `opening_balances` → `ready`

`branding`, `rates` and `opening_balances` may be skipped with a written reason. The rest cannot,
because no bill can be made without them.

## Opening balances — the dangerous screen

Everything after setup is checked by double entry. Opening balances are where a wrong number enters
the books with nothing to contradict it, so the rules here are stricter than anywhere else:

- both sides must match, and when they do not the message says **by how much and in which
  direction**, in money a shopkeeper can go and find: *"What you own is ₹6,300.00 more than what
  you owe plus your own money in the business."*
- **a difference is never absorbed silently.** A person accepts it explicitly with a reason, and it
  becomes one visible, named line in the opening entry.
- a row may name an **account** or a **customer or supplier**. Naming a party opens their account
  during setup (`LedgerService.openPartyAccount`), so nobody has to understand a chart of accounts
  to say "Hotel Rajmahal owes me ₹4,500". Their balance then folds from journal lines like any other.
- posting to a heading account is refused with a message that points at the party path instead.

`finish()` posts one `OPENING_BALANCE` voucher, records the declared rates, and is idempotent —
running it twice posts one entry.

## Where option C lives

The `rates` step is where a business tells us the GST it charges (issue #54, option C). Every rate
must say **where it came from**, and that basis travels to the printed bill. A business with no
sourced rate can still work; the bill says whose figures they are.

## Errors

| Code | Meaning |
| --- | --- |
| `ONBOARDING_CONCURRENT_EDIT` | Someone else changed this setup first |
| `ONBOARDING_INCOMPLETE` | Steps still outstanding, named in `details.remaining` |
| `ONBOARDING_OPENING_UNBALANCED` | The two sides differ and nobody has accepted the difference |
| `ONBOARDING_OPENING_ACCOUNT_IS_HEADING` | Name the customer or supplier instead |
| `ONBOARDING_OPENING_ACCOUNT_UNKNOWN` | No such account in this company's books |
| `ONBOARDING_STEP_NOT_SKIPPABLE` | A bill depends on this step |
| `ONBOARDING_SKIP_REASON_REQUIRED` | Skipping needs a written reason |
| `ONBOARDING_ALREADY_DONE` | Change these details in settings instead |

## The screen

`checklistFor(session, locale)` returns what is done, what is left, what is stopping progress and
where "continue" should go. `renderChecklist()` produces a standalone screen so the wording and
ordering can be reviewed by a person now — **issue #38 owns the real interface**; this exists to be
ported, not to compete with it.

## Known limitations

- Opening **stock** is handed to an `OpeningStockPort`, which is a no-op until #12 lands. Quantities
  are collected and passed through; nothing counts them yet.
- Creating the company itself belongs to GPT 2's #3. This assumes the company exists and its chart
  of accounts has been seeded.
- Logos are accepted as data URIs with no resizing or format validation.
- There is no "invite your staff" step; users and roles are #3's.
