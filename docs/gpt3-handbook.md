# Invoice Product — GPT 3 Delivery Handbook

> Converted from `Invoice_Product_GPT_3_Delivery_Handbook.docx` so that it travels with the
> repository. The document is the authoritative statement of scope for GPT 3's issues; where
> this file and a GitHub issue disagree, raise it rather than choosing silently.

**Accuracy is the product promise**

AI may interpret voice, documents and questions, but financial postings and compliance decisions must be deterministic, versioned, testable and auditable. Never silently guess missing financial facts.

## 1. Project context
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. The target is not a plugin for Tally, BUSY or Vyapar. The product should eventually replace ordinary billing/accounting tools for businesses that value correctness, automation and a simple non-accountant experience.

**Core business workflows**

- Purchase: read supplier invoices, validate GST and duplicates, match purchase order and goods received, approve, post purchase, increase stock and create supplier payable.
- Sale: understand a voice/text instruction, resolve customer and items, check stock and credit, calculate GST, approve, issue invoice, send it, reduce stock and create customer receivable.
- Transport: decide e-way-bill applicability, capture transporter and vehicle data, check vehicle plausibility and manage the e-way-bill lifecycle.
- Payments: record cash/cheque/bank receipts and payments, support partial payments, reconcile bank transactions and maintain outstanding balances.
- GST: prepare and reconcile GSTR-1, GSTR-3B, IMS/GSTR-2B, track deadlines, protect input-tax credit and explain exceptions.
- Returns: process partial/full sale or purchase returns and reverse inventory, tax and party balances correctly.
- Experience: voice, regional languages, Fancy Invoice templates, simple screens, an explainable knowledge assistant and a safe in-app action agent.

**Non-negotiable product rules**

- The double-entry ledger is the financial source of truth; every posted voucher must balance.
- Final transactions are immutable. Corrections use reversal, amendment, credit note or debit note with an audit trail.
- Stock cannot become negative unless an authorised override policy explicitly allows it and records the reason.
- Compliance decisions use deterministic rules linked to authoritative sources and effective dates; AI must not invent thresholds or tax treatment.
- Potentially destructive, financial or government actions require preview, approval and idempotency protection.
- External GST, bank, messaging and vehicle providers sit behind replaceable adapters; development must work with mocks before production credentials arrive.
- Every company is isolated from every other company. Permissions are enforced server-side.
- Low-confidence or contradictory input goes to an exception queue instead of being silently posted.

**What this product must prevent**

- Selling 70 units when only 30 are available without an authorised override.
- Creating duplicate purchase invoices, vouchers, IRNs, e-way bills or bank postings during retries.
- Using an obviously implausible vehicle, such as a two-wheeler for a multi-ton shipment, without a warning or block.
- Accepting incorrect GSTIN, HSN/SAC, GST rate, place of supply, totals or filing-period treatment without explanation and review.
- Marking an invoice paid when only a partial payment was received.
- Allowing AI-generated output to bypass the ledger, rule engine, approval workflow or audit history.

## 2. Your ownership and boundaries

**Your lane: Purchasing, GST, transport and government integrations**

- Your issues: #5, #15, #16, #17, #18, #19, #26, #27, #28, #29, #30, #31, #32, #33, #44, #45, #50, #51, #53
- Start immediately with: #5, #15, #50

**Other GPT ownership**

- GPT 1: Accounting, sales, deterministic rules and user experience; issues #1, #4, #7, #9, #10, #11, #12, #13, #20, #25, #34, #35, #36, #37, #43, #46, #48, #54
- GPT 2: Platform, banking, communications, security and operations; issues #2, #3, #6, #8, #14, #21, #22, #23, #24, #38, #39, #40, #41, #42, #47, #49, #52, #55

**Do not expand your ownership**

If an assigned issue needs another GPT's module, define or consume a narrow interface and use a mock. Do not reimplement the other GPT's ledger, authentication, GST, purchase, banking, notification or adapter module.

## 3. Parallel collaboration protocol
Work in a dedicated branch/worktree and keep changes limited to your owned modules whenever practical.
Before substantial implementation, publish the module's data model, commands/events, API contract, error model and test fixtures in the repository.
When a dependency is unfinished, build against its documented contract or a mock. Record every assumption in the pull request.
A dependent issue may be implemented in parallel, but it is not complete until the real dependency is integrated and its acceptance tests pass.
Never change a shared contract silently. Propose the change, identify affected issues and update contract tests.
Use stable identifiers, money-safe decimal types, effective dates, idempotency keys and explicit transaction states.
Commit in small, reviewable units. Every pull request must name the GitHub issue, dependencies, migrations, tests, mocks and unresolved risks.
Do not use production GSTINs, bank credentials, personal data or vendor secrets in tests.

**Required interface handoff**

- Contract name and version
- Owner GPT and consuming GPTs
- Request/response or command/event schema
- Validation and permission rules
- Idempotency and retry behaviour
- Expected errors and exception-queue behaviour
- Sample fixtures and contract tests
- Migration or compatibility notes

**Known dependency correction**

**Issue #19 / #31 circular dependency**

The published graph lists #19 and #31 as mutual blockers. For execution, #19 must first deliver baseline supplier-risk warnings without requiring #31. Issue #31 may later supply reconciliation/ITC signals through an optional interface. Keep #31 dependent on #19; do not keep #19 blocked by #31.

## 4. Delivery schedule

**Parallel wave**

- Owned issues
- Exit condition
- Weeks 1-2
#5, #15, #50
Acceptance tests pass; contracts and handoffs are committed; dependent work can replace mocks.
Weeks 3-5
#16, #17, #18, #29
Acceptance tests pass; contracts and handoffs are committed; dependent work can replace mocks.
Weeks 6-8
#19, #26, #27, #28
Acceptance tests pass; contracts and handoffs are committed; dependent work can replace mocks.
Weeks 9-11
#30, #31, #32, #33, #51, #53
Acceptance tests pass; contracts and handoffs are committed; dependent work can replace mocks.
Weeks 12-14
#44, #45
Acceptance tests pass; contracts and handoffs are committed; dependent work can replace mocks.
Weeks 15-18
Integration and pilot fixes
Acceptance tests pass; contracts and handoffs are committed; dependent work can replace mocks.

## 5. Definition of ready and done

**An issue is ready when**

- Its goal and acceptance criteria are understood.
- Required dependency contracts exist, even if their implementations are mocked.
- Files/modules to be owned are identified and do not conflict with another active GPT.
- Unknown financial or compliance decisions are explicitly listed instead of guessed.

**An issue is done only when**

- Implementation, migrations, API contracts and user-visible states are complete.
- Unit, integration, permission, idempotency and failure-path tests pass as applicable.
- The implementation works with realistic Indian-business fixtures.
- Security, tenant isolation, audit events and exception handling are verified.
- User-facing language is understandable without accounting knowledge.
- The real dependencies have replaced mocks and contract tests still pass.
- The pull request documents assumptions, supported scenarios and known limitations.

## 6. Detailed issue instructions
The following specifications are the authoritative execution instructions for this GPT's assigned issues. Preserve their scope and acceptance criteria.

## Issue #5 — [E05] Build business master data for parties, items, tax and logistics

**Owner: GPT 3**

Planned wave: Weeks 1-2
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Create reusable, validated master records used consistently by every transaction.

**User example**

- Speaking ‘ABC Traders’ resolves the correct customer, GSTIN, address, credit settings and previous item relationship.

**Required work**

- Customers, suppliers and multiple addresses/GSTINs
- Items/services, HSN/SAC, units and conversions
- Warehouses, batches, serials and opening stock fields
- Price lists, tax defaults, transporters, vehicles and bank accounts
- Duplicate detection, merge controls and effective-dated changes

**Dependencies**

#1, #3, #4
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Transactions reference stable master IDs
- Similar names do not silently resolve to the wrong party/item
- Changes preserve historical document facts

**Testing and failure handling**

- Duplicate and fuzzy-match tests
- Unit conversion tests
- Historical snapshot tests after master changes

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Supplier risk scoring
- Live GSTIN lookup

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #15 — [E15] Build an omnichannel purchase-invoice inbox with OCR

**Owner: GPT 3**

Planned wave: Weeks 1-2
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Receive supplier documents automatically from WhatsApp/email as well as upload, camera and e-invoice JSON, then create extraction drafts.

**User example**

- A supplier sends a PDF on WhatsApp; the business does not download or re-upload it—the app routes it to the correct company and prepares a purchase draft.

**Required work**

- Manual, camera, email and official WhatsApp Business intake
- PDF/image/e-invoice JSON parsing
- Company/GSTIN routing and attachment deduplication
- Field-level extraction confidence and source highlighting
- Quarantine for unsupported, suspicious or uncertain documents

**Dependencies**

#2, #5, #8
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- A received document becomes a draft without financial posting
- Users can inspect every extracted value against source evidence
- Documents cannot cross tenant boundaries

**Testing and failure handling**

- Multi-page, rotated, blurred and duplicate document tests
- Wrong-company routing tests
- Channel retry and attachment malware-validation tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Approve or post purchases automatically
- Unofficial WhatsApp account scraping

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #16 — [E16] Validate supplier invoices and detect duplicates

**Owner: GPT 3**

Planned wave: Weeks 3-5
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Check extracted purchase data before it can affect books, stock or ITC.

**User example**

- The app detects the same supplier GSTIN, invoice number and date submitted twice and blocks a duplicate purchase entry.

**Required work**

- Supplier/GSTIN/name/address/invoice-date checks
- Invoice-number and content-fingerprint duplicate detection
- Item, HSN/SAC, rate, place-of-supply, subtotal, tax and total validation
- Tolerance and exception policies
- Evidence-linked correction workflow

**Dependencies**

#5, #6, #7, #15, #25
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Duplicate confidence and matching evidence are visible
- Totals are independently recomputed
- Unresolved material discrepancies cannot post

**Testing and failure handling**

- Near-duplicate and amended invoice tests
- Tax/rounding/missing-field tests
- False-positive duplicate tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Determine supplier fraud
- Receive physical goods

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #17 — [E17] Post approved purchases to inventory, ledger and supplier payable

**Owner: GPT 3**

Planned wave: Weeks 3-5
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Convert a validated purchase draft into consistent accounting, stock and payable records.

**User example**

- Approving 100 boxes records the purchase and input tax, increases stock and creates the amount payable to the supplier.

**Required work**

- Purchase approval/finalisation
- Purchase and input-tax ledger postings
- Stock receipts by warehouse/batch/unit
- Supplier payable and due date
- Reversal/correction hooks and source-document linkage

**Dependencies**

#4, #5, #6, #12, #16
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Ledger, stock and payable update atomically
- A failed component leaves no partial posting
- Reprocessing the same approval is idempotent

**Testing and failure handling**

- Atomic transaction tests
- Batch/unit/tax posting tests
- Failure recovery and duplicate approval tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Bank payment execution
- GST portal reconciliation

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #18 — [E18] Implement purchase orders, goods receipt and three-way matching

**Owner: GPT 3**

Planned wave: Weeks 3-5
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Compare what was ordered, physically received and invoiced, while still supporting small businesses without formal PO/GRN processes.

**User example**

- PO says 100 boxes, GRN confirms 90 arrived and supplier invoice charges 100; the app holds the difference for approval.

**Required work**

- Purchase-order lifecycle
- Goods receipt note with quantity/quality evidence
- PO versus GRN versus invoice matching
- Configurable quantity/price/tax tolerances
- Simplified goods-confirmed flow when no PO exists

**Dependencies**

#5, #6, #15, #16, #17
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Mismatches are explained field by field
- Only accepted received quantities increase stock
- Small-business workflow does not force a PO

**Testing and failure handling**

- Partial receipt and split invoice tests
- Over/under delivery tests
- Return and cancellation interaction tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Warehouse hardware automation
- Supplier payment execution

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #19 — [E19] Build explainable supplier GST and payment-risk warnings

**Owner: GPT 3**

Planned wave: Weeks 6-8
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Warn buyers using factual evidence without presenting an unsupported fraud judgement as government-certified.

**User example**

- When adding a supplier, show that its GSTIN was cancelled before the invoice date and the invoice is missing from available IMS/GSTR-2B data.

**Required work**

- GSTIN status and effective dates
- Available filing/return status and e-invoice eligibility
- IMS/GSTR-2B presence and mismatch signals
- Internal disputes, overdue balances and unexpected bank-detail changes
- Explainable risk levels with evidence date and source

**Dependencies**

#7, #8, #16, #20, #31
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Every warning names its evidence
- The product never labels a party fraudulent solely from a model score
- Stale/unavailable government data is clearly identified

**Testing and failure handling**

- Cancelled/suspended/missing-record scenarios
- Stale data and provider outage tests
- Defamation-safe wording review tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Guarantee that a supplier is genuine
- Create a public blacklist

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.
- Execution override for #19
- Implement baseline supplier-risk warnings without blocking on #31. Define an optional input contract for later reconciliation/ITC risk signals from #31.

## Issue #26 — [E26] Implement e-invoice applicability and the complete IRN lifecycle

**Owner: GPT 3**

Planned wave: Weeks 6-8
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Decide applicability, prepare valid payloads and manage government-registered e-invoices safely.

**User example**

- An eligible B2B invoice is approved, submitted once, receives an IRN and signed QR, and cannot create a duplicate IRN on retry.

**Required work**

- Applicability decision with turnover/document/recipient rules
- Government-schema payload and offline JSON export
- Generate, fetch and cancel IRN
- Signed QR/acknowledgement preservation
- Deadline, duplicate, amendment and failure workflow

**Dependencies**

#7, #8, #9, #25
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Normal invoice and registered e-invoice states are never confused
- Submission is idempotent
- Government response is stored and verified before marking registered

**Testing and failure handling**

- Applicable/non-applicable cases
- Duplicate/retry/cancellation deadline tests
- Provider sandbox contract tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Allow AI to submit without required approval
- Assume every GST invoice needs an IRN

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #27 — [E27] Implement e-way-bill applicability and full lifecycle

**Owner: GPT 3**

Planned wave: Weeks 6-8
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Evaluate movement-specific rules and manage e-way bills without hard-coding the uncle’s ₹1 lakh/day assumption.

**User example**

- Before dispatch, evaluate consignment value, state, goods, exemptions, bill-to/ship-to and movement; explain why an e-way bill is or is not required.

**Required work**

- General and state-specific applicability rules
- Consignment/movement grouping and exemptions
- Offline JSON plus generate/get/cancel/reject APIs
- Part A/Part B, transporter assignment, vehicle update and consolidated scenarios
- Validity, distance, expiry and correction workflow

**Dependencies**

#7, #8, #9, #25, #26
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Every decision lists applied facts and source
- ₹1 lakh/day is not treated as a universal rule
- Incorrect government submissions are cancelled/recreated according to allowed lifecycle

**Testing and failure handling**

- ₹50,000 boundary and state-rule cases
- Multiple invoice/vehicle and bill-to/ship-to cases
- Validity/cancellation/provider outage tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Prove physical delivery
- Hard-code rules without effective dates

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #28 — [E28] Implement transport details and vehicle suitability controls

**Owner: GPT 3**

Planned wave: Weeks 6-8
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Prevent implausible transport assignments using shipment facts and available vehicle facts.

**User example**

- A five-tonne shipment assigned to a scooter is blocked; a smaller goods vehicle above its recorded capacity requires correction or authorised override.

**Required work**

- Transporter ID, vehicle number, mode, distance and document fields
- Shipment weight/volume and configurable vehicle suitability rules
- Vehicle class/body/capacity/permit/fitness evidence when available
- Number-plate photo OCR and comparison
- Block/warn/override policy with reason

**Dependencies**

#5, #6, #7, #27, #29
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Obvious class/capacity mismatch is detected
- Unavailable government data is distinguished from a valid result
- Override never edits source evidence

**Testing and failure handling**

- Scooter/private car/goods vehicle scenarios
- Capacity boundary and missing-data tests
- Photo OCR mismatch tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Prove the vehicle carried the goods
- Live GPS tracking in first version

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #29 — [E29] Integrate authorised vehicle-record verification

**Owner: GPT 3**

Planned wave: Weeks 3-5
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Retrieve permitted RC/VAHAN-style facts through an approved, replaceable provider.

**User example**

- Entering a number plate returns a masked, timestamped vehicle classification that E28 can use for suitability checks.

**Required work**

- API Setu/NTR or approved provider adapter
- Consent/use-case and credential lifecycle
- Normalized registration, class, body, capacity and validity fields where supplied
- Caching, freshness and unavailable-state rules
- Privacy-minimised storage

**Dependencies**

#8
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Only authorised fields are requested/stored
- Provider response and retrieval date are traceable
- No result is not interpreted as an invalid vehicle

**Testing and failure handling**

- Sandbox/fixture contract tests
- Masked/missing/stale response tests
- Provider replacement test

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Scrape public portals
- Retrieve owner PII not required for suitability

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #30 — [E30] Build the GSTR-1 and GSTR-3B preparation workspace

**Owner: GPT 3**

Planned wave: Weeks 9-11
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Prepare outward-supply and summary-tax returns from the internal books, with simple review and one-click submission after approval.

**User example**

- A small company with four invoices sees the exact GSTR-1 sections, validation results and changes before approving submission.

**Required work**

- Period selection and book snapshot
- GSTR-1 classification and summaries
- GSTR-3B liability/ITC summary inputs
- Mismatch, amendment and unresolved-exception workspace
- Government JSON export and later API submission

**Dependencies**

#4, #6, #7, #9, #17, #25
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Every return number traces to source vouchers
- Locked/approved periods cannot change silently
- Manual export works without production GSP access

**Testing and failure handling**

- Four-invoice small-business example
- B2B/B2C/note/amendment tests
- Book-to-return reconciliation tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Call purchase reconciliation ‘GSTR-2 filing’
- Submit without taxpayer approval

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #31 — [E31] Implement IMS/GSTR-2B reconciliation and ITC controls

**Owner: GPT 3**

Planned wave: Weeks 9-11
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Compare purchase books with supplier-reported records and guide accept/reject/pending decisions.

**User example**

- A supplier invoice exists in books but not in IMS/GSTR-2B; the app warns about potential ITC risk and tracks follow-up.

**Required work**

- File import first and GSP download later
- Exact/fuzzy matching across GSTIN, invoice, date, taxable value and tax
- Accept/reject/pending workflow
- Missing, duplicate, amended and reversed-document handling
- ITC eligibility warning and GSTR-3B linkage

**Dependencies**

#7, #8, #16, #17, #19, #25, #30
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Match decisions show evidence
- A missing portal document is not silently treated as eligible ITC
- Recomputation preserves user actions and audit

**Testing and failure handling**

- Match/mismatch/missing/amendment cases
- Period recomputation tests
- File/API equivalence tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Guarantee ITC solely from presence in GSTR-2B
- Automatically accuse suppliers of fraud

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #32 — [E32] Build the compliance calendar and preventive alert engine

**Owner: GPT 3**

Planned wave: Weeks 9-11
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Warn businesses before filing, IRN, e-way, correction and reconciliation deadlines.

**User example**

- The owner is warned that unresolved purchase mismatches may affect the upcoming GSTR-3B and sees the required action.

**Required work**

- Effective-dated obligation/deadline definitions
- Company-specific applicability and filing frequency
- In-app/email escalation
- Unresolved-exception and consequence-aware alerts
- Completion evidence and snooze/escalate permissions

**Dependencies**

#7, #23, #26, #27, #30, #31, #39
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Alerts identify rule, deadline, affected records and next action
- Changed deadlines update without rewriting history
- Completed obligations stop escalating

**Testing and failure handling**

- Deadline change/timezone/holiday tests
- Escalation and completion tests
- Missing-data applicability tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Provide a generic calendar disconnected from transactions
- Guarantee portal availability

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #33 — [E33] Integrate GSP/IRP customer onboarding and production GST operations

**Owner: GPT 3**

Planned wave: Weeks 9-11
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Connect approved internal workflows to live GST, IRN and e-way-bill services through an authorised provider.

**User example**

- A customer authorises its GSTIN, the app receives valid scoped access and submits only approved documents for that GSTIN.

**Required work**

- ASP/provider tenant onboarding
- OTP/consent/API-user state without storing portal passwords
- Production endpoints for approved GST/IRP/e-way operations
- Credential rotation, revocation, rate limit and outage handling
- Provider reconciliation and status polling

**Dependencies**

#8, #26, #27, #30, #31, #50, #51
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Each GSTIN has separate authorisation state
- Revocation stops new calls without deleting history
- Internal status matches authoritative government acknowledgement

**Testing and failure handling**

- Sandbox onboarding and consent tests
- Expired/revoked credential tests
- Provider outage/retry/reconciliation tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Become a GSP in the first release
- Give one customer access to another GSTIN

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #44 — [E44] Build end-to-end workflow and failure testing

**Owner: GPT 3**

Planned wave: Weeks 12-14
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Verify that complete business flows remain consistent across modules and external failures.

**User example**

- A WhatsApp purchase becomes a reviewed purchase, stock increases, a voice sale consumes stock, payment is reconciled and GST outputs trace back correctly.

**Required work**

- End-to-end sale, purchase, return, payment, banking and compliance scenarios
- External service stubs and failure injection
- Concurrency, retry and recovery coverage
- Cross-ledger/inventory/return invariants
- Performance tests for initial target volumes

**Dependencies**

#9, #12, #15, #17, #20, #22, #25, #26, #27, #30, #31, #43
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Critical workflows run automatically in CI
- Failures never leave inconsistent partial state
- Every production regression receives a permanent test

**Testing and failure handling**

- Happy path, ambiguity, outage and cancellation suites
- Concurrent invoice/payment tests
- Backup/restore workflow smoke test

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Replace feature-level unit tests
- Test unimplemented future jurisdictions

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #45 — [E45] Implement sales/purchase returns and transaction adjustments

**Owner: GPT 3**

Planned wave: Weeks 12-14
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Handle full and partial returns without corrupting inventory, balances, GST or reconciliation.

**User example**

- Ten of seventy apple boxes are returned as damaged; stock disposition, customer balance, credit note and GST reporting all update consistently.

**Required work**

- Full/partial sales and purchase returns
- Accepted, damaged, scrapped and replacement dispositions
- Credit/debit notes and original-document references
- Inventory, receivable/payable, tax and bank-refund impact
- E-invoice/e-way and period-lock consequences

**Dependencies**

#9, #12, #17, #20, #25, #26, #27, #30, #31
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Returned quantities cannot exceed eligible original quantities
- All subledgers update atomically
- Closed-period changes use valid adjustment flows

**Testing and failure handling**

- Partial/full/repeated return tests
- Damaged/replacement/refund tests
- Cross-period and registered-document tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Physical reverse-logistics tracking
- Hide returns by editing original invoices

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #50 — [X02] Compare GSP/IRP providers and obtain sandbox access

**Owner: GPT 3**

Planned wave: Weeks 1-2
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Select providers based on actual endpoint coverage, cost, storage, SLA and startup onboarding rather than marketing claims.

**User example**

- IRIS, FinAGG, MasterGST and Clear receive the same 10–50 GSTIN requirement and return comparable written quotations.

**Required work**

- Request GSTIN, GSTR-1/3B, IMS/GSTR-2B, filing, IRN and e-way APIs
- Request sandbox before commitment
- Compare per-GSTIN/call/document fees and minimums
- Review data storage, support, SLA, portability and termination
- Record missing endpoints and contract risks

**Dependencies**

#1
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- At least two written comparable proposals
- A sandbox demonstrates required critical endpoints
- Recommendation identifies primary and fallback provider

**Testing and failure handling**

- Run a standard capability checklist against each sandbox
- Validate claims against documentation/contracts

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Choose only by lowest headline price
- Assume one vendor offers everything without proof

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #51 — [X03] Complete GSP/IRP production contracting and onboarding

**Owner: GPT 3**

Planned wave: Weeks 9-11
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Obtain production credentials and documented customer-GSTIN authorisation flow for the selected provider.

**User example**

- A pilot customer can authorise its GSTIN and execute a controlled production IRN/e-way/GST operation.

**Required work**

- Security and legal review
- Commercial agreement and SLA
- Production IP/domain/credential requirements
- Customer consent/OTP/onboarding procedure
- Incident, support and exit/portability process

**Dependencies**

#49, #50
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Production access is active
- Pilot GSTIN onboarding is documented and tested
- Fallback/manual workflow remains available

**Testing and failure handling**

- Controlled production smoke test with authorised customer
- Credential rotation and revocation drill

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Bulk onboard customers without consent
- Depend on undocumented credentials

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #53 — [X05] Apply for authorised vehicle-data access

**Owner: GPT 3**

Planned wave: Weeks 9-11
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Request only the vehicle facts needed for plausibility checks through API Setu/NTR or an approved provider.

**User example**

- Submit a use case for registration status, vehicle class/body and capacity-related fields without requesting unnecessary owner information.

**Required work**

- Company/use-case application
- Requested-field minimisation
- Provider approval, pricing and SLA review
- Sandbox/test data access
- Privacy, caching and permitted-use documentation

**Dependencies**

#1, #28
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Application submitted and tracked
- Approved fields and usage restrictions documented
- Fallback manual evidence workflow defined

**Testing and failure handling**

- Review sample response against E28 needs
- Privacy-minimisation review

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Scrape VAHAN/mParivahan
- Request vehicle-owner PII without necessity

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.


