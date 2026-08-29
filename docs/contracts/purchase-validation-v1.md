# Contract: `purchase-validation` v1.0.0

| | |
| --- | --- |
| **Owner** | GPT 3, issue #16 [E16] |
| **Consumes** | `master-data-v1` (#5), `purchase-intake-v1` (#15), `rules-engine.v1` (#7/#25), `platform-command-v1` (#6) |
| **Consumed by** | GPT 3 (#17 posting, #18 three-way match, #31 ITC), GPT 1 (#45 returns) |
| **Package** | `@invoice/purchasing` |
| **Status** | Published |

## Purpose

Decide whether an `ExtractionDraft` from #15 is **safe to post**. Nothing here posts, moves stock
or claims ITC — #17 does that, and only for a verdict this contract marked postable.

The promise is narrow and total: **an unresolved material discrepancy cannot post.** Every check is
deterministic arithmetic or a rules-engine decision. No model output is trusted as a fact.

## The verdict

```ts
const verdict = validatePurchase({ draft, supplier, existing, engine, policy });
```

| Field | Meaning |
| --- | --- |
| `status` | `POSTABLE` · `NEEDS_REVIEW` · `BLOCKED` |
| `findings[]` | Every check that did not pass cleanly, each with its evidence |
| `duplicate` | The duplicate assessment, always present, even when nothing matched |
| `recomputed` | Totals this contract calculated itself, never the ones printed on the document |
| `corrections[]` | The specific edits that would clear each finding |
| `fingerprint` | Stable hash of the inputs; identical inputs give an identical verdict |

`POSTABLE` means every material check passed. `NEEDS_REVIEW` means a person must look, and may
confirm. `BLOCKED` means it cannot proceed even with confirmation until the document or the master
data changes — a confirmed duplicate, or a supplier whose GSTIN fails its own check digit.

## Severity, and what it costs

| Severity | Effect on status | Cleared by |
| --- | --- | --- |
| `MATERIAL` | `BLOCKED` | Fixing the document or the master record. Never by confirming |
| `SIGNIFICANT` | `NEEDS_REVIEW` | An authorised person confirming, with a reason recorded |
| `MINOR` | none — reported only | Nothing; shown so the reviewer is not surprised |

Rounding differences inside tolerance are not findings at all. They are reported in `recomputed`.

## Duplicate detection

Two independent signals, reported separately so a reviewer can see *why*:

1. **Logical key** — supplier GSTIN + invoice number + invoice date + total. An exact match is
   `CONFIRMED` and `MATERIAL`. This is the case in the issue's own example.
2. **Content fingerprint** — a normalised hash over supplier, number, date, line HSN/quantity/rate
   and totals. Matches a re-send that was retyped or re-scanned.

Partial agreement produces `LIKELY` or `POSSIBLE` with a `confidence` between 0 and 1 and the list
of fields that agreed and disagreed. **An amended invoice is not a duplicate**: same number, later
date, different total, and a document that says it revises another is `AMENDMENT`, not a match.

Confidence is arithmetic over which fields matched. It is not a model score.

## Totals are recomputed, never read

`recomputed` is built from the lines upward: quantity × rate per line, summed to taxable value; tax
from the rules engine's `gst.tax_split` decision; total as taxable + tax. Money is `bigint` paise,
quantities `bigint` micro-units, rates basis points (rule 9).

The printed totals are then compared against the recomputed ones. Where they differ by more than
tolerance, the recomputed figure wins and a finding is raised. A document whose own arithmetic does
not add up never posts silently.

## Tolerance policy

```ts
interface TolerancePolicy {
  readonly roundingPaise: bigint;        // default 100n — ₹1, absorbs GST rounding
  readonly taxAbsolutePaise: bigint;     // default 100n
  readonly totalAbsolutePaise: bigint;   // default 100n
  readonly totalRelativeBasisPoints: number; // default 10 — 0.1%
}
```

Tolerance is per company, effective-dated, and recorded in the verdict so a past decision can be
explained under the policy that was in force. Widening it is a permission-gated act under #6.

## When the rules engine cannot decide

`CANNOT_DECIDE` is expected, not an error. It becomes a `SIGNIFICANT` finding naming the missing
facts, and the item goes to the exception queue (rule 8). It never becomes a guessed tax split.

**Known limitation at v1.0.0:** every rule in `in.gst` is `reviewState: 'DRAFT'` pending #54, so a
`production` engine returns `CANNOT_DECIDE` for tax split and place of supply. Tax validation
therefore degrades to arithmetic self-consistency until #54 publishes reviewed sources. This is
recorded per verdict in `taxCheck.basis` as `RULES_ENGINE` or `SELF_CONSISTENCY_ONLY` so no caller
mistakes one for the other.

## Corrections carry evidence

Each correction names the field, what the document said, what is suggested instead, and the
`FieldEvidence` from #15 — page, text and bounding box — so a reviewer sees the pixels the value
came from before accepting. Accepting a correction is an idempotent command under #6.

## Wording

Findings are written for a shopkeeper: "This bill has already been entered on 12 August, so adding
it again would pay the same supplier twice", not "duplicate constraint violation".
