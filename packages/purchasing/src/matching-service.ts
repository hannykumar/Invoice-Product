// Issue #18 [E18] — running the order, the delivery and the comparison between them.
//
// The one rule this service exists to enforce: **stock moves when goods are confirmed, and it
// moves by the accepted quantity only.** Not the ordered quantity, which is a hope, and not the
// invoiced quantity, which is the supplier's claim. Ten wet boxes turned away at the gate never
// enter the godown, whatever the bill says.
//
// A purchase order is not a financial document, so nothing here writes to the ledger. Confirming
// a receipt moves goods; recording the bill (#17) moves money. Keeping those apart is what lets
// a delivery on Monday and a bill on Friday both be true.

import { conflict, forbidden, invalid, isoDate, notFound, type CompanyId } from "@invoice/kernel";
import type { ActorContext, AuditPort, LedgerStore } from "@invoice/ledger";
import type { Clock } from "@invoice/kernel";
import { formatPaise } from "./money.ts";
import { divideRoundHalfUp } from "./recompute.ts";
import { MICRO } from "../../masters/src/units.ts";
import { matchPurchase, showQuantity, type MatchInput, type MatchInvoice } from "./matching.ts";
import { DEFAULT_MATCH_TOLERANCE } from "./matching-types.ts";
import type { PurchaseInventoryPort } from "./posting-ports.ts";
import type {
  GoodsReceipt, GoodsReceiptLine, GoodsReceiptMovement, MatchApproval, MatchResult,
  MatchTolerancePolicy, PurchaseOrder, PurchaseOrderLine, PurchaseOrderState,
} from "./matching-types.ts";
import type {
  GoodsReceiptRepository, MatchApprovalRepository, MatchTolerancePort, PurchaseOrderRepository,
} from "./matching-ports.ts";

/** Raising an order commits the business to spending money, so it is its own permission. */
export const ORDER_WRITE_PERMISSION = "purchase.order.write";
export const ORDER_CANCEL_PERMISSION = "purchase.order.cancel";
/** Confirming goods moves stock, so the godown's own permission is required as well. */
export const RECEIPT_WRITE_PERMISSION = "purchase.receipt.write";
/** Letting a bill through that disagrees with the delivery is a decision, not a formality. */
export const MATCH_APPROVE_PERMISSION = "purchase.match.approve";

export interface PurchaseOrderInput {
  readonly orderNumber: string;
  readonly supplierPartyId: string;
  readonly supplierName: string;
  readonly orderDate: string;
  readonly expectedDate?: string;
  readonly lines: readonly PurchaseOrderLine[];
}

export interface GoodsReceiptInput {
  readonly receiptNumber: string;
  /** Omitted on the small-business path, where goods are confirmed without an order. */
  readonly orderId?: string;
  readonly supplierPartyId: string;
  readonly supplierName: string;
  readonly receiptDate: string;
  readonly deliveryNote?: string;
  readonly vehicleNumber?: string;
  readonly lines: readonly GoodsReceiptLine[];
}

export interface MatchingServiceDeps {
  readonly store: LedgerStore;
  readonly inventory: PurchaseInventoryPort;
  readonly orders: PurchaseOrderRepository;
  readonly receipts: GoodsReceiptRepository;
  readonly approvals: MatchApprovalRepository;
  readonly audit: AuditPort;
  readonly clock: Clock;
  /** Absent means every company uses the shipped default. */
  readonly tolerance?: MatchTolerancePort;
  readonly idFactory?: () => string;
}

export class ThreeWayMatchingService {
  readonly #store: LedgerStore;
  readonly #inventory: PurchaseInventoryPort;
  readonly #orders: PurchaseOrderRepository;
  readonly #receipts: GoodsReceiptRepository;
  readonly #approvals: MatchApprovalRepository;
  readonly #audit: AuditPort;
  readonly #clock: Clock;
  readonly #tolerance: MatchTolerancePort | undefined;
  readonly #newId: () => string;

  constructor(deps: MatchingServiceDeps) {
    this.#store = deps.store;
    this.#inventory = deps.inventory;
    this.#orders = deps.orders;
    this.#receipts = deps.receipts;
    this.#approvals = deps.approvals;
    this.#audit = deps.audit;
    this.#clock = deps.clock;
    this.#tolerance = deps.tolerance;
    this.#newId = deps.idFactory ?? (() => crypto.randomUUID());
  }

  // --------------------------------------------------------------------- purchase orders

  async order(actor: ActorContext, id: string): Promise<PurchaseOrder | null> {
    return this.#orders.findById(actor.companyId, id);
  }

  async orders(actor: ActorContext): Promise<readonly PurchaseOrder[]> {
    return this.#orders.list(actor.companyId);
  }

  /**
   * Raises an order. Calling it again with the same order number returns the order that already
   * exists rather than raising a second one, so a retry after a timeout cannot double-order.
   */
  async createOrder(actor: ActorContext, input: PurchaseOrderInput): Promise<PurchaseOrder> {
    this.#require(actor, ORDER_WRITE_PERMISSION);
    const number = input.orderNumber.trim();
    if (number === "") throw invalid("ORDER_NUMBER_REQUIRED", "Please give this order a number, so you and the supplier can both refer to it.");
    isoDate(input.orderDate);
    if (input.lines.length === 0) throw invalid("ORDER_EMPTY", "An order needs at least one thing on it.");

    const existing = await this.#orders.findByNumber(actor.companyId, number);
    if (existing !== null) return existing;

    let value = 0n;
    for (const line of input.lines) {
      const label = `Line ${line.lineNumber} (${line.description})`;
      if (line.quantity.scaled <= 0n) throw invalid("ORDER_QUANTITY_INVALID", `${label} has no quantity on it. Please say how much you are ordering.`);
      if (line.ratePaise < 0n) throw invalid("ORDER_RATE_INVALID", `${label} has a price below zero.`);
      if (line.supplyKind === "GOODS" && line.warehouseId === undefined) {
        throw invalid("ORDER_WAREHOUSE_REQUIRED", `${label} is goods, so please say which godown they should come to.`);
      }
      value += divideRoundHalfUp(line.quantity.scaled * line.ratePaise, MICRO);
    }

    const at = this.#clock.now().toISOString();
    const order: PurchaseOrder = {
      id: this.#newId(),
      companyId: actor.companyId,
      orderNumber: number,
      supplierPartyId: input.supplierPartyId,
      supplierName: input.supplierName,
      orderDate: input.orderDate,
      ...(input.expectedDate === undefined ? {} : { expectedDate: input.expectedDate }),
      lines: input.lines,
      state: "DRAFT",
      orderedValuePaise: value,
      createdBy: actor.userId,
      createdAt: at,
      summary: `Order ${number} for ${formatPaise(value)} of goods from ${input.supplierName}. Nothing has been bought yet — this only records what you have asked for.`,
    };
    await this.#orders.insert(order);
    await this.#record(actor, at, "purchase.order_created", order.id, order.summary, {
      number, supplier: input.supplierName, value: formatPaise(value), lines: String(input.lines.length),
    });
    return order;
  }

  /** Tells the system the supplier has been given the order. Deliveries are checked against it. */
  async placeOrder(actor: ActorContext, orderId: string): Promise<PurchaseOrder> {
    this.#require(actor, ORDER_WRITE_PERMISSION);
    const order = await this.#mustFindOrder(actor, orderId);
    if (order.state === "PLACED") return order;
    if (order.state !== "DRAFT") {
      throw conflict("ORDER_NOT_DRAFT", `Order ${order.orderNumber} has already moved on from being a draft, so it cannot be placed again.`);
    }
    const at = this.#clock.now().toISOString();
    const placed: PurchaseOrder = {
      ...order, state: "PLACED", placedBy: actor.userId, placedAt: at,
      summary: `Order ${order.orderNumber} has been placed with ${order.supplierName}. When the goods arrive, confirm them and we will check them against this order.`,
    };
    await this.#orders.update(placed);
    await this.#record(actor, at, "purchase.order_placed", order.id, placed.summary, { number: order.orderNumber });
    return placed;
  }

  /**
   * Cancels an order nothing has been delivered against.
   *
   * An order that has already received goods cannot be cancelled, because cancelling would say
   * the goods on the shelf were never ordered. Close it instead: that says "we are not expecting
   * the rest", which is the true statement.
   */
  async cancelOrder(actor: ActorContext, orderId: string, reason: string): Promise<PurchaseOrder> {
    this.#require(actor, ORDER_CANCEL_PERMISSION);
    const order = await this.#mustFindOrder(actor, orderId);
    if (order.state === "CANCELLED") return order;
    if (reason.trim() === "") throw invalid("ORDER_CANCEL_REASON_REQUIRED", "Please say why this order is being cancelled; the reason is kept with it.");
    const received = (await this.#receipts.listForOrder(actor.companyId, orderId)).filter((receipt) => receipt.state === "CONFIRMED");
    if (received.length > 0) {
      throw conflict(
        "ORDER_HAS_RECEIPTS",
        `Goods have already been received against order ${order.orderNumber}, so it cannot be cancelled — that would say they were never ordered. Close the order instead if you are not expecting the rest.`,
      );
    }
    const at = this.#clock.now().toISOString();
    const cancelled: PurchaseOrder = {
      ...order, state: "CANCELLED", cancelledReason: reason,
      summary: `Order ${order.orderNumber} has been cancelled. Reason kept on record: ${reason}`,
    };
    await this.#orders.update(cancelled);
    await this.#record(actor, at, "purchase.order_cancelled", order.id, cancelled.summary, { number: order.orderNumber }, reason);
    return cancelled;
  }

  /** Stops expecting the rest of a part-delivered order. What arrived stays exactly as it is. */
  async closeOrder(actor: ActorContext, orderId: string, reason: string): Promise<PurchaseOrder> {
    this.#require(actor, ORDER_WRITE_PERMISSION);
    const order = await this.#mustFindOrder(actor, orderId);
    if (order.state === "CLOSED") return order;
    if (order.state === "CANCELLED") throw conflict("ORDER_CANCELLED", `Order ${order.orderNumber} was cancelled, so there is nothing to close.`);
    if (reason.trim() === "") throw invalid("ORDER_CLOSE_REASON_REQUIRED", "Please say why the rest of this order is no longer expected.");
    const at = this.#clock.now().toISOString();
    const closed: PurchaseOrder = {
      ...order, state: "CLOSED", closedReason: reason,
      summary: `Order ${order.orderNumber} has been closed. Whatever arrived stays in your stock; nothing more is expected. Reason kept on record: ${reason}`,
    };
    await this.#orders.update(closed);
    await this.#record(actor, at, "purchase.order_closed", order.id, closed.summary, { number: order.orderNumber }, reason);
    return closed;
  }

  // ---------------------------------------------------------------------- goods receipts

  async receipt(actor: ActorContext, id: string): Promise<GoodsReceipt | null> {
    return this.#receipts.findById(actor.companyId, id);
  }

  async receiptsForOrder(actor: ActorContext, orderId: string): Promise<readonly GoodsReceipt[]> {
    return this.#receipts.listForOrder(actor.companyId, orderId);
  }

  async receiptsForParty(actor: ActorContext, partyId: string): Promise<readonly GoodsReceipt[]> {
    return this.#receipts.listForParty(actor.companyId, partyId);
  }

  /**
   * Writes down what arrived, without moving anything yet.
   *
   * Two figures are kept apart on purpose: what the lorry brought, and what was kept after
   * looking at it. The difference has to be explained, because "10 boxes short" and "10 boxes
   * arrived soaked" are different conversations to have with a supplier.
   */
  async recordReceipt(actor: ActorContext, input: GoodsReceiptInput): Promise<GoodsReceipt> {
    this.#require(actor, RECEIPT_WRITE_PERMISSION);
    const number = input.receiptNumber.trim();
    if (number === "") throw invalid("RECEIPT_NUMBER_REQUIRED", "Please give this delivery a number so it can be found again.");
    isoDate(input.receiptDate);
    if (input.lines.length === 0) throw invalid("RECEIPT_EMPTY", "A delivery needs at least one thing on it.");

    const existing = await this.#receipts.findByNumber(actor.companyId, number);
    if (existing !== null) return existing;

    const order = input.orderId === undefined ? null : await this.#mustFindOrder(actor, input.orderId);
    if (order !== null && order.state === "CANCELLED") {
      throw conflict("ORDER_CANCELLED", `Order ${order.orderNumber} was cancelled, so goods cannot be received against it.`);
    }

    for (const line of input.lines) {
      const label = `Line ${line.lineNumber} (${line.description})`;
      if (line.receivedQuantity.scaled <= 0n) throw invalid("RECEIPT_QUANTITY_INVALID", `${label} says nothing arrived. Please put in how much came.`);
      if (line.acceptedQuantity.scaled < 0n) throw invalid("RECEIPT_ACCEPTED_INVALID", `${label} cannot accept less than nothing.`);
      if (line.acceptedQuantity.unit !== line.receivedQuantity.unit) {
        throw invalid("RECEIPT_UNITS_DIFFER", `${label} counts what arrived in ${line.receivedQuantity.unit} but what was kept in ${line.acceptedQuantity.unit}. Please use the same unit for both.`);
      }
      if (line.acceptedQuantity.scaled > line.receivedQuantity.scaled) {
        throw invalid(
          "RECEIPT_ACCEPTED_ABOVE_RECEIVED",
          `${label} says you kept ${showQuantity(line.acceptedQuantity)} but only ${showQuantity(line.receivedQuantity)} arrived. You cannot keep more than came.`,
        );
      }
      // Turning goods away without saying why leaves nothing to show the supplier later.
      if (line.acceptedQuantity.scaled < line.receivedQuantity.scaled && line.rejectionReason === undefined) {
        throw invalid(
          "RECEIPT_REJECTION_REASON_REQUIRED",
          `${label}: ${showQuantity({ scaled: line.receivedQuantity.scaled - line.acceptedQuantity.scaled, unit: line.receivedQuantity.unit })} was not kept. Please say why, so you have something to show the supplier.`,
        );
      }
      if (line.ratePaise <= 0n) {
        throw invalid(
          "RECEIPT_RATE_REQUIRED",
          `${label} has no price on it. Stock has to come in at a value, so please say what one ${line.receivedQuantity.unit.toLowerCase()} costs — from the order if there is one.`,
        );
      }
    }

    const at = this.#clock.now().toISOString();
    const accepted = input.lines.reduce((sum, line) => sum + (line.acceptedQuantity.scaled > 0n ? 1 : 0), 0);
    const turnedAway = input.lines.filter((line) => line.acceptedQuantity.scaled < line.receivedQuantity.scaled).length;
    const receipt: GoodsReceipt = {
      id: this.#newId(),
      companyId: actor.companyId,
      receiptNumber: number,
      ...(order === null ? {} : { orderId: order.id }),
      supplierPartyId: input.supplierPartyId,
      supplierName: input.supplierName,
      receiptDate: input.receiptDate,
      ...(input.deliveryNote === undefined ? {} : { deliveryNote: input.deliveryNote }),
      ...(input.vehicleNumber === undefined ? {} : { vehicleNumber: input.vehicleNumber }),
      lines: input.lines,
      state: "DRAFT",
      movements: [],
      createdBy: actor.userId,
      createdAt: at,
      summary: `Delivery ${number} from ${input.supplierName}: ${accepted} thing${accepted === 1 ? "" : "s"} to go into your stock${turnedAway > 0 ? `, and ${turnedAway} where part of it was turned away` : ""}. Nothing has moved yet — confirm it when you are happy.`,
    };
    await this.#receipts.insert(receipt);
    await this.#record(actor, at, "purchase.receipt_recorded", receipt.id, receipt.summary, {
      number, supplier: input.supplierName, order: order?.orderNumber ?? "none", lines: String(input.lines.length),
    });
    return receipt;
  }

  /**
   * Confirms a delivery. This is the moment stock moves, and it moves by the accepted quantity.
   *
   * Every line moves inside one unit of work, so a godown that refuses one of them — an unknown
   * item, a batch nobody named — leaves the whole delivery unconfirmed rather than half of it on
   * the shelf.
   */
  async confirmReceipt(actor: ActorContext, receiptId: string): Promise<GoodsReceipt> {
    this.#require(actor, RECEIPT_WRITE_PERMISSION);
    const receipt = await this.#mustFindReceipt(actor, receiptId);
    if (receipt.state === "CONFIRMED") return receipt;
    if (receipt.state === "CANCELLED") {
      throw conflict("RECEIPT_CANCELLED", `Delivery ${receipt.receiptNumber} was cancelled, so it cannot be confirmed. Record it again if the goods really did arrive.`);
    }

    const at = this.#clock.now().toISOString();
    const confirmed = await this.#store.transaction(actor.companyId, async () => {
      const movements: GoodsReceiptMovement[] = [];
      for (const line of receipt.lines) {
        // Rejected goods are not stock. A line where nothing was kept moves nothing at all.
        if (line.acceptedQuantity.scaled <= 0n) continue;
        const value = divideRoundHalfUp(line.acceptedQuantity.scaled * line.ratePaise, MICRO);
        const movement = await this.#inventory.receiveIn(actor, {
          idempotencyKey: `grn:receive:${receipt.id}:${line.lineNumber}`,
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          batchId: line.batchId ?? null,
          ...(line.serialNumbers === undefined ? {} : { serialNumbers: line.serialNumbers }),
          quantity: line.acceptedQuantity,
          lineCostPaise: value,
          documentDate: isoDate(receipt.receiptDate),
          source: { kind: "goods_receipt", id: receipt.id, number: receipt.receiptNumber },
        });
        movements.push({
          lineNumber: line.lineNumber,
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          ...(line.batchId === undefined ? {} : { batchId: line.batchId }),
          ...(line.serialNumbers === undefined ? {} : { serialNumbers: line.serialNumbers }),
          quantity: line.acceptedQuantity,
          valuePaise: value,
          stockMovementId: movement.id,
        });
      }

      const stocked = movements.map((movement) => showQuantity(movement.quantity)).join(", ");
      const rejected = receipt.lines
        .filter((line) => line.acceptedQuantity.scaled < line.receivedQuantity.scaled)
        .map((line) => showQuantity({ scaled: line.receivedQuantity.scaled - line.acceptedQuantity.scaled, unit: line.receivedQuantity.unit }));
      const updated: GoodsReceipt = {
        ...receipt,
        state: "CONFIRMED",
        movements,
        confirmedBy: actor.userId,
        confirmedAt: at,
        summary: `Delivery ${receipt.receiptNumber} is confirmed. ${stocked === "" ? "Nothing went into your stock, because none of it was kept" : `${stocked} went into your stock`}${rejected.length > 0 ? `. ${rejected.join(", ")} was turned away and has not been added` : ""}.`,
      };
      await this.#receipts.update(updated);
      return updated;
    });

    if (receipt.orderId !== undefined) await this.#advanceOrder(actor, receipt.orderId);
    await this.#record(actor, at, "purchase.receipt_confirmed", receipt.id, confirmed.summary, {
      number: receipt.receiptNumber,
      supplier: receipt.supplierName,
      stockMovements: String(confirmed.movements.length),
      accepted: confirmed.movements.map((movement) => showQuantity(movement.quantity)).join(", "),
    });
    return confirmed;
  }

  /**
   * Takes a confirmed delivery back out of stock — the goods went back on the lorry, or the
   * delivery was entered against the wrong supplier.
   *
   * If any of it has already been sold the godown refuses, and the whole cancellation is undone
   * rather than leaving the books and the shelf disagreeing.
   */
  async cancelReceipt(
    actor: ActorContext,
    receiptId: string,
    input: { readonly reason: string; readonly negativeOverrideReason?: string },
  ): Promise<GoodsReceipt> {
    this.#require(actor, RECEIPT_WRITE_PERMISSION);
    const receipt = await this.#mustFindReceipt(actor, receiptId);
    if (receipt.state === "CANCELLED") return receipt;
    if (input.reason.trim() === "") {
      throw invalid("RECEIPT_CANCEL_REASON_REQUIRED", "Please say why this delivery is being cancelled; the reason is kept with it.");
    }

    const at = this.#clock.now().toISOString();
    const cancelled = await this.#store.transaction(actor.companyId, async () => {
      for (const movement of receipt.movements) {
        await this.#inventory.returnIn(actor, {
          idempotencyKey: `grn:return:${receipt.id}:${movement.lineNumber}`,
          itemId: movement.itemId,
          warehouseId: movement.warehouseId,
          batchId: movement.batchId ?? null,
          ...(movement.serialNumbers === undefined ? {} : { serialNumbers: movement.serialNumbers }),
          quantity: movement.quantity,
          lineCostPaise: movement.valuePaise,
          documentDate: isoDate(receipt.receiptDate),
          source: { kind: "goods_receipt", id: receipt.id, number: receipt.receiptNumber },
          reason: input.reason,
          ...(input.negativeOverrideReason === undefined ? {} : { negativeOverrideReason: input.negativeOverrideReason }),
        });
      }
      const updated: GoodsReceipt = {
        ...receipt,
        state: "CANCELLED",
        cancelledReason: input.reason,
        summary: `Delivery ${receipt.receiptNumber} has been cancelled${receipt.movements.length > 0 ? " and the goods taken back out of your stock" : ""}. Reason kept on record: ${input.reason}`,
      };
      await this.#receipts.update(updated);
      return updated;
    });

    if (receipt.orderId !== undefined) await this.#advanceOrder(actor, receipt.orderId);
    await this.#record(actor, at, "purchase.receipt_cancelled", receipt.id, cancelled.summary, {
      number: receipt.receiptNumber, movementsReversed: String(receipt.movements.length),
    }, input.reason);
    return cancelled;
  }

  /**
   * The whole small-business path in one call: the goods are here, put them in stock.
   *
   * No order, no separate confirm step, no approval queue. A shop that buys a carton of soap
   * from the wholesaler down the road uses this and never meets a purchase order. The result is
   * an ordinary goods receipt, so everything downstream — matching, stock, the bill — works the
   * same way it would for a business that does raise orders.
   */
  async goodsConfirmed(actor: ActorContext, input: Omit<GoodsReceiptInput, "orderId">): Promise<GoodsReceipt> {
    const recorded = await this.recordReceipt(actor, input);
    return recorded.state === "CONFIRMED" ? recorded : this.confirmReceipt(actor, recorded.id);
  }

  // ---------------------------------------------------------------------------- matching

  /**
   * Compares a supplier's bill with the order it came from and the deliveries against it.
   *
   * Reads only. This never records the bill and never moves stock — its whole output is an
   * explanation, which is what a person needs before deciding.
   */
  async matchForInvoice(
    actor: ActorContext,
    invoice: MatchInvoice,
    options: { readonly orderId?: string; readonly receiptIds?: readonly string[]; readonly on?: string } = {},
  ): Promise<MatchResult> {
    const on = options.on ?? this.#clock.now().toISOString().slice(0, 10);
    const policy = await this.#policyFor(actor.companyId, on);

    const order = options.orderId === undefined ? undefined : (await this.#orders.findById(actor.companyId, options.orderId)) ?? undefined;
    if (options.orderId !== undefined && order === undefined) {
      throw notFound("ORDER_UNKNOWN", "We could not find that purchase order.");
    }

    // Named receipts win; otherwise every delivery against the order counts, which is what makes
    // a part-delivered order match correctly against a bill for the whole of it.
    const receipts = options.receiptIds !== undefined
      ? await this.#receiptsByIds(actor.companyId, options.receiptIds)
      : order !== undefined
        ? await this.#receipts.listForOrder(actor.companyId, order.id)
        : [];

    const input: MatchInput = {
      companyId: actor.companyId,
      ...(order === undefined ? {} : { order }),
      receipts,
      invoice,
    };
    return matchPurchase(input, policy);
  }

  /** A held match a person has decided to let through, with the reason kept beside it. */
  async approveMatch(actor: ActorContext, match: MatchResult, reason: string): Promise<MatchApproval> {
    this.#require(actor, MATCH_APPROVE_PERMISSION);
    if (match.companyId !== actor.companyId) throw notFound("MATCH_UNKNOWN", "We could not find that comparison.");
    if (reason.trim() === "") {
      throw invalid("MATCH_APPROVAL_REASON_REQUIRED", "Please say why this difference is acceptable; the reason is kept with the bill.");
    }
    if (match.outcome === "BLOCKED") {
      throw conflict("MATCH_BLOCKED", "This bill cannot be compared with the order and the delivery at all, so there is nothing to approve yet. Put the quantities in the same unit and check again.");
    }

    const existing = await this.#approvals.findByFingerprint(actor.companyId, match.fingerprint);
    if (existing !== null) return existing;

    const at = this.#clock.now().toISOString();
    const approval: MatchApproval = {
      matchFingerprint: match.fingerprint,
      approvedBy: actor.userId,
      approvedAt: at,
      reason,
      accepted: [...new Set(match.findings.filter((finding) => finding.severity === "HOLD").map((finding) => finding.code))],
    };
    await this.#approvals.insert(actor.companyId, approval);
    await this.#record(actor, at, "purchase.match_approved", match.purchaseId,
      `The differences on bill ${match.invoiceNumber} were accepted. Reason kept on record: ${reason}`,
      { invoice: match.invoiceNumber, accepted: approval.accepted.join(", "), fingerprint: match.fingerprint }, reason);
    return approval;
  }

  /**
   * Whether a bill may be recorded.
   *
   * A held match blocks it until somebody with the permission has approved that exact comparison.
   * Change a quantity after approving and the fingerprint changes with it, so the old approval no
   * longer covers the new bill — which is the whole reason the fingerprint exists.
   */
  async isClearedToPost(actor: ActorContext, match: MatchResult): Promise<{ readonly cleared: boolean; readonly reason: string }> {
    if (match.outcome === "MATCHED" || match.outcome === "WITHIN_TOLERANCE") {
      return { cleared: true, reason: match.summary };
    }
    if (match.outcome === "BLOCKED") {
      return { cleared: false, reason: match.summary };
    }
    const approval = await this.#approvals.findByFingerprint(actor.companyId, match.fingerprint);
    return approval === null
      ? { cleared: false, reason: match.summary }
      : { cleared: true, reason: `The differences on this bill were accepted on ${approval.approvedAt.slice(0, 10)}. Reason kept on record: ${approval.reason}` };
  }

  // --------------------------------------------------------------------------- internals

  /**
   * Moves an order along to match what has actually arrived.
   *
   * Derived from the receipts every time rather than nudged a step at a time, so cancelling a
   * delivery walks the order backwards correctly instead of leaving it stuck on "received".
   */
  async #advanceOrder(actor: ActorContext, orderId: string): Promise<void> {
    const order = await this.#orders.findById(actor.companyId, orderId);
    if (order === null || order.state === "CANCELLED" || order.state === "CLOSED") return;

    const receipts = (await this.#receipts.listForOrder(actor.companyId, orderId)).filter((receipt) => receipt.state === "CONFIRMED");
    const acceptedByItem = new Map<string, bigint>();
    for (const receipt of receipts) {
      for (const line of receipt.lines) {
        acceptedByItem.set(line.itemId, (acceptedByItem.get(line.itemId) ?? 0n) + line.acceptedQuantity.scaled);
      }
    }

    const complete = order.lines.every((line) => (acceptedByItem.get(line.itemId) ?? 0n) >= line.quantity.scaled);
    const anything = [...acceptedByItem.values()].some((value) => value > 0n);
    const state: PurchaseOrderState = complete ? "RECEIVED" : anything ? "PARTIALLY_RECEIVED" : order.placedAt === undefined ? "DRAFT" : "PLACED";
    if (state === order.state) return;

    await this.#orders.update({
      ...order,
      state,
      summary: state === "RECEIVED"
        ? `Order ${order.orderNumber} is complete: everything you ordered has arrived and gone into your stock.`
        : state === "PARTIALLY_RECEIVED"
          ? `Order ${order.orderNumber} is part-delivered. Some of it has arrived; the rest is still to come.`
          : `Order ${order.orderNumber} is with ${order.supplierName}. Nothing has arrived against it.`,
    });
  }

  async #receiptsByIds(companyId: CompanyId, ids: readonly string[]): Promise<GoodsReceipt[]> {
    const found: GoodsReceipt[] = [];
    for (const id of ids) {
      const receipt = await this.#receipts.findById(companyId, id);
      if (receipt === null) throw notFound("RECEIPT_UNKNOWN", "We could not find one of the deliveries you asked to check against.");
      found.push(receipt);
    }
    return found;
  }

  async #policyFor(companyId: CompanyId, on: string): Promise<MatchTolerancePolicy> {
    return this.#tolerance === undefined ? DEFAULT_MATCH_TOLERANCE : this.#tolerance.policyFor(companyId, on);
  }

  async #mustFindOrder(actor: ActorContext, id: string): Promise<PurchaseOrder> {
    const order = await this.#orders.findById(actor.companyId, id);
    // Tenancy comes from the repository query, never from an id the caller supplied: an order in
    // another business is reported as missing, not as forbidden, so nothing is leaked by asking.
    if (order === null) throw notFound("ORDER_UNKNOWN", "We could not find that purchase order.");
    return order;
  }

  async #mustFindReceipt(actor: ActorContext, id: string): Promise<GoodsReceipt> {
    const receipt = await this.#receipts.findById(actor.companyId, id);
    if (receipt === null) throw notFound("RECEIPT_UNKNOWN", "We could not find that delivery.");
    return receipt;
  }

  #require(actor: ActorContext, permission: string): void {
    if (!actor.permissions.includes(permission)) {
      throw forbidden("PERMISSION_DENIED", "You do not have permission to do that. Ask the owner to give you access.", { details: { permission } });
    }
  }

  async #record(
    actor: ActorContext,
    at: string,
    action: string,
    subjectId: string,
    summary: string,
    details: Record<string, string>,
    overrideReason?: string,
  ): Promise<void> {
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action,
      subjectType: action.startsWith("purchase.order") ? "purchase_order" : action.startsWith("purchase.receipt") ? "goods_receipt" : "purchase_match",
      subjectId,
      summary,
      details,
      ...(overrideReason === undefined ? {} : { overrideReason }),
    });
  }
}
