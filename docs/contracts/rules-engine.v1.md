# Contract: `rules-engine` v1.0.0

| | |
| --- | --- |
| **Owner** | GPT 1, issue #7 [E07] |
| **Consumed by** | GPT 1 (#9 sales, #11 credit, #12 stock, #25 GST calculation, #34 knowledge assistant), GPT 3 (#19 supplier risk, #26 e-invoice, #27 e-way bill, #28 transport, #30 returns workspace, #31 ITC) |
| **Package** | `@invoice/rules-engine` |
| **Status** | Published |

## Purpose

Decide compliance and financial questions **deterministically**, from typed facts, under the rules
that were in force on the document's own date, and return an answer that carries its own evidence.

A rule is a pure, synchronous function of facts. It cannot read a database, call a service or ask
a model — the type has no seam for it. That is the mechanism behind the product rule that an LLM
never determines a legal or financial outcome.

## The three guarantees

1. **Determinism.** The same facts and the same rule-set version produce a byte-identical decision,
   including its explanation and its fingerprint. The order facts arrive in cannot change it.
2. **Replay.** A decision records the rule-set version it used. `replay()` re-runs it under that
   version and reports whether the answer still matches. A mismatch means a released rule set was
   edited, which is a release-blocking defect under #48.
3. **Never guess.** A missing fact, an unresolvable tie between rules, an unreviewed rule, or no
   rule at all each produce `CANNOT_DECIDE` with an explanation — never a plausible answer.

## Calling it

```ts
const engine = new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.gst', mode: 'production' });

const { decision, trace } = engine.evaluate({
  topic: 'gst.eway.applicability',
  facts: FactSet.of({ 'consignment.value': rupees(100000), 'movement.type': 'INTER_STATE', 'movement.mode': 'ROAD' }),
  documentDate: isoDate('2026-04-15'),   // the document's own date, never `new Date()`
  stateCode: '07',                        // lets a state-specific rule win
});
```

| Method | Behaviour |
| --- | --- |
| `evaluate(input)` | Decide, with the trace of every rule considered and why it was set aside |
| `simulate(input)` | Identical and guaranteed side-effect free — for "what if the value were ₹60,000?" |
| `replay(decision, facts)` | Re-run under the recorded rule-set version; returns `{ matches, decision }` |

## Outcomes

| Outcome | Meaning |
| --- | --- |
| `ALLOW` | Go ahead. Financial rules also return values in `computed` |
| `WARN` | Go ahead, but the person must see this first |
| `BLOCK` | Do not proceed without an authorised override |
| `REQUIRED` / `NOT_REQUIRED` | For applicability questions such as an e-way bill |
| `CANNOT_DECIDE` | **Expected, not an error.** Open an exception item; never post anything |

## What every decision carries

`topic`, `outcome`, `documentDate`, `ruleSetId`, `ruleSetVersion`, `ruleId`, `ruleVersion`,
`ruleKind`, `ruleReviewState`, `effectiveFrom`, `sourceRef`, `evidence[]`, `missingFacts[]`,
`explanation` in both languages, `computed`, `factsFingerprint`, `decisionFingerprint`.

`evidence` names every fact the rule looked at, its value, **where it came from** (`USER`,
`DOCUMENT`, `MASTER_DATA`, `DERIVED`, `MODEL`, `DEFAULT`) and, for a model-produced fact, its
confidence. A consumer must show model-produced facts for confirmation before acting on a decision
that used them.

## Rule selection, in order

1. Same `topic`.
2. Effective on the **document date**, not today.
3. Jurisdiction matches: an all-India rule always applies; a state-specific rule applies only in
   its state.
4. In `production` mode, `reviewState === 'APPROVED'`. `SUPERSEDED` and `WITHDRAWN` are never used.
5. Rank: more specific jurisdiction, then higher priority, then the more recent `effectiveFrom`.
6. **A remaining tie is a conflict, never broken arbitrarily** — `CANNOT_DECIDE`, with both rules
   named in `trace.unresolvedConflict`.

## Rule sets shipped today

| Rule set | Kind | Review state | Notes |
| --- | --- | --- | --- |
| `in.policy@2026.04.01` | `POLICY` | **APPROVED** | `invoice.rounding`, `sales.credit_limit`, `stock.negative`. We are their source: they state a choice this product and the business made, not the law. |
| `in.gst@2026.04.01` | `COMPLIANCE` | **DRAFT** | `gst.place_of_supply.goods`, `gst.tax_split`, `gst.eway.applicability` (three variants). |

**Every compliance rule is DRAFT and every threshold in it is a placeholder.** A compliance rule
cannot be `APPROVED` until issue #54 records the notification or circular it comes from, its
jurisdiction, its effective date and its reviewer — and `validateRuleSet` refuses to load an
`APPROVED` compliance rule with no `sourceRef`.

The consequence is deliberate: **in `production` mode the GST topics currently answer
`CANNOT_DECIDE`.** That is the correct behaviour for a product that has not yet verified its
sources, and it is what #25 will build on. Development and tests run in `development` mode, where
DRAFT rules are used and every decision says so in `ruleReviewState`.

No module may copy a threshold out of `packages/rules-engine/src/rulesets/gst.ts`.

## Errors

| Code | When |
| --- | --- |
| `RULES_APPROVED_WITHOUT_SOURCE` | A compliance rule claims to state the law but names no source |
| `RULES_UNKNOWN_FACT` | A rule requires a fact the rule set does not define |
| `RULES_EXPLANATION_MISMATCH` | The two languages of an explanation carry different placeholders |
| `RULES_DUPLICATE_RULE`, `RULES_DUPLICATE_RULE_SET` | The same rule or rule-set version registered twice |
| `RULES_BAD_EFFECTIVE_RANGE` | A rule stops applying before it starts |
| `RULES_SET_NOT_FOUND` | A past decision names a rule-set version that is not registered — a replay must fail loudly rather than answer from today's rules |
| `RULES_EXPLANATION_PLACEHOLDER` | A rule produced an explanation value short of its own template |

## Exceptions

`toExceptionDraft(decision, source)` turns a `CANNOT_DECIDE` into one piece of work for a person:
what was being decided, what was already known, what is still needed and why, in both languages.
Its `idempotencyKey` is derived from the decision fingerprint, so handing the same decision over
twice queues one item. It returns `null` for a decision that *was* made, so callers can pipe every
decision through it without branching.

The exception queue itself is GPT 2's issue #6. This is the payload handed to it.

## Permissions and tenant isolation

The engine holds no data and reads no storage, so it has nothing to isolate. Facts are supplied by
the caller, which has already applied the company boundary and the permission checks. **A consumer
must not pass facts it did not fetch under the acting user's company.**

## Idempotency

Pure. Evaluating twice changes nothing and returns the same fingerprint.

## Change policy

Adding a rule set version, a topic, an outcome value or an error code is a minor version. Editing a
**released** rule set is never allowed — publish a new version, or every past decision becomes
irreproducible and `replay` will report a mismatch. Changing the shape of `Decision` is a major
version and must name every consuming issue.
