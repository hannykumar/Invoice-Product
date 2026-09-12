# Contract: `sales` v1.1.0

| | |
| --- | --- |
| **Owner** | GPT 1, issue #9 [E09] |
| **Consumed by** | GPT 1 (#10 voice, #11 pricing and credit, #12 inventory, #13 templates, #20 receivables, #35 reports), GPT 2 (#14 delivery), GPT 3 (#26 e-invoice, #27 e-way bill, #45 returns) |
| **Package** | `@invoice/sales` |
| **Depends on** | [`ledger`](./ledger.v1.md) (#4), [`gst-calc`](./gst-calc.v1.md) (#25), [`rules-engine`](./rules-engine.v1.md) (#7), [`master-data-ports`](./master-data-ports.v1.md) (#5, **mocked**) |
| **Status** | Published |

## Purpose

The whole life of a sales invoice: start it, price it, hold the stock, take an approval when the
business asks for one, issue it, and cancel it if that is still allowed.

## States

`DRAFT` → `PENDING_APPROVAL` → `FINAL` → `CANCELLED`, plus `NEEDS_INFO` for anything the product
will not guess. These are the states in `docs/product/spec/states.json`, machine `sales_invoice`,
and no other state exists.

## Four properties a consumer may rely on

1. **A draft never consumes a number.** Numbers are allocated at finalisation only, so three
   started bills and one finished bill leave no gaps in a legally significant series.
2. **Finalisation is one unit of work.** The number, the ledger entry and the invoice are written
   inside the same transaction — `LedgerService.postVoucherIn` exists for exactly this. A failure
   leaves no numbered bill without an entry, and burns no number.
3. **Totals are reproducible.** Finalisation recomputes the tax and refuses if the total has moved
   since the person looked at it, rather than issuing a bill they never saw.
4. **A final bill is never edited.** Cancellation posts a reversal and keeps both documents. Once
   the configured window closes, the correction is a credit note.

## Commands

| Command | Permission | Idempotent | Effect |
| --- | --- | --- | --- |
| `createDraft(actor, { idempotencyKey, input })` | `sales.draft.write` | Yes | Starts and prices a bill |
| `updateDraft(actor, id, patch, expectedVersion)` | `sales.draft.write` | Optimistic version | Changes and re-prices an unfinished bill |
| `price(actor, id)` | — | Pure | Re-runs the tax calculation |
| `submitForApproval(actor, id)` | `sales.draft.write` | — | Holds the stock, moves to `PENDING_APPROVAL` |
| `finalise(actor, { idempotencyKey, invoiceId })` | `sales.finalise` (+ `sales.approve` from `PENDING_APPROVAL`) | Yes | Allocates the number, posts the entry, issues the stock |
| `cancel(actor, { idempotencyKey, invoiceId, reason, today })` | `sales.cancel` | Yes | Posts a reversal and returns the goods |

`finalise` on an already-final bill returns it with `deduplicated: true`. That is success, not an
error.

## Policy — configuration, not code

```ts
interface SalesPolicy {
  series: { prefix, branchCode, padding };       // INV/26-27/00042
  approvalRequiredAtOrAbove: Money | null;
  cancellationWindowDays: number;
  allowCancelAfterGovernmentRegistration: boolean;
  defaultDueDays: number;
  roundToWholeRupee: boolean;
}
```

The person who sends a bill for approval can never be the one who approves it.

## Numbering

`{prefix}/{branchCode}/{shortFinancialYear}/{sequence}` — unique per company, branch and financial
year, allocated inside the finalisation transaction. Fifty concurrent finalisations produce fifty
different numbers with no gaps, and that is a test. `branchCode` may be empty, and is then left out
of the number altogether; the default series is `INV/26-27/00001`.

**Sixteen characters, never more (v1.1.0, issue #162).** CGST Rule 46(b) asks for "a consecutive
serial number not exceeding sixteen characters", and the e-invoice portal refuses a document number
longer than that. So:

- The financial year is written short — `26-27`, not `2026-27`. The long form spent seven of the
  sixteen characters on the year alone, which is what made the old numbers twenty to twenty-two
  characters long.
- `validateSeries(series)` runs in the `SalesService` constructor and refuses a series whose widest
  possible number would pass sixteen. A series is therefore rejected on the day it is configured,
  not on the day the sequence grows a digit and overflows.
- `formatNumber` refuses the same way, so nothing can get past it at issue time either.
- `INVOICE_NUMBER_MAX_LENGTH` is exported for consumers that display or re-check the number.

A branch code costs four characters (the code itself plus a separator, plus the year and its
separators), so a series that wants one needs a shorter prefix or less padding —
`INV/KB/26-27/001` fits, `INV/KB/26-27/0001` does not.

**`invoice.financialYear` is computed from `documentDate`, not parsed out of the number**, and is
still the long form (`2026-27`). `parseNumber` returns the year as printed (`26-27`) and accepts
numbers with or without a branch code.

### Migration from v1.0.0

Numbers already issued under the old format stay as they are; nothing rewrites history. Any consumer
that pattern-matched `INV/{branch}/{4-digit year}/...`, or that read the financial year out of the
third segment of the number, must be updated — `financialYear` on the invoice is the field to read.

## Ports it consumes

| Port | Owner | State |
| --- | --- | --- |
| `InventoryPort` (`reserve`, `release`, `issue`, `returnToStock`) | #12 | Mocked; `permissiveInventory` ships for lanes without stock |
| `ComplianceHookPort` (`onInvoiceFinalised`, `onInvoiceCancelled`) | #26, #27 | Mocked; `noComplianceHooks` ships |
| `PermissionPort`, `AuditPort` | GPT 2 #3, #6 | Mocked, per `platform-ports.v1.md` |
| Master data | GPT 3 #5 | Mocked, per `master-data-ports.v1.md` |

**The government step runs after the books are already safe.** A failed e-invoice registration
never unmakes a bill; it comes back as a retryable status, worded by `gov.service_unavailable`.

## Errors

| Code | Meaning |
| --- | --- |
| `SALES_NEEDS_INFO` | Something must be answered before the bill can be issued |
| `SALES_APPROVAL_REQUIRED` | Above the business's limit; send it for approval first |
| `SALES_SELF_APPROVAL` | The maker of a bill cannot approve it |
| `SALES_PRICING_CHANGED` | The total moved while the bill was open |
| `SALES_NOT_EDITABLE` | The bill has been issued (`messageId: final.cannot_edit`) |
| `SALES_CANCEL_WINDOW_CLOSED` | Too late to cancel; make a return note |
| `SALES_CONCURRENT_EDIT` | Someone else changed this draft first |
| `SALES_ACCOUNT_MISSING`, `SALES_CUSTOMER_ACCOUNT_MISSING` | The chart of accounts is not set up for this |
| `SALES_REASON_REQUIRED` | Cancelling needs a written reason |
| `SALES_NUMBER_TOO_LONG` | The series would print a number past the sixteen characters GST allows |
| `SALES_PREFIX_REQUIRED` | An invoice series needs a prefix, such as `INV` |
| `SALES_SERIES_CHARACTERS` | A number may contain only letters, digits, `-` and `/` |
| `SALES_SERIES_PADDING` | An invoice series needs at least one digit of sequence |

## Known limitations

- Services place of supply follows the general rule only (IGST Act section 12(2), approved under
  #54). The specific services in sections 12(3) to 12(14) — immovable property, transport, events,
  telecom and the rest — are refused, and a services bill for a customer with no recorded state
  asks a person rather than guessing.
- Recurring invoices, part-delivery and proforma conversion are out of scope for this issue.
- The posting template covers domestic sales only; exports and SEZ are refused upstream in #25.
