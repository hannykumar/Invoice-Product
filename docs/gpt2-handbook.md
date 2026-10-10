# Invoice Product — GPT 2 Delivery Handbook

> Converted from `Invoice_Product_GPT_2_Delivery_Handbook.docx` so that it travels with the
> repository. The document is the authoritative statement of scope for GPT 2's issues; where
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

**Your lane: Platform, banking, communications, security and operations**

- Your issues: #2, #3, #6, #8, #14, #21, #22, #23, #24, #38, #39, #40, #41, #42, #47, #49, #52, #55
- Start immediately with: #2, #3, #6, #8

**Other GPT ownership**

- GPT 1: Accounting, sales, deterministic rules and user experience; issues #1, #4, #7, #9, #10, #11, #12, #13, #20, #25, #34, #35, #36, #37, #43, #46, #48, #54
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
| Weeks 1-2 | #2, #3, #6, #8 | Acceptance tests pass; contracts and handoffs are committed; dependent work can replace mocks. |
| Weeks 3-5 | #21, #38, #39, #40, #49 | Acceptance tests pass; contracts and handoffs are committed; dependent work can replace mocks. |
| Weeks 6-8 | #14, #22, #24, #41, #52, #55 | Acceptance tests pass; contracts and handoffs are committed; dependent work can replace mocks. |
| Weeks 9-11 | #23, #42 | Acceptance tests pass; contracts and handoffs are committed; dependent work can replace mocks. |
| Weeks 12-14 | #47 | Acceptance tests pass; contracts and handoffs are committed; dependent work can replace mocks. |
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

## Issue #2 — [E02] Establish repository architecture, development environment and CI

**Owner: GPT 2**

Planned wave: Weeks 1-2
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Create a maintainable application skeleton that allows many agents to work independently without conflicting project conventions.

**User example**

- A sales agent and purchase agent should be able to add modules and tests using the same commands, database conventions and API patterns.

**Required work**

- Choose and document frontend, backend, database, queue and testing structure
- Create local setup, environment templates, migrations and seed data
- Configure formatting, linting, type checking, unit/integration tests and CI
- Define module boundaries and code ownership
- Provide mock-service conventions for unfinished dependencies

**Dependencies**

#1
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- A clean checkout starts with one documented command
- CI runs deterministic checks on every change
- Agents can develop modules without requiring production credentials

**Testing and failure handling**

- Verify clean setup in a fresh environment
- Verify migrations up/down and seed repeatability
- Verify CI detects a deliberate lint and test failure

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Implement business features
- Deploy a production environment

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #3 — [E03] Implement multi-company authentication, branches, users and permissions

**Owner: GPT 2**

Planned wave: Weeks 1-2
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Support multiple isolated businesses, branches and users with least-privilege access.

**User example**

- A cashier may create a draft sale but cannot view bank balances, file GST or override negative stock.

**Required work**

- Company and branch tenancy
- Secure login, session management and recovery
- Roles and granular permissions
- Invitations, user deactivation and access review
- Server-side tenant isolation on every query and command

**Dependencies**

#1, #2
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- No user can access another company's data
- Permissions are enforced server-side, not only hidden in UI
- Owner can review and revoke access

**Testing and failure handling**

- Cross-tenant access tests
- Role matrix tests
- Session expiry and revoked-user tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Subscription billing
- Government portal authorisation

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #6 — [E06] Implement approvals, immutable audit history and idempotent commands

**Owner: GPT 2**

Planned wave: Weeks 1-2
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Provide one shared safety workflow for drafts, approvals, overrides, retries and traceability.

**User example**

- A sale exceeding available stock is blocked unless an authorised owner overrides it and records a reason.

**Required work**

- Draft, submitted, approved, rejected, finalised, failed and cancelled states
- Configurable approval policies by action/risk/amount
- Append-only audit events with before/after facts
- Idempotency keys and duplicate request protection
- Exception queue, comments and supporting evidence

**Dependencies**

#3, #4
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Sensitive actions cannot bypass required approval
- Retries never create duplicate financial/government records
- An auditor can reconstruct who did what and why

**Testing and failure handling**

- Permission and approval-transition tests
- Concurrent retry tests
- Audit completeness and tamper-resistance tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Define feature-specific financial rules
- Implement an external signing service

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #8 — [E08] Build replaceable external-service connector contracts

**Owner: GPT 2**

Planned wave: Weeks 1-2
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Prevent GSP, IRP, bank, messaging, OCR or vehicle vendors from controlling the internal product architecture.

**User example**

- IRIS can be replaced by another GSP without changing the sales invoice or ledger modules.

**Required work**

- Provider-neutral interfaces for GST, IRP, e-way bill, banking, vehicle, OCR, email and WhatsApp
- Credential/token vault integration
- Sandbox/mock adapters
- Timeout, retry, circuit-breaker, webhook and health conventions
- Normalized errors and provider request IDs

**Dependencies**

#2, #6
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Business modules depend only on internal connector contracts
- A mock and at least one reference adapter pass the same contract tests
- Provider outage does not corrupt internal state

**Testing and failure handling**

- Contract tests
- Timeout/retry/idempotency tests
- Credential redaction tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Complete any specific provider integration
- Store customer portal passwords

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #14 — [E14] Deliver invoices and track customer communications

**Owner: GPT 2**

Planned wave: Weeks 6-8
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Send final documents through supported channels and maintain delivery evidence.

**User example**

- After approval, email the invoice and later send it through WhatsApp, showing delivered/failed status without duplicating the invoice.

**Required work**

- Email delivery, download link and resend
- Provider-neutral WhatsApp outbound hook
- Recipient/channel preferences
- Delivery events, retries and bounce/failure handling
- Access-controlled document links and expiry

**Dependencies**

#8, #9, #13
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Sending failure never changes financial posting
- Every attempt and recipient is auditable
- Repeated sends do not create a new invoice

**Testing and failure handling**

- Provider failure/retry tests
- Expired link tests
- Wrong/empty recipient validation

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Inbound purchase document ingestion
- Marketing campaigns

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #21 — [E21] Import and normalize bank statements

**Owner: GPT 2**

Planned wave: Weeks 3-5
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Support useful banking workflows before live bank APIs by importing common statement formats.

**User example**

- The owner uploads an ICICI CSV or PDF and receives normalized dated debit/credit transactions without changing the ledger.

**Required work**

- CSV, Excel and text-based PDF ingestion
- Pluggable bank-format parsers
- Opening/closing balance checks
- Transaction fingerprints and duplicate-file detection
- Review queue for uncertain dates, amounts or descriptions

**Dependencies**

#2, #4, #5
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Reimporting a statement does not duplicate transactions
- Normalized records retain source rows/pages
- Balance inconsistencies are reported

**Testing and failure handling**

- Multiple Indian bank samples
- Date/amount/encoding variants
- Overlapping statement and duplicate upload tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Live bank connectivity
- Automatically post every imported transaction

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #22 — [E22] Build automatic bank reconciliation and exception handling

**Owner: GPT 2**

Planned wave: Weeks 6-8
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Match bank transactions with receipts, payments and invoices while keeping uncertain matches for review.

**User example**

- A ₹30,000 transfer is matched to one part-payment of ABC’s invoice using amount, date and reference; two plausible matches require confirmation.

**Required work**

- Exact and scored matching
- One-to-one, one-to-many and many-to-one reconciliation
- Wrong-date, missing-book and missing-bank detection
- Suggested receipt/payment creation
- Manual confirm/unmatch with audit

**Dependencies**

#20, #21
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Automatic matches meet a configured confidence threshold
- Ambiguous matches never post silently
- Reconciliation status and remaining difference are visible

**Testing and failure handling**

- Split/combined payment tests
- Near-date/reference ambiguity tests
- Reversal and duplicate bank transaction tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Move money
- Modify the original bank statement

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #23 — [E23] Add payment reminders and collection tracking

**Owner: GPT 2**

Planned wave: Weeks 9-11
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Help businesses follow up on overdue receivables without losing communication context.

**User example**

- Send ABC a polite reminder for the remaining ₹50,000 and stop reminders automatically once the payment is matched.

**Required work**

- Reminder schedules and templates
- In-app/email/WhatsApp channel abstraction
- Customer opt-out and quiet periods
- Promise-to-pay and dispute tracking
- Stop/escalate logic based on balance and ageing

**Dependencies**

#14, #20, #22, #39
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- No reminder is sent for a settled or disputed invoice against policy
- Communication and balance snapshot are recorded
- Owner can review scheduled messages

**Testing and failure handling**

- Partial-payment and settlement tests
- Duplicate-send prevention
- Delivery failure and opt-out tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Debt collection agency services
- Threatening or legally misleading language

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #24 — [E24] Add live bank feeds through replaceable authorised adapters

**Owner: GPT 2**

Planned wave: Weeks 6-8
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Synchronize bank transactions with explicit customer permission after statement-based reconciliation is stable.

**User example**

- An authorised business account automatically imports yesterday’s transactions and feeds the same reconciliation engine used for CSV statements.

**Required work**

- Provider onboarding and consent states
- Incremental sync, cursors and duplicate prevention
- Balance and transaction normalization
- Revocation, token expiry and account disconnect
- Provider-specific adapter behind the E08 contract

**Dependencies**

#8, #21, #22
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Disconnecting a provider preserves historical accounting data
- Sync is idempotent and recoverable
- No customer bank password/PIN is stored

**Testing and failure handling**

- Sandbox sync/revocation tests
- Cursor replay and outage tests
- Cross-account/tenant isolation tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Become an RBI Account Aggregator
- Initiate payments in the first version

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #38 — [E38] Implement multilingual, mobile-responsive product foundations

**Owner: GPT 2**

Planned wave: Weeks 3-5
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Make all core workflows usable on phones and support Hindi/English with extensible regional languages.

**User example**

- A shop owner can create and approve an invoice from a phone in Hindi without accounting vocabulary.

**Required work**

- Responsive navigation and transaction components
- Translation-key architecture and locale formatting
- Hindi/English content with mixed-language input tolerance
- Accessible controls, keyboard and screen-reader basics
- Offline-friendly draft protection where practical

**Dependencies**

#2, #3, #46
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Core sale/purchase/payment flows work at mobile widths
- No untranslated hard-coded critical text
- Amounts/dates remain unambiguous across locales

**Testing and failure handling**

- Responsive and accessibility tests
- Hindi/English snapshot tests
- Slow-network/draft recovery tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Translate every language in first release
- Build separate native mobile apps initially

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #39 — [E39] Build notification infrastructure

**Owner: GPT 2**

Planned wave: Weeks 3-5
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Provide reliable in-app and external notifications for invoices, payments, approvals and compliance.

**User example**

- A GST deadline alert appears in-app and by email once, escalates to the owner if unresolved and records delivery state.

**Required work**

- Notification event contract
- In-app/email and future SMS/WhatsApp adapters
- Templates, locale and recipient preferences
- Scheduling, retry, deduplication and rate limits
- Delivery/open/failure events where available

**Dependencies**

#3, #8
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- A business event cannot cause duplicate notification storms
- Sensitive contents respect channel and role policy
- Failures are visible and retryable

**Testing and failure handling**

- Deduplication/scheduling/timezone tests
- Provider failure tests
- Preference and permission tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Marketing automation
- Implement payment reminder policy

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #40 — [E40] Implement security, privacy, backup and disaster recovery

**Owner: GPT 2**

Planned wave: Weeks 3-5
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Protect financial, tax, document, bank and voice data and prove the product can recover safely.

**User example**

- A database incident does not expose another company’s invoices, and an encrypted backup can restore to a tested recovery point.

**Required work**

- Threat model and security baseline
- Encryption, secrets management and tenant isolation
- DPDP-oriented notice, consent, export and deletion workflows
- Encrypted backups, restore drills and retention
- Incident response, dependency scanning and secure logging

**Dependencies**

#2, #3, #6, #8
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Restore procedure is tested
- Secrets and sensitive documents never appear in ordinary logs
- Data export/deletion follows retention and legal-lock rules

**Testing and failure handling**

- Access-control and encryption tests
- Backup restore drill
- Security scanning and incident tabletop test

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Claim a certification before an audit
- Store bank passwords or DSC private keys

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #41 — [E41] Build monitoring, support and operational administration

**Owner: GPT 2**

Planned wave: Weeks 6-8
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Give operators visibility into failures without granting unsafe access to customer financial data.

**User example**

- Support can see that an IRP call failed and its error code, but cannot silently change the invoice or view unrelated tenant data.

**Required work**

- Structured logs, metrics, traces and health checks
- Queue/retry/dead-letter visibility
- Support roles and consent-based diagnostic access
- Customer-visible status and incident timeline
- Feature flags and safe operational controls

**Dependencies**

#2, #3, #6, #8, #40
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Every external failure has correlation IDs
- Support access is time-bound and audited
- Operators can replay safe idempotent jobs

**Testing and failure handling**

- Alert and failure injection tests
- Support permission tests
- Queue recovery tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- An unrestricted AnyDesk-style backdoor
- Manual database editing

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #42 — [E42] Implement subscriptions, entitlements and usage measurement

**Owner: GPT 2**

Planned wave: Weeks 9-11
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Support trials and sustainable pricing without withholding core correctness features from smaller businesses.

**User example**

- All plans receive compliance safeguards; limits may differ by invoices, companies, storage or API usage rather than safety features.

**Required work**

- Plan/entitlement model
- Trial and subscription lifecycle
- Usage counters for invoices, storage, AI and external APIs
- Grace periods and read-only behaviour
- Payment-provider abstraction and invoices for our service

**Dependencies**

#3, #8, #35
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Financial data is never deleted when a plan expires
- Usage is auditable and concurrency safe
- Essential compliance warnings are not disabled by plan

**Testing and failure handling**

- Limit/concurrency/grace-period tests
- Upgrade/downgrade tests
- Payment webhook idempotency tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Finalise commercial prices
- Build lending products

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #47 — [E47] Build a safe AI action agent for in-app assistance

**Owner: GPT 2**

Planned wave: Weeks 12-14
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Let AI perform authorised in-app work through typed internal tools rather than uncontrolled screen clicking or an AnyDesk backdoor.

**User example**

- ‘Find ABC’s unpaid invoices and send reminders’ produces a preview, requests approval and executes the permitted search/send tools with an audit trail.

**Required work**

- Permission-scoped action/tool registry
- Plan, preview, approve, execute and report lifecycle
- Typed inputs/outputs and idempotency
- High-risk action policy for filing, cancellation, overrides and money movement
- Tool-result grounding and recovery from partial failure

**Dependencies**

#6, #8, #10, #34, #41
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Agent cannot call a tool the user lacks permission for
- Material effects are previewed and approved according to policy
- Every attempted action and result is audited

**Testing and failure handling**

- Prompt injection and privilege escalation tests
- Wrong-party/amount confirmation tests
- Tool timeout and partial-failure tests

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Unrestricted remote desktop control
- Browser automation of government portals where an API is required

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #49 — [X01] Incorporate the company and assemble vendor-onboarding documents

**Owner: GPT 2**

Planned wave: Weeks 3-5
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Create the legal entity and document pack needed for GSP, bank, messaging and vehicle-provider contracts.

**User example**

- A provider receives company registration, PAN/GST details when applicable, authorised contact, domain and product description in one reviewed package.

**Required work**

- Select entity type with professional advice
- Complete incorporation/PAN/bank/GST steps as applicable
- Create official domain/email and authorised signatory details
- Maintain reusable KYC/vendor document checklist
- Track renewal and access ownership

**Dependencies**

#1
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Required company documents are securely available
- No vendor credential depends on a founder’s personal account without documentation
- Authorised contacts and ownership are recorded

**Testing and failure handling**

- Document completeness review
- Access-recovery tabletop check

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Implement software
- Apply to become a GSP immediately

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #52 — [X04] Research and obtain bank-feed sandbox/partnership access

**Owner: GPT 2**

Planned wave: Weeks 6-8
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Determine the practical, authorised route for multi-bank transaction feeds after statement import is working.

**User example**

- Compare direct corporate-bank APIs and aggregation partners for consent, coverage, pricing, transaction history and startup eligibility.

**Required work**

- Document statement-upload baseline
- Contact bank/API partners
- Compare coverage, consent, pricing, data freshness and revocation
- Confirm whether accounting/reconciliation use is contractually allowed
- Obtain sandbox for the selected approach

**Dependencies**

#1, #21, #22
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Written recommendation and cost model
- At least one viable sandbox or documented reason to defer
- No credential-scraping approach

**Testing and failure handling**

- Sandbox data-field and consent-flow validation
- Disconnect/data-retention review

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Become an NBFC Account Aggregator
- Block launch on live feeds

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.

## Issue #55 — [X07] Prepare privacy, terms, consent and pilot agreements

**Owner: GPT 2**

Planned wave: Weeks 6-8
We are building a standalone, India-first accounting, inventory, GST-compliance and business-operations product for MSMEs. It is intended to replace ordinary billing/accounting tools, not integrate with Tally, BUSY or Vyapar. A non-accountant must be able to operate it through a simple interface, voice and regional languages.
Accuracy is the primary product promise. AI may understand documents, voice and questions, but monetary postings and compliance decisions must use deterministic, versioned rules. Sensitive actions require preview/approval, all changes must be auditable, and external government/bank services must sit behind replaceable adapters.

**Objective**

- Create the customer-facing legal and consent documents required before handling production financial, GST, bank, voice and messaging data.

**User example**

- A pilot business understands what invoice/bank/voice data is processed, which providers receive it and how to revoke access.

**Required work**

- Privacy notice and data-processing inventory
- Terms and supported/unsupported compliance statement
- GST/bank/messaging consent wording
- Pilot agreement and support/escalation responsibilities
- Retention, deletion, export and incident contact process

**Dependencies**

#40, #49
Do not reimplement dependency-owned modules. If a dependency is unfinished, work against its documented contract or a mock and record assumptions in the pull request.

**Acceptance criteria**

- Documents match actual system behaviour
- Consent is specific by integration/purpose
- Pilot customers explicitly accept before production data use

**Testing and failure handling**

- Data-flow-to-notice review
- Consent withdrawal walkthrough
- Professional legal review before commercial launch

**Security, audit and correctness**

- Enforce company/tenant isolation and the permissions established by the platform.
- Record material actions, inputs, outputs, actor, timestamps and overrides without logging secrets.
- Make retries idempotent and show draft, processing, success and failure states clearly.
- Never silently guess missing financial or compliance facts; request confirmation or place the item in an exception queue.

**Non-goals**

- Use a disclaimer to excuse incorrect software
- Collect consent for unspecified future purposes

**Definition of done**

- Implementation, migrations, API contracts and UI states are complete.
- Automated tests cover the acceptance criteria and important edge cases.
- User-facing wording is understandable without accounting knowledge.
- Documentation explains assumptions, supported scenarios and known limitations.
- The feature is demonstrable with realistic Indian-business sample data.
