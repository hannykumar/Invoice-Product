<!-- GENERATED FILE — do not edit by hand.
     Source: docs/product/spec/workflows.json
     Regenerate: node --experimental-strip-types tools/spec-docs/generate.ts -->

# Core business workflows

Issue [#1](./README.md) records every core flow from start to finish, with the module that owns each step. An agent that has read only this page can say what a purchase invoice does without reading any earlier conversation.

Workflow specification version **1.0.0**.

## Sale

**In plain words:** Sell something and give the customer a bill

**Starts when:** A user types, speaks or scans a sale instruction, or an approved quotation is converted.

| # | Step | Who | Owning module | Issue | Result |
| --- | --- | --- | --- | --- | --- |
| 1 | Capture the instruction | user | `packages/voice-assistant` | #10 | Draft sale request with a confidence score for every extracted field. |
| 2 | Resolve the customer and items | system | `packages/master-data` | #5 | Party id, item ids, units, HSN/SAC, tax profile. |
| 3 | Apply price and check credit | system | `packages/pricing-credit` | #11 | Rate with its source, discount authority check, credit-limit decision (allow, warn, block). |
| 4 | Check and reserve stock | system | `packages/inventory` | #12 | Reservation or a shortage block. |
| 5 | Calculate GST | system | `packages/gst-calc` | #25 | Tax lines with place of supply, rate, CGST/SGST/UTGST/IGST split, cess and the rule version used. |
| 6 | Show a preview and take approval | user | `packages/workflow-audit` | #6 | Approval decision recorded with actor and time. |
| 7 | Finalise the invoice | system | `packages/sales` | #9 | Permanent invoice number, immutable invoice record. |
| 8 | Post to the ledger | system | `packages/ledger` | #4 | Balanced SALE voucher: customer debit, income credit, output tax credit, round-off. |
| 9 | Post the stock issue | system | `packages/inventory` | #12 | Stock movements out, reservation consumed. |
| 10 | Register the e-invoice if applicable | system | `packages/e-invoice` | #26 | IRN and signed QR, or a clearly failed state. |
| 11 | Create the e-way bill if applicable | system | `packages/e-way-bill` | #27 | E-way bill number and validity, or a documented not-required decision. |
| 12 | Render and deliver | system | `packages/invoice-templates + packages/delivery` | #13 | PDF or print output and a delivery record. |
| 13 | Track the receivable | system | `packages/receivables-payables` | #20 | Open receivable with due date and ageing bucket. |

**Rules that must hold**

- Step 1 (Capture the instruction): Low-confidence party, item, quantity, unit or price is confirmed with the user, never assumed.
- Step 2 (Resolve the customer and items): Two similar names must be disambiguated by the user.
- Step 2 (Resolve the customer and items): An unknown customer is created only after the user confirms the details.
- Step 3 (Apply price and check credit): The price source is always shown.
- Step 3 (Apply price and check credit): Credit uses outstanding plus pending transactions.
- Step 4 (Check and reserve stock): Availability is physical minus reserved.
- Step 4 (Check and reserve stock): Overselling requires an authorised override with a reason.
- Step 5 (Calculate GST): A missing place-of-supply fact blocks the sale and opens an exception item.
- Step 5 (Calculate GST): An LLM never chooses the rate.
- Step 6 (Show a preview and take approval): Preview repeats customer, quantity, unit, price, tax basis and stock impact in plain words.
- Step 7 (Finalise the invoice): Numbering is unique per company, branch and financial year and is concurrency safe.
- Step 7 (Finalise the invoice): The same idempotency key never creates a second invoice.
- Step 8 (Post to the ledger): The voucher must balance to zero or nothing is written.
- Step 9 (Post the stock issue): Ledger posting and stock posting succeed or fail together.
- Step 10 (Register the e-invoice if applicable): Retries must not create a second IRN.
- Step 11 (Create the e-way bill if applicable): Applicability is a deterministic rule decision with evidence.
- Step 12 (Render and deliver): Mandatory legal fields cannot be removed by any template.

**When things go wrong**

| Situation | What the product does |
| --- | --- |
| Stock short | Block with the exact shortfall and offer reduce quantity, choose another warehouse, or authorised override. |
| Place of supply unknown | Move to the exception queue; never post a guessed tax split. |
| IRP or e-way service down | Invoice stays FINAL and correct in the books; the government step shows a retryable failed state. |
| Duplicate submit after timeout | The idempotency key returns the original invoice. |

## Purchase

**In plain words:** Record a supplier's bill, add stock and record what you owe

| # | Step | Who | Owning module | Issue | Result |
| --- | --- | --- | --- | --- | --- |
| 1 | Receive the supplier bill | supplier | `packages/purchase-inbox` | #15 | Captured document with extracted fields and confidence. |
| 2 | Validate and detect duplicates | system | `packages/purchase-validation` | #16 | Validation result, duplicate verdict, supplier GSTIN check. |
| 3 | Match to purchase order and goods receipt | system | `packages/procurement` | #18 | Three-way match result with tolerances. |
| 4 | Approve | user | `packages/workflow-audit` | #6 | Approval record. |
| 5 | Post the purchase | system | `packages/purchase-posting` | #17 | PURCHASE voucher: purchases debit, input tax debit, supplier credit; stock movements in. |
| 6 | Track input tax credit | system | `packages/ims-reconciliation` | #31 | Credit marked provisional until it appears in GSTR-2B. |

**Rules that must hold**

- Step 2 (Validate and detect duplicates): A suspected duplicate is never posted silently.
- Step 5 (Post the purchase): Increases stock and creates a payable; it never creates a sale or a receivable.

**When things go wrong**

| Situation | What the product does |
| --- | --- |
| Same supplier invoice number arrives twice | Blocked as duplicate with a link to the existing record. |
| Bill total does not match line totals | Exception item; the difference is shown, never absorbed. |

## Return

**In plain words:** Goods come back, or a bill has to be reduced

| # | Step | Who | Owning module | Issue | Result |
| --- | --- | --- | --- | --- | --- |
| 1 | Choose the original document | user | `packages/returns` | #45 | Linked original invoice and returnable quantities. |
| 2 | Decide the tax treatment | system | `packages/gst-calc` | #25 | Tax reversal lines using the original invoice's rule version. |
| 3 | Approve and issue the note | user | `packages/returns` | #45 | Credit note for a sales return, debit note for a purchase return. |
| 4 | Post the reversal | system | `packages/ledger + packages/inventory` | #4 | CREDIT_NOTE or DEBIT_NOTE voucher plus reversing stock movements. |

**Rules that must hold**

- Step 1 (Choose the original document): Return quantity can never exceed the original quantity less earlier returns.
- Step 2 (Decide the tax treatment): A return uses the tax treatment effective for the original supply.
- Step 4 (Post the reversal): Party balance, tax and stock all move together or not at all.

**When things go wrong**

| Situation | What the product does |
| --- | --- |
| Original period already hard-locked | The note is dated in the current open period and linked to the original document. |
| Goods not physically returned | A value-only note is issued with no stock movement, and this is stated on the note. |

## Payment

**In plain words:** Money comes in from a customer or goes out to a supplier

| # | Step | Who | Owning module | Issue | Result |
| --- | --- | --- | --- | --- | --- |
| 1 | Record the money | user | `packages/receivables-payables` | #20 | Receipt or payment with mode: cash, cheque, bank transfer, UPI, other. |
| 2 | Allocate to bills | user | `packages/receivables-payables` | #20 | Allocation lines per invoice; the remainder stays on account. |
| 3 | Post to the ledger | system | `packages/ledger` | #4 | RECEIPT or PAYMENT voucher. |
| 4 | Update outstanding and ageing | system | `packages/receivables-payables` | #20 | Recomputed outstanding and ageing buckets. |

**Rules that must hold**

- Step 1 (Record the money): Cheques start as PENDING and are not treated as cleared money.
- Step 2 (Allocate to bills): Partial payment never marks an invoice paid.
- Step 2 (Allocate to bills): Unallocated money is visible, not assumed.
- Step 4 (Update outstanding and ageing): Outstanding equals invoice value less accepted allocations.

**When things go wrong**

| Situation | What the product does |
| --- | --- |
| Cheque bounces | Post a reversal, restore the outstanding, keep the full cheque history, and notify. |
| Customer pays more than the bills | Excess is held on account, not silently written off. |

## Banking

**In plain words:** Match your bank statement with your books

| # | Step | Who | Owning module | Issue | Result |
| --- | --- | --- | --- | --- | --- |
| 1 | Import or fetch statement lines | system | `packages/bank-import + packages/bank-feeds` | #21 | Normalised bank lines. |
| 2 | Suggest matches | system | `packages/bank-reconciliation` | #22 | Suggested links to receipts, payments and invoices with confidence. |
| 3 | Confirm or create entries | user | `packages/bank-reconciliation` | #22 | Confirmed reconciliation or a new voucher. |
| 4 | Report unmatched items | system | `packages/bank-reconciliation` | #22 | Reconciliation exception list. |

**Rules that must hold**

- Step 1 (Import or fetch statement lines): Re-importing the same file must not double-count lines.
- Step 2 (Suggest matches): A suggestion is never posted without confirmation.

**When things go wrong**

| Situation | What the product does |
| --- | --- |
| One bank credit covers three invoices | The user splits the allocation; the product does not choose. |

## Inventory

**In plain words:** Keep the godown count right

| # | Step | Who | Owning module | Issue | Result |
| --- | --- | --- | --- | --- | --- |
| 1 | Record every movement | system | `packages/inventory` | #12 | Append-only movement rows linked to a source document. |
| 2 | Maintain availability | system | `packages/inventory` | #12 | Physical, reserved, available per item, warehouse and batch. |
| 3 | Handle transfers and adjustments | user | `packages/inventory` | #12 | Transfer and adjustment documents with reasons. |
| 4 | Value the stock | system | `packages/inventory + packages/ledger` | #12 | Valuation postings using the configured method. |

**Rules that must hold**

- Step 1 (Record every movement): Stock is always derived from movements; no balance is edited directly.
- Step 3 (Handle transfers and adjustments): Every adjustment needs a reason and, above a threshold, an approval.
- Step 4 (Value the stock): The valuation method is fixed per company and changing it is an audited event.

**When things go wrong**

| Situation | What the product does |
| --- | --- |
| Two users sell the last 30 boxes at the same time | One succeeds; the other is blocked with the corrected availability. |
| Backdated movement into a locked period | Blocked unless the period lock policy allows an audited override. |

## GST

**In plain words:** Work out and file your GST correctly

| # | Step | Who | Owning module | Issue | Result |
| --- | --- | --- | --- | --- | --- |
| 1 | Classify each line | system | `packages/gst-calc` | #25 | HSN or SAC, rate, exemption or nil treatment, reverse-charge flag. |
| 2 | Decide the place of supply | system | `packages/gst-calc` | #25 | Place of supply and intra or inter-state conclusion. |
| 3 | Prepare returns | system | `packages/gst-returns` | #30 | GSTR-1 and GSTR-3B working papers with exception lists. |
| 4 | Reconcile purchases with GSTR-2B | system | `packages/ims-reconciliation` | #31 | Matched, missing and mismatched credit lines. |
| 5 | File and record | user | `packages/gsp-integration` | #33 | Filed acknowledgement stored against the tax period. |

**Rules that must hold**

- Step 1 (Classify each line): Effective-dated tax data with a source reference.
- Step 2 (Decide the place of supply): Unsupported scenarios are refused with an explanation, not approximated.
- Step 4 (Reconcile purchases with GSTR-2B): Credit is claimed only for eligible, reconciled lines.
- Step 5 (File and record): Filing requires explicit human approval and is idempotent on retry.

**When things go wrong**

| Situation | What the product does |
| --- | --- |
| Rate changes mid-period | Each invoice uses the rate effective on its own document date. |
| Supplier has not filed | Credit is held as unavailable with the supplier and amount shown. |

## Transport

**In plain words:** Move the goods legally and safely

| # | Step | Who | Owning module | Issue | Result |
| --- | --- | --- | --- | --- | --- |
| 1 | Decide e-way applicability | system | `packages/rules-engine + packages/e-way-bill` | #27 | Required or not required with the facts and rule version used. |
| 2 | Capture transporter and vehicle | user | `packages/transport` | #28 | Transporter id, vehicle number, mode, distance. |
| 3 | Verify the vehicle record | system | `packages/vehicle-verification` | #29 | Vehicle class and capacity check result. |
| 4 | Generate, update and close the e-way bill | system | `packages/e-way-bill` | #27 | E-way bill with validity, vehicle updates and closure. |

**Rules that must hold**

- Step 2 (Capture transporter and vehicle): An implausible vehicle for the load warns or blocks.
- Step 4 (Generate, update and close the e-way bill): Retries must not create a second e-way bill.

**When things go wrong**

| Situation | What the product does |
| --- | --- |
| Two-wheeler entered for a multi-ton load | Warn or block with the capacity evidence. |
| Vehicle changes in transit | Record a Part-B update against the same e-way bill. |

## Approval and exceptions

**In plain words:** A person checks anything risky before it happens

| # | Step | Who | Owning module | Issue | Result |
| --- | --- | --- | --- | --- | --- |
| 1 | Detect that approval is needed | system | `packages/workflow-audit` | #6 | Approval request with the reason and a plain-language preview. |
| 2 | Preview the exact effect | user | `owning module` | #6 | What will change in books, stock, tax and money. |
| 3 | Approve, reject or override | user | `packages/workflow-audit` | #6 | Decision with actor, time and typed reason. |
| 4 | Record in the audit trail | system | `packages/workflow-audit` | #6 | Append-only audit entry without secrets. |

**Rules that must hold**

- Step 1 (Detect that approval is needed): Thresholds are configuration, not code.
- Step 2 (Preview the exact effect): The preview must be understandable without accounting training.
- Step 3 (Approve, reject or override): The requester cannot approve their own request unless the company explicitly allows it.

**When things go wrong**

| Situation | What the product does |
| --- | --- |
| Approver is unavailable | The item waits in a clearly visible queue; it is never auto-approved by time-out. |
| AI proposes an action | It enters the same approval path as manual entry, with no shortcut. |
