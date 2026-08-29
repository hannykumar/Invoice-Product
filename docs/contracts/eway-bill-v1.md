# E-way bill applicability and the full lifecycle — v1

Issue #27 [E27]. Owner: GPT 3. Package: `packages/transport`.

Decide whether a movement of goods needs an e-way bill at all, prepare Part A and Part B, and
manage the permit through its whole life: vehicle changes, validity, extension, cancellation,
rejection and consolidated trip sheets.

## The assumption that shapes everything

> **₹1 lakh a day is not a rule.**

It is a rule of thumb somebody's uncle uses, and it is wrong in both directions:

- The general limit is **₹50,000 for one consignment**, not ₹1 lakh, and never *per day*.
- **Inside one state, each state sets its own limit.** Several of them are ₹1 lakh — Maharashtra,
  Delhi, West Bengal, Tamil Nadu, Bihar, Punjab, Rajasthan — which is where the belief comes from.
  That is those states' limit, from those states' dates, not a national one.
- Some movements need a bill **at any value at all** (goods sent inter-state for job work), and
  some need **none however large** (a consignment of jewellery, goods on a hand cart).

So applicability is a **decision** — with the facts it applied, a rule id, an effective date and
the notification behind it. Where a fact is missing the answer is `CANNOT_DECIDE` and the movement
goes to a person, never to a guess that lets a lorry leave.

## Applicability

`decideEwayApplicability(movement)` is pure: same facts, same answer, forever.

| Outcome | Meaning |
| --- | --- |
| `REQUIRED` | The vehicle may not leave without an e-way bill |
| `NOT_REQUIRED` | No e-way bill is needed for this movement |
| `CANNOT_DECIDE` | We were not told something we need, and will not guess |

Decided in this order, which is the order the rules really override each other in:

1. Non-motorised conveyance — Rule 138(14)(a).
2. The customs-clearance leg between a port/airport and an inland depot — Rule 138(14)(g).
3. Goods moving under customs bond — Rule 138(14)(h).
4. No document on the movement → `CANNOT_DECIDE`.
5. Everything on the vehicle is annexure-exempt goods — Annexure to Rule 138(14).
6. Inter-state job work → required **at any value** — first proviso to Rule 138(1).
7. Handicrafts moved by a person exempt from registration → required at any value.
8. Origin or destination state unknown → `CANNOT_DECIDE`.
9. Inter-state → the national ₹50,000 limit.
10. Intra-state → that state's limit from `rules.ts`, on the movement's own date.

### Consignment value

Explanation 2 to Rule 138(1): the value **including** CGST, SGST, IGST and cess, **excluding** the
value of any exempt supply on the same invoice. Both halves matter — tax can push ₹48,000 over the
line, and forgetting to drop exempt lines can push a bill over one it was never near.

The comparison is a strict `>`: **exactly ₹50,000 does not need a bill**, because the rule says
"exceeds". That one word is the whole boundary, and it lives in one function so every state gets it.

### The state table

`INTRA_STATE_RULES` in `rules.ts`, by GST state code, each with its own effective date and the
state order it came from. A state we hold no order for falls back to ₹50,000 and **says so** —
which is different from claiming that state set ₹50,000, and is written differently.

Gujarat is in the table with `intraCityExemptAnyValue`, because its rule turns on a fact rather
than on money: no e-way bill at all inside one city, at any value. When we have not been told
whether a delivery stays inside one city, a Gujarat movement gets `CANNOT_DECIDE` with
`withinSameCity` named as the missing fact.

## Part A and Part B

They are separate on the portal and separate here, because different people fill them in at
different times, and because **goods may not move on a Part A alone**. A consignor can raise Part A
in the morning; the transporter adds the lorry at four in the afternoon.

| Status | Meaning |
| --- | --- |
| `PENDING` | Sent to the portal, no reply yet. We do not know |
| `PART_A_ONLY` | The portal holds the consignment but no vehicle. **The goods may not move** |
| `ACTIVE` | Part B filled, validity running. This is what the lorry travels on |
| `EXPIRED` | Validity has run out. Derived at read time, never trusted from the last write |
| `CANCELLED` / `REJECTED` / `FAILED` | Withdrawn, disowned by the other party, or not accepted |

Bill-to and ship-to are kept apart throughout. A Bengaluru seller billing Mumbai and delivering to
Hyderabad is one movement to Telangana and one bill to Maharashtra: the movement decides which
rules apply, the bill decides the tax. `transactionType: 2` and the `actToStateCode` field carry it.

## Validity

- One day for every **200 km** or part of it; one day for every **20 km** for over-dimensional
  cargo. So 840 km is 5 days on a lorry and 42 days on an ODC trailer.
- A day ends at **midnight Indian time**, and the portal's own counting adds a day: a bill made on
  the 21st with one day of validity runs to the midnight ending the 22nd. Everything in
  `validity.ts` works in IST explicitly; doing it in UTC "because the server is UTC" silently moves
  every expiry by five and a half hours, which at midnight is a whole day.
- **The clock starts at Part B**, not at Part A, and **a vehicle change does not restart it**. A
  breakdown at Hubballi does not buy the consignment another two days.
- Extension is accepted only in the **eight hours either side of expiry**. `canExtendNow()` says
  which side of that window you are on in words a driver can act on.

## Lifecycle

| Call | What it does |
| --- | --- |
| `preview` | The decision, the facts, what is missing, how long it would last. Writes nothing |
| `generate` | Raises the bill, once. Part B optional |
| `updateVehicle` | Part B: first vehicle, or a change with a reason |
| `assignTransporter` | Hands it to a transporter, who fills in Part B themselves |
| `extendValidity` | Extends inside the portal's window, with where the vehicle is now |
| `cancel` | Withdraws it, inside 24 hours, with a reason |
| `reject` | The other party saying the consignment is not theirs, inside 72 hours |
| `consolidate` | One trip sheet over several consignments on one lorry |
| `reconcile` | Asks the portal what it actually holds, for when a call timed out |
| `offlineJson` | Part A as a file for manual upload |
| `onTheRoad` / `expiringWithin` | What is moving now, and what runs out soon |

**Idempotency.** The key comes from the movement, never from the attempt, and the portal's own
duplicate reply (error 604) is treated as success with the number it already holds. Pressing the
button twice cannot put two permits on one lorry; a unique index on `(company_id, movement_id)` is
the database's half of the same promise.

**Cancellation is not rejection.** Cancelling withdraws your own permit within 24 hours; rejecting
is the *other* party disowning a movement raised against them within 72 hours. They are separate
states, separate permissions and separate audit actions. A consignment an officer has already
verified on the road **cannot be cancelled at all** — the portal refuses, and that refusal is
passed on rather than retried.

**A consolidated trip sheet replaces nothing.** Each consignment keeps its own number and its own
expiry; the sheet is what the driver shows at a check post. The service says exactly that in the
message it returns.

## Permissions

| Permission | Guards |
| --- | --- |
| `eway.view` | Seeing status, previewing, reconciling, offline export |
| `eway.generate` | Raising a permit with the portal |
| `eway.update` | Vehicle, transporter, extension, trip sheets |
| `eway.cancel` | Withdrawing a permit, or rejecting one raised against you |

Raising a permit is deliberately separate from issuing a bill: #9's `sales.finalise` does not carry
it. The transporter's day-to-day act — putting a lorry on — is separate from both.

## Storage

Migration `20260829T230150061Z_transport_f5901402df63_eway_bill_lifecycle`: `eway_bills`,
`eway_consolidated_trips`, `eway_bill_policies`, `eway_state_thresholds`. The sales invoice (#9)
and the delivery challan (#18) are not created here; only the movement id and document number are
stored. Constraints enforce what the module promises: nothing claims a portal state without a
number, and nothing is `ACTIVE` without a validity.

## Provider

The portal sits behind `connector-v1` (#8), connector kind `eway_bill`. Development runs against
`SyntheticEwayBillPortal`, which enforces the behaviours that matter: duplicate 604 with the
existing number, validity starting at Part B and expiring at midnight IST, cancellation refused
after 24 hours with 108, cancellation refused outright once verified in transit with 110, and the
eight-hour extension window. No production credential is needed to run or test anything.

## Assumptions recorded

1. **The state figures and dates are transcribed from the state orders named against each entry.**
   They are the values this product ships with, not values it discovered. Before a business in a
   given state relies on it, that entry should be checked against the state's current order — every
   row carries its `sourceRef` so the check is a lookup rather than an investigation, and a change
   is a change to the table rather than to any code.
2. **Distance is supplied, not computed.** The portal can work it out from pin codes when it is
   left at zero; this product does not compute road distance, and a blank one is left blank rather
   than guessed. Validity days are only shown once a distance is known.
3. **Exempt goods are matched by HSN prefix** against the part of the Rule 138(14) annexure a small
   business actually moves. The list is not exhaustive, so a line can also be marked exempt
   directly. A GST rate of zero does **not** imply e-way-bill exemption and is never read as one.

## Known limitations

1. **Only the union of state rules we hold is modelled.** States not in `INTRA_STATE_RULES` get the
   national limit with a note saying that is what happened.
2. **Some states restrict their intra-state limit to specified goods.** That refinement is not
   modelled; those states currently carry a plain threshold and their source reference.
3. **No automatic e-way bill from an IRN.** #26 stores the number when the IRP returns one
   alongside an e-invoice; joining the two records is not done yet.
4. **Distance-based expiry does not know about journey type changes.** Switching from road to ship
   mid-journey is recorded as a vehicle leg, but the ODC/regular per-day figure is taken from the
   vehicle on the bill.
5. **Consignor and consignee addresses on the web surface are placeholders**, because #5's full
   address records are not wired into the demo company. The Part A builder validates them properly;
   the demo simply supplies thin ones.
6. **We do not prove physical delivery** — explicitly a non-goal. An e-way bill is a permit, and
   this module never treats one as evidence that goods arrived.

## Try it

```sh
npm run demo:eway   # applicability, state rules, Part A, Part B, breakdown, expiry, cancel
npm run web         # sign in, then the "E-way bill" screen
```
