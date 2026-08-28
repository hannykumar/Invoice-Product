# Product specification (issue #1 — [E01])

This folder is the canonical product specification for the Invoice Product. It exists so that
three independent agents, and every agent that joins later, share one business context, one
vocabulary and one description of every core workflow **without reading any prior conversation**.

Every later issue links here.

## Read in this order

| Page | What it settles |
| --- | --- |
| [00 — Principles, scope and business types](./00-principles-and-scope.md) | What we are building, for whom, what is deliberately out of scope, and the non-negotiable rules. |
| [01 — Financial and GST glossary](./01-glossary.md) | What every word means, in plain language, with what it must not be confused with. |
| [02 — Core business workflows](./02-workflows.md) | Sale, purchase, return, payment, banking, inventory, GST, transport and approval, end to end, with the owning module of every step. |
| [03 — Transaction states](./03-states.md) | Every state a record can be in, every allowed transition, and the plain wording shown to the user. |
| [04 — Ownership boundaries](./04-ownership.md) | Which agent owns which of the 55 issues and which module path. |
| [05 — Worked examples](./05-worked-examples.md) | One realistic sale, purchase, partial payment, return and transport case, checked line by line. |

## Machine-readable source of truth

The Markdown pages 01 to 04 are **generated**. The source of truth is JSON, so that code, API
contracts and screens can import the same definitions instead of copying them:

| File | Contents |
| --- | --- |
| `spec/glossary.json` | Terms, plain-language wording per locale, definitions, examples, confusable terms. |
| `spec/workflows.json` | Workflow steps with actor, owning module, owning issue, result and rules. |
| `spec/states.json` | State machines, transitions, guards and the six user-facing state groups. |
| `spec/ownership.json` | All 55 issues with owner, module path, scope, dependencies and delivery wave. |

Regenerate the pages after changing any JSON file:

```bash
node --experimental-strip-types tools/spec-docs/generate.ts
```

`tools/test/` fails the build when a page is out of date, when a workflow references an unknown
issue or module owner, when a state machine has an unreachable state or a transition to a state
that does not exist, or when a document uses an accounting term that the glossary does not define.

## How to link to this specification from another issue

Use a stable anchor, not a page number:

- A term: `docs/product/01-glossary.md#place-of-supply`
- A workflow step: `docs/product/spec/workflows.json` → workflow `sale`, step 5
- A state: `docs/product/spec/states.json` → machine `sales_invoice`, state `PENDING_APPROVAL`
- Your own boundary: `docs/product/04-ownership.md`, row for your issue number

## Changing the specification

The specification is a shared contract. Change it the way a contract is changed:

1. Open a pull request that edits the JSON source, never only the generated Markdown.
2. Name every issue affected by the change.
3. Regenerate the pages and run the checks.
4. If a term, state or workflow step is removed or renamed, list the modules that must migrate.

Silently redefining a shared term is the single most damaging change an agent can make here.
