# Contract: `voice-assistant` v1.0.0

| | |
| --- | --- |
| **Owner** | GPT 1, issue #10 [E10] |
| **Consumed by** | GPT 2 (#38 web, #47 action agent), GPT 1 (#9 sales, #34 knowledge assistant) |
| **Package** | `@invoice/voice-assistant` |
| **Status** | Published |

## Purpose

Turn *"ABC ko sattar box apple aath sau per box becho"* into a draft a person confirms.

## Where the model is, and where it is not

A model may **transcribe sound into text**. That is the entire extent of it, and it lives behind
`TranscriptionPort`. Everything after that is a lexicon and a lookup:

- **Numbers** come from a table. `sattar` is 70 and `satrah` is 17 because the table says so, and a
  table can be tested, corrected and explained. A word not in it becomes a question, never a guess.
- **Customers and items** are resolved by GPT 3's #5, which answers `resolved`, `ambiguous` or
  `not_found`. `ambiguous` is never treated as `resolved`.
- **Nothing is posted here.** The output is a `DraftInvoiceInput` — the same shape a person typing
  produces — handed to `SalesService`, so the same permissions, approvals, stock checks and tax
  rules apply. Speaking a sale does not open a shorter path to the books.

## Confidence, and where it lives

Every field carries its value, **its evidence** (the words it came from), its source
(`DIGITS`, `WORDS`, `MODEL`, `USER_CONFIRMED`) and a confidence. A material field below
`MATERIAL_CONFIDENCE` (0.9) becomes a question: quantity, unit, rate, price basis, customer, item.

**Uncertainty localises to the field it is about.** A provider's confidence is about the whole
utterance, but the doubt is usually in one word. When every transcription alternative agrees the
rate was 800, the rate is not what the provider was unsure of — so it keeps the parser's own
confidence, and only a genuine disagreement drops it. Without this, one uncertain word would make
someone re-confirm the customer, the item and the rate to fix a quantity, which is exactly the
failure this issue is about.

## The conversation

```ts
let session = AssistantSession.fromSpeech(companyId, transcription, resolver, documentDate, capturedAt);
session.questions();            // what is still standing in the way
session = session.answer('quantity', '70');   // one answer, one field
session.confirmation('en-IN');  // read it back before anything is recorded
session.toDraftInput();         // refuses while any question is open
```

Sessions are immutable: answering returns a new one, so going back is free and a correction can be
undone.

Every question carries `ask`, `why`, the options worth offering, and **what we heard**, in both
languages. All of it passes the #46 plain-language linter.

## What travels with the draft

The transcript — every alternative, the language, the recording reference and when it was captured
— is kept **beside** the draft as evidence. It is never the source of truth for a figure. The
narration records what was said so a bill can be explained later.

## Supported today

- One item per instruction.
- English, Hindi in Latin script, and the mixture people actually speak. Devanagari digits are
  normalised; Devanagari words are not yet in the lexicon.
- The word orders `sell <qty> <unit> <item> to <party> at <rate>` and
  `<party> ko <qty> <unit> <item> <rate> per <unit> becho`.

## Known limitations

- **One line per instruction.** "Two boxes of apples and three of juice" is not read as two lines.
- Devanagari **words** are not in the lexicon, only Devanagari digits.
- Hindi numbers are covered for 0–99 plus sau, hazaar, lakh and crore; an unlisted word becomes a
  question rather than a guess, which is safe but adds friction.
- Only sales. Purchases, payments and returns are not parsed.
- There is no `TranscriptionPort` implementation shipped; #8's connector contract is where a real
  speech provider belongs, and development uses supplied text.
- Adding a language means adding a lexicon table and the question wording. No sentence is generated.
