# Contract: `golden-dataset` v1.0.0

| | |
| --- | --- |
| **Owner** | GPT 1, issue #43 [E43] |
| **Consumed by** | Every lane. GPT 1 (#48 release gates), GPT 2 (#44 end-to-end testing), GPT 3 (#44, #45) |
| **Package** | `@invoice/golden-dataset` |
| **Depends on** | `@invoice/ledger` (#4), `@invoice/rules-engine` (#7), `@invoice/sales` (#9), `@invoice/inventory` (#12), `@invoice/gst-calc` (#25), `@invoice/receivables` (#20) |
| **Status** | Published |

## Purpose

Four example businesses, the things that happened to them, and exactly what every module is
expected to say afterwards — so that any lane can prove its work against the same facts.

## A fixture is data, not code

Each example is a plain JSON file in `packages/golden-dataset/fixtures/`. That is the point: the
same file is replayed by this lane's tests today and can be read by another agent's module, in
another language, without importing anything of ours. Nothing in a fixture is a TypeScript literal
and nothing in it is computed.

```
fixture := { id, version, describes, company, parties, items, events, expected }
```

`describes` is prose aimed at whoever is about to change the file. A fixture nobody can read is a
fixture people edit until the test passes.

## The four businesses

| Fixture | What it is for |
| --- | --- |
| `wholesaler.json` | The issue's own example: 100 boxes in, 70 sold, an oversale of 50 **refused**, a part payment. Apples are nil-rated, so it proves a bill with no tax still balances and still reports. |
| `bakery.json` | The ordinary intra-state case: seller and buyer in one state, so a 5% declared rate splits into ₹150 central and ₹150 state. |
| `services.json` | Across a state line, so the whole 18% is one IGST amount, and a service holds no stock. |
| `transport.json` | The correction case: a freight bill cancelled the next day. **Both entries stay** — ₹25,200 posted in total while every balance is zero. |

## Money is a string

Every amount is `"6000.00"`, never `6000` or `6000.5`. JSON numbers are floats, and floats are the
one thing the money rules forbid anywhere near a financial figure. The validator rejects a number.

## Every tax figure names the rule behind it

```json
"provenance": {
  "ruleId": "gst.tax_split", "ruleVersion": "2026.04.01",
  "sourceRef": "policy:place-of-supply-v1", "effectiveFrom": "2026-04-01",
  "note": "Seller and buyer are both in state 08, so …"
}
```

This is the acceptance criterion *"changing expected outcomes requires documented rule/source
review"*, made structural. A figure with no provenance can be edited by anyone to make a failing
test pass, which is precisely what a golden dataset exists to stop. The `note` says what a reviewer
must check **before** changing the number.

## A refusal pins its reason, not just its code

`SALES_NEEDS_INFO` covers every reason a bill cannot be issued. A fixture that pinned only the code
would keep passing if the module started refusing for something else entirely, so each refusal also
states `expectedMessageContains` — for the oversale, `"so 20.000 BOX are missing"`. There is a
mutation test that changes the expected reason and requires the comparison to fail.

## Replay runs the real modules

`replay(fixture)` turns the events into calls on the genuine ledger, sales, inventory, GST and
receivables services and reads back what they produced. Nothing here re-implements a module, so if
one drifts the golden file stops matching and the failure points at the module rather than at a
copy of it kept here.

It is deterministic by construction: a fixed clock, fixed ids, and dates from the fixture rather
than from today. There is a test that replays the same file twice and requires identical output.

## The mutation tests are the point

A golden dataset whose checks pass on tampered figures is worse than none, because it looks like
assurance. Eleven tests deliberately corrupt something — a ledger balance, a tax amount, both
trial-balance totals at once, a stock count, a refusal that did not happen, a refusal that happened
for a different reason, money written as a float, provenance stripped out, tax parts that do not
add up — and each **requires** the check to complain.

## Using it from another lane

```ts
import { loadAllFixtures, replay, compareToExpected } from '@invoice/golden-dataset';
```

Or read the JSON directly. If your module produces one of these figures, compare against the
fixture rather than against a number you wrote yourself.

## Known limitations

- **The replay covers what is built**: ledger, sales, inventory, GST and receivables. Purchases
  (#17), returns (#45), e-way (#27) and e-invoice (#26) are not replayed, so the transport example
  exercises a cancellation rather than an e-way decision. When those land, the events and
  expectations extend rather than change shape.
- **Rates are business-declared** (#54 option C), which is what production supports today. A
  fixture states the rate its business charges and who declared it. When rates are sourced from
  notifications, the provenance block is where that lands.
- **Stock value is not posted to the ledger**, so no fixture asserts a stock account balance.
  That belongs with #17.
- Fixtures are anonymised and invented. Every GSTIN is structurally valid and belongs to nobody.
