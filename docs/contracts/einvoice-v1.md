# E-invoice applicability and the IRN lifecycle — v1

Issue #26 [E26]. Owner: GPT 3. Package: `packages/gst`.

Decide whether a bill needs a government e-invoice number at all, prepare a valid payload, and
manage the registered document safely.

## The non-goal that shapes everything

> **Do not assume every GST invoice needs an IRN.**

Registering everything looks like the safe default and is not one. An e-invoice that did not need
to exist sits on the government's record, and after twenty-four hours it cannot be withdrawn. Most
bills a small shop raises need no IRN, and telling the shopkeeper otherwise is wrong.

So applicability is a **decision** — with a reason, a rule id, an effective date and the
notification behind it — never a default. Where a fact is missing the answer is `CANNOT_DECIDE`
and the bill goes to a person, not to a guess in either direction.

## Applicability

`decideApplicability(input)` is pure: same facts, same answer, forever.

| Outcome | Meaning |
| --- | --- |
| `APPLICABLE` | An IRN must be obtained before the bill goes to the customer |
| `NOT_APPLICABLE` | No IRN needed. The ordinary case |
| `CANNOT_DECIDE` | We were not told something we need, and will not guess |

Decided in this order: bill of supply → e-invoicing not yet in force on that date → exempt
category → reportable document type → B2C → buyer GSTIN present → department mandate → turnover.

**Thresholds are effective-dated**, because the limit has moved five times. A 2022 invoice is
judged under the ₹20 crore limit and a 2026 one under ₹5 crore, and each names its notification:

| From | Threshold | Notification |
| --- | --- | --- |
| 2023-08-01 | ₹5 crore | 10/2023 - Central Tax |
| 2022-10-01 | ₹10 crore | 17/2022 - Central Tax |
| 2022-04-01 | ₹20 crore | 1/2022 - Central Tax |
| 2021-04-01 | ₹50 crore | 5/2021 - Central Tax |
| 2020-10-01 | ₹500 crore | 61/2020 - Central Tax |

A **B2C sale never carries an IRN**, however large. Large B2C bills need a dynamic QR code, which
is a different obligation and is not this module's.

## The IRN, and why the reply can be verified

The IRN is not an opaque token the portal invents. It is a hash over four fields we already know:

```
IRN = SHA-256( supplier GSTIN + financial year + document type + document number )
```

So we compute what it **must** be and compare it with what came back. A reply belonging to another
document — a mixed-up response, a bug in an adapter, a stale cached reply — is caught before it is
written into the books as this invoice's IRN. `preview` shows the expected IRN before anything is
sent, and a test asserts the prediction equals the reply.

The financial year is April–March, so 15 February 2026 is `2025-26`. Getting that wrong produces a
valid-looking IRN for the wrong year, which is exactly what the hash check exists to catch.

**Assumption, recorded because it matters:** the concatenation follows the published NIC formula
with no separators. If a production IRP is found to differ, `verifyIrnHash: false` in the policy
turns off the hash comparison while leaving the structural checks — which never depend on the
formula — in force.

Structural checks always run: 64 lowercase hex, acknowledgement number present, acknowledgement
date readable (the portal writes `DD/MM/YYYY HH:mm:ss`, parsed explicitly rather than hopefully),
and a signed QR code present. **Without the signed QR the buyer's copy is not a valid e-invoice**,
so a reply without one is not a registration we record.

## States are never confused

| Status | Meaning |
| --- | --- |
| `NOT_APPLICABLE` | This bill needs no IRN |
| `PENDING` | Sent, no answer yet. **Never reads as registered** |
| `REGISTERED` | The government's verified reply is stored |
| `CANCELLED` | Withdrawn with the government |
| `FAILED` | The attempt did not succeed, and we say so |

A timeout leaves the record saying we do not know, because we do not. The message is explicit that
the bill is still a valid GST bill safe in the books — only the government's number is missing.
The database enforces it too: `status <> 'REGISTERED' OR (irn IS NOT NULL AND ack_number IS NOT
NULL AND signed_qr_code IS NOT NULL)`.

## Idempotency

Three layers, so pressing the button twice cannot produce two IRNs:

1. One live e-invoice per sales document (`e_invoices_one_per_document_idx`), and a registered or
   cancelled record short-circuits before any call.
2. The idempotency key is derived from the **document**, not the attempt, so a retry reaches the
   provider as the same call.
3. The government's duplicate reply (error `2150`) is treated as **success**, and its IRN is kept.
   A retry after a lost reply ends holding the right IRN.

`reconcile()` answers "did it actually go through?" by asking the portal, for the case where our
record and the government's have drifted apart.

## Cancellation and deadlines

The window is the government's, not ours: 24 hours from acknowledgement. It is checked before
calling so a person gets a sentence rather than error 4002 — and past it, the message says to
raise a **credit note** instead, which is the real remedy. The portal remains the authority; its
refusal is honoured if the two ever disagree.

A reason is required and kept. The four codes the government accepts are `DUPLICATE`,
`DATA_ENTRY_MISTAKE`, `ORDER_CANCELLED`, `OTHER`.

`awaitingReport()` lists applicable documents not yet reported, so a 30-day reporting deadline is
never missed silently.

## Offline export

`toOfflineJson()` produces the bulk-upload shape for the day the portal is down and a business
still has to invoice. The file **says inside itself** that it is not an e-invoice until the
government returns an IRN — a JSON file on a desktop that looked like a registered invoice would
be precisely the confusion the first acceptance criterion forbids.

## Permissions

| Permission | Guards |
| --- | --- |
| `einvoice.view` | Seeing status, previewing, reconciling, offline export |
| `einvoice.generate` | Sending a document to the government |
| `einvoice.cancel` | Withdrawing a government record |

Reporting is deliberately separate from issuing a bill: #9's `sales.finalise` does not carry it.
This is also what keeps the non-goal "allow AI to submit without required approval" enforceable —
nothing can register a document without an actor holding `einvoice.generate`.

## Storage

Migration `20260829T214047787Z_gst_beb95a52fde7_einvoice_irn_lifecycle`: `e_invoices`,
`e_invoice_policies`, `e_invoice_supplier_facts`. The sales invoice belongs to #9 and is not
created here; only its id is stored.

## Provider

The IRP sits behind `connector-v1` (#8), connector kind `irp`. Development runs against
`SyntheticIrp`, which implements the behaviours that matter: the duplicate error on a repeat
submission, the 24-hour cancellation refusal, and **real IRN hashes**, so the verification is
genuinely exercised rather than rubber-stamped. No production credential is needed to run or test
anything.

## Known limitations

1. **Amendment is not supported, because e-invoices cannot be amended.** The remedy is cancel
   within 24 hours and re-issue, or raise a credit note. The error message says so.
2. **No e-way bill is generated alongside.** The field is read from the reply and stored if the
   provider sends one; the lifecycle belongs to #27.
3. **Turnover is stated, not derived.** Aggregate annual turnover across all GSTINs of a PAN is
   not something this product can compute yet, so it is a fact the business supplies. A blank one
   gives `CANNOT_DECIDE` rather than a guess.
4. **`ExemptCategory` is declared, not inferred.** Guessing that a taxpayer is a bank from its
   name is exactly the invention rule 4 forbids.
5. **Dynamic QR for large B2C invoices is out of scope.** Different obligation, not an IRN.
6. **The supplier and buyer addresses on the web surface are placeholders**, because #5's full
   address records are not yet wired into the demo company. The payload builder validates them
   properly; the demo simply supplies thin ones.

## Try it

```sh
npm run demo:einvoice   # applicability, preview, send, retry, outage, cancel — no database
npm run web             # sign in, then the "E-invoice" screen
```
