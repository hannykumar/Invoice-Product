# Contract: `receivables` v1.0.0

| | |
| --- | --- |
| **Owner** | GPT 1, issue #20 [E20] |
| **Consumed by** | GPT 1 (#11 credit control, #35 reports, #34 assistant), GPT 2 (#22 bank reconciliation, #23 reminders) |
| **Package** | `@invoice/receivables` |
| **Depends on** | `@invoice/ledger` (#4), sales #9 and purchases #17 through `DocumentLedgerPort` |
| **Status** | Published |

## Purpose

What customers owe, what the business owes, and which bill each payment settled.

## Three refusals

1. **A partial payment never marks a bill paid.** Outstanding is derived — document value less
   accepted allocations — every time it is asked for. Nothing is stored.
2. **A cheque is not bank balance.** It sits in *cheques received, not yet cleared* until it
   clears. Collapsing the two is how a bounced cheque is discovered from a bank statement three
   weeks later.
3. **The product does not decide which bill a payment settles.** It suggests the oldest first,
   because that is what most businesses do, and a person confirms. What is left over stays visibly
   **on account** rather than being attached to whichever bill looks closest.

## Recording and allocating are different things

The customer's balance falls the moment the money arrives, whether or not anyone has decided which
invoice it belongs to. So:

- `recordPayment` posts the entry — debit where the money went, credit the customer.
- `allocate` is a **link, not a posting**. Re-deciding which bill a payment settles does not move
  money again, and the audit trail keeps every version.

They are separate permissions (`payments.record`, `payments.allocate`) for the same reason.

## The cheque lifecycle

`PENDING → DEPOSITED → CLEARED`, or `BOUNCED` from either, or `CANCELLED` while pending — the
machine in `docs/product/spec/states.json`. **State is not a column that gets overwritten**; it is
the last entry in a history nobody removes from, and every step records who, when and what the bank
said. A bounce and a cancellation require that note.

A bounce **reverses the receipt** rather than editing it away: the dues come back, both entries stay
visible, and the allocations fall away because a cheque that did not clear settled nothing.

## Modes

`CASH` → cash in hand. `CHEQUE` → cheques in hand. `BANK_TRANSFER`, `UPI`, `CARD`, `OTHER` → the
named bank account, which must be given and must not be a heading.

## Ageing and statements

Ageing counts from the **due date**, not the invoice date: *"sixty days old"* and *"thirty days
late"* are different facts and only the second is a problem. Buckets are not-due, 1–30, 31–60,
61–90 and over 90 days late.

`overdueSummaries` answers the home screen's *"who owes me money?"* worst first, in one sentence
per customer. `buildStatement` produces what a business actually sends: bills, payments and a
running balance in date order, ending in one checkable sentence, with uncleared cheques marked as
such.

## Writing off

An expense the business bore, not a disappearance. Own permission (`payments.write_off`), a written
reason that travels to the ledger narration and the audit trail, a visible account
(`BAD_DEBTS`, seeded as *"Money we could not collect"*), and a refusal to write off more than is
owed.

## Errors

| Code | Meaning |
| --- | --- |
| `ALLOCATION_EXCEEDS_OUTSTANDING` | Names the bill and what is actually left on it |
| `ALLOCATION_EXCEEDS_PAYMENT` | More put against bills than was received |
| `ALLOCATION_DUPLICATE_DOCUMENT` | One bill listed twice in a split |
| `CHEQUE_INVALID_STEP` | A cheque cannot go from that state to this one |
| `CHEQUE_REASON_REQUIRED` | A bounce or cancellation must say what happened |
| `PAYMENT_BANK_ACCOUNT_REQUIRED` / `_UNKNOWN` / `_IS_HEADING` | The money has to land somewhere real |
| `WRITE_OFF_EXCEEDS_OUTSTANDING`, `WRITE_OFF_REASON_REQUIRED` | Giving up money is deliberate |
| `PAYMENT_CONCURRENT_EDIT` | Someone else changed this payment first |

## Known limitations

- **`DocumentLedgerPort` is implemented by the caller.** Sales invoices come from #9 and purchase
  bills from GPT 3's #17; this module reads neither module's storage.
- Advances are held on account but are not yet linked to a GST advance-receipt treatment. That is
  #25 and #30 territory.
- Reminders and collection tracking are GPT 2's #23; this exposes the positions they need.
- Bank reconciliation is GPT 2's #22. A cleared cheque posts to the named bank account here, and
  matching that against a statement line is theirs.
