# Usability test protocol (issue #46 — [E46])

The acceptance criterion is "target users complete core tasks without training". That is a claim
about people, so it is measured with people. The automated tests in
`packages/ux-vocabulary/test/` protect the wording between those sessions; they do not replace
them.

This protocol is written so that anyone on the team can run a session without a research
background, and so that results from different rounds can be compared.

## 1. Who we test with

Eight participants per round, recruited to this profile:

| Requirement | Detail |
| --- | --- |
| Runs or works in an MSME | Retail, wholesale, small manufacturing or services |
| Has never studied accounting | No formal bookkeeping training; a person who says "my CA does that" is exactly right |
| Uses a smartphone daily | Android, mid-range, their own device wherever possible |
| Language | At least three participants tested entirely in Hindi |
| Excluded | Accountants, our own staff, anyone who has seen the product before |

Eight is enough to find the problems that block a task. It is not a statistical sample and we do
not report percentages from it.

## 2. The tasks

Participants are given a situation, never an instruction that names a screen. "Make a sales
invoice" teaches the answer; "A customer has come to buy 70 boxes of apples at ₹800 — do what you
would normally do" does not.

| # | Situation given to the participant | We are watching for |
| --- | --- | --- |
| 1 | A customer wants 70 boxes at ₹800. Do what you would do. | Can they complete a bill unaided? Do they understand the total? |
| 2 | The same customer now wants 70 more boxes. | Do they understand *why* it is blocked, and pick a sensible way forward? |
| 3 | Your supplier has given you this bill (hand them a printed bill). | Do they record a purchase, not a sale? |
| 4 | The customer has paid ₹30,000 of a ₹1,00,000 bill by cheque. | Do they understand the bill is not paid? |
| 5 | Tell me what this customer owes you now. | Can they find it, and is the number the one they expect? |
| 6 | The cheque has bounced. | Do they understand the dues went back up, and that nothing was hidden? |
| 7 | Tell me how much stock is left. | Do they distinguish what they can sell from what is kept aside? |

## 3. What we measure

| Measure | How | Target |
| --- | --- | --- |
| **Unaided completion** | The participant finishes without the facilitator answering a question | 7 of 8 participants for tasks 1, 3, 4, 5, 7 |
| **Steps taken** | Screens completed, counted from the recording | Within the budget in `task-flows.json` |
| **Comprehension of a block** | After task 2, the participant explains in their own words why it stopped | 8 of 8 explain it correctly |
| **No false "paid"** | After task 4, the participant states the correct amount still due | 8 of 8 |
| **Term recall** | The participant is never required to use the words debit, credit, ledger or voucher | 0 occurrences required |
| **Recovery** | After task 6, the participant finds the full cheque history | 6 of 8 |

A "critical failure" is any of: a participant believes a bill is paid when it is not; a participant
believes stock is available when it is not; a participant cannot state what a blocking message
means. One critical failure blocks the release of that flow, regardless of the other numbers.

## 4. Error-message comprehension test

Run separately, and cheaply, on the whole message catalogue. Each participant is shown a message
out of context and asked two questions:

1. In your own words, what has happened?
2. What would you do next?

A message passes when at least 7 of 8 participants answer both correctly. A failed message is
rewritten in `messages.json` and re-tested; it is never "explained better in training".

This test is repeated in Hindi with the Hindi strings. A Hindi message that scores lower than its
English counterpart is treated as a defect in the Hindi string, not in the participant.

## 5. Mobile and language variants

Every round is run:

- on a mid-range Android phone at 360 pt width, on a throttled connection;
- once with the device offline mid-task, to test the "saved on your phone, not in your books"
  wording;
- in both English and Hindi, with at least three participants who do the whole session in Hindi.

## 6. Facilitator rules

- Do not answer a question during a task. Ask "what would you do if I were not here?"
- Do not use product vocabulary the participant has not used first.
- Record the screen and the audio, with consent, and record nothing that identifies a real
  business or a real customer.
- Use only the synthetic fixture business. Never a participant's real data, real GSTIN or real
  customers.

## 7. What happens to the findings

Each finding becomes one of:

| Finding type | Outcome |
| --- | --- |
| Wording is misunderstood | Fix the string in `messages.json`, add it to the comprehension set |
| A step is missing or in the wrong place | Change `task-flows.json`, which fails the step-budget test until the flow is fixed |
| A safety check is misunderstood | Rewrite the "why" and the next steps — never remove the check |
| A control is genuinely unnecessary | Move it behind progressive disclosure, never delete a legal field |

Findings are recorded with the round number and the participant number only. Round results are
kept next to the version of the catalogue they tested, so a later change that undoes a fix is
visible.
