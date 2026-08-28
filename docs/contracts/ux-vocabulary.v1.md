# Contract: `ux-vocabulary` v1.0.0

| | |
| --- | --- |
| **Owner** | GPT 1, issue #46 [E46] |
| **Consumed by** | GPT 2 (#38 client foundations, #39 notifications, #47 action agent), GPT 3 (all user-facing purchase, GST and transport surfaces), GPT 1 (#9, #10, #11, #12, #13, #20, #34, #35, #36, #37) |
| **Package** | `@invoice/ux-vocabulary` |
| **Status** | Published |

## Purpose

One source of user-facing wording. A surface asks for a message id and supplies values; it never
writes a sentence. This is what makes the wording testable, translatable and consistent with the
glossary in issue #1.

## Data model

```ts
type Locale = 'en-IN' | 'hi-IN';
type Severity = 'block' | 'warn' | 'info' | 'success' | 'progress';

interface Message {
  id: string;                  // stable, dot-separated, e.g. "stock.not_enough"
  severity: Severity;
  surface: string[];           // where it may appear: sale, purchase, payment, voice, transport, ...
  placeholders: string[];      // every {name} used in any locale
  text: Record<Locale, string>;
  why: Record<Locale, string>;
  nextSteps: { id: string; label: Record<Locale, string>; requiresPermission?: string }[];
}
```

## API

| Function | Behaviour |
| --- | --- |
| `renderMessage(id, locale, values)` | Returns `{ id, severity, text, why, nextSteps }` with every placeholder filled. |
| `permittedSteps(rendered, heldPermissions)` | Drops steps whose `requiresPermission` the caller does not hold. |
| `stateLabel(machine, state, locale)` | Plain wording for any state in `docs/product/spec/states.json`. |
| `groupLabel(group, locale)` | Plain wording for one of the six user-facing state groups. |
| `plainWordFor(glossaryTerm, locale)` | The words to show for a glossary term, or `undefined` when the term is internal only. |
| `allMessages()` | The full catalogue, for tooling and translation workflows. |
| `lintUserFacingText(text, { locale, allow })` | The plain-language rules, for any string this package does not own. |

## Errors

| Error | When | Caller must |
| --- | --- | --- |
| `UnknownMessageError` | The message id is not in the catalogue | Add the message to the catalogue; do not fall back to an inline string |
| `MissingPlaceholderValueError` | A required value was not supplied | Supply it; showing a raw `{amount}` to a user is a defect, not a cosmetic issue |
| `Error` from `stateLabel` | A state has no plain wording | Add it to `state-labels.json` in the same pull request that adds the state |

These throw rather than degrading. A half-rendered money message is more dangerous than a visible
failure.

## Rules for consumers

1. Never inline a user-facing sentence. If the wording you need is missing, add a message.
2. Never show `nextSteps` without filtering them through `permittedSteps`.
3. Never display an internal state name. Use `stateLabel`.
4. Never remove a `block` or `warn` message to shorten a flow. The step budget is met by hiding
   optional inputs, not consequences.
5. Formatting of amounts, quantities and dates follows
   [the content rules](../ux/00-design-principles.md#6-money-numbers-and-language).

## Permissions

This package holds no data and enforces no permissions. It only *declares* the permission a next
step requires, so a surface can hide actions the user cannot take. Server-side permission checks
remain the responsibility of GPT 2's issue #3 on every command.

## Idempotency

Pure and side-effect free. Calling `renderMessage` twice with the same input returns the same
output. There is nothing to retry.

## Adding a language

Add the locale to `locales` in each catalogue file and supply the strings. The tests fail until
every message, every next step and every state label has the new locale, and until the new strings
carry the same placeholders as the existing ones.

## Change policy

Adding a message or a next step is a minor version. Changing a message id, removing a message, or
changing what a message means is a **major** version and must name every consuming issue in the
pull request. Rewording an existing message for clarity is a patch version and does not break
consumers, because consumers never depend on the words, only on the id.
