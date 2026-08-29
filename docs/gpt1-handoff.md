# GPT 1 handoff

**Lane:** accounting, sales, deterministic financial and compliance rules, reporting, user experience.
**Branch:** `codex/gpt1-accounting-sales`. **Base:** `main`.
**Last updated:** 29 August 2026, after #35 merged.

Read this, then `docs/product/README.md`. The authoritative requirements are the GitHub issue text
and `~/Downloads/Invoice_Product_GPT_1_Delivery_Handbook.docx`, in that order. Where a handbook and
an issue disagree, raise it rather than choosing silently.

---

## 1. State of the lane

**Closed (13):** #1 spec · #4 ledger · #7 rules engine · #9 sales · #10 voice assistant ·
#12 inventory · #13 invoice templates · #20 receivables · #25 GST calculation · #35 reports ·
#36 onboarding · #46 UX · #54 compliance register.

**Open (5):**

| Issue | What it is | Ready? |
| --- | --- | --- |
| **#11** | Pricing, discounts, customer credit, overdue controls | **Yes — recommended next.** Needs #5 ✓, #9 ✓, #20 ✓. The credit-limit rule already exists in `in.policy`. |
| **#43** | Golden test dataset | Yes. Needs #1 ✓, #4 ✓, #7 ✓, #25 ✓. `packages/reports/test/fixtures.ts` is most of one already — a business built through the real services rather than by hand. Start there. |
| **#37** | Excel/CSV migration from other tools | Yes. Needs #4 ✓, #5 ✓, #12 ✓, #36 ✓. |
| **#34** | AI business and legal knowledge assistant | Ready now that #35 is in: the assistant answers from reports rather than from the ledger. Also wants #32 (GPT 3). |
| **#48** | Financial correctness release gates | After #43. Also wants #44 (GPT 3). `trialBalanceBody().balanced` and `reconciles()` are the two gates it should hang off. |

**486 tests pass.** `npm run typecheck && npm test`, plus `npx tsc --noEmit -p tsconfig.strict.json`.

---

## 2. How to work

```bash
npm install
npm run typecheck && npm test          # the whole suite, no dependencies needed
npx tsc --noEmit -p tsconfig.strict.json   # the extra checks this lane needs
npm run web                            # GPT 2's UI preview on 127.0.0.1:4173
```

Demos that produce something to look at:

```bash
npm run demo:invoice      # real bills into tmp/invoices/ — A4, thermal, mobile, 100-line
npm run demo:onboarding   # a bakery set up, interrupted, resumed, into tmp/onboarding/
npm run demo:reports      # two months of trading, reported, into tmp/reports/ — click a total
```

### The working agreement

- Small commits, each naming its issue: `#12 [E12] …`.
- **Never push to `main` directly.** Open a PR, wait for the `verify` check, then merge. The owner
  has authorised merging our own PRs once green.
- Publish the contract in `docs/contracts/` before substantial implementation.
- Close the issue with a comment recording what was verified, what was assumed and what is still
  limited. Never close because code exists.
- Fetch the other agents' branches before starting an issue.

### Repository conventions

- TypeScript run directly by Node's type stripping. **No parameter properties, no enums** —
  `tsconfig.strict.json` sets `erasableSyntaxOnly` and Node would fail at run time otherwise.
- Root `package.json` and `tsconfig.json` are **issue #2's, owned by GPT 2**. Take them verbatim on
  merge; put our extra checks in `tsconfig.strict.json`.
- Money is `bigint` paise. Quantities are `bigint` micro-units. Rates are basis points. No floats.
- Cross-package imports: mine use `@invoice/*`; GPT 2's and GPT 3's use relative paths because
  their `package.json` files declare no `exports`. Follow whichever the *owning* package uses.
- `gh` is not installed. Reach the GitHub API with the stored credential:
  `TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')`
- Never invent a migration id. `npm run db:migration:id -- <module> <description>`.

---

## 3. What this lane has built

| Package | Issue | One line |
| --- | --- | --- |
| `kernel` | #4 | Exact money and quantities, rounding, ids, Indian dates, the error model |
| `ledger` | #4 | The only write path into the books. Balances fold from journal lines |
| `rules-engine` | #7 | Deterministic, effective-dated rules returning explainable decisions |
| `compliance-register` | #54 | The gate: a rule cannot be APPROVED without a verified official source |
| `gst-calc` | #25 | GST arithmetic; every judgement delegated to the rules engine |
| `sales` | #9 | Draft → approval → issue → cancel, with numbering and posting |
| `inventory` | #12 | Stock from an append-only movement ledger, reservations, negative-stock control |
| `receivables` | #20 | Payments, allocation, cheque lifecycle, ageing, statements |
| `invoice-templates` | #13 | Templates and rendering: A4, thermal, mobile, print |
| `onboarding` | #36 | Guided setup, declared rates, opening balances, resumable checklist |
| `voice-assistant` | #10 | Spoken or typed instruction to a confirmed draft |
| `reports` | #35 | Every report, composed from the modules that own the facts, each total drillable |
| `ux-vocabulary` | #46 | The only supported way to produce user-facing wording |

Contracts for all of them are in `docs/contracts/`.

---

## 4. Principles that are actually enforced

These are not aspirations; each has a test that fails if it is broken.

1. **Every posted voucher balances.** Checked in the service and again by a database trigger.
2. **Final records are never edited.** Corrections are reversals; both entries stay visible.
3. **Available stock, not physical, is what a sale is checked against.**
4. **A model never decides money or law.** Rules are pure synchronous functions with no I/O seam.
   The voice assistant's model may only turn sound into text.
5. **Nothing is defaulted.** An unclassified item, an unknown place of supply, an unlisted number
   word, a missing rate — each becomes a question or an exception, never a plausible value.
6. **Every user-facing string comes from `packages/ux-vocabulary`** and passes its linter. Banned
   jargon, technical leaks and raw state names fail the build.
7. **Retries are idempotent** everywhere money or a document number is involved.

---

## 5. Decisions still waiting on the product owner

**a. GST rates are not sourced.** The owner chose **option C + B**:

- **C is built.** A business declares the rates it charges; every line carries `rateBasis`, the
  declarer and their stated basis, and the printed bill says whose figures they are. Onboarding
  collects them. A sourced rate always wins over a declared one.
- **B is not started.** It needs the pilot business's trade so the right HSN headings can be
  sourced against the notifications. **Ask for this.**

**b. The compliance register needs a countersignature.** Every source records its reviewer as
*"GPT 1 (agent) — awaiting countersignature by a qualified reviewer"*, and a test enforces that
wording. Before this is sold to a business, a qualified reviewer should countersign. It is a data
change, not a code change.

**c. The rate schedule changed on 22 September 2025.** Four slabs became 5%, 18% and a 40% demerit
rate. The fixture rates predate it. Worth knowing for whoever sources them: CBIC's own rates page
still says its figures are current as of 1 April 2023, and its rate-notification index was last
updated January 2023. Recorded as `dl-rate-table-predates-2025-restructure`.

---

## 6. Cross-agent state

**GPT 2** (`codex/gpt2-platform-banking`) — platform, notifications, web foundations, security,
bank import, delivery. Two items raised on **#3** and not yet resolved:

1. `Permission` is a **closed union of six strings**. This lane needs ~20 more. Proposed a
   namespaced template type or a registry so every lane's PR does not edit their file.
2. **Audit event shape** differs. Proposed keeping theirs and adding `subjectType`, `subjectId`
   and a plain-language `summary`.

Also open: a **seam proposal on #38** — plain request/response handlers in `packages/sales` that
`apps/api` can mount, so the web preview's steps 2 and 3 stop being synthetic. Awaiting their word
on the signature; do not touch `apps/web` or their router.

**GPT 3** (`codex/gpt3-purchase-gst`) — master data, purchasing, GST returns, transport. Unblocked
by #54; `gst.tax_split` now answers in production. Two things raised with them:

1. Their state table marks Delhi, Puducherry and J&K `union: true`. They *are* union territories,
   but the **UTGST Act does not extend to them**, so those supplies carry State tax. Reading that
   flag as "UTGST applies" would mis-tax a large share of ordinary bills.
2. Two `Quantity` types mean the same thing — kernel's `{ scaled, unit }` and masters'
   `{ micro, unitCode }`. Both integer micro-units; it should be one type.

---

## 7. Known limitations carried forward

- **Production still cannot rate a taxable line** unless the business declared a rate (option C).
  E-way applicability and Ladakh's UTGST status also return `CANNOT_DECIDE`, deliberately.
- **Stock value is computed but not posted to the ledger.** Those entries belong with #17. #35 does
  not paper over it: the balance sheet shows the ledger's stock account, the stock report shows the
  movements' valuation, and the difference is raised as `STOCK_VALUE_NOT_IN_BOOKS` with its records.
  The same gap makes the profit figure flattering, and the profit and loss says so in words
  (`costOfGoodsInBooks`). All of it disappears when #17 posts purchases.
- **Period locks are not enforced on a stock movement date**, only on the ledger entry.
- Everything runs against in-memory stores. `packages/ledger/migrations/0001_ledger.sql` is the
  real schema; no Postgres adapter is written yet.
- The usability sessions in `docs/ux/02-usability-test-protocol.md` have not been run.
- The voice assistant handles **one item per instruction** and sales only.

---

## 8. Starting #11 (the recommended next issue)

Read the issue text first, then:

- **The credit-limit rule already exists** in `in.policy` and the sales service already calls it;
  #11 is about the rest — price lists, discount rules, and what happens when a customer is over
  their limit or badly overdue.
- `packages/receivables` already answers "how much do they owe and how late are they"
  (`position`, `overdueSummaries`). Consume it; do not work out lateness a second time.
- Master data's price lists are GPT 3's #5 and are built. Read
  `docs/contracts/master-data-v1.md` before defining a price-list type of your own.
- The hard part is the same as everywhere else in this lane: a discount a person did not
  authorise must not be applied, and a blocked sale must say what would unblock it. Message ids go
  in `packages/ux-vocabulary`, not in the service.

### What #35 left for others

- **`PurchaseReadPort`** in `packages/reports/src/ports.ts` is the shape the purchase register,
  the input-tax figures and the payables ageing need from GPT 3's #17. When #17 lands, write the
  adapter; nothing else in the package changes.
- **`Contribution.description` is one language.** Everything else on a report is bilingual. Making
  it bilingual needs the contributing modules to supply bilingual descriptions.
- **`ReportService.pack()` requires every report permission**, because it is every report.

## 9. First commands in a new session

```bash
cd /Users/hannykumar/Desktop/Invoice-Product
git fetch --all --prune && git checkout codex/gpt1-accounting-sales && git merge origin/main
npm install && npm run typecheck && npm test
```

Then read the issue on GitHub before writing anything.
