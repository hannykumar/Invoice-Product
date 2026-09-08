# Vehicle-record access: privacy, caching and permitted use (issue #53 — [X05])

This is the documentation the issue asks for, and it is deliberately written so that most of it can
be checked by a program rather than believed. `npm run vehicle:access` prints the current state of
everything below; `ops/vehicle-data-access` is where it lives, and its tests fail if this document
and the software stop agreeing.

## What we are applying for, and what we are not

A registering authority does not sell vehicle data. It grants a named company, for a stated purpose,
permission to read named fields — and it can withdraw that permission. So this is an application,
and an application is mostly an argument about **necessity**.

The product's one need is to answer a single question before goods leave a yard: *can this vehicle
lawfully carry this consignment?* That is what stops five tonnes of steel going out on a scooter, a
refrigerated load on an open truck, or a movement on a lorry whose registration was cancelled last
year. Nothing else is asked for and nothing else is kept.

**We do not scrape.** Several services offer "vehicle RC APIs" that are a screen scrape of the
public VAHAN or mParivahan pages behind a REST façade. Using one is this issue's own stated
non-goal, it breaches those portals' terms, and it hands a customer evidence with no authority
behind it — which, for a product whose promise is accuracy, is worse than having no evidence.

## The twelve fields

The field list on the application is not typed out here. It is `PERMITTED_VEHICLE_FIELDS` in
`packages/transport/src/vehicle-record-types.ts` — the allow-list the code already applies at the
boundary before anything reaches storage — and a test fails if the two ever drift. An application
that asks for one set of fields while the software reads another is either taking data without
permission or holding permission it does not use.

| Field | In plain words | What it decides |
| --- | --- | --- |
| `registrationNumber` | the vehicle number | It is the question we send, not an answer we receive |
| `vehicleClass` | what kind of vehicle it is | Whether it is built to carry goods at all |
| `bodyType` | the kind of body it has | Refrigerated, tanker and hazardous-goods suitability |
| `grossVehicleWeightKg` | what it may weigh when loaded | Payload, where the record does not state one |
| `unladenWeightKg` | what it weighs empty | The other half of that subtraction |
| `ratedPayloadKg` | how much it may carry | Payload, where the record states it outright |
| `permitType` | which permit it holds | Whether it may cross a state border |
| `permitValidUpto` | when that permit runs out | Whether the permit means anything today |
| `fitnessValidUpto` | when its fitness certificate runs out | Whether it is road-legal |
| `insuranceValidUpto` | when its insurance runs out | Whether a loss is covered |
| `registrationStatus` | whether the registration is still live | Scrapped and cancelled vehicles |
| `registeredOwnerName` | the owner's initials only | Nothing — see below |

### The one field that names a person

`registeredOwnerName` is the only requested field that names anybody, and it is the only one **no
rule reads**. That is not an oversight; it is checked. The necessity review reads the rule source in
`packages/transport/src/suitability.ts` and classifies every field by whether a deterministic check
actually looks at it. Ten fields do. The registration number is the question. The owner's name is
shown, masked to initials, on the vehicle-check screen so that a person at a loading bay can tell
whether the lorry in front of them belongs to the transporter who was booked.

For that job `S******** T******` is exactly as useful as the full name and far less to lose, so the
full name never enters storage or memory beyond the parse — `maskOwnerName` runs at the boundary. If
the authority declines this field, **nothing in the product stops working**, and the application
says so.

## What we are not asking for

Thirteen fields the record holds and we decline, including the chassis number, the engine number,
the owner's current and permanent addresses, their father's name, mobile number and date of birth,
the financier the vehicle is hypothecated to, the make, model and colour, the pollution certificate
and the enforcement flags. Each one carries its reason in `ops/vehicle-data-access/src/fields.ts`.

Writing them down is what makes minimisation reviewable. "We only asked for what we needed" is
unfalsifiable. "We did not ask for the chassis number, and here is a test that runs a full provider
response through the real boundary and fails if any declined field reaches storage" is not.

## Caching and retention

| | Setting | Why |
| --- | --- | --- |
| Reuse without asking again | 6 hours | A registration class does not change from one hour to the next, and an avoided call is a call nobody is charged for and a person's data not moved again |
| Shown as stale after | 7 days | Insurance and fitness certificates expire; a month-old reading may describe a lorry that is no longer road-legal |
| Retained as evidence | 8 years | A dispatch decision has to stay explainable for as long as the underlying tax records are kept |

A stale reading is not deleted. It is not evidence of today and the product never presents it as
such — but it is the evidence somebody dispatched on, and a dispatch later questioned by a check
post, a buyer or an insurer has to be explainable in terms of what was known at the time. Deleting
it would be a privacy gesture that destroys the audit trail the same authority would expect us to
keep.

**Nobody has yet told us how long a provider permits a response to be kept.** `reviewCaching`
compares our six-hour reuse against whatever a provider allows and reports it as outside terms until
somebody asks. A provider permitting less is not a disqualifier; it is a narrower freshness policy,
more calls and a bigger bill — which is why the policy is dated data rather than a constant.

## What we undertake

1. One purpose only: deciding whether a specific consignment may go out on a specific vehicle. The
   purpose is a single-valued type in code and travels on every request.
2. Only on behalf of a business with live, dated consent naming the purpose and the fields.
3. Only the approved fields; anything else in a response is discarded at the boundary.
4. The owner's name stored only as initials.
5. **No bulk enumeration.** One number per call, from a movement about to be dispatched — never a
   list, a file or a range. There is no batch entry point.
6. No secondary use: no vehicle database, no sale, no sharing between businesses, no analysis about
   an owner.
7. The public portals are not read, with or without a provider.
8. Stored readings are deleted when a business leaves or asks.

Each undertaking names the thing in the code that keeps it true, and a test asserts that it does.

## The fallback: what happens without any of this

**Today this is not a fallback. It is the whole of the product's vehicle checking**, because no
application has been made — there is no company to make one, and #49's register says so.

A person asks the driver for the registration certificate and types in what it says. The facts are
recorded as `ENTERED_BY_HAND`, which #28 ranks below both the authority's record and the business's
own vehicle list, so typing a bigger capacity can never overrule a record that says otherwise. A
photograph of the certificate can be attached and **is not required** — a worn paper copy in bad
light must not stop a dispatch. The six steps are in `ops/vehicle-data-access/src/fallback.ts`;
`npm run vehicle:access -- --fallback` prints them.

What still works with no authorised access: every suitability check runs, and a scooter carrying
five tonnes is still blocked, because that is arithmetic on facts somebody typed rather than a
lookup. What does not: a vehicle the business has recorded wrongly stays wrongly recorded, a
scrapped registration is invisible, and the expiry dates are only as current as what was last typed.

And when the provider exists but does not answer, the product says so. "We could not ask" is a
different answer from "the authority holds no such vehicle", and neither is ever shown as "no
problem found".

## Where the application stands

Nothing has been submitted. The blocker is not this document — it is that a vehicle-data provider
asks for eight company documents (certificate of incorporation, PAN, board resolution, authorised
signatory identification, domain ownership, an official email address, a security questionnaire and
a signed data-processing agreement) and #49's register holds none of them, because the company does
not exist yet.

`npm run vehicle:access` exits non-zero while that is true, so the work depending on it cannot be
quietly marked done.
