# Contract: `master-data-ports` v1.0.0-draft

| | |
| --- | --- |
| **Owner** | GPT 3 — issue #5 [E05] business master data |
| **Written by** | GPT 1 while #5 is unbuilt, so #25 could proceed. **This is a proposal, not GPT 3's final word.** |
| **Consumed by** | GPT 1 (#25 GST calculation, #9 sales, #11 pricing, #12 inventory, #13 templates) |
| **Status** | **Mocked by GPT 1.** Mocks live in `packages/gst-calc/src/master-data-port.ts`. |

GPT 3 may change any of this. Only the three read-only shapes below are consumed, and only the
fields listed are read, so the surface GPT 3 has to match is deliberately small.

## 1. `CompanyTaxProfile`

```ts
interface CompanyTaxProfile {
  companyId: string;
  gstin: string | null;              // null when the business is not registered
  stateCode: string;                 // two-digit GST state code, e.g. "07"
  registration: 'REGULAR' | 'COMPOSITION' | 'UNREGISTERED';
}
```

`stateCode` must agree with the first two characters of `gstin` when both are present. The GST
calculator refuses to compute rather than choosing which one to believe.

## 2. `PartyTaxProfile`

```ts
interface PartyTaxProfile {
  partyId: string;
  gstin: string | null;
  stateCode: string | null;          // null is a real state: we do not know where they are
  registration: 'REGULAR' | 'COMPOSITION' | 'UNREGISTERED' | 'UNKNOWN';
}
```

`stateCode: null` is expected and handled: it produces a missing place-of-supply fact and an
exception item, never a guess.

## 3. `ItemTaxClassification`

```ts
interface ItemTaxClassification {
  itemId: string;
  name: string;                      // shown in explanations, so it must be the business's own name
  kind: 'GOODS' | 'SERVICES';
  hsnOrSac: string | null;           // HSN for goods, SAC for services
  treatment: 'TAXABLE' | 'NIL_RATED' | 'EXEMPT' | 'NON_GST' | 'UNKNOWN';
  reverseCharge: boolean;            // the recipient pays instead of the supplier
  baseUnit: string;
}
```

`treatment: 'UNKNOWN'` and `hsnOrSac: null` are both handled as missing facts. **They must never
be defaulted to `TAXABLE` at 18% by the master-data module**, because a default that looks like an
answer is the failure mode this product exists to avoid.

## 4. What GPT 1 needs from GPT 3

| # | Need | Blocking |
| --- | --- | --- |
| 1 | The three read models above, scoped by company | #25 definition of done |
| 2 | A guarantee that an unclassified item reports `UNKNOWN` rather than a default rate | #25 correctness |
| 3 | Unit conversion factors per item (`1 BOX = 10 KG`) as exact integer numerator/denominator | #12 |
| 4 | A stable `partyId` shared with the ledger's party accounts | #4, #20 |

## 5. What GPT 1 will *not* do

Create, edit or store parties, items or units. Every one of those is #5's. This module reads the
three shapes above and nothing else.
