# Invoice Product — GPT 1 Delivery Handbook

> Converted from `Invoice_Product_GPT_1_Delivery_Handbook.docx` so that it travels with the
> repository. The document is the authoritative statement of scope for GPT 1's issues; where
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

**Your lane: Accounting, sales, deterministic rules and user experience**

- Your issues: #1, #4, #7, #9, #10, #11, #12, #13, #20, #25, #34, #35, #36, #37, #43, #46, #48, #54
- Start immediately with: #1, #4, #46

**Other GPT ownership**

- GPT 2: Platform, banking, communications, security and operations; issues #2, #3, #6, #8, #14, #21, #22, #23, #24, #38, #39, #40, #41, #42, #47, #49, #52, #55
- GPT 3: Purchasing, GST, transport and government integrations; issues #5, #15, #16, #17, #18, #19, #26, #27, #28, #29, #30, #31, #32, #33, #44, #45, #50, #51, #53

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

| Parallel wave | Owned issues | Exit condition |
| --- | --- | --- |
| Weeks 1-2 | #1, #4, #46 | Acceptance tests pass; contracts and handoffs are committed; dependent work can replace mocks. |
| Weeks 3-5 | #7, #9, #12, #13, #25 | Acceptance tests pass; contracts and handoffs are committed; dependent work can replace mocks. |
| Weeks 6-8 | #10, #20, #35, #36 | Acceptance tests pass; contracts and handoffs are committed; dependent work can replace mocks. |
| Weeks 9-11 | #11, #34, #37, #43, #54 | Acceptance tests pass; contracts and handoffs are committed; dependent work can replace mocks. |
| Weeks 12-14 | #48 | Acceptance tests pass; contracts and handoffs are committed; dependent work can replace mocks. |
| Weeks 15-18 | Integration and pilot fixes | Acceptance tests pass; contracts and handoffs are committed; dependent work can replace mocks. |

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

## Issue #1 — [E01] Define the product specification, workflows and financial glossary

**Owner: GPT 1**

Planned wave: Weeks 1-2
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Create the canonical product specification that gives every independent agent the same business context, vocabulary, scope and transaction flows.

**User example**

- When one agent says purchase invoice, another agent must understand that it creates a purchase entry, inventory increase and supplier payable—not a sales invoice.

**Required work**

- Document sale, purchase, return, payment, banking, inventory, GST, transport and approval flows end to end
- Define accounting and GST terms in simple language with examples
- Define product principles: standalone ledger, accuracy first, simple UI, AI plus deterministic rules
- Document supported business types, initial India scope and explicit exclusions
- Create ownership boundaries for all later issues

**Dependencies**

None
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- A new agent can explain every core workflow without reading prior conversations
- Terms are used consistently across product, API and UI specifications
- Every later issue can link to this specification

**Testing and failure handling**

- Review the specification against at least one sale, purchase, partial payment, return and transport example
- Check for contradictory definitions and missing workflow states

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Implement application code
- Select final technology vendors

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #4 — [E04] Build the core double-entry accounting ledger

**Owner: GPT 1**

Planned wave: Weeks 1-2
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Implement the financial source of truth for vouchers, journal lines, balances, periods and reversals.

**User example**

- Finalising a ₹1,180 sale posts revenue, output GST and customer receivable while remaining balanced.

**Required work**

- Chart of accounts and account types
- Balanced immutable postings with draft/final/reversed states
- Sales, purchase, receipt, payment, journal, credit-note and debit-note voucher primitives
- Fiscal periods, opening balances, locks and controlled corrections
- Currency precision, rounding and references to source documents

**Dependencies**

#1, #2
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Every posted voucher balances to zero
- Final records are corrected by reversal/amendment rather than destructive edits
- Account and party balances reproduce from journal lines

**Testing and failure handling**

- Golden posting tests for all voucher types
- Rounding and period-lock tests
- Concurrent and duplicate-posting tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Design end-user invoice screens
- Implement GST filing

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #7 — [E07] Create the versioned compliance and financial rules engine

**Owner: GPT 1**

Planned wave: Weeks 3-5
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Evaluate transaction facts using deterministic, effective-dated rules and return explainable decisions.

**User example**

- The engine explains whether an e-way bill is required using consignment value, movement, state, exemptions and effective date—not an AI guess.

**Required work**

- Typed facts, decisions, warnings, blocks and missing-information results
- Rules with jurisdiction, effective dates, priority and official source links
- State-specific overrides and exception handling
- Human-readable explanation templates
- Simulation endpoint and rule-version replay

**Dependencies**

#1, #4, #5, #6
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- The same facts and rule version produce the same result
- Past transactions can be replayed under the rules effective at that date
- Every compliance decision shows evidence and missing facts

**Testing and failure handling**

- Boundary-date and threshold tests
- Conflicting-rule resolution tests
- Golden examples sourced from official material

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Let an LLM directly determine legal outcome
- File returns or generate government documents

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #9 — [E09] Implement the complete sales invoice lifecycle

**Owner: GPT 1**

Planned wave: Weeks 3-5
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Support creation, approval, finalisation, cancellation and accounting of domestic sales.

**User example**

- Sell 70 boxes of apples to ABC Traders at ₹800 per box; calculate tax, create receivable and produce a final numbered invoice after approval.

**Required work**

- Draft and final invoice workflow
- B2B/B2C, goods/services, tax-inclusive/exclusive prices
- Discount, freight, round-off and additional charges
- Invoice numbering by company/branch/financial year
- Posting to ledger and downstream inventory/compliance hooks

**Dependencies**

#4, #5, #6, #7
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Invoice totals and postings are reproducible
- Final numbering is unique and concurrency safe
- Cancellation follows configured approval and reversal policy

**Testing and failure handling**

- Representative intra/inter-state invoices
- Discount/rounding/concurrency tests
- Draft-to-final and cancellation tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Government IRN generation
- Fancy visual templates

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #10 — [E10] Build the multilingual voice and text transaction assistant

**Owner: GPT 1**

Planned wave: Weeks 6-8
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Turn conversational instructions into structured drafts while confirming ambiguous material terms.

**User example**

- ‘ABC ko sattar box apple aath sau per box becho’ becomes a draft, then repeats customer, quantity, unit, price, GST basis and stock impact before approval.

**Required work**

- Hindi, English and Hinglish input pipeline with extensible languages
- Entity resolution for parties/items/units
- Confidence per extracted field
- Clarification and confirmation dialogue
- Voice/text transcript linked to—not substituted for—the structured draft

**Dependencies**

#5, #6, #9
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Low-confidence quantity, unit, price or party is never silently accepted
- User can correct one field without repeating everything
- Final action uses the same approval rules as manual entry

**Testing and failure handling**

- 17/70, kg/box and tax-inclusive ambiguity tests
- Similar customer/item name tests
- Noisy/code-switched speech tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Let voice bypass permissions
- Build the accounting engine inside the assistant

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #11 — [E11] Add pricing, discounts, customer credit and overdue controls

**Owner: GPT 1**

Planned wave: Weeks 9-11
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Use agreed prices and customer risk limits during sale creation.

**User example**

- The app suggests ABC’s last agreed ₹800 price and warns that the new invoice exceeds its credit limit due to overdue balances.

**Required work**

- Customer/item price history and price lists
- Discount authority and margin warnings
- Credit limits, ageing and overdue checks
- Block/warn/override policy
- Reasoned approval and audit

**Dependencies**

#5, #6, #9, #20
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Price source is visible
- Credit calculations include outstanding and pending transactions correctly
- Overrides require appropriate permission

**Testing and failure handling**

- Price effective-date tests
- Partial payment and credit-limit tests
- Concurrent sales against the same limit

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Credit bureau scoring
- Automated lending

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #12 — [E12] Implement inventory availability, reservations and negative-stock prevention

**Owner: GPT 1**

Planned wave: Weeks 3-5
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Maintain accurate stock and prevent impossible sales across warehouses, units, batches and concurrent users.

**User example**

- After buying 100 boxes and selling 70, a second sale of 70 is blocked because only 30 remain unless an authorised override is recorded.

**Required work**

- Stock movement ledger
- Available, reserved, committed and physical quantities
- Warehouse/batch/serial/unit conversion support
- Reservations during draft/approval lifecycle
- Negative-stock policy and authorised override

**Dependencies**

#4, #5, #6, #9
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Stock is derived from traceable movements
- Concurrent invoices cannot oversell the same stock
- Returns, cancellations and transfers reverse/update stock correctly

**Testing and failure handling**

- Concurrent reservation tests
- Unit/batch/warehouse tests
- Backdated movement and period-lock tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Demand forecasting
- Physical RFID tracking

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #13 — [E13] Build the AI Fancy Invoice designer and rendering engine

**Owner: GPT 1**

Planned wave: Weeks 3-5
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Generate professional, industry-appropriate invoice patterns while locking mandatory legal data.

**User example**

- A bakery receives a cake-oriented template with flavour/size/delivery fields; a wholesaler gets HSN, unit, batch, dispatch and transport fields.

**Required work**

- Business-type template recommendations
- Logo, colour, typography and layout customisation
- Compliance-locked data section
- A4, thermal, mobile, PDF and print layouts
- English/Hindi/regional fonts, QR readability and historical template snapshots

**Dependencies**

#5, #9
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Required fields cannot be removed
- Layouts remain readable from 1 to 100 items
- Old invoices preserve their original template

**Testing and failure handling**

- Visual regression tests
- Multilingual font and QR scanning tests
- Long-item and pagination tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Determine GST liability
- Treat a styled PDF as a registered e-invoice

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #20 — [E20] Implement receivables, payables and payment allocation

**Owner: GPT 1**

Planned wave: Weeks 6-8
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Track what customers owe and what the business owes, including cash, cheque, bank and partial payments.

**User example**

- A ₹1 lakh invoice receives ₹30,000 by cheque and ₹20,000 by bank transfer; ₹50,000 remains with dates and payment references preserved.

**Required work**

- Cash, cheque, bank, UPI and other payment modes
- Partial, combined, advance, overpayment and on-account allocation
- Cheque pending/cleared/bounced states
- Ageing, due dates and party statements
- Approved write-off and adjustment flow

**Dependencies**

#4, #5, #6, #9, #17
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Outstanding balances equal invoice less accepted allocations
- Cheque status changes do not lose history
- One payment can be allocated across invoices with audit trail

**Testing and failure handling**

- Partial/advance/overpayment tests
- Bounced cheque tests
- Currency rounding and reversed payment tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Initiate bank transfers
- Provide lending or collections services

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #25 — [E25] Implement GST calculation, place of supply and tax classification

**Owner: GPT 1**

Planned wave: Weeks 3-5
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Calculate GST deterministically for supported sales and purchase scenarios.

**User example**

- A Delhi seller billing a Delhi buyer uses CGST/SGST, while a supported interstate supply uses IGST, subject to place-of-supply facts.

**Required work**

- CGST/SGST/UTGST/IGST selection
- Goods/services, HSN/SAC, rates, cess, exemptions and nil/non-GST treatment
- Tax-inclusive/exclusive calculation and round-off
- Reverse charge and supported place-of-supply rules
- Effective-dated tax data with source and review state

**Dependencies**

#5, #7
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Same facts/rule version produce identical tax lines
- Missing place-of-supply facts block unsupported decisions
- UI explains the chosen tax treatment

**Testing and failure handling**

- Intra/inter-state golden cases
- Rate/effective-date/rounding tests
- Reverse-charge and exempt-supply tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Support every rare GST scenario at first release
- Use an LLM as the tax calculator

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #34 — [E34] Build the AI business and legal-knowledge assistant

**Owner: GPT 1**

Planned wave: Weeks 9-11
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Answer business, ledger, inventory and supported compliance questions using authorised company data and sourced rules.

**User example**

- ‘Why is this invoice blocked?’ returns the stock shortage, applicable e-way rule and next safe action in simple Hindi or English.

**Required work**

- Permission-aware retrieval from internal reports and rule sources
- Answers with data period, assumptions and source links
- Natural-language financial reports
- No unsupported legal certainty
- Escalation to exception/action workflows

**Dependencies**

#5, #7, #32, #35
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Answers never reveal inaccessible company data
- Numbers reconcile to canonical reports
- Compliance answers identify source/effective date and uncertainty

**Testing and failure handling**

- Permission leakage tests
- Numeric consistency evaluations
- Prompt injection and unsupported-question tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Replace deterministic posting/rule engines
- Give unrelated personal legal advice

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #35 — [E35] Build financial, inventory and operational reports

**Owner: GPT 1**

Planned wave: Weeks 6-8
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Provide trustworthy reports derived from the ledger and subledgers.

**User example**

- The owner sees profit/loss, stock remaining, overdue customers, supplier dues and GST exceptions for a selected period.

**Required work**

- Trial balance, P&L and balance sheet
- Sales/purchase/stock and ageing reports
- GST and exception dashboards
- Drill-down from totals to source transactions
- Export with consistent filters and period snapshots

**Dependencies**

#4, #9, #12, #17, #20, #25
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Report totals reconcile to ledger
- Every total drills to contributing records
- Period/company/branch filters are explicit

**Testing and failure handling**

- Golden report datasets
- Filter and opening/closing balance tests
- Large-data performance tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Predictive forecasting
- Allow report code to post transactions

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #36 — [E36] Build guided business onboarding and opening balances

**Owner: GPT 1**

Planned wave: Weeks 6-8
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Let a non-accountant configure a company, tax profile, branding, inventory and opening balances safely.

**User example**

- A bakery selects its business type, adds GSTIN/logo/items/opening stock and receives a suitable invoice template and checklist.

**Required work**

- Company, registration and filing profile
- Business-type defaults without hiding editable facts
- Opening ledgers, party balances and stock
- Logo/Fancy Invoice setup
- Progress checklist, validation and resumable onboarding

**Dependencies**

#3, #4, #5, #13, #46
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Onboarding can be resumed safely
- Opening debit/credit balances validate
- Business-type suggestions never invent legal facts

**Testing and failure handling**

- Bakery/wholesaler/service examples
- Incomplete/resumed onboarding tests
- Opening balance reconciliation tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Automatically register the business for GST
- Migrate arbitrary historical data

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #37 — [E37] Implement Excel/CSV migration from existing accounting tools

**Owner: GPT 1**

Planned wave: Weeks 9-11
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Help businesses switch without requiring direct Tally/BUSY/Vyapar integration.

**User example**

- A Vyapar user exports customers, items, opening stock and balances to Excel; the app maps, validates and imports them with a reconciliation report.

**Required work**

- Template and column-mapping workflow
- Customers, suppliers, items, units, stock and opening balances
- Preview, validation, duplicate handling and rollback
- Import batch audit and error file
- Optional historical vouchers only through a separately validated format

**Dependencies**

#4, #5, #12, #36
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Import is repeatable or safely rejected as duplicate
- User approves mapping before commit
- Imported opening figures reconcile

**Testing and failure handling**

- Common export variants
- Duplicate/malformed/large-file tests
- Rollback and reconciliation tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Real-time competitor integration
- Reverse engineer proprietary databases

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #43 — [E43] Create a financial and compliance golden-test dataset

**Owner: GPT 1**

Planned wave: Weeks 9-11
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Build versioned example businesses and expected outputs that every module and agent can test against.

**User example**

- The apple wholesaler dataset covers purchase of 100 boxes, sale of 70, attempted oversale, partial payment, return, e-way decision and GST reporting.

**Required work**

- Anonymised synthetic bakery, wholesaler, service and transport examples
- Expected ledger, inventory, tax, return and warning outputs
- Boundary, failure and correction scenarios
- Rule source/effective date metadata
- Machine-readable fixtures plus human explanation

**Dependencies**

#1, #4, #7, #25
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Fixtures are deterministic and reusable across modules
- Expected debits/credits and tax totals balance
- Changing expected outcomes requires documented rule/source review

**Testing and failure handling**

- Fixture schema validation
- Cross-module replay
- Mutation tests that prove incorrect results fail

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Use confidential customer invoices
- Treat examples as universal legal advice

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #46 — [E46] Create a zero-training, non-accountant user experience

**Owner: GPT 1**

Planned wave: Weeks 1-2
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Make common work possible for someone who has never studied accounting—‘meri app lalloo chala le’—without sacrificing controls.

**User example**

- The owner sees ‘Customer still owes ₹50,000’ instead of needing to interpret debtor-ledger terminology.

**Required work**

- Plain-language design system and vocabulary
- Three-step-or-fewer target for common actions
- Guided defaults, progressive disclosure and contextual examples
- Clear draft/submitted/accepted/failed states
- First-sale/purchase/payment walkthrough and usability-test protocol

**Dependencies**

#1, #2, #3
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Target users complete core tasks without training
- Accounting terms have plain explanations
- Safety confirmations remain understandable rather than being removed

**Testing and failure handling**

- Task-based usability tests with non-accountants
- Error-message comprehension tests
- Mobile and language variants

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Hide legally important information
- Reduce steps by removing approvals

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #48 — [E48] Establish financial correctness release gates

**Owner: GPT 1**

Planned wave: Weeks 12-14
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Make correctness a measurable release condition across ledger, stock, tax, AI extraction and government submissions.

**User example**

- A feature cannot ship if its sale posts an unbalanced voucher, oversells stock, produces the wrong GST result or duplicates an IRN on retry.

**Required work**

- Cross-module financial invariants
- Required golden, property, mutation and regression tests
- AI confidence and human-review thresholds
- Rule-source and effective-date review checks
- Release checklist, severity policy and production rollback criteria

**Dependencies**

#4, #6, #7, #43, #44
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- CI blocks release on violated critical invariants
- Every discovered financial defect gains a regression test
- Supported/unsupported scenarios are explicit

**Testing and failure handling**

- Deliberately inject ledger, inventory, GST and idempotency defects
- Verify gates fail closed
- Verify override paths remain audited

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Promise mathematical impossibility of all future errors
- Use disclaimers instead of tests

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #54 — [X06] Maintain the official compliance-source register

**Owner: GPT 1**

Planned wave: Weeks 9-11
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Track authoritative GST, e-invoice, e-way, IMS and privacy sources used by the rule engine.

**User example**

- An e-way threshold rule links to the official notification/FAQ, jurisdiction, effective date, reviewer and affected tests.

**Required work**

- Source catalogue with authority and retrieval date
- Rule-to-source and test-to-rule mapping
- Change-monitoring and review queue
- Superseded/withdrawn source handling
- Decision log for interpretations and unsupported scenarios

**Dependencies**

#1, #7
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Every production compliance rule has an approved source
- Changes generate actionable review tasks
- Marketing/blog sources are not treated as legal authority

**Testing and failure handling**

- Broken/stale source audit
- Sample trace from transaction decision to source and test

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Copy entire copyrighted publications
- Treat AI memory as the canonical source

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.
