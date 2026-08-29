// Issue #18 [E18] — what was ordered, what actually arrived, and what the supplier charged for.
//
// Three documents describe one delivery and they routinely disagree. The order says 100 boxes,
// the godown counted 90, the bill charges for 100. This module's whole job is to hold those
// three side by side, say exactly which field disagrees and by how much, and refuse to let the
// difference through quietly.
//
// Nothing here posts to the books. The order is a promise, not a transaction; the receipt moves
// goods and nothing else; the bill is #17's to post. Money stays `bigint` paise and quantities
// stay the `Quantity` micro-units from #5, because a stock figure that has been through a float
// is a stock figure nobody can defend.

import type { Quantity } from "@invoice/kernel";
import type { Id, IsoDate, Paise } from "../../masters/src/types.ts";

// ---------------------------------------------------------------- purchase order

/**
 * Where an order has got to.
 *
 * `PLACED` means the supplier has been told. Everything after that is driven by what arrives:
 * the order walks itself to `PARTIALLY_RECEIVED` and then `RECEIVED` as goods are confirmed. A
 * buyer closes an order that will never be completed — the supplier stopped short, the rest is
 * no longer wanted — and that is `CLOSED`, which is different from `CANCELLED`, where nothing
 * was ever received.
 */
export type PurchaseOrderState =
  | "DRAFT"
  | "PLACED"
  | "PARTIALLY_RECEIVED"
  | "RECEIVED"
  | "CLOSED"
  | "CANCELLED";

export interface PurchaseOrderLine {
  readonly lineNumber: number;
  readonly itemId: Id;
  readonly description: string;
  readonly hsnSac: string;
  /** How much was ordered, in the unit it was ordered in. */
  readonly quantity: Quantity;
  /** Agreed price of one `quantity.unit`, before tax. This is what a bill is priced against. */
  readonly ratePaise: Paise;
  readonly gstRateBasisPoints: number;
  readonly cessRateBasisPoints?: number;
  readonly supplyKind: "GOODS" | "SERVICES";
  /** Where the goods are expected. Required for goods, so a receipt has somewhere to land. */
  readonly warehouseId?: Id;
}

/**
 * An order placed on a supplier.
 *
 * It carries no verdict and no voucher because it is not a financial document: agreeing to buy
 * something changes neither the books nor the godown. It exists so that later, when the goods
 * and the bill turn up, there is something to check them against.
 */
export interface PurchaseOrder {
  readonly id: Id;
  readonly companyId: Id;
  /** What the buyer and the supplier both call this order, e.g. "PO/2026/0117". */
  readonly orderNumber: string;
  readonly supplierPartyId: Id;
  readonly supplierName: string;
  readonly orderDate: IsoDate;
  /** When the goods were promised. Used only to explain a late delivery, never to block one. */
  readonly expectedDate?: IsoDate;
  readonly lines: readonly PurchaseOrderLine[];
  readonly state: PurchaseOrderState;
  /** Sum of quantity × rate over the lines, before tax. What the order commits the buyer to. */
  readonly orderedValuePaise: Paise;
  readonly placedBy?: Id;
  readonly placedAt?: string;
  readonly closedReason?: string;
  readonly cancelledReason?: string;
  readonly createdBy: Id;
  readonly createdAt: string;
  /** One sentence the buyer reads. Never mentions debits or credits. */
  readonly summary: string;
}

// ------------------------------------------------------------------ goods receipt

/**
 * Why some of a delivery was turned away.
 *
 * Recorded per line rather than per delivery, because a lorry usually brings several things and
 * only one of them is wet.
 */
export type RejectionReason =
  | "DAMAGED"
  | "WRONG_ITEM"
  | "SHORT_SUPPLY"
  | "EXPIRED"
  | "QUALITY_BELOW_AGREED"
  | "OTHER";

/**
 * What the person at the gate saw, kept so a rejection can be defended weeks later when the
 * supplier disputes it. `photoIds` point at files the platform stores; nothing here is a secret.
 */
export interface QualityEvidence {
  readonly checkedBy: Id;
  readonly checkedAt: string;
  /** In the receiver's own words, e.g. "10 boxes were soaked, gunny sacks torn". */
  readonly note?: string;
  readonly photoIds?: readonly string[];
  /** Weighbridge slip, lorry receipt, inspection report — whatever was on paper. */
  readonly documentIds?: readonly string[];
}

export interface GoodsReceiptLine {
  readonly lineNumber: number;
  /** The order line this answers. Absent on a receipt taken without an order. */
  readonly orderLineNumber?: number;
  readonly itemId: Id;
  readonly description: string;
  readonly warehouseId: Id;
  readonly batchId?: Id;
  readonly serialNumbers?: readonly string[];
  /** What the lorry brought, before anyone inspected it. */
  readonly receivedQuantity: Quantity;
  /** What was kept. This, and only this, is what increases stock. */
  readonly acceptedQuantity: Quantity;
  /** Required whenever anything was turned away, so a rejection is never unexplained. */
  readonly rejectionReason?: RejectionReason;
  readonly rejectionNote?: string;
  /**
   * Price of one unit used to value the accepted goods. Taken from the order when there is one.
   * Without an order the receiver states it: stock is never taken in at a price nobody named,
   * because an unvalued receipt quietly wrecks the average cost of everything on that shelf.
   */
  readonly ratePaise: Paise;
  readonly evidence?: QualityEvidence;
}

export type GoodsReceiptState = "DRAFT" | "CONFIRMED" | "CANCELLED";

/**
 * One delivery, as the godown recorded it.
 *
 * `CONFIRMED` is the moment stock moves. Before that a receipt is a note; after it, the accepted
 * quantities are on the shelf and the only way back is to cancel the receipt, which takes them
 * out again with a reason attached.
 */
export interface GoodsReceipt {
  readonly id: Id;
  readonly companyId: Id;
  /** What the godown calls this receipt, e.g. "GRN/2026/0304". */
  readonly receiptNumber: string;
  /** Absent on the small-business path, where goods are confirmed without an order. */
  readonly orderId?: Id;
  readonly supplierPartyId: Id;
  readonly supplierName: string;
  readonly receiptDate: IsoDate;
  /** Lorry number, e-way bill, delivery challan — how the goods actually arrived. */
  readonly deliveryNote?: string;
  readonly vehicleNumber?: string;
  readonly lines: readonly GoodsReceiptLine[];
  readonly state: GoodsReceiptState;
  /** Set once confirmed: the stock movements this receipt made, so a cancellation undoes them. */
  readonly movements: readonly GoodsReceiptMovement[];
  readonly confirmedBy?: Id;
  readonly confirmedAt?: string;
  readonly cancelledReason?: string;
  readonly createdBy: Id;
  readonly createdAt: string;
  readonly summary: string;
}

/** One accepted line as it landed in the godown, kept so a cancellation puts back exactly it. */
export interface GoodsReceiptMovement {
  readonly lineNumber: number;
  readonly itemId: Id;
  readonly warehouseId: Id;
  readonly batchId?: Id;
  readonly serialNumbers?: readonly string[];
  readonly quantity: Quantity;
  readonly valuePaise: Paise;
  readonly stockMovementId: string;
}

// ---------------------------------------------------------------------- matching

/**
 * How far the three documents may disagree before a person has to look.
 *
 * Per company and effective-dated, and recorded on every match, so a decision taken last year
 * can be explained under the tolerance that was in force then rather than today's. Widening it
 * is permission-gated, exactly like #16's money tolerances.
 */
export interface MatchTolerancePolicy {
  /** Proportional slack on quantity. 100 = 1%. Covers ordinary weighing and counting error. */
  readonly quantityBasisPoints: number;
  /** Flat slack on quantity in micro-units, for small orders where a percentage is meaningless. */
  readonly quantityAbsoluteMicro: bigint;
  /** Proportional slack on the price of one unit. 100 = 1%. */
  readonly priceBasisPoints: number;
  readonly priceAbsolutePaise: Paise;
  /** Slack on the tax charged for a line, in paise. Absorbs ordinary GST rounding. */
  readonly taxAbsolutePaise: Paise;
  /**
   * Whether a supplier may send more than was ordered and have it accepted quietly.
   * Off by default: extra goods are extra money, and the buyer decides.
   */
  readonly allowOverDelivery: boolean;
  readonly effectiveFrom: IsoDate;
}

export const DEFAULT_MATCH_TOLERANCE: MatchTolerancePolicy = Object.freeze({
  // A percent either way on quantity, because sand, steel and grain are weighed, not counted.
  quantityBasisPoints: 100,
  quantityAbsoluteMicro: 0n,
  // Half a percent on price. Anything wider is a renegotiation, not a rounding.
  priceBasisPoints: 50,
  priceAbsolutePaise: 100n,
  taxAbsolutePaise: 100n,
  allowOverDelivery: false,
  effectiveFrom: "2026-04-01",
});

/**
 * The specific ways an order, a delivery and a bill can fall out of step.
 *
 * Deliberately narrow and named after what a buyer would say happened, not after the field that
 * failed a comparison, because these codes end up in the message a shopkeeper reads.
 */
export type MatchFindingCode =
  /** The supplier billed for more than the godown accepted. The classic overcharge. */
  | "INVOICED_ABOVE_ACCEPTED"
  /** Billed for less than arrived — often the second half is still to come. */
  | "INVOICED_BELOW_ACCEPTED"
  /** More arrived than was ordered. */
  | "OVER_DELIVERED"
  /** Less arrived than was ordered, and the order is not yet complete. */
  | "UNDER_DELIVERED"
  /** Some of the delivery was turned away. Never enters stock, and should not be billed. */
  | "REJECTED_ON_ARRIVAL"
  | "PRICE_ABOVE_ORDER"
  | "PRICE_BELOW_ORDER"
  | "TAX_RATE_DIFFERS"
  /** The bill charges for something the order never mentioned. */
  | "ITEM_NOT_ORDERED"
  /** The bill charges for something no delivery ever brought. */
  | "ITEM_NOT_RECEIVED"
  /** Received but not on this bill. Normal when a supplier splits the billing. */
  | "ITEM_NOT_INVOICED"
  /** No order exists. Stated, not held against anyone: most small purchases have none. */
  | "NO_ORDER"
  /** No goods receipt exists, so nothing confirms the bill against what arrived. */
  | "NO_RECEIPT"
  /** The same goods are written in different units on different documents. Never guessed at. */
  | "UNITS_DIFFER";

/**
 * How seriously a difference is taken.
 *
 * `HOLD` stops the bill until a person decides — it is the honest answer to "you were charged
 * for ten boxes you never got". `REVIEW` needs eyes but does not stop the work. `INFORMATION` is
 * shown so nobody is surprised later, and costs nothing.
 */
export type MatchSeverity = "HOLD" | "REVIEW" | "INFORMATION";

/**
 * One disagreement, with all three figures beside each other.
 *
 * The three `…Says` fields are the whole point: a buyer arguing with a supplier needs to see
 * "you promised 100, we counted 90, you charged for 100" in one line, not a code.
 */
export interface MatchFinding {
  readonly code: MatchFindingCode;
  readonly severity: MatchSeverity;
  /** The field this is about, e.g. `lines[2].quantity` or `lines[2].ratePaise`. */
  readonly field: string;
  /** The item the disagreement is about, when it belongs to one. */
  readonly itemId?: Id;
  readonly description?: string;
  /** Formatted for reading, not for arithmetic. Absent where a document is silent. */
  readonly orderSays?: string;
  readonly receiptSays?: string;
  readonly invoiceSays?: string;
  /** The gap, formatted the same way, when the check compared two figures. */
  readonly difference?: string;
  /** Whether the gap fell inside the tolerance that was in force. */
  readonly withinTolerance: boolean;
  /** Written for someone who has never studied accounting. */
  readonly message: string;
}

/**
 * One item's row in the comparison, whichever documents mention it.
 *
 * Quantities are held per unit as they were written. A line whose order, receipt and bill used
 * different units is reported rather than converted: converting a stock figure on the way into a
 * comparison is how a mismatch gets hidden by arithmetic.
 */
export interface MatchLine {
  readonly itemId: Id;
  readonly description: string;
  readonly orderLineNumber?: number;
  readonly invoiceLineNumber?: number;
  readonly orderedQuantity?: Quantity;
  readonly receivedQuantity?: Quantity;
  /** What the godown kept. The figure that increased stock. */
  readonly acceptedQuantity?: Quantity;
  readonly rejectedQuantity?: Quantity;
  readonly invoicedQuantity?: Quantity;
  readonly orderedRatePaise?: Paise;
  readonly invoicedRatePaise?: Paise;
  readonly orderedGstRateBasisPoints?: number;
  readonly invoicedGstRateBasisPoints?: number;
  /** Only the findings about this line, so a screen can show them under the row. */
  readonly findings: readonly MatchFinding[];
}

/**
 * What the match came to.
 *
 * `MATCHED` — the three agree exactly. `WITHIN_TOLERANCE` — they differ, but by less than the
 * company allows, and the differences are still listed. `HOLD_FOR_APPROVAL` — something real
 * disagrees and a person must decide before the bill is recorded. `BLOCKED` — the documents
 * cannot be compared at all, for instance the bill and the order use different units.
 */
export type MatchOutcome = "MATCHED" | "WITHIN_TOLERANCE" | "HOLD_FOR_APPROVAL" | "BLOCKED";

/** Which documents were actually available to compare. */
export type MatchKind = "THREE_WAY" | "TWO_WAY_RECEIPT" | "TWO_WAY_ORDER" | "INVOICE_ONLY";

export interface MatchResult {
  readonly companyId: Id;
  /** The purchase this is a match for, so a verdict and a match sit on the same record. */
  readonly purchaseId: Id;
  readonly invoiceNumber: string;
  readonly orderId?: Id;
  readonly orderNumber?: string;
  readonly receiptIds: readonly Id[];
  readonly kind: MatchKind;
  readonly outcome: MatchOutcome;
  readonly lines: readonly MatchLine[];
  /** Every finding across every line, worst first, for a screen that shows one list. */
  readonly findings: readonly MatchFinding[];
  readonly policy: MatchTolerancePolicy;
  /** Identical inputs give an identical match, so a retry is idempotent (#6). */
  readonly fingerprint: string;
  /** One line the buyer sees first. */
  readonly summary: string;
}

/**
 * A person's decision on a held match, kept because approving an overcharge is exactly the kind
 * of thing that has to be answerable for later.
 */
export interface MatchApproval {
  readonly matchFingerprint: string;
  readonly approvedBy: Id;
  readonly approvedAt: string;
  /** Why the difference is acceptable, in the approver's own words. Required. */
  readonly reason: string;
  /** The codes being accepted. A match that grew a new finding is not covered by this. */
  readonly accepted: readonly MatchFindingCode[];
}
