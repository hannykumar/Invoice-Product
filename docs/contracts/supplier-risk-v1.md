# Supplier GST and payment-risk warnings — v1

Issue #19 [E19]. Owner: GPT 3. Package: `packages/purchasing`.

Warn a buyer with facts that carry a date and a source, and stop short of judgements the evidence
cannot support.

## The line this module will not cross

> allowed:     "The GST department's records show this number was cancelled on 12 March 2026."
> not allowed: "This supplier is fraudulent."   — a judgement we cannot support
> not allowed: "This supplier is blacklisted."  — we run no blacklist (an explicit non-goal)

The buyer draws their own conclusion. This is both the honest position and the defensible one:
the product's non-goals are "guarantee that a supplier is genuine" and "create a public
blacklist", and a warning that reads as an accusation does the second by implication.

The rule is machinery, not intent. Every message is built through `safeMessage()`, which throws
rather than return a sentence containing a banned word or phrase — see `supplier-risk-wording.ts`.
A test drives every branch of the engine and asserts no message, action or evidence statement
trips the guard.

## Three guarantees, each enforced rather than intended

| Guarantee | How it is enforced |
| --- | --- |
| Every warning names its evidence | `warn()` throws if built with an empty evidence array |
| No party is judged from a model score | `ModelHint` is excluded from the level calculation by construction; it can only ever produce an `INFORMATION` warning that says it is a guess |
| Missing or stale data is identified | Its own `INFORMATION` warning about **our** data, excluded from the level, plus `confidence: "PARTIAL"` and a per-source note |

## Evidence

Every warning carries one or more:

```ts
interface Evidence {
  source: "GST_PORTAL" | "IMS_GSTR2B" | "OUR_RECORDS" | "SUPPLIER_DOCUMENT";
  statement: string;        // the fact, stated without inference
  effectiveFrom?: IsoDate;  // when the fact took effect (e.g. cancellation date)
  observedAt?: string;      // when we read it — this is what makes staleness visible
  ageInDays?: number;
  stale: boolean;
  unavailable?: { reason: UnavailableReason; retryable: boolean };
}
```

`UNKNOWN` and `NOT_FOUND` are deliberately different GSTIN statuses. `NOT_FOUND` is the portal
actively saying there is no such registration; `UNKNOWN` is what we record when we could not ask.
Collapsing the two would turn an outage into an accusation.

## Warnings

| Code | Level | What it means |
| --- | --- | --- |
| `GSTIN_CANCELLED_BEFORE_INVOICE` | SERIOUS | Cancelled on or before the bill date. The issue's own example. |
| `GSTIN_CANCELLED_AFTER_INVOICE` | CAUTION | Cancelled later — **this bill is not affected**, later ones would be |
| `GSTIN_SUSPENDED` | SERIOUS | |
| `GSTIN_NOT_FOUND` | SERIOUS | Worded as a likely typo, which it usually is |
| `GSTIN_INACTIVE` | CAUTION | |
| `GSTIN_PROVISIONAL` | INFORMATION | |
| `GSTIN_REGISTERED_RECENTLY` | INFORMATION | "New businesses are new, and that is all this means" |
| `GSTIN_NAME_DIFFERS` | CAUTION | Compared loosely: "Pvt Ltd" and "Private Limited" agree |
| `GSTIN_STATE_DIFFERS` | CAUTION | Changes whether IGST or CGST+SGST applies |
| `RETURNS_NOT_FILED` | CAUTION | Counted by **period**, not by form |
| `EINVOICE_EXPECTED_BUT_ABSENT` | INFORMATION | |
| `NOT_IN_GSTR2B` | CAUTION | Optional (#31). Worded as usually a timing matter |
| `GSTR2B_VALUE_DIFFERS` | CAUTION | Optional (#31) |
| `BANK_DETAILS_CHANGED` | SERIOUS if recent, else CAUTION | The invoice-redirection warning |
| `OVERDUE_TO_SUPPLIER` | INFORMATION | Framed as **our** position, not their failing |
| `OPEN_DISPUTE` | CAUTION | |
| `FIRST_TIME_SUPPLIER` | INFORMATION | |
| `GOVERNMENT_DATA_STALE` | INFORMATION | About our data. Cannot raise the level. |
| `GOVERNMENT_DATA_UNAVAILABLE` | INFORMATION | About our data. Cannot raise the level. |
| `GSTR2B_NOT_CHECKED` | INFORMATION | About our gap. Cannot raise the level. |
| `MODEL_HINT` | INFORMATION | Always. Cannot raise the level. |

There is no `FRAUD` level and there never will be. `SERIOUS` means "stop and check before you
pay", which is the strongest thing a buyer's own software is entitled to say.

Only `SERIOUS` blocks anything, and only until someone with `supplier.risk.acknowledge` accepts
it with a reason. `CAUTION` and `INFORMATION` are shown and never block — a warning that stops
work is one people learn to click past.

## Two lights (issue #99)

Every assessment carries exactly two lights, so someone who is not looking for a problem still
sees one:

| Light | Based on |
| --- | --- |
| "The GST department's records" | Only what the GST portal says — registration status, filings |
| "Your own records" | Only this business's books — bank changes, disputes, money overdue |

| Colour | Headline | Meaning |
| --- | --- | --- |
| Red | "Stop and check before you pay" | Something real is wrong |
| Amber | "Worth a look" | Worth knowing, does not stop you |
| Green | "Looks fine" | Nothing to flag |
| Grey | "We could not check" | The source could not answer |

The split matters. A supplier's bank account changing is the most common way a business loses
money, so it must be able to show red — but on the second light. The government has no complaint
in that case, and making its light red would misrepresent it. Conversely a cancelled GSTIN reddens
the first light and leaves the second green.

**Grey is not green.** If the GST service is down, the first light is grey. "We checked and it was
fine" and "we could not check" are different answers and the buyer must be able to tell them apart.

A warning is attributed to a light by reading its own evidence — anything sourced from
`GST_PORTAL` or `IMS_GSTR2B` belongs to the government light — so a warning added later cannot
quietly land on the wrong one. The meta-warnings (`GOVERNMENT_DATA_UNAVAILABLE`,
`GOVERNMENT_DATA_STALE`, `GSTR2B_NOT_CHECKED`) and `MODEL_HINT` colour nothing: the first three
describe the state of our own checking, and a model's guess is not evidence.

## Data sources and outages

The GST department sits behind `connector-v1` (#8). The adapter:

- caches readings and serves them for `cacheMinutes` (default 60) unless `refresh` is passed;
- on failure returns `{ kind: "UNAVAILABLE", lastKnown }` rather than throwing — the last reading
  is still shown, marked stale, because a seven-day-old "cancelled" is far more useful than
  silence provided it is labelled;
- normalises `ConnectorError` into a reason a buyer can read without alarm.

Development and tests run against `SyntheticGstConnector`. Every GST number in fixtures is built
by `syntheticGstin()`: structurally valid, checksum-correct, belonging to nobody. **No production
credential is needed to run or test anything.**

## The optional #31 contract

The execution override in `docs/gpt3-handbook.md` says #19 ships baseline warnings without #31,
and defines an optional input contract for it. That contract is `Gstr2bPort`:

```ts
interface Gstr2bPort {
  signalFor(companyId, { supplierGstin, invoiceNumber, invoiceDate }): Promise<Gstr2bSignal | null>;
}
```

Construct `SupplierRiskService` without it and every assessment carries `GSTR2B_NOT_CHECKED` at
`INFORMATION`, saying plainly that this is about what we can see, not about the supplier. A port
that throws is treated as "not checked", never as a finding — that is the point of making it
optional rather than assumed.

## Bank-detail changes

Read from #5's master version history (`VersionedStore.history()`), not copied into a table of
this module's own, so there is one account of what changed. Only a changed account number or IFSC
counts — a renamed branch is not the money moving.

**Account numbers are masked to the last four digits** on the way out. A warning about a changed
account has no business carrying the account itself, and a test asserts no full number reaches
the audit trail.

## Permissions, audit, idempotency

| Permission | Guards |
| --- | --- |
| `supplier.risk.view` | Seeing a supplier's government record — it is data about someone else |
| `supplier.risk.acknowledge` | Going ahead despite a serious warning |

Assessments are keyed by `fingerprint`, a hash over the facts and the policy, so re-checking the
same supplier on the same day records one assessment rather than a row per page refresh. An
acknowledgement is pinned to that fingerprint, so accepting "their GST number was cancelled" today
does not silently cover a bank-account change that appears next week.

Audit records the level, the warning codes and the fingerprint. It never records a credential
reference or an account number.

## Storage

Migration `20260829T181515430Z_purchasing_a9be7b3d2c86_supplier_risk_warnings`:
`supplier_gstin_readings`, `supplier_risk_assessments`, `supplier_risk_acknowledgements`,
`supplier_risk_policies`.

## Known limitations

1. **`SupplierHistoryPort` is a narrow read.** Open disputes are not yet a first-class record
   anywhere in the product; the port accepts them and the web surface supplies an empty list.
   Marking a bill disputed belongs with #45 (returns and adjustments).
2. **Filing status is only as good as what the provider returns.** An empty `filings` array means
   "the portal did not tell us", never "they have never filed", and the engine treats it that way.
3. **No e-invoice IRN verification.** `EINVOICE_EXPECTED_BUT_ABSENT` fires on the portal's
   e-invoice flag plus the absence of an IRN on our side. Verifying an IRN against the IRP is #26.
4. **One risk policy per company**, not per supplier or trade.
5. **GSTR-2B signals are unimplemented** until #31. The contract is defined and exercised by tests
   with a stub, but no real reconciliation exists yet.
6. **The forbidden-word list is blunt.** A false positive costs one reworded sentence; a false
   negative is a letter from a supplier's lawyer, so it errs toward blocking. It deliberately does
   not ban the ordinary copula — "This supplier is required to issue e-invoices" is a plain fact.

## Try it

```sh
npm run demo:risk   # four suppliers, four stories, and a provider outage — no database
npm run web         # sign in, then the "Supplier check" screen
```
