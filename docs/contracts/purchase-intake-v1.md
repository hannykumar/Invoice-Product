# Purchase intake v1

Owner: GPT 3 (issue #15). Consumers: GPT 3 (#16 validation, #17 posting), GPT 2 (channel adapters).

The inbox turns a document that arrived from somewhere into a reviewable draft. It is the only
module allowed to accept an unverified document, and it is not allowed to post anything.

## The one rule

**Nothing in this module touches money.** No ledger entry, no stock movement, no supplier
payable, no ITC claim. The furthest a document travels here is `draft_ready`. Issue #16 validates
the draft and issue #17 posts it, both after a human has approved.

## Life of a document

```
received → screening → (quarantined)
         → extracting → (failed → retry) → draft_ready
         → discarded (duplicate, or a human rejected it)
```

`quarantined` always carries a `QuarantineReason` and a sentence a shopkeeper can act on.
`failed` is a technical problem and is retryable; `quarantined` needs a human decision.

## Order of operations, and why

1. **Screen the attachment** before anything reads it: real type from magic bytes against the
   declared type, size cap, password-protected and script-carrying PDFs, virus verdict.
2. **Route to a company** before the pages go to the OCR provider, so no company's paperwork is
   ever processed under another company's tenant.
3. **Read** — e-invoice JSON is parsed locally; PDFs and photos go to the OCR connector.
4. **Re-check routing against what was printed.** When routing came from a channel binding
   (guessed) and the document names a different company's GSTIN and never this one's, the
   document is quarantined as `COMPANY_MISMATCH`.

## Routing precedence

| basis | when | confidence |
| --- | --- | --- |
| `explicit_company` | an authenticated user uploaded into a company | 1.0 |
| `buyer_gstin` | the buyer GSTIN on the document matches exactly one company | 0.99 |
| `channel_binding` | the email alias or WhatsApp number belongs to one company | 0.70 |

An explicit upload is still overruled by a buyer GSTIN that belongs to a *different* company:
that is the most common way a document ends up in the wrong books. A GSTIN that matches no
company is `COMPANY_MISMATCH` — it is someone else's invoice.

## Deduplication

- **Attachment level (here):** SHA-256 of the file, scoped to the company. A second arrival is
  marked `discarded` with `duplicateOfId` set, and is never read twice.
- **Channel level (here):** `sender.providerMessageId`. A provider redelivering the same message
  returns the original document and does not call OCR again.
- **Logical level (#16):** `logicalKey(draft)` returns supplier GSTIN + invoice number + date +
  total for the same invoice arriving as a photo on WhatsApp and a PDF by email. This module
  exposes the key; deciding what to do about it is #16's.

## Every extracted value carries its evidence

```ts
interface ExtractedField<T> {
  value: T;
  confidence: number;        // 0-1
  evidence: { page, text, box?, jsonPath? };
  warning?: string;
}
```

`box` is in fractional page coordinates (0-1) so any zoom level can highlight it; `page: 0` with
a `jsonPath` means the value came from structured JSON rather than from pixels. This is what the
acceptance criterion "users can inspect every extracted value against source evidence" requires:
the UI shows the source text and highlights it, it does not ask the user to trust a number.

Confidence bands: below `REVIEW_CONFIDENCE` (0.8) a field is listed in `fieldsNeedingReview`;
below `QUARANTINE_CONFIDENCE` (0.4), or with three of the four essential fields missing, an OCR
document is quarantined rather than drafted. e-invoice JSON reads at confidence 1.

## Deterministic reading, never repair

- Money is parsed to exact `bigint` paise. `1,23,456.78` and `₹ 100` both work; anything else is
  `null`, not a guess.
- Dates are read day-first, as Indian invoices are written. When both parts are 12 or less the
  field carries a warning and a reduced confidence, because it genuinely cannot be resolved from
  the document alone.
- A GSTIN that fails its own check digit is reported as a problem and its confidence drops to
  0.3. It is never corrected.
- `crossCheck` reports arithmetic that does not add up (taxable + tax ≠ total, lines ≠ taxable).
  It reports; it does not reconcile.

## Connector use

OCR goes through `ExternalConnector` (`connector-v1`, kind `ocr`) with operation
`ocr.read_document`. The OCR idempotency key is `ocr:<documentId>`, so a retry after a timeout
returns the provider's existing result rather than paying for a second read. `MockOcrAdapter`
implements the same interface and can simulate outage, timeout, first-attempt failure, blurred
pages and rotated scans.

## What #16 receives

An `ExtractionDraft` with the fields above, `fieldsNeedingReview`, `arithmeticProblems`, and the
`documentId` linking back to the source file. Supplier identification against master data is a
*suggestion* only; #16 confirms it, and `resolveByName` may legitimately answer `ambiguous`.

## Out of scope here

Approving or posting a purchase; three-way matching (#18); supplier risk (#19); duplicate
*invoice* detection beyond the file level (#16); unofficial WhatsApp scraping — intake uses the
official WhatsApp Business channel through GPT 2's adapter only.
