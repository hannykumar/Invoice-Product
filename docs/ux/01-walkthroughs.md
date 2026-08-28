# First sale, purchase and payment walkthroughs (issue #46 — [E46])

These are the three things a new business does on its first day. Each is specified screen by
screen with the exact message ids, so the wording is testable rather than decorative. The step
budget is three, and it is enforced by `packages/ux-vocabulary/test/catalogue.test.ts`.

The example business is Sharma Fruit Traders from
[the worked examples](../product/05-worked-examples.md).

---

## Walkthrough A — Make a bill

### Step 1 of 3 — Who and what

```
Make a bill                                         [ 🎤 Speak instead ]

Customer   [ ABC Traders                        ▾ ]
Item       [ Apple box, 10 kg                   ▾ ]   You can sell: 100 boxes
Quantity   [ 70          ] boxes ▾
Rate       [ ₹800.00     ] per box                    Last time: ₹800.00 on 2 Apr

                                        Total so far  ₹56,000.00
More options ▾   (discount, freight, batch, due date)          [ Next ]
```

Everything below `More options` is hidden until asked. `Rate` shows where the number came from,
because a suggested price the owner cannot trace is worse than no suggestion.

Speaking is the same step, not an extra one. *"ABC ko sattar box apple aath sau per box becho"*
fills the same four fields and then shows message `voice.confirm_draft`:

> Please check: sell **70 boxes** of Apple box, 10 kg to **ABC Traders** at **₹800.00 per box**,
> price **without GST**. After this you will have **30 boxes** left.
>
> Yes, this is right · Change one thing · Say it again

"Change one thing" edits a single field. The person never repeats the whole sentence.

### Step 2 of 3 — Check

```
Check this bill

  70 boxes × ₹800.00                              ₹56,000.00
  GST                                                  ₹0.00
  ─────────────────────────────────────────────────────────
  ABC Traders will pay                            ₹56,000.00

  Why no GST?  Fresh fruit is not taxed. [ See the rule ]
  After this bill you will have 30 boxes left at Narela godown.
  ABC Traders will then owe you ₹56,000 in total.

                                    [ Back ]     [ Make the bill ]
```

Everything that changes the money is stated here even if the user never opened the field that
produced it. This is the screen that carries the safety confirmations:

| If | The person sees | Message id |
| --- | --- | --- |
| Stock is short | Not enough stock, with the exact shortfall and four ways forward | `stock.not_enough` |
| The customer is over their limit | How much over, and three ways forward | `credit.limit_crossed` |
| The state for GST is unknown | We will not guess it, with the two facts that would settle it | `tax.place_of_supply_missing` |
| The month is closed | The date cannot be used, and what to do instead | `period.closed` |
| Approval is required | Who must approve and why | `approval.needed` |

A block is never a dead end and never a bare "not allowed".

### Step 3 of 3 — Give the bill

```
Saving…                                                 (state.saving)

Done. INV/KB/2026-27/00042 is recorded in your books.   (state.saved)
Your stock, your dues and your GST have all been updated together.

[ Send on WhatsApp ]   [ Print ]   [ Make another bill ]
```

If the network fails, nothing is half-saved:

> **It did not go through.** Nothing was recorded, so you can safely try again.
> *We save the whole entry or none of it. There is no half-saved bill.*
> Try again · Keep it as an unfinished bill

If the person taps twice, they get the bill they already made, not a second one:

> This was already saved a moment ago as **INV/KB/2026-27/00042**, so we opened it instead of
> making a second one.

---

## Walkthrough B — Record a supplier bill

### Step 1 of 3 — The bill

Photograph it or type it. The supplier, bill number, date, items and amounts are filled in for the
person to check, each marked with how sure we are. A field we are not sure about is highlighted and
must be confirmed; it is never accepted quietly.

### Step 2 of 3 — Check

```
Check this supplier bill

  Nashik Farms · bill NF/1191 · 6 April 2026
  200 crates × ₹200.00                            ₹40,000.00
  GST (you paid)                                   ₹7,200.00
  ─────────────────────────────────────────────────────────
  You will owe Nashik Farms                       ₹47,200.00

  200 crates will be added to Narela godown.
  ₹7,200 GST you paid will reduce your GST bill once Nashik Farms files their return.

                                    [ Back ]     [ Save ]
```

The last line is deliberate. Telling the owner the credit is theirs *once the supplier files* is
the difference between an accurate expectation and an unpleasant surprise in month three.

If the same bill is already recorded, `duplicate.supplier_bill` blocks it and offers to open the
existing one.

### Step 3 of 3 — Save

Same as a sale: `state.saving`, then `state.saved`.

---

## Walkthrough C — Record money received

### Step 1 of 3 — Who paid and how much

```
Money received

From      [ ABC Traders                        ▾ ]
Amount    [ ₹30,000.00                          ]
How       ( ) Cash   (•) Cheque   ( ) Bank   ( ) UPI
Cheque no [ 112233   ]   Date [ 20 April 2026 ]

                                                    [ Next ]
```

### Step 2 of 3 — Which bills

```
Which bills does this settle?

  ☑ INV/KB/2026-27/00044   15 Apr   Due ₹1,00,000   Apply [ ₹30,000.00 ]
  ☐ INV/KB/2026-27/00042   12 Apr   Due   ₹56,000   Apply [       ₹0.00 ]

  Applying ₹30,000 of ₹30,000.        Nothing left over.

  After this, ABC Traders will still owe ₹70,000 on bill 00044.
                                    [ Back ]     [ Save ]
```

The oldest unpaid bill is offered first, which is a suggestion, not a decision. If money is left
over, `payment.extra_on_account` says so plainly and never picks a bill on the owner's behalf. If
the bill is only partly covered, `payment.partly_paid` states the amount still due, and the bill is
never marked paid.

### Step 3 of 3 — Save

```
Done. Payment recorded.
₹30,000 received by cheque 112233. Waiting for the cheque to clear.
```

The cheque stays visible as *not cleared yet*. When it clears, the money moves into the bank
balance. If it bounces:

> **Cheque 112233 from ABC Traders for ₹30,000 did not clear.** Their dues are back to **₹80,000**.
> *We do not delete the old record. We add an opposite entry, so you can always see what happened.*
> Call ABC Traders · Record a new payment

---

## Two one-tap answers

The two questions a business owner asks most often are not tasks at all, and must not be built as
reports:

| Question | Where it lives | What it shows |
| --- | --- | --- |
| "Who owes me money?" | Home screen, one tap | Every customer who owes, biggest and oldest first, with call and remind buttons |
| "What is left in the godown?" | Home screen, one tap | Every item, what you can sell now, what is kept aside, and in which godown |

Both are declared in `task-flows.json` with a one-step budget.
