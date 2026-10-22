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
2. **Route to a company** before anything is read, so no company's paperwork is ever processed
   under another company's tenant, and so nothing inside the file can influence the choice.
3. **Read** — e-invoice JSON is parsed locally after its IRP signature is checked; PDFs and
   photos go to the OCR connector.
4. **Cross-check against what was printed.** The cross-check can *hold* a document in the
   company it was routed to (`COMPANY_MISMATCH`); it never moves it to another company:
   - a buyer GSTIN that is not one of this company's GSTINs holds it, whatever the routing basis;
   - for a channel binding, a document that prints GSTINs but none of this company's holds it.
   The hold message never names another company: the company list is every tenant.

## Routing (changed in 1.1.0, #400)

Only facts the sender cannot write decide the company:

| basis | when | confidence |
| --- | --- | --- |
| `explicit_company` | an authenticated upload: the company is `uploader.companyId` from the uploader's `RequestContext` | 1.0 |
| `channel_binding` | the address the provider delivered to belongs to exactly one company — an email alias for `email`, a WhatsApp Business number for `whatsapp` | 0.70 |

Anything else is quarantined `COMPANY_NOT_IDENTIFIED` and stays unrouted. **The buyer GSTIN
printed in a document never routes it** (`buyer_gstin` was removed from `RoutingBasis`): a GSTIN
is printed on every bill, so anyone can type a victim's into a forged file (threat model I1).
`ReceiveInput.explicitCompanyId` was removed for the same reason — a caller-supplied company id is
never authority; pass `uploader: RequestContext` instead.

`deliveredTo` must come from the provider's delivery record (SMTP envelope recipient, WhatsApp
Business phone-number id), never from a header the sender wrote. That is the channel adapter's
obligation (GPT 2).

An alias or WhatsApp number may be shared only by companies that declare the same `ownerId`;
the service constructor refuses any other overlap. WhatsApp numbers compare in full
international digits (a bare ten-digit number is read as +91), not by their last ten digits.

## Later commands are tenant- and permission-checked (1.1.0, #400)

Both need the new permission `purchase.inbox.manage` (added to the platform `Permission` union and
the owner/setup role lists). Another company's document answers `NOT_FOUND` everywhere —
`document`, `draft`, `retry`, `assignCompany` — so ids cannot be probed (previously
`TENANT_ISOLATION`).

- `retry(context, documentId)` — only a `failed` document of `context.companyId`. A retry runs
  the same reading, cross-check and review rules as the first attempt.
- `assignCompany(context, documentId, reason)` — only for a document quarantined
  `COMPANY_NOT_IDENTIFIED` or `COMPANY_MISMATCH`, and only when it is already in
  `context.companyId` or arrived on an address `context.companyId` owns (a shared alias).
  An unrouted document that arrived on nobody's address answers `NOT_FOUND` to everyone. Safety
  holds (malware, active content, `SIGNATURE_INVALID`, …) cannot be cleared this way. A reason is
  required and the audit actor is `context.actorId`. The hold reason is cleared and the file
  joins the company's duplicate index. Reading an assigned document is not built yet: it stays
  `received`.
- `awaitingAssignment(context)` lists the unrouted documents on this company's shared addresses
  (id, channel, time, file name and size only).

## e-invoice signatures (1.1.0, #400)

`readEInvoiceJson(raw, { signatures })` and `PurchaseInboxService(…, { irpSignatures })` take an
`IrpSignatureVerifier` (`packages/gst/src/irp-signature.ts`). `Rs256IrpSignatureVerifier` checks
the IRP's RS256 JWS (`SignedInvoice`) with the public key(s) published on the IRP portal, using
`node:crypto` only. The key is configuration and is not in the repository; without one nothing is
ever verified.

| `signature` | meaning | effect |
| --- | --- | --- |
| `verified` | the IRP's signature checks out | values are read **only** from inside the signature, confidence 1 |
| `unverified` | carries a signature we could not check (no key) | values at `UNSIGNED_JSON_CONFIDENCE` (0.75), all listed for review |
| `unsigned` | no signature | same as `unverified` |
| `invalid` | the signature does not match, wrong key, or `alg` is not RS256 | quarantined `SIGNATURE_INVALID` |

`ExtractionDraft.signature` carries the status for JSON drafts. An IRN that is not the SHA-256 of
supplier GSTIN + financial year + document type + number is reported as a problem.

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
document is quarantined rather than drafted. e-invoice JSON reads at confidence 1 only when its
IRP signature is verified; otherwise at `UNSIGNED_JSON_CONFIDENCE` (see above).

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
