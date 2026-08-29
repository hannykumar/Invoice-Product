# The compliance-source register (issue #54 — [X06])

Every compliance rule in this product must be able to answer one question: **where does this come
from?** This folder and `packages/compliance-register` are the answer, and they are a gate rather
than a bibliography — a rule marked `APPROVED` that the register will not vouch for cannot be
loaded into a rules engine at all.

## Why it exists

A GST rate, a threshold or a place-of-supply conclusion is easy to get *almost* right. Almost right
means the wrong tax on a real bill, and a business finding out months later. So the product refuses
to state the law from memory. It states it from a provision it has read, on the publisher's own
site, on a recorded date, with the words it relies on quoted.

## What counts as authority

| Class | Examples | May approve a rule? |
| --- | --- | --- |
| `STATUTE`, `RULE`, `NOTIFICATION`, `ORDER` | The IGST Act, the CGST Rules, a rate notification | **Yes** |
| `CIRCULAR`, `OFFICIAL_FAQ`, `PRESS_RELEASE` | A CBIC circular, an official FAQ, a GST Council announcement | Only alongside a legal source |
| `COMMENTARY` | A consultant's summary, a vendor's blog, a news article | **Never** |

Three further gates apply to every source, each with a test:

- it must be **hosted by the authority that issued it** — a statute reproduced on a consultancy
  site is not a statute for our purposes;
- it must have been **read first-hand**, not summarised from an index;
- it must have a **reviewer** and a **review date**, and a rule that cites it must **name a test**.

## What is approved today

| Rule | Provision | Source |
| --- | --- | --- |
| `gst.place_of_supply.goods@2026.08.29` | IGST Act 2017, s. 10(1)(a) | `igst-act-2017-s10-1-a` |
| `gst.place_of_supply.services@2026.08.29` | IGST Act 2017, s. 12(2) | `igst-act-2017-s12-2` |
| `gst.tax_split@2026.08.29` | IGST Act 2017, ss. 7 and 8; UTGST Act 2017, s. 7 | three entries |

These are the rules that decide whether a supply is inter-State or intra-State, and therefore
whether one combined GST applies or two separate ones. **A production engine can now answer that
question**, which is what issues #16, #17, #30 and #31 were waiting for.

## What is still refused, and why

Refusing is not a gap. It is the product working.

| Refused | Why | What would settle it |
| --- | --- | --- |
| **Every GST rate** | The shipped table was written to exercise arithmetic, and it also **predates the restructuring of 22 September 2025**. See below. | Retrieve the rate notifications themselves and load the table from the register. |
| **E-way bill applicability** | Its thresholds are placeholders. | Record the e-way bill rules and each State's intra-State threshold notification. |
| **Ladakh** | The UTGST extent clause we could read first-hand is the text as enacted in 2017, which predates Ladakh. The amended text could not be retrieved from the publisher. | Retrieve the Act as amended and add Ladakh with that source. |
| **Place of supply except goods-in-movement and the general services rule** | Bill-to-ship-to, assembly at site, immovable property, transport, events and the rest each need facts the product does not capture. | Capture those facts, then one rule per clause with its own source. |
| **Composition invoicing** | No source recorded yet. | Record the provision governing a composition dealer's bill. |

Each of these is a decision-log entry with its reasoning, not an omission.

## Why rates are harder than they look

The GST Council restructured the whole rate schedule with effect from **22 September 2025**: four
slabs of 5, 12, 18 and 28 per cent became a merit rate of **5%**, a standard rate of **18%** and a
demerit rate of **40%**. Anything encoding the old slabs is not merely unsourced, it is wrong.

Three traps make this worse than a one-off transcription job, and each is recorded in the decision
log rather than in someone's memory:

1. **The easiest official pages are stale.** CBIC's own "GST Goods and Services Rates" page still
   says its figures are current as of **1 April 2023** and does not mention the change at all. Its
   Central Tax (Rate) notification index was last updated in **January 2023**.
2. **The announcement is not the law.** The Council's press release is reliable and detailed, and
   it is a *recommendation*. The instrument that changes the rate is the notification. That is why
   `PRESS_RELEASE` is an authority class that can never approve a rule on its own.
3. **Some goods have no single current rate.** Pan masala, gutkha, cigarettes, zarda,
   unmanufactured tobacco and bidi stay on the older rates "till loan and interest payment
   obligations under the compensation cess account are completely discharged" — a date to be
   notified. Their effective date is an event to monitor, not a date to record.

## A subtlety worth reading

The master-data state table (issue #5) marks Delhi, Puducherry and Jammu and Kashmir as union
territories, which they are. **The UTGST Act does not extend to them**, so an intra-State supply in
Delhi carries State tax, not union territory tax. Reading the `union` flag as "UTGST applies" would
mis-tax a very large number of ordinary Delhi bills.

That is why the rule works from the Act's own extent clause — a list of names — rather than from a
general flag, and why decision-log entry `dl-delhi-puducherry-state-tax` exists.

## The honesty this register is built around

The reviewer recorded on every entry today is:

> GPT 1 (agent) — awaiting countersignature by a qualified reviewer

That is deliberate and it is visible in the data, not buried in a comment. An agent retrieved and
quoted these provisions; an agent is not a substitute for professional responsibility. **Before this
product is sold to a business, a qualified reviewer should countersign each entry**, and the
register is shaped so that doing so is a data change, not a code change.

A test asserts that every decision-log entry says who decided it and that the answer contains the
word "countersignature". Removing that honesty breaks the build.

## Working with it

```ts
import { defaultRegister } from '@invoice/compliance-register';

const register = defaultRegister();

register.mayApprove('gst.tax_split', '2026.08.29', today);  // { approved, reasons[] }
register.reviewQueue(today);                                 // work, with severities
register.trace('gst.tax_split', '2026.08.29');               // rule → provision → quote → tests
```

`reviewQueue` is the change-monitoring surface. A superseded, withdrawn, stale or unofficially
hosted source becomes a task with a severity, so a change to the law arrives as work rather than as
a silent wrong answer.

## Adding a source

1. Retrieve the provision from the publisher's own site. Record the URL and the date.
2. Quote only the words the rule relies on — a citation, not a reproduction.
3. Set `verification: 'FIRST_HAND'` only if you actually read it there.
4. Add the rule-to-source link, **including the names of the tests that prove the rule behaves**.
   A test named there that does not exist fails the register's own audit.
5. If anything was interpreted or deliberately left unsupported, add a decision-log entry saying
   what would settle it.
