// Issue #17 [E17] — what a posted purchase is made of.
//
// #15 receives a document, #16 decides whether it is safe. This module is the first one in the
// purchase lane allowed to touch money: it turns an approved bill into a ledger voucher, stock
// receipts and an amount owed to the supplier, or into none of those.
//
// Money is `bigint` paise throughout the purchase lane and becomes `Money` at the ledger
// boundary. Quantities are the `Quantity` micro-units from #5, because stock is the one thing
// that must never be converted approximately.

import type { Id, IsoDate, Paise } from "../../masters/src/types.ts";
import type { Quantity } from "../../masters/src/units.ts";
import type { PurchaseVerdict } from "./validation-types.ts";

/**
 * Whether the GST on a line can be taken as input credit.
 *
 * `INELIGIBLE` is not an error: section 17(5) blocks credit on some purchases, and the tax then
 * becomes part of what the goods cost. The caller states it; this module never rules on it.
 */
export type ItcEligibility = "ELIGIBLE" | "INELIGIBLE" | "CAPITAL_GOODS";

/** Who pays the GST over to the government. */
export type TaxLiability = "SUPPLIER" | "REVERSE_CHARGE";

export interface ApprovedPurchaseLine {
  readonly lineNumber: number;
  readonly itemId: Id;
  readonly description: string;
  readonly hsnSac: string;
  /** As written on the supplier's bill. Converted to the item's base unit when stock moves. */
  readonly quantity: Quantity;
  /** Price of one `quantity.unitCode`, before tax. */
  readonly ratePaise: Paise;
  /** What the bill says this line's taxable value is, after any trade discount. */
  readonly taxableValuePaise: Paise;
  readonly gstRateBasisPoints: number;
  readonly cessRateBasisPoints?: number;
  readonly itcEligibility: ItcEligibility;
  /** `GOODS` lines receive stock; `SERVICES` lines are an expense and receive none. */
  readonly supplyKind: "GOODS" | "SERVICES";
  /** Where the goods landed. Required for a goods line; never set on a service line. */
  readonly warehouseId?: Id;
  readonly batchId?: Id;
  readonly serialNumbers?: readonly string[];
  /**
   * Set when a confirmed goods receipt (#18) already put these goods on the shelf.
   *
   * The bill then records the money and nothing else. Receiving stock again here would count the
   * same delivery twice, and it would count it at the invoiced quantity rather than the quantity
   * the godown actually accepted — which is exactly the figure #18 exists to keep apart.
   */
  readonly receivedAgainstReceiptId?: Id;
}

/**
 * A bill that a human has reviewed and approved, carrying the verdict #16 gave it.
 *
 * The verdict is not decoration: this module refuses to post anything that #16 did not mark
 * `POSTABLE`, and refuses to post at all when the tax split was never decided by the rules
 * engine. A purchase is never posted on a reading alone.
 */
export interface ApprovedPurchase {
  readonly id: Id;
  readonly companyId: Id;
  /** The inbox document this came from, so any figure traces back to real paper. */
  readonly sourceDocumentId: Id;
  readonly verdict: PurchaseVerdict;
  readonly supplierPartyId: Id;
  readonly supplierName: string;
  readonly supplierGstin?: string;
  readonly invoiceNumber: string;
  readonly invoiceDate: IsoDate;
  readonly lines: readonly ApprovedPurchaseLine[];
  /** The total printed on the bill. The posting must reach exactly this figure. */
  readonly invoiceTotalPaise: Paise;
  readonly taxLiability: TaxLiability;
  /** Payment terms in days, from the supplier master. Absent means due immediately. */
  readonly creditDays?: number;
  readonly approvedBy: Id;
  readonly approvedAt: string;
}

/** The GST split, kept apart because the return (#26) and ITC matching (#31) read it directly. */
export interface PurchaseTaxSummary {
  readonly taxableValuePaise: Paise;
  readonly cgstPaise: Paise;
  readonly sgstPaise: Paise;
  readonly igstPaise: Paise;
  readonly cessPaise: Paise;
  /** Tax charged that cannot be claimed, and so was added to the cost of the goods. */
  readonly ineligibleItcPaise: Paise;
  readonly intraState: boolean;
  readonly reverseCharge: boolean;
  /** Which rule decided the split, copied from the verdict so the decision stays explainable. */
  readonly ruleSetVersion?: string;
  readonly ruleId?: string;
}

/** One stock receipt a bill produced, kept so a reversal can put exactly it back. */
export interface PurchaseBillReceipt {
  readonly lineNumber: number;
  readonly itemId: Id;
  readonly warehouseId: Id;
  readonly batchId?: Id;
  readonly serialNumbers?: readonly string[];
  readonly quantity: Quantity;
  readonly valuePaise: Paise;
  readonly stockMovementId: string;
}

export type PurchaseBillState = "POSTED" | "REVERSED";

/**
 * The purchase bill as it is kept once posted. Immutable: a correction is a reversal, never an
 * edit, so this record is only ever rewritten to mark it `REVERSED`.
 */
export interface PurchaseBill {
  readonly id: Id;
  readonly companyId: Id;
  readonly purchaseId: Id;
  readonly sourceDocumentId: Id;
  readonly supplierPartyId: Id;
  readonly supplierName: string;
  readonly invoiceNumber: string;
  readonly invoiceDate: IsoDate;
  readonly dueDate: IsoDate;
  readonly totalPaise: Paise;
  readonly tax: PurchaseTaxSummary;
  readonly state: PurchaseBillState;
  readonly voucherId: string;
  readonly receipts: readonly PurchaseBillReceipt[];
  /** Deliveries whose goods this bill pays for, and which already moved the stock themselves. */
  readonly receivedByReceiptIds?: readonly Id[];
  readonly postedBy: Id;
  readonly postedAt: string;
  readonly idempotencyKey: string;
  /** Set once a reversal has undone this bill. */
  readonly reversedByVoucherId?: string;
  readonly reversalReason?: string;
  /** One sentence the shopkeeper reads. Never mentions debits or credits. */
  readonly summary: string;
}

export interface PurchasePostingResult {
  readonly bill: PurchaseBill;
  /** True when this call matched an earlier one and nothing new was written. */
  readonly deduplicated: boolean;
}

/** What `preview` returns: the same figures `post` would write, with nothing written. */
export interface PurchasePostingPreview {
  readonly tax: PurchaseTaxSummary;
  readonly dueDate: IsoDate;
  readonly totalPaise: Paise;
  readonly roundOffPaise: Paise;
  /** Stock that would be received, in the unit it was bought in. */
  readonly receipts: readonly {
    readonly itemId: Id;
    readonly warehouseId: Id;
    readonly batchId?: Id;
    readonly quantity: Quantity;
    readonly valuePaise: Paise;
  }[];
  readonly summary: string;
  /** Things a person should see before approving, in plain words. */
  readonly warnings: readonly string[];
}
