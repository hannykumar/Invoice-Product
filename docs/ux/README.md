# Zero-training user experience (issue #46 — [E46])

> *"meri app lalloo chala le"* — someone who has never studied accounting must be able to run
> this app, without us removing a single control that protects their money.

This folder holds the plain-language design system. The words themselves live in code, in
[`packages/ux-vocabulary`](../../packages/ux-vocabulary), so that a screen can never invent its
own sentence and no two surfaces can describe the same thing differently.

| Page | What it settles |
| --- | --- |
| [00 — Design principles and content rules](./00-design-principles.md) | How we speak, what we hide until asked, how errors are built, and the rules a linter enforces. |
| [01 — First sale, purchase and payment walkthroughs](./01-walkthroughs.md) | The exact screens and words for the three things every business does on day one. |
| [02 — Usability test protocol](./02-usability-test-protocol.md) | How we prove the acceptance criterion "target users complete core tasks without training". |

## What is code, not prose

| File | Contents | Enforced by |
| --- | --- | --- |
| `packages/ux-vocabulary/src/catalogue/vocabulary.json` | Accounting term → the words we show, per language, with the words we never show | `test/catalogue.test.ts` |
| `packages/ux-vocabulary/src/catalogue/messages.json` | Every message a person can see, with why it happened and what they can do next | `test/catalogue.test.ts` |
| `packages/ux-vocabulary/src/catalogue/state-labels.json` | Plain wording for every state in `docs/product/spec/states.json` | `test/catalogue.test.ts` |
| `packages/ux-vocabulary/src/catalogue/task-flows.json` | The step budget for everyday work, and the safety checks that may not be removed to meet it | `test/catalogue.test.ts` |
| `packages/ux-vocabulary/src/lint.ts` | The plain-language linter | `test/catalogue.test.ts` |

## How a screen uses it

```ts
import { renderMessage, permittedSteps } from '@invoice/ux-vocabulary';

const message = renderMessage('stock.not_enough', locale, {
  itemName: 'Apple box, 10 kg',
  warehouseName: 'Narela godown',
  available: '30',
  required: '70',
  shortfall: '40',
  unit: 'boxes',
});

const actions = permittedSteps(message, currentUser.permissions);
```

The screen renders `message.text`, `message.why` and one button per entry in `actions`. It never
concatenates its own sentence, and it never offers an action the user cannot perform.

The API surface is documented in [`docs/contracts/ux-vocabulary.v1.md`](../contracts/ux-vocabulary.v1.md).
Issue #38 (GPT 2) owns the visual foundations — layout, components, theming, responsiveness — and
consumes this contract for the wording.
