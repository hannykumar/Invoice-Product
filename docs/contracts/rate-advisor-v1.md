# GST rate suggestion and cross-check — v1

Issue #59 [E59]. Owner: GPT 3. Package: `packages/rate-advisor`.

When a document does not state a usable GST rate, offer one from the tax-default register and let a
person approve it. When the document does state a rate, hold it against that register and say so
when they disagree.

## The line this module will not cross

> allowed:     "18% — because this is HSN 72142090, TMT Steel Bar, per Notification 1/2017-CTR
>              Schedule III entry 224, in force from 2026-04-01. Use 18%?"
> allowed:     "This bill charges 18%, but your records say 28% for this. One of them is wrong."
> not allowed: applying either figure without a person saying yes
> not allowed: a percentage that came from a model rather than from the register
> not allowed: "corrected to 28%" — the register is the business's own record, not the law

The register may be out of date and the supplier may be right. A product that assumes the register
wins will quietly overrule a correct supplier, so a disagreement names both figures and neither.
The law itself is #54's; this module reads what the business has recorded, and says where it came
from every single time.

## Three guarantees, each enforced rather than intended

| Guarantee | How it is enforced |
| --- | --- |
| A rate is never produced by a model | `ProposedClassification` has no rate field of any kind. A model may propose an HSN or an item match and nothing else; there is nowhere to put a percentage |
| Nothing is applied without approval | `suggest()` and `check()` write nothing. `approve()` is the only write, and it refuses a suggestion resting on a classification no person has confirmed |
| The document's own date decides | `asOf` is a required argument on every call. There is no default and no clock read in the resolution path, so a back-dated bill cannot silently acquire today's rate |

## The two questions

```ts
suggest(companyId, line, asOf): Promise<RateAdvice>
check(companyId, line, asOf): Promise<RateCrossCheck | null>
```

`RateAdvice` has exactly two shapes and no third. There is no "best guess" branch, so a caller
cannot accidentally treat an unanswerable line as answered:

```ts
type RateAdvice =
  | { kind: 'SUGGESTED'; suggestion: RateSuggestion }
  | { kind: 'ASK'; reason: RateUnknownReason; candidates: RegisterRate[];
      question: Bilingual; whatWouldHelp: Bilingual;
      awaitingConfirmationOf?: ProposedClassification }
```

`RateUnknownReason` distinguishes four situations that need four different things from a person:

| Reason | What it means | What would help |
| --- | --- | --- |
| `NO_ENTRY` | Nothing in the register matches, as of that date | Set a rate for the item or its HSN once |
| `NOTHING_TO_MATCH_ON` | No HSN, and the item is not in the master list | Add the HSN, or pick the item |
| `CONFLICTING_ENTRIES` | Several entries match and disagree | Remove the wrong entries |
| `CLASSIFICATION_UNCONFIRMED` | A model proposed what the goods are | Confirm what they are |

## Every suggestion carries its citation

```ts
interface RateCitation {
  source: string;           // "Notification 1/2017-CTR Schedule III entry 224"
  effectiveFrom: IsoDate;   // when this entry took effect
  registerEntryId: Id;      // the exact row, producible on demand
}
```

Cess and reverse charge travel with the rate rather than being fetched separately. A suggestion that
says 28% and omits 12% cess is a suggestion that under-bills, and the reason sentence says both.

## Cross-check findings

Findings use #16's severities and field paths, so a rate finding sits in the same list as a
mismatched total and needs no separate screen.

| Code | Severity | Raised when |
| --- | --- | --- |
| `GST_RATE_DISAGREES_WITH_REGISTER` | `MATERIAL` | The bill and the register state different rates |
| `GST_RATE_REGISTER_CONFLICTED` | `SIGNIFICANT` | The register holds more than one rate, so nothing could be checked |
| `GST_RATE_NOT_IN_REGISTER` | `MINOR` | Nothing to check against — reported, because "unchecked" must not look like "fine" |

Only the GST percentage is compared. A bill's tax column does not state cess, and treating its
absence as a disagreement would cry wolf on every bill of cess-bearing goods.

## Approving, and learning

```ts
approve(context, command): Promise<ApprovedRate>
```

An approval writes an **item-level** default through #5's own `setTaxDefault`, so a learned rate is
the same kind of record as one somebody typed into the master screens: same versioning, same audit,
same effective dating. A separate "learned rates" store would have created a second register the
first one does not know about.

It takes effect **from the approval date**, never from the document date. A person approving today
is saying what is true from today; back-dating their approval would silently restate every earlier
bill for that item. The source written into the register records the original citation, who approved
it, on what date, and — where the classification came from a model — which model and who confirmed
it.

Approval is idempotent on `idempotencyKey`, so a button pressed twice on a slow connection appends
one version rather than two with two different effective dates.

## What this module needs from others

| Port | Supplied by | Used for |
| --- | --- | --- |
| `TaxDefaultRegistryPort` | #5, via `mastersRegistry()` | Reading every matching entry with its effective date |
| `RateLearningPort` | #5, via `mastersLearning()` | Writing the one default a person approved |
| `RateAuditPort` | #6 | Recording the approval, the entry it came from, and any model involvement |

`taxDefaultCandidates()` was added to #5 for this. `taxDefaultFor()` answers "what rate should this
line use" and must pick one; this module asks "what does the register actually hold", where the
difference between one entry and three that disagree is the difference between a suggestion and a
question.

## Fixtures

`makeShop()` builds a business with four items and three registered rates: steel at the item level,
cement at the HSN level, an aerated drink at 28% plus 12% cess, and hardware with nothing recorded
at all. Every rate is marked `(synthetic test declaration, not a legal source)` — #54 is the only
thing in this product allowed to state what the law says.

`npm run demo:rates` plays out the issue's own user example end to end.
