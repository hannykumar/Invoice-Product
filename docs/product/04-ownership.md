<!-- GENERATED FILE — do not edit by hand.
     Source: docs/product/spec/ownership.json
     Regenerate: node --experimental-strip-types tools/spec-docs/generate.ts -->

# Ownership boundaries for all issues

Issue [#1](./README.md) assigns every one of the 55 issues to exactly one agent and one module path, so parallel work cannot collide and no agent reimplements another agent's module.

Ownership map version **1.0.0**.

## Agents

- **GPT1** — Accounting, sales, deterministic financial and compliance rules, reporting and user experience
- **GPT2** — Platform, banking, communications, security and operations
- **GPT3** — Purchasing, GST returns, transport and government integrations

## GPT1

| Issue | Title | Module | Scope | Depends on | Wave |
| --- | --- | --- | --- | --- | --- |
| #1 | [E01] Define the product specification, workflows and financial glossary | `docs/product/` | Canonical product specification, glossary, workflows and ownership map. | none | weeks-1-2 |
| #4 | [E04] Build the core double-entry accounting ledger | `packages/ledger/` | Double-entry ledger: accounts, vouchers, journal lines, periods, reversals, balances. | #1, #2 | weeks-1-2 |
| #7 | [E07] Create the versioned compliance and financial rules engine | `packages/rules-engine/` | Deterministic, effective-dated compliance and financial rule evaluation with explanations. | #1, #4, #5, #6 | weeks-3-5 |
| #9 | [E09] Implement the complete sales invoice lifecycle | `packages/sales/` | Sales invoice lifecycle: draft, approval, finalisation, numbering, cancellation, posting. | #4, #5, #6, #7 | weeks-3-5 |
| #10 | [E10] Build the multilingual voice and text transaction assistant | `packages/voice-assistant/` | Multilingual voice/text to structured draft with per-field confidence and confirmation. | #5, #6, #9 | weeks-6-8 |
| #11 | [E11] Add pricing, discounts, customer credit and overdue controls | `packages/pricing-credit/` | Price lists, price history, discount authority, credit limits and overdue controls. | #5, #6, #9, #20 | weeks-9-11 |
| #12 | [E12] Implement inventory availability, reservations and negative-stock prevention | `packages/inventory/` | Stock movement ledger, availability, reservations, negative-stock policy and overrides. | #4, #5, #6, #9 | weeks-3-5 |
| #13 | [E13] Build the AI Fancy Invoice designer and rendering engine | `packages/invoice-templates/` | Fancy Invoice template designer, compliance-locked sections and renderers. | #5, #9 | weeks-3-5 |
| #20 | [E20] Implement receivables, payables and payment allocation | `packages/receivables-payables/` | Payments, allocation, cheque lifecycle, ageing, statements, write-offs. | #4, #5, #6, #9, #17 | weeks-6-8 |
| #25 | [E25] Implement GST calculation, place of supply and tax classification | `packages/gst-calc/` | Deterministic GST computation, place of supply, classification and rounding. | #5, #7 | weeks-3-5 |
| #34 | [E34] Build the AI business and legal-knowledge assistant | `packages/knowledge-assistant/` | Permission-aware business and compliance question answering over canonical reports. | #5, #7, #32, #35 | weeks-9-11 |
| #35 | [E35] Build financial, inventory and operational reports | `packages/reports/` | Trial balance, P&L, balance sheet, stock, ageing, GST and exception reports with drill-down. | #4, #9, #12, #17, #20, #25 | weeks-6-8 |
| #36 | [E36] Build guided business onboarding and opening balances | `packages/onboarding/` | Guided company setup, business-type defaults, opening balances and checklists. | #3, #4, #5, #13, #46 | weeks-6-8 |
| #37 | [E37] Implement Excel/CSV migration from existing accounting tools | `packages/migration-import/` | Excel/CSV mapping, validation, preview, commit, rollback and reconciliation. | #4, #5, #12, #36 | weeks-9-11 |
| #43 | [E43] Create a financial and compliance golden-test dataset | `fixtures/golden/` | Versioned synthetic businesses with expected ledger, stock, tax and warning outputs. | #1, #4, #7, #25 | weeks-9-11 |
| #46 | [E46] Create a zero-training, non-accountant user experience | `docs/ux/ + packages/ux-vocabulary/` | Plain-language design system, vocabulary, states and message catalogue. | #1, #2, #3 | weeks-1-2 |
| #48 | [E48] Establish financial correctness release gates | `tools/release-gates/` | Cross-module financial invariants, required test classes and release checklist. | #4, #6, #7, #43, #44 | weeks-12-14 |
| #54 | [X06] Maintain the official compliance-source register | `docs/compliance/ + packages/compliance-register/` | Official source catalogue, rule-to-source mapping and review queue. | #1, #7 | weeks-9-11 |

## GPT2

| Issue | Title | Module | Scope | Depends on | Wave |
| --- | --- | --- | --- | --- | --- |
| #2 | [E02] Establish repository architecture, development environment and CI | `(repository root, build and CI)` | Repository architecture, development environment, build tooling and CI pipelines. | — | — |
| #3 | [E03] Implement multi-company authentication, branches, users and permissions | `packages/identity/` | Companies, branches, users, roles, permissions and tenant isolation. | — | — |
| #6 | [E06] Implement approvals, immutable audit history and idempotent commands | `packages/workflow-audit/` | Approval workflows, immutable audit history and idempotent command handling. | — | — |
| #8 | [E08] Build replaceable external-service connector contracts | `packages/connectors/` | Replaceable external-service connector contracts, mocks and sandbox adapters. | — | — |
| #14 | [E14] Deliver invoices and track customer communications | `packages/delivery/` | Invoice delivery over email, WhatsApp and SMS with tracking. | — | — |
| #21 | [E21] Import and normalize bank statements | `packages/bank-import/` | Bank statement import and normalisation. | — | — |
| #22 | [E22] Build automatic bank reconciliation and exception handling | `packages/bank-reconciliation/` | Automatic bank reconciliation and reconciliation exceptions. | — | — |
| #23 | [E23] Add payment reminders and collection tracking | `packages/collections/` | Payment reminders and collection tracking. | — | — |
| #24 | [E24] Add live bank feeds through replaceable authorised adapters | `packages/bank-feeds/` | Live bank feeds through authorised adapters. | — | — |
| #38 | [E38] Implement multilingual, mobile-responsive product foundations | `apps/web/ + apps/mobile/` | Multilingual, mobile-responsive client application foundations. | — | — |
| #39 | [E39] Build notification infrastructure | `packages/notifications/` | Notification infrastructure and channel routing. | — | — |
| #40 | [E40] Implement security, privacy, backup and disaster recovery | `ops/security/` | Security, privacy, backup and disaster recovery. | — | — |
| #41 | [E41] Build monitoring, support and operational administration | `ops/monitoring/` | Monitoring, support tooling and operational administration. | — | — |
| #42 | [E42] Implement subscriptions, entitlements and usage measurement | `packages/subscriptions/` | Subscriptions, entitlements and usage measurement. | — | — |
| #47 | [E47] Build a safe AI action agent for in-app assistance | `packages/action-agent/` | Safe in-app AI action agent with preview and approval. | — | — |
| #49 | [X01] Incorporate the company and assemble vendor-onboarding documents | `docs/business/` | Company incorporation and vendor-onboarding documents. | — | — |
| #52 | [X04] Research and obtain bank-feed sandbox/partnership access | `docs/business/` | Bank-feed sandbox and partnership access. | — | — |
| #55 | [X07] Prepare privacy, terms, consent and pilot agreements | `docs/legal/` | Privacy, terms, consent and pilot agreements. | — | — |

## GPT3

| Issue | Title | Module | Scope | Depends on | Wave |
| --- | --- | --- | --- | --- | --- |
| #5 | [E05] Build business master data for parties, items, tax and logistics | `packages/master-data/` | Parties, items, units, tax master data and logistics master data. | — | — |
| #15 | [E15] Build an omnichannel purchase-invoice inbox with OCR | `packages/purchase-inbox/` | Omnichannel purchase-invoice intake and OCR extraction. | — | — |
| #16 | [E16] Validate supplier invoices and detect duplicates | `packages/purchase-validation/` | Supplier invoice validation and duplicate detection. | — | — |
| #17 | [E17] Post approved purchases to inventory, ledger and supplier payable | `packages/purchase-posting/` | Posting approved purchases to inventory, ledger and supplier payable. | — | — |
| #18 | [E18] Implement purchase orders, goods receipt and three-way matching | `packages/procurement/` | Purchase orders, goods receipt and three-way matching. | — | — |
| #19 | [E19] Build explainable supplier GST and payment-risk warnings | `packages/supplier-risk/` | Explainable supplier GST and payment-risk warnings. | — | — |
| #26 | [E26] Implement e-invoice applicability and the complete IRN lifecycle | `packages/e-invoice/` | E-invoice applicability and IRN lifecycle. | — | — |
| #27 | [E27] Implement e-way-bill applicability and full lifecycle | `packages/e-way-bill/` | E-way-bill applicability and lifecycle. | — | — |
| #28 | [E28] Implement transport details and vehicle suitability controls | `packages/transport/` | Transport details and vehicle suitability controls. | — | — |
| #29 | [E29] Integrate authorised vehicle-record verification | `packages/vehicle-verification/` | Authorised vehicle-record verification. | — | — |
| #30 | [E30] Build the GSTR-1 and GSTR-3B preparation workspace | `packages/gst-returns/` | GSTR-1 and GSTR-3B preparation workspace. | — | — |
| #31 | [E31] Implement IMS/GSTR-2B reconciliation and ITC controls | `packages/ims-reconciliation/` | IMS/GSTR-2B reconciliation and input tax credit controls. | — | — |
| #32 | [E32] Build the compliance calendar and preventive alert engine | `packages/compliance-calendar/` | Compliance calendar and preventive alerts. | — | — |
| #33 | [E33] Integrate GSP/IRP customer onboarding and production GST operations | `packages/gsp-integration/` | GSP/IRP onboarding and production GST operations. | — | — |
| #44 | [E44] Build end-to-end workflow and failure testing | `tests/e2e/` | End-to-end workflow and failure testing. | — | — |
| #45 | [E45] Implement sales/purchase returns and transaction adjustments | `packages/returns/` | Sales and purchase returns and transaction adjustments. | — | — |
| #50 | [X02] Compare GSP/IRP providers and obtain sandbox access | `docs/business/` | GSP/IRP provider comparison and sandbox access. | — | — |
| #51 | [X03] Complete GSP/IRP production contracting and onboarding | `docs/business/` | GSP/IRP production contracting and onboarding. | — | — |
| #53 | [X05] Apply for authorised vehicle-data access | `docs/business/` | Authorised vehicle-data access application. | — | — |
