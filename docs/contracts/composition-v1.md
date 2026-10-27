# Composition scheme — contract v1 (issue #296)

Owner: GPT 1 (sales) with GPT 3 (returns); built by one session at the owner's direction, recorded in the PR.
Consumed by: sales (#9), purchases (#17), GST returns (#30), e-invoice (#26), e-way bill (#27), the web app.

A business registered under the composition levy (CGST Act s.10) cannot collect tax, issues a **Bill of
Supply**, cannot claim input credit, cannot make inter-State outward supplies, pays a percentage of
turnover every quarter (CMP-08) and files GSTR-4 once a year.

## Rule 0 — the law, and what was and was not verified

The primary sites (`taxinformation.cbic.gov.in`, `cbic-gst.gov.in`, `gstcouncil.gov.in`) **could not be
opened from the build sandbox** (the host does not resolve). What follows rests on search results that
quote those sites and on secondary commentary, and is carried as `DRAFT` — to be compared with the
gazette text and approved in the register (#54) by a person. Today's date for this check: 27 October 2026.

| Rule | Source | Where applied | Verified? |
| --- | --- | --- | --- |
| No tax collected from the buyer | CGST Act s.10(4) | rules engine `gst.composition.charging` (already APPROVED); `mayChargeGst=false` in `gst-calc` | Text of the rule as already approved in the register |
| Bill of Supply, not tax invoice | CGST Rule 49 (and s.31(3)(c)) | `BILL_OF_SUPPLY` title on the printed bill | Search results only |
| The words "composition taxable person, not eligible to collect tax on supplies" at the top | CGST Rule 5 (issue text cites 5(1)(g)) | `COMPOSITION_LEGEND`, `legendBlock` | The sentence: two sources agree. The clause letter: **not verified** |
| No input tax credit | CGST Act s.10(4) | `apps/api/src/demo-application.ts` purchase lines → `INELIGIBLE`, clause `10(4)` | Search results only |
| No inter-State outward supply | CGST Act s.10(2)(c); Notification 2/2019-CT(Rate) | `COMPOSITION_INTERSTATE_SUPPLY` in `gst-calc` | Goods: agreed. **Services under ordinary s.10(1): not verified** — refused too, easy to relax |
| No supply through an e-commerce operator that must collect tax | CGST Act s.10(2)(d) | a declaration the owner ticks; the product has no e-commerce channel | Declaration only |
| Services-only composition, ₹50 lakh, 6% | CGST Act s.10(2A); Notification 2/2019-CT(Rate) 7 Mar 2019 | category `SERVICES_ONLY` | Search results only |
| Goods limit ₹1.5 crore; ₹75 lakh in special-category States | Notification 14/2019-CT 7 Mar 2019 | `compositionLimitFor` (warning only) | **State list not verified** (CBIC documents disagree on Assam, Himachal Pradesh, Uttarakhand) |
| Rates 1% / 5% / 6% | CGST Rules Rule 7; Notification 2/2019-CT(Rate) | `COMPOSITION_RATES`, `DRAFT` | Amendment history to 2026 **not verified** |
| Ceases from the day the limit is crossed | CGST Act s.10(3) (clause not verified) | `watchLimit` warns; never refuses | Not verified |
| CMP-08 due the 18th after the quarter | CGST Rules Rule 62 | `cmp08DueDate` | Search results only |
| GSTR-4 due 30 June (from FY 2024-25) | Notification 12/2024-CT, 10 Jul 2024 | `gstr4DueDate` | Secondary sources only |
| Option exercised before the year starts (CMP-02) | CGST Rules Rule 3 | opt-in must start 1 April unless "newly registered" | Search results only |

### Cases — what works, what does not, and why

| Case | Outcome |
| --- | --- |
| Sale inside the business's own State | Bill of Supply, own series `BOS/26-27/000001`, no GST, legend on top |
| Sale to a customer in another State, or an export/SEZ supply | **Refused** with a plain reason (s.10(2)(c)); no number is used |
| Sale line that is exempt / nil-rated | Printed; carried on CMP-08 row 1; no composition tax on it (NOT VERIFIED that exempt turnover is excluded from the base) |
| Credit note against a Bill of Supply | Reduces the quarter's turnover (GSTR-4 is "net of goods returned"); a quarter that goes negative owes nothing and is not refunded |
| Purchase from a regular supplier | GST goes into cost; nothing claimed (s.10(4)) |
| Purchase from an unregistered or composition supplier | As before (#289); no GST on the bill |
| Reverse-charge purchase | Liability unchanged; credit lost. Tax on it is **entered by hand** on CMP-08 row 2 — not worked out |
| GSTR-1 / GSTR-3B for a composition month | **Refused**, pointing to CMP-08/GSTR-4 (`GST_RETURN_NOT_FOR_COMPOSITION`) |
| GSTR-1 / GSTR-3B for the month the scheme changed | **Refused** (`GST_RETURN_MIXED_SCHEME_MONTH`) — one return cannot cover both |
| E-invoice for a Bill of Supply | Never needed (`EINV.DOC.BILL_OF_SUPPLY`) |
| E-way bill for a Bill of Supply | Document type `BILL_OF_SUPPLY` |
| Interest, late fee, ITC-03 / ITC-01 | **Not computed**; said to the owner in the preview and on the statement |
| Portal upload JSON for CMP-08 / GSTR-4 | **Not produced**: the statements are working papers to file from |
| Turnover crosses the limit mid-year | Warning from 80%, naming the day it was crossed; the owner changes the scheme |

## Data

`SchemeChange` (append-only, per company, `app_records` kind `composition_scheme`):
`{ requestId, scheme: REGULAR|COMPOSITION, effectiveFrom, category, rateBasisPoints, rateBasis, newlyRegistered, declaredBy, declaredOn, note }`.
`rateBasis` is `BUSINESS_DECLARED` (the owner confirmed the rate) — the product never presents a rate as checked law.

`StatementRecord` (kind `composition_statements`): per quarter, the bookings (fingerprint, amount, delta, voucher) and, once filed, the portal reference.

`InvoicePricing.supplierRegistration` records the scheme on the bill's own date; `CompanyTaxProfile.registrationHistory` lets the calculator tax a bill by the scheme in force on its date.

## Commands and API (tenancy from the session; every write previewed, approved and idempotent)

| Route | Permission | Notes |
| --- | --- | --- |
| `GET /api/composition/scheme` | `business.settings.read` | scheme, history, the legend |
| `POST /api/composition/scheme/preview` | `business.settings.write` | blockers, warnings, what changes, a token |
| `POST /api/composition/scheme` | `business.settings.write` | needs the token and a `requestId`; the same id applies once |
| `POST /api/composition/statements` | `gst_returns.view` | running quarter + four before, limit watch |
| `POST /api/composition/statement` | `gst_returns.view` | one quarter with its bills |
| `POST /api/composition/approve` | `gst_returns.approve` | needs the statement's fingerprint; books `Dr Other business costs / Cr GST you owe the government yourself`; a later approval after bills changed books only the difference |
| `POST /api/composition/filed` | `gst_returns.approve` | only after approval; records the portal reference |
| `POST /api/composition/yearly` | `gst_returns.view` | GSTR-4 working paper |

## Errors

`COMPOSITION_NOT_PREVIEWED`, `COMPOSITION_CHANGED_SINCE_PREVIEW` (409), `COMPOSITION_NOT_ALLOWED`,
`COMPOSITION_REQUEST_ID`, `COMPOSITION_NOT_CHECKED`, `COMPOSITION_CHANGED_SINCE_CHECK` (409),
`COMPOSITION_ALREADY_FILED` (409), `COMPOSITION_APPROVE_FIRST`, `COMPOSITION_NOTHING_DUE`,
`COMPOSITION_REFERENCE`, `COMPOSITION_RATE*`, `GST_RETURN_NOT_FOR_COMPOSITION`, `GST_RETURN_MIXED_SCHEME_MONTH`,
`COMPOSITION_INTERSTATE_SUPPLY` (a sale problem, not an HTTP error).

## Fixtures

`npm run demo:composition` — Kaveri Provision Store, an invented shop, a year of bills, four statements, GSTR-4.
Tests: `packages/gst-returns/test/composition.test.ts`, `packages/gst-calc/test/compute.test.ts`,
`packages/sales/test/composition.test.ts`, `packages/invoice-templates/test/bill-of-supply.test.ts`,
`apps/api/test/composition.test.ts`, `tests/browser/composition.spec.ts`.

## Known limitations

No database migration: the setting and the statement records live in the app's own durable store like
business details. Statements post to the existing accounts (5900, 2300) rather than dedicated ones, to
leave the chart of accounts alone. The payment of the tax on the portal is recorded as an ordinary
journal entry. Customers registered under composition are unaffected (#5).
