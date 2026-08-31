# Vehicle-record verification — v1

Issue #29 [E29]. Owner: GPT 3. Package: `packages/transport`.

Ask an approved government provider what the registering authority holds about one lorry, keep only
what a dispatch decision needs, and never let "we could not ask" look like "nothing is wrong".

## What this is for

A business is about to send goods out on a vehicle. The registering authority (VAHAN, reached
through API Setu or an equivalent approved provider) knows what that vehicle actually is: whether it
is a goods vehicle at all, how much it may carry, which permit it holds, and whether its fitness
certificate and insurance are still live. Issue #28 turns those facts into a decision; this module
is how the facts are obtained.

## The three answers, which are never two

| Answer | Means | On a screen |
| --- | --- | --- |
| `FOUND` | The authority holds this vehicle, and here is what it says | The classification, the capacity, the dates, and when we asked |
| `NOT_FOUND` | The authority answered, and it has no such vehicle | "Not on record" — a fact about the lorry, and not proof the number is wrong |
| `UNAVAILABLE` | We could not ask, or could not get an answer | "This vehicle has not been checked", with which reason it was |

Collapsing the third into either of the other two is the failure this module exists to prevent. A
provider outage that reads as "nothing found against this vehicle" would send an unchecked lorry out
under the appearance of a check.

`UNAVAILABLE` carries a reason, because each one is a different thing for somebody to do:
`NOT_CONNECTED`, `CONSENT_EXPIRED`, `UNAUTHORIZED`, `TIMEOUT`, `OUTAGE`, `INVALID_NUMBER`,
`REFUSED`.

## Only authorised fields, enforced rather than intended

`PERMITTED_VEHICLE_FIELDS` in `vehicle-record-types.ts` is an allow-list of twelve fields, each of
which answers a suitability question. A provider that returns more — chassis number, engine number,
the owner's address, the registration date — has the extra dropped in the adapter, before anything
is stored. The database has no column for them either, so a future mistake in the adapter has
nowhere to put them.

A company's consent may narrow the list further; it can never widen it. The narrowing is applied
inside `normaliseVehicleRecord`, so a field the business did not agree to is never assembled into an
object in the first place.

The one field naming a person, `registeredOwnerName`, is masked at the boundary:
`"Sampoorna Traders Private Limited"` becomes `"S******** T****** P****** L******"`. That is enough
for somebody at the gate to tell whether the lorry belongs to the transporter who was booked, and
useless to anybody who steals the table.

## Consent and credentials

```ts
interface VehicleRecordConsent {
  companyId: string;
  purpose: "TRANSPORT_SUITABILITY";  // the only purpose this product has
  fields: readonly PermittedVehicleField[];
  grantedBy: string;
  grantedAt: string;
  expiresOn?: IsoDate;
  credentialReference?: string;      // a name the vault understands, never a credential
  revokedAt?: string;
}
```

* Granting and withdrawing consent need `transport.vehicle.connect`; looking a vehicle up needs
  only `transport.vehicle.check`, which the dispatch desk already has.
* Consent is dated. Past `expiresOn`, or once revoked, lookups return `CONSENT_EXPIRED` and nothing
  is sent.
* Withdrawing consent also deletes every stored reading. The movements that were decided on those
  readings keep their own copy of the evidence in `vehicle_suitability_checks`, so nothing auditable
  depends on the cache surviving.
* The credential itself lives in issue #8's vault. This module holds only its reference, and the
  reference never appears in an audit entry.

## Traceability

Every reading carries a `VehicleRecordProvenance`: the provider's name, the provider's own reference
for that answer, and the moment we asked. All three are required columns. Every lookup — including
the ones that never left the building — writes a `transport.vehicle_record.looked_up` audit entry
naming the actor, the vehicle, the outcome, the provider, their reference, whether it came from the
cache, and the purpose.

## Caching and freshness

```ts
interface VehicleRecordFreshnessPolicy {
  reuseWithinHours: number;   // default 6
  staleAfterDays: number;     // default 7
  effectiveFrom: IsoDate;
}
```

Per company, effective-dated, like every other policy in the product.

* Inside `reuseWithinHours`, a stored reading is returned and the provider is not asked. A
  registration class does not change between breakfast and lunch.
* Past `staleAfterDays`, a reading is shown as `STALE`, with its age in words, and the screen says
  the insurance and fitness dates should be confirmed.
* When the provider is unreachable and a stored reading exists, the answer is still `UNAVAILABLE`.
  The old reading is attached as `lastKnown` for the screen to show, and is deliberately **not**
  passed to issue #28 as evidence — the check has to keep the ability to say "this lorry was not
  checked today".
* The idempotency key is `vehicle-record:<company>:<vehicle>:<date>`, so a retry within the day
  reaches the provider as the same call, while tomorrow is a genuinely new question about papers
  that may have expired overnight.

## Replacing the provider

`VehicleRecordProviderPort` is the only interface that knows about a particular government service.
`apiSetuVehicleAdapter` implements it over issue #8's `ConnectorGateway` (connector kind `vehicle`),
which owns the credential lookup, the retries and the circuit breaker.

A different approved provider is a different `provider` name and a different field-name table
(`VahanPayloadFields`) passed to the same adapter — or a new implementation of the same port. The
provider-replacement test drives both providers over the same vehicles and asserts the resulting
evidence is identical field for field.

## Normalising

Everything provider-specific is a mapping table in `vehicle-record.ts`:

* `VAHAN_CLASS_DESCRIPTIONS` — the authority's own class words (`"M-CYCLE/SCOOTER"`,
  `"LIGHT GOODS VEHICLE"`, `"HGV"`, …). A description not in the table produces **no class**, never
  a guess. A record that says only `"GOODS CARRIER"` is sorted by its registered gross weight using
  the Motor Vehicles Act's own division — up to 7,500 kg light, up to 12,000 kg medium, above that
  heavy — and the basis is recorded so a person can see how the class was arrived at.
* `VAHAN_BODY_DESCRIPTIONS`, `VAHAN_PERMIT_DESCRIPTIONS` — the same idea for bodies and permits.
* `readRecordDate` — `"31-Mar-2027"`, `"31/03/2027"` and `"2027-03-31"` all appear in real answers.
  A date that cannot be read is dropped, never turned into today.
* `readWeightKg` — `"2590"`, `"2590 KG"`, `"1,250 KG"`, `2590`.

## Storage

Two tables, in `vehicle-record-migrations.ts`:

* `vehicle_record_consents` — one row per company and purpose.
* `vehicle_records` — one reading per company per vehicle, replaced when a newer one arrives. A
  cache, not a history.

## What this module does not do

* It does not scrape public portals. Everything goes through an approved provider behind the
  connector gateway.
* It does not retrieve owner PII beyond masked initials, and asks for no address, no chassis number
  and no engine number.
* It does not decide anything. Whether a load may go on a vehicle is issue #28's question; this
  module only supplies the facts and says plainly when it has none.

## Running it

```sh
npm run demo:vehicle-record
```

No credential and no network. The synthetic VAHAN sits behind the real gateway, so the demo
exercises the consent check, the field narrowing, the masking, the caching, the outage handling and
the provider replacement.
