# Invoice Product

A standalone, India-first accounting, inventory, GST-compliance and business-operations product
for MSMEs. It is meant to replace an ordinary billing tool, not to plug into one.

**Accuracy is the product promise.** AI may read documents, understand speech and answer
questions. AI never decides money or law. Every posting and every compliance conclusion comes
from deterministic, versioned, testable rules.

## Start here

| If you are | Read |
| --- | --- |
| New to the project | [`docs/product/README.md`](docs/product/README.md) — the canonical specification |
| Looking for a word's meaning | [`docs/product/01-glossary.md`](docs/product/01-glossary.md) |
| Looking for how a flow works | [`docs/product/02-workflows.md`](docs/product/02-workflows.md) |
| Wondering who owns an issue | [`docs/product/04-ownership.md`](docs/product/04-ownership.md) |
| Writing anything a person will read | [`docs/ux/README.md`](docs/ux/README.md) |
| Consuming another module | [`docs/contracts/README.md`](docs/contracts/README.md) |

## Packages on this branch (`codex/gpt1-accounting-sales`)

| Package | Issue | What it is |
| --- | --- | --- |
| [`packages/kernel`](packages/kernel) | #4 | Exact money, exact quantities, rounding, identifiers, dates, the error model |
| [`packages/ledger`](packages/ledger) | #4 | The double-entry ledger: the only write path into the books |
| [`packages/rules-engine`](packages/rules-engine) | #7 | Deterministic, effective-dated, versioned rules that return explainable decisions |
| [`packages/gst-calc`](packages/gst-calc) | #25 | Deterministic GST computation, place of supply and tax classification |
| [`packages/ux-vocabulary`](packages/ux-vocabulary) | #46 | The only supported way to produce user-facing wording |

## Running the checks

Node 22.18 or newer. There are no runtime dependencies; TypeScript runs directly.

```bash
npm install
```

```bash
npm run check
```

That type-checks every package and runs the whole test suite: the ledger's golden postings,
rounding, period locks, reversals, concurrency and tenant isolation; the money and quantity
arithmetic; the plain-language rules; and the specification's own consistency checks.

## A note on the workspace layout

The root `package.json` and `tsconfig.json` here are **provisional**. Repository architecture,
build tooling and CI belong to issue #2, owned by GPT 2, and supersede them. They exist only so
this branch can run its own tests while the repository is otherwise empty.
