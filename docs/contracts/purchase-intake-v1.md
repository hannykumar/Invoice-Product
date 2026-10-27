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

1. **Screen the attachment** before anything reads it, against the whole file the channel
   adapter passed as `ReceiveInput.bytes` — never what the sender declared (1.2.0, #401):
   - the inbox measures `sizeBytes` and `sha256` from the bytes itself and stores the
     measured values on the document; the declared `attachment.sizeBytes`/`sha256` never
     reach the size cap or the dedup index;
   - real type from magic bytes against the declared type;
   - a virus-scan verdict of `infected` is quarantined `MALWARE_SUSPECTED`, and `unscanned`
     — a file no scanner has answered for — is **held** `AWAITING_SCAN`, not passed. The
     scanner's answer releases it through `scanAnswered(documentId, verdict)`, which runs
     the identical route-and-read pipeline on `clean` and holds `MALWARE_SUSPECTED` on
     `infected`;
   - a PDF is parsed for real over the whole file, not pattern-matched over its first
     kilobytes: `/Encrypt` in the trailer, active content (`/JavaScript`, `/JS`,
     `/OpenAction`, `/AA`, `/Launch`, `/EmbeddedFile`) in the clear or inside a
     decompressed stream, embedded files and actions reported by the parser are all
     held. Caps bound the check itself: `MAX_PDF_PAGES` (250), `MAX_PDF_OBJECTS`
     (20,000), `MAX_PDF_INFLATED_BYTES` (64 MB total across Flate streams — a
     decompression bomb) and `PDF_PARSE_LIMIT_MS` (10 s — a file that cannot be
     checked in time is held `UNREADABLE`).

   `ReceiveInput.head` (the first few kilobytes) and `jsonBody` were replaced by `bytes`,
   the whole file, in 1.2.0: an e-invoice JSON file is its own body, and every other
   type goes to the OCR connector by `storageKey`.
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
- `scanAnswered(documentId, verdict)` (1.2.0, #401) is the scanner integration's call, not a
  tenant command: it releases a document held `AWAITING_SCAN` into the normal pipeline on
  `clean`, or confirms it `MALWARE_SUSPECTED` on `infected`. It is the only way an
  unscanned file ever reaches a company.

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

- **Attachment level (here):** SHA-256 of the file **as measured from the received bytes**
  (#401 — a sender's declared hash cannot borrow another file's slot), scoped to the
  company. A second arrival is marked `discarded` with `duplicateOfId` set, and is never
  read twice.
- **Channel level (here):** `sender.providerMessageId`, scoped to facts the sender cannot write
  (#406): the channel, the destination the message arrived on (the uploader's company, or the
  delivery address the provider reported) and the file's measured SHA-256. A provider redelivering the
  same message with the same file returns the original document and does not call OCR again. A
  sender-chosen id (an email `Message-ID`, a client's message id) can never collide across
  companies or channels, and the same id carrying a different file is a new document — never a
  "duplicate" answer that returns another company's document or drops a real bill.
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

## Storage (#366)

Lane owner GPT 3. A document is stored once it is routed to a company, behind `InboxStore`
(`packages/purchasing/src/inbox-store.ts`): `InMemoryInboxStore` by default,
`PostgresInboxStore` (`inbox-postgres.ts`) on PostgreSQL, one contract suite for both
(`test/inbox-store-contract.ts`). Tables, from migration `…_purchasing_5fb63110524b_inbox_documents`:

| Table | Holds | Refuses |
| --- | --- | --- |
| `purchase_inbox_documents` | the routed document; the attachment as storage key and measured metadata, never the bytes | a second document for one `(company_id, message_key)` (#406); any change once `draft_ready` or `discarded`; any change to what arrived (only status, hold reason and message, duplicate link, attempts and routing are granted) |
| `purchase_inbox_contents` | which document of a company first held a file (SHA-256) | a second claim on the same file |
| `purchase_inbox_drafts` | the reviewable draft, paise as exact strings | a second draft for a document; any change |

All three force row-level security on `app.company_id`; nothing is granted `DELETE`.

- `PurchaseInboxService` takes `{ store, unitOfWork }`. It opens each step's unit of work itself,
  for the company routing chose, and never across the OCR call. Commands that read (`document`,
  `draft`, `inbox`) and `assignCompany` are now `async`; `inbox` takes an optional keyset `page`.
- A document whose company is not known yet (screening, `AWAITING_SCAN`, an address shared by
  several companies or by none) is **not stored**: it stays in the service's process until it is
  routed or claimed, and is lost if the process restarts. Keeping it durably needs a pre-tenant
  holding table of the kind `government_webhook_events` uses (#345/#389); there is none yet.

## In the running app (#489)

The service is built once for the process (`apps/api/src/purchase-inbox-application.ts`), not per
company, because routing needs every company's address. Its routes open their own short units of work
(`ownUnitsOfWork`); the OCR read never runs inside one.

| Route | Gate | What it does |
| --- | --- | --- |
| `GET /api/purchase-inbox` | `purchase.inbox.view` | The company's documents, newest first, each with a shopkeeper's state (`ready`, `reading`, `held`, `failed`, `duplicate`, `billed`, `rejected`), what to do next, and `sameBillAs` when a second file is the same bill (`logicalKey`). Also the unrouted documents on a shared address, and where suppliers send bills. |
| `GET /api/purchase-inbox/:id` | `purchase.inbox.view` | One document with every field's value, confidence in words, evidence text and page or JSON path, the essential fields not found, the sums that do not add up, and the form the person corrects (supplier and item *suggested*, never decided). |
| `POST /api/purchase-inbox/upload` | `purchase.inbox.upload` | `{ fileId }` — a bill already put in private storage and screened by #341 — or `{ einvoiceJson, fileName }`. The company is the session's. Resending the same file is the same document. |
| `POST /api/purchase-inbox/:id/retry`, `/assign`, `/reject` | `purchase.inbox.manage` | `retry` and `assign` are `PurchaseInboxService.retry` / `assignCompany`. `reject` writes a decision with a reason; the document stays. |
| `POST /api/purchase-inbox/:id/preview`, `/record` | `purchase.inbox.view` + `ledger.post.purchase` | The Purchase screen's own `previewPurchase` (#16 checks) and `recordPurchase` (#17 posts, receives stock), with the document's id. `record` then notes the decision `billed`. The reply lists what the person changed from what was read. |
| `POST /api/webhooks/purchase-inbox/:channel` | none — signed | `email` or `whatsapp`. The provider adapter's normal form `{ providerMessageId, from, deliveredTo, fileName, mimeType, contentBase64 }` inside a `ConnectorWebhook`, verified by `HmacWebhookVerifier` (secrets `PURCHASE_INBOX_WEBHOOK_SECRET_EMAIL` / `_WHATSAPP`; refused outright where none is set outside development). The company is `deliveredTo`, as the provider's delivery record reported it. Answers 202 `{ received, duplicate }` and nothing about any company. Body up to 12 MB. |

`purchase_inbox_decisions` (migration `…_purchasing_230a407f7be4_inbox_decisions`) holds one row per
document: `billed` with the bill number, or `rejected` with a reason. It is needed because a
`draft_ready` document is frozen by the database. Written once, never changed or deleted, row-level
security on `company_id`. `InboxDecisionStore`: `InMemoryInboxDecisionStore`, `PostgresInboxDecisionStore`.

Reading: `DevelopmentOcr` answers in development and tests (a sample bill made by `sampleBillPdf`, or
what it was told); elsewhere `OcrNotContracted` answers a retryable outage until a vendor is contracted
(#51). The e-invoice JSON path needs no OCR. The reader fills the header only (supplier, number, date,
taxable value, tax, total); the person types the bill's lines (e-invoice files carry theirs).
