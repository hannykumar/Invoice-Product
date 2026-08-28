<!-- GENERATED FILE — do not edit by hand.
     Source: docs/product/spec/states.json
     Regenerate: node --experimental-strip-types tools/spec-docs/generate.ts -->

# Transaction states

Issue [#1](./README.md) fixes the states a record can be in. A module must not invent a state that is not listed here; propose it in `docs/product/spec/states.json` first.

State specification version **1.0.0**.

## What the user sees

Every internal state maps to one of six groups so screens stay understandable without accounting training.

| Group | Shown to the user as |
| --- | --- |
| `draft` | Not finished yet. Nothing has been sent, posted or counted. |
| `processing` | The app is working on it right now. |
| `submitted` | Waiting for a person or an outside service to respond. |
| `accepted` | Done and recorded in your books. |
| `failed` | It did not go through. Nothing was recorded. |
| `needs_attention` | The app stopped because it was not sure. A person must decide. |

## voucher

Owned by **GPT1** under issue **#4**.

| State | Group | Plain wording | Final? |
| --- | --- | --- | --- |
| `DRAFT` | draft | Not in your books yet | no |
| `FINAL` | accepted | Recorded in your books | no |
| `REVERSED` | accepted | Cancelled by an opposite entry | yes |

| From | Event | To | Must be true first |
| --- | --- | --- | --- |
| `DRAFT` | `post` | `FINAL` | `balanced`, `period_open`, `permission:ledger.post`, `accounts_active` |
| `DRAFT` | `amendDraft` | `DRAFT` | `permission:ledger.draft.write` |
| `FINAL` | `reverse` | `REVERSED` | `permission:ledger.reverse`, `reversal_period_open`, `reason_required` |

> A DRAFT voucher may be deleted. A FINAL voucher may never be deleted or edited.
> REVERSED is reached only by posting a mirrored REVERSAL voucher; both remain visible.

## sales_invoice

Owned by **GPT1** under issue **#9**.

| State | Group | Plain wording | Final? |
| --- | --- | --- | --- |
| `DRAFT` | draft | Bill not finished | no |
| `PENDING_APPROVAL` | submitted | Waiting for approval | no |
| `NEEDS_INFO` | needs_attention | Some details are missing | no |
| `FINAL` | accepted | Bill issued | no |
| `CANCELLED` | accepted | Bill cancelled | yes |

| From | Event | To | Must be true first |
| --- | --- | --- | --- |
| `DRAFT` | `submit` | `PENDING_APPROVAL` | `stock_reserved_or_override`, `tax_decided`, `party_resolved` |
| `DRAFT` | `missingFact` | `NEEDS_INFO` | — |
| `NEEDS_INFO` | `factSupplied` | `DRAFT` | — |
| `PENDING_APPROVAL` | `reject` | `DRAFT` | `reason_required` |
| `PENDING_APPROVAL` | `approveAndFinalise` | `FINAL` | `permission:sales.finalise`, `number_allocated`, `voucher_posted`, `stock_posted` |
| `DRAFT` | `finalise` | `FINAL` | `approval_not_required`, `permission:sales.finalise`, `number_allocated`, `voucher_posted`, `stock_posted` |
| `FINAL` | `cancel` | `CANCELLED` | `permission:sales.cancel`, `cancellation_policy_allows`, `no_irn_or_irn_cancelled`, `reason_required`, `reversal_posted`, `stock_reversed` |

> An invoice number is allocated only at FINAL, so drafts never consume numbers.
> After the cancellation window closes, correction is by credit note, not cancellation.

## payment

Owned by **GPT1** under issue **#20**.

| State | Group | Plain wording | Final? |
| --- | --- | --- | --- |
| `DRAFT` | draft | Payment not saved yet | no |
| `RECORDED` | accepted | Payment recorded | no |
| `REVERSED` | accepted | Payment cancelled | yes |

| From | Event | To | Must be true first |
| --- | --- | --- | --- |
| `DRAFT` | `record` | `RECORDED` | `permission:payments.record`, `allocation_within_outstanding`, `period_open` |
| `RECORDED` | `reverse` | `REVERSED` | `permission:payments.reverse`, `reason_required`, `allocations_released` |

## cheque

Owned by **GPT1** under issue **#20**.

| State | Group | Plain wording | Final? |
| --- | --- | --- | --- |
| `PENDING` | submitted | Cheque received, not yet cleared | no |
| `DEPOSITED` | submitted | Cheque given to the bank | no |
| `CLEARED` | accepted | Money in your bank | yes |
| `BOUNCED` | failed | Cheque did not clear | yes |
| `CANCELLED` | failed | Cheque cancelled | yes |

| From | Event | To | Must be true first |
| --- | --- | --- | --- |
| `PENDING` | `deposit` | `DEPOSITED` | — |
| `DEPOSITED` | `clear` | `CLEARED` | `clearing_date_required` |
| `DEPOSITED` | `bounce` | `BOUNCED` | `reason_required`, `reversal_posted` |
| `PENDING` | `cancel` | `CANCELLED` | `reason_required` |

> A bounce never deletes history; it posts a reversal and restores the outstanding balance.

## stock_reservation

Owned by **GPT1** under issue **#12**.

| State | Group | Plain wording | Final? |
| --- | --- | --- | --- |
| `HELD` | submitted | Stock held for this bill | no |
| `CONSUMED` | accepted | Stock issued | yes |
| `RELEASED` | accepted | Stock free again | yes |
| `EXPIRED` | failed | Hold expired, stock free again | yes |

| From | Event | To | Must be true first |
| --- | --- | --- | --- |
| `HELD` | `postMovement` | `CONSUMED` | — |
| `HELD` | `cancelDraft` | `RELEASED` | — |
| `HELD` | `timeout` | `EXPIRED` | — |

## exception_item

Owned by **GPT1** under issue **#7**.

| State | Group | Plain wording | Final? |
| --- | --- | --- | --- |
| `OPEN` | needs_attention | Waiting for you to decide | no |
| `IN_REVIEW` | needs_attention | Someone is looking at it | no |
| `RESOLVED` | accepted | Sorted out | yes |
| `DISMISSED` | accepted | Closed without action | yes |

| From | Event | To | Must be true first |
| --- | --- | --- | --- |
| `OPEN` | `claim` | `IN_REVIEW` | — |
| `IN_REVIEW` | `resolve` | `RESOLVED` | `resolution_recorded` |
| `IN_REVIEW` | `dismiss` | `DISMISSED` | `reason_required`, `permission:exceptions.dismiss` |
| `IN_REVIEW` | `release` | `OPEN` | — |

> Exception items are never resolved automatically by an AI component.

## approval_request

Owned by **GPT2** under issue **#6**. Consumed by GPT1.

| State | Group | Plain wording | Final? |
| --- | --- | --- | --- |
| `PENDING` | submitted | Waiting for approval | no |
| `APPROVED` | accepted | Approved | yes |
| `REJECTED` | failed | Not approved | yes |
| `WITHDRAWN` | failed | Request taken back | yes |

| From | Event | To | Must be true first |
| --- | --- | --- | --- |
| `PENDING` | `approve` | `APPROVED` | `approver_permission`, `approver_not_requester` |
| `PENDING` | `reject` | `REJECTED` | `reason_required` |
| `PENDING` | `withdraw` | `WITHDRAWN` | — |

## fiscal_period

Owned by **GPT1** under issue **#4**.

| State | Group | Plain wording | Final? |
| --- | --- | --- | --- |
| `OPEN` | accepted | You can still make entries | no |
| `SOFT_LOCKED` | accepted | Closed, but a manager can still allow an entry | no |
| `HARD_LOCKED` | accepted | Closed for good | yes |

| From | Event | To | Must be true first |
| --- | --- | --- | --- |
| `OPEN` | `softLock` | `SOFT_LOCKED` | `permission:periods.lock` |
| `SOFT_LOCKED` | `reopen` | `OPEN` | `permission:periods.reopen`, `reason_required` |
| `SOFT_LOCKED` | `hardLock` | `HARD_LOCKED` | `permission:periods.hard_lock`, `reason_required` |

> HARD_LOCKED is deliberately irreversible so filed periods cannot move.
