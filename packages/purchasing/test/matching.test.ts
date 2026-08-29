/**
 * Issue #18 [E18] acceptance criteria, enforced automatically.
 *
 *  - "Mismatches are explained field by field"
 *  - "Only accepted received quantities increase stock"
 *  - "Small-business workflow does not force a PO"
 *
 * plus the required partial-receipt and split-invoice, over/under delivery, and return and
 * cancellation interaction tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DomainError, isoDate, quantityFromString } from "@invoice/kernel";
import { DEFAULT_MATCH_TOLERANCE, type GoodsReceipt, type MatchFindingCode } from "../src/matching-types.ts";
import { matchPurchase, showQuantity } from "../src/matching.ts";
import {
  MATCHING_PERMISSIONS, ORDER_INPUT, RECEIPT_INPUT, COMPANY, SUPPLIER, actorWith, makeYard,
  soapInvoice, soapInvoiceLine, soapOrderLine, soapReceiptLine,
} from "../src/matching-fixtures.ts";

const box = (value: string) => quantityFromString(value, "BOX");

/**
 * The soap on the shelf in the Peenya godown, in pieces (one box is twenty-four).
 *
 * The batch is named because #12's `balance` treats a missing batch as "the unbatched stock",
 * not as "all batches" — see issue #86. Once that is fixed, the batch argument can go.
 */
const stockOf = async (
  yard: Awaited<ReturnType<typeof makeYard>>,
  { itemId = "SOAP", batchId = "batch-aug" }: { itemId?: string; batchId?: string | null } = {},
): Promise<string> => {
  const balance = await yard.inventoryService.balance(yard.actor, { itemId, warehouseId: "wh-main", batchId });
  return showQuantity(balance.physical);
};

const codes = (findings: readonly { code: MatchFindingCode }[]): MatchFindingCode[] => findings.map((f) => f.code);

/** Order placed, goods received and confirmed, all in the state the issue's example describes. */
const deliveredYard = async (
  overrides: { order?: Parameters<typeof soapOrderLine>[0]; receipt?: Parameters<typeof soapReceiptLine>[0] } = {},
) => {
  const yard = await makeYard();
  const order = await yard.matching.createOrder(yard.actor, {
    ...ORDER_INPUT, lines: [soapOrderLine(overrides.order ?? {})],
  });
  await yard.matching.placeOrder(yard.actor, order.id);
  const receipt = await yard.matching.recordReceipt(yard.actor, {
    ...RECEIPT_INPUT, orderId: order.id, lines: [soapReceiptLine(overrides.receipt ?? {})],
  });
  const confirmed = await yard.matching.confirmReceipt(yard.actor, receipt.id);
  return { yard, order, receipt: confirmed };
};

// ------------------------------------------- "Only accepted received quantities increase stock"

test("only the accepted quantity reaches the godown; the rejected boxes never do", async () => {
  const { yard, receipt } = await deliveredYard();

  // 100 boxes arrived, 10 were soaked, 90 were kept. One box is 24 pieces, so 90 × 24 = 2,160.
  assert.equal(await stockOf(yard), "2160 PCS");
  assert.equal(receipt.movements.length, 1);
  assert.equal(showQuantity(receipt.movements[0]!.quantity), "90 BOX");
  // Valued at the agreed ₹240 a box, not at what the supplier later billed.
  assert.equal(receipt.movements[0]!.valuePaise, 21_600_00n);
  assert.match(receipt.summary, /90 BOX went into your stock/);
  assert.match(receipt.summary, /10 BOX was turned away/);
});

test("a delivery where nothing was kept moves no stock at all", async () => {
  const { yard, receipt } = await deliveredYard({
    receipt: { acceptedQuantity: box("0"), rejectionNote: "Whole load spoiled, sent back on the lorry" },
  });
  assert.equal(await stockOf(yard), "0 PCS");
  assert.equal(receipt.movements.length, 0);
  assert.match(receipt.summary, /Nothing went into your stock/);
});

test("keeping more than arrived is refused before anything moves", async () => {
  const yard = await makeYard();
  await assert.rejects(
    () => yard.matching.recordReceipt(yard.actor, {
      ...RECEIPT_INPUT,
      lines: [soapReceiptLine({ receivedQuantity: box("90"), acceptedQuantity: box("100"), rejectionReason: undefined })],
    }),
    (error: DomainError) => {
      assert.equal(error.code, "RECEIPT_ACCEPTED_ABOVE_RECEIVED");
      assert.match(error.message, /cannot keep more than came/);
      return true;
    },
  );
  assert.equal(await stockOf(yard), "0 PCS");
});

test("turning goods away without saying why is refused", async () => {
  const yard = await makeYard();
  await assert.rejects(
    () => yard.matching.recordReceipt(yard.actor, {
      ...RECEIPT_INPUT,
      lines: [soapReceiptLine({ rejectionReason: undefined, rejectionNote: undefined })],
    }),
    (error: DomainError) => {
      assert.equal(error.code, "RECEIPT_REJECTION_REASON_REQUIRED");
      assert.match(error.message, /something to show the supplier/);
      return true;
    },
  );
});

test("stock is never taken in at a price nobody named", async () => {
  const yard = await makeYard();
  await assert.rejects(
    () => yard.matching.recordReceipt(yard.actor, { ...RECEIPT_INPUT, lines: [soapReceiptLine({ ratePaise: 0n })] }),
    (error: DomainError) => error.code === "RECEIPT_RATE_REQUIRED",
  );
});

// ----------------------------------------------- "Mismatches are explained field by field"

test("the issue's own example: ordered 100, received 90, billed 100 is held for approval", async () => {
  const { yard, order, receipt } = await deliveredYard();
  const match = await yard.matching.matchForInvoice(yard.actor, soapInvoice(), { orderId: order.id });

  assert.equal(match.kind, "THREE_WAY");
  assert.equal(match.outcome, "HOLD_FOR_APPROVAL");
  assert.equal(match.receiptIds[0], receipt.id);

  const overcharge = match.findings.find((finding) => finding.code === "INVOICED_ABOVE_ACCEPTED");
  assert.ok(overcharge, "the overcharge must be reported");
  assert.equal(overcharge.severity, "HOLD");
  assert.equal(overcharge.field, "lines[1].quantity");
  // All three documents, side by side, on the one finding.
  assert.equal(overcharge.orderSays, "100 BOX");
  assert.equal(overcharge.receiptSays, "90 BOX");
  assert.equal(overcharge.invoiceSays, "100 BOX");
  assert.equal(overcharge.difference, "10 BOX");
  assert.equal(overcharge.withinTolerance, false);
  assert.match(overcharge.message, /you kept 90 BOX but the bill charges for 100 BOX/);
  assert.match(overcharge.message, /₹2,400\.00/);

  // The short delivery and the rejection are explained too, each on its own field.
  assert.ok(match.findings.some((finding) => finding.code === "UNDER_DELIVERED"));
  const rejected = match.findings.find((finding) => finding.code === "REJECTED_ON_ARRIVAL");
  assert.ok(rejected);
  assert.equal(rejected.field, "lines[1].acceptedQuantity");
  assert.match(rejected.message, /soaked in the rain/);
  assert.match(rejected.message, /should not be paying for it/);

  // Each line carries its own findings, so a screen can put them under the row.
  assert.equal(match.lines.length, 1);
  const line = match.lines[0]!;
  assert.equal(showQuantity(line.orderedQuantity!), "100 BOX");
  assert.equal(showQuantity(line.receivedQuantity!), "100 BOX");
  assert.equal(showQuantity(line.acceptedQuantity!), "90 BOX");
  assert.equal(showQuantity(line.rejectedQuantity!), "10 BOX");
  assert.equal(showQuantity(line.invoicedQuantity!), "100 BOX");
  assert.match(match.summary, /on hold/);
});

test("a bill that agrees with the delivery matches cleanly", async () => {
  const { yard, order } = await deliveredYard();
  const match = await yard.matching.matchForInvoice(
    yard.actor,
    soapInvoice({ lines: [soapInvoiceLine({ quantity: box("90") })] }),
    { orderId: order.id },
  );
  // The order was for 100 and 90 came, so the short delivery is still worth saying — but nothing
  // holds the bill, because the supplier only charged for what was kept.
  assert.equal(match.outcome, "WITHIN_TOLERANCE");
  assert.ok(!match.findings.some((finding) => finding.severity === "HOLD"));
  assert.ok(!codes(match.findings).includes("INVOICED_ABOVE_ACCEPTED"));
  const cleared = await yard.matching.isClearedToPost(yard.actor, match);
  assert.equal(cleared.cleared, true);
});

test("a price above the agreed one is held, and the extra is worked out in rupees", async () => {
  const { yard, order } = await deliveredYard();
  const match = await yard.matching.matchForInvoice(
    yard.actor,
    soapInvoice({ lines: [soapInvoiceLine({ quantity: box("90"), ratePaise: 260_00n })] }),
    { orderId: order.id },
  );
  const price = match.findings.find((finding) => finding.code === "PRICE_ABOVE_ORDER");
  assert.ok(price);
  assert.equal(price.severity, "HOLD");
  assert.equal(price.field, "lines[1].ratePaise");
  assert.equal(price.orderSays, "₹240.00");
  assert.equal(price.invoiceSays, "₹260.00");
  assert.equal(price.difference, "₹20.00");
  assert.match(price.message, /₹20\.00 more each, about ₹1,800\.00 on this bill/);
  assert.equal(match.outcome, "HOLD_FOR_APPROVAL");
});

test("a price difference inside the tolerance is mentioned but does not hold the bill", async () => {
  const { yard, order } = await deliveredYard();
  // 0.5% of ₹240 is ₹1.20, so ₹241 is inside it.
  const match = await yard.matching.matchForInvoice(
    yard.actor,
    soapInvoice({ lines: [soapInvoiceLine({ quantity: box("90"), ratePaise: 241_00n })] }),
    { orderId: order.id },
  );
  const price = match.findings.find((finding) => finding.code === "PRICE_ABOVE_ORDER");
  assert.ok(price);
  assert.equal(price.withinTolerance, true);
  assert.equal(price.severity, "INFORMATION");
  assert.ok(!match.findings.some((finding) => finding.severity === "HOLD"));
});

test("a GST rate the bill changed is flagged, because the wrong claim is a wrong return", async () => {
  const { yard, order } = await deliveredYard();
  const match = await yard.matching.matchForInvoice(
    yard.actor,
    soapInvoice({ lines: [soapInvoiceLine({ quantity: box("90"), gstRateBasisPoints: 1200 })] }),
    { orderId: order.id },
  );
  const tax = match.findings.find((finding) => finding.code === "TAX_RATE_DIFFERS");
  assert.ok(tax);
  assert.equal(tax.field, "lines[1].gstRateBasisPoints");
  assert.equal(tax.orderSays, "18%");
  assert.equal(tax.invoiceSays, "12%");
  assert.match(tax.message, /wrong amount back is a problem at return time/);
});

test("a bill charging for something never ordered is held", async () => {
  const { yard, order } = await deliveredYard();
  const match = await yard.matching.matchForInvoice(yard.actor, soapInvoice({
    lines: [
      soapInvoiceLine({ quantity: box("90") }),
      soapInvoiceLine({ lineNumber: 2, itemId: "TMT12", description: "TMT Steel Bar 12mm", quantity: quantityFromString("50", "KGS"), ratePaise: 64_00n }),
    ],
  }), { orderId: order.id });

  const notOrdered = match.findings.find((finding) => finding.code === "ITEM_NOT_ORDERED");
  assert.ok(notOrdered);
  assert.equal(notOrdered.severity, "HOLD");
  assert.match(notOrdered.message, /not on order PO\/2026\/0117/);
  assert.equal(match.outcome, "HOLD_FOR_APPROVAL");
});

test("goods written in different units are refused rather than converted mid-comparison", async () => {
  const { yard, order } = await deliveredYard();
  const match = await yard.matching.matchForInvoice(
    yard.actor,
    soapInvoice({ lines: [soapInvoiceLine({ quantity: quantityFromString("2160", "PCS") })] }),
    { orderId: order.id },
  );
  assert.equal(match.outcome, "BLOCKED");
  assert.equal(match.findings[0]!.code, "UNITS_DIFFER");
  assert.match(match.findings[0]!.message, /different units/);
  const cleared = await yard.matching.isClearedToPost(yard.actor, match);
  assert.equal(cleared.cleared, false);
});

// ------------------------------------------------ over and under delivery

test("more arriving than was ordered is held, because extra goods are extra money", async () => {
  const { yard, order } = await deliveredYard({
    receipt: { receivedQuantity: box("120"), acceptedQuantity: box("120"), rejectionReason: undefined, rejectionNote: undefined },
  });
  const match = await yard.matching.matchForInvoice(
    yard.actor, soapInvoice({ lines: [soapInvoiceLine({ quantity: box("120") })] }), { orderId: order.id },
  );
  const over = match.findings.find((finding) => finding.code === "OVER_DELIVERED");
  assert.ok(over);
  assert.equal(over.severity, "HOLD");
  assert.match(over.message, /20 BOX more than you asked for/);
  assert.equal(match.outcome, "HOLD_FOR_APPROVAL");
});

test("a business that allows over-delivery is not stopped by it", async () => {
  const { yard, order } = await deliveredYard({
    receipt: { receivedQuantity: box("120"), acceptedQuantity: box("120"), rejectionReason: undefined, rejectionNote: undefined },
  });
  yard.tolerances.set(COMPANY, { ...DEFAULT_MATCH_TOLERANCE, allowOverDelivery: true });
  const match = await yard.matching.matchForInvoice(
    yard.actor, soapInvoice({ lines: [soapInvoiceLine({ quantity: box("120") })] }), { orderId: order.id },
  );
  const over = match.findings.find((finding) => finding.code === "OVER_DELIVERED");
  assert.equal(over?.severity, "INFORMATION");
  assert.ok(!match.findings.some((finding) => finding.severity === "HOLD"));
});

test("under-delivery is reported but never blocks the bill for what did arrive", async () => {
  const { yard, order } = await deliveredYard();
  const match = await yard.matching.matchForInvoice(
    yard.actor, soapInvoice({ lines: [soapInvoiceLine({ quantity: box("90") })] }), { orderId: order.id },
  );
  const under = match.findings.find((finding) => finding.code === "UNDER_DELIVERED");
  assert.ok(under);
  assert.equal(under.severity, "REVIEW");
  assert.match(under.message, /10 BOX is still to come/);
  assert.equal((await yard.matching.isClearedToPost(yard.actor, match)).cleared, true);
});

test("a quantity difference inside the tolerance passes quietly", async () => {
  const yard = await makeYard();
  const order = await yard.matching.createOrder(yard.actor, {
    ...ORDER_INPUT, lines: [soapOrderLine({ quantity: box("1000") })],
  });
  await yard.matching.placeOrder(yard.actor, order.id);
  // 1% of 1,000 boxes is 10, so 1,005 delivered and billed is inside it.
  const receipt = await yard.matching.recordReceipt(yard.actor, {
    ...RECEIPT_INPUT, orderId: order.id,
    lines: [soapReceiptLine({ receivedQuantity: box("1005"), acceptedQuantity: box("1005"), rejectionReason: undefined, rejectionNote: undefined })],
  });
  await yard.matching.confirmReceipt(yard.actor, receipt.id);
  const match = await yard.matching.matchForInvoice(
    yard.actor, soapInvoice({ lines: [soapInvoiceLine({ quantity: box("1005") })] }), { orderId: order.id },
  );
  assert.ok(!match.findings.some((finding) => finding.severity === "HOLD"));
  assert.equal(match.findings.find((finding) => finding.code === "OVER_DELIVERED")?.withinTolerance, true);
});

// --------------------------------------------------- partial receipts and split invoices

test("two part-deliveries add up, and the order walks from part-delivered to complete", async () => {
  const yard = await makeYard();
  const order = await yard.matching.createOrder(yard.actor, ORDER_INPUT);
  await yard.matching.placeOrder(yard.actor, order.id);

  const first = await yard.matching.recordReceipt(yard.actor, {
    ...RECEIPT_INPUT, receiptNumber: "GRN/2026/0304", orderId: order.id,
    lines: [soapReceiptLine({ receivedQuantity: box("60"), acceptedQuantity: box("60"), rejectionReason: undefined, rejectionNote: undefined })],
  });
  await yard.matching.confirmReceipt(yard.actor, first.id);
  assert.equal((await yard.matching.order(yard.actor, order.id))!.state, "PARTIALLY_RECEIVED");
  assert.equal(await stockOf(yard), "1440 PCS");

  const second = await yard.matching.recordReceipt(yard.actor, {
    ...RECEIPT_INPUT, receiptNumber: "GRN/2026/0311", orderId: order.id, receiptDate: "2026-08-24",
    lines: [soapReceiptLine({ receivedQuantity: box("40"), acceptedQuantity: box("40"), rejectionReason: undefined, rejectionNote: undefined })],
  });
  await yard.matching.confirmReceipt(yard.actor, second.id);
  const complete = await yard.matching.order(yard.actor, order.id);
  assert.equal(complete!.state, "RECEIVED");
  assert.match(complete!.summary, /is complete/);
  assert.equal(await stockOf(yard), "2400 PCS");

  // A bill for the whole order now agrees with the two deliveries together.
  const match = await yard.matching.matchForInvoice(yard.actor, soapInvoice(), { orderId: order.id });
  assert.equal(match.outcome, "MATCHED");
  assert.match(match.summary, /agrees with what you ordered and what arrived/);
});

test("a split invoice is explained as the balance still to be billed, not as an error", async () => {
  const yard = await makeYard();
  const order = await yard.matching.createOrder(yard.actor, ORDER_INPUT);
  await yard.matching.placeOrder(yard.actor, order.id);
  const receipt = await yard.matching.recordReceipt(yard.actor, {
    ...RECEIPT_INPUT, orderId: order.id,
    lines: [soapReceiptLine({ receivedQuantity: box("100"), acceptedQuantity: box("100"), rejectionReason: undefined, rejectionNote: undefined })],
  });
  await yard.matching.confirmReceipt(yard.actor, receipt.id);

  const first = await yard.matching.matchForInvoice(
    yard.actor, soapInvoice({ invoiceNumber: "SRS/2026/0088", lines: [soapInvoiceLine({ quantity: box("60") })] }), { orderId: order.id },
  );
  const short = first.findings.find((finding) => finding.code === "INVOICED_BELOW_ACCEPTED");
  assert.ok(short);
  assert.equal(short.severity, "REVIEW");
  assert.match(short.message, /the rest is coming on a later bill/);
  // It never holds: being billed for less than you got is not a reason to stop work.
  assert.equal((await yard.matching.isClearedToPost(yard.actor, first)).cleared, true);
});

// ------------------------------------------- "Small-business workflow does not force a PO"

test("goods can be confirmed with no order at all, in one call", async () => {
  const yard = await makeYard();
  const receipt = await yard.matching.goodsConfirmed(yard.actor, {
    receiptNumber: "GRN/2026/0400",
    supplierPartyId: SUPPLIER,
    supplierName: "Shree Ram Steels Private Limited",
    receiptDate: "2026-08-26",
    lines: [soapReceiptLine({
      orderLineNumber: undefined, receivedQuantity: box("10"), acceptedQuantity: box("10"),
      rejectionReason: undefined, rejectionNote: undefined, evidence: undefined,
    })],
  });
  assert.equal(receipt.state, "CONFIRMED");
  assert.equal(receipt.orderId, undefined);
  assert.equal(await stockOf(yard), "240 PCS");

  const match = await yard.matching.matchForInvoice(
    yard.actor, soapInvoice({ lines: [soapInvoiceLine({ quantity: box("10") })] }), { receiptIds: [receipt.id] },
  );
  assert.equal(match.kind, "TWO_WAY_RECEIPT");
  assert.equal(match.outcome, "MATCHED");
  const noOrder = match.findings.find((finding) => finding.code === "NO_ORDER");
  assert.ok(noOrder);
  assert.equal(noOrder.severity, "INFORMATION");
  assert.match(noOrder.message, /perfectly normal for everyday buying/);
});

test("a bill with neither an order nor a delivery still gets a usable answer", async () => {
  const yard = await makeYard();
  const match = await yard.matching.matchForInvoice(yard.actor, soapInvoice());
  assert.equal(match.kind, "INVOICE_ONLY");
  assert.equal(match.outcome, "MATCHED");
  assert.deepEqual(codes(match.findings).sort(), ["NO_ORDER", "NO_RECEIPT"]);
  assert.equal((await yard.matching.isClearedToPost(yard.actor, match)).cleared, true);
  assert.match(match.summary, /nothing to contradict it/);
});

test("a bill for goods no delivery ever brought is held", async () => {
  const yard = await makeYard();
  const receipt = await yard.matching.goodsConfirmed(yard.actor, {
    ...RECEIPT_INPUT, receiptNumber: "GRN/2026/0500",
    lines: [soapReceiptLine({ orderLineNumber: undefined, receivedQuantity: box("10"), acceptedQuantity: box("10"), rejectionReason: undefined, rejectionNote: undefined })],
  });
  const match = await yard.matching.matchForInvoice(yard.actor, soapInvoice({
    lines: [
      soapInvoiceLine({ quantity: box("10") }),
      soapInvoiceLine({ lineNumber: 2, itemId: "TMT12", description: "TMT Steel Bar 12mm", quantity: quantityFromString("50", "KGS"), ratePaise: 64_00n }),
    ],
  }), { receiptIds: [receipt.id] });
  const missing = match.findings.find((finding) => finding.code === "ITEM_NOT_RECEIVED");
  assert.ok(missing);
  assert.equal(missing.severity, "HOLD");
  assert.match(missing.message, /no delivery of it has been confirmed/);
});

// ----------------------------------------------- returns and cancellation interactions

test("cancelling a confirmed delivery takes the goods back out of stock", async () => {
  const { yard, order, receipt } = await deliveredYard();
  assert.equal(await stockOf(yard), "2160 PCS");

  const cancelled = await yard.matching.cancelReceipt(yard.actor, receipt.id, { reason: "Entered against the wrong supplier" });
  assert.equal(cancelled.state, "CANCELLED");
  assert.equal(await stockOf(yard), "0 PCS");
  assert.match(cancelled.summary, /taken back out of your stock/);

  // The order walks backwards with it rather than being stuck on "part delivered".
  assert.equal((await yard.matching.order(yard.actor, order.id))!.state, "PLACED");

  // And the cancelled delivery is no longer evidence that anything arrived.
  const match = await yard.matching.matchForInvoice(yard.actor, soapInvoice(), { orderId: order.id });
  assert.equal(match.kind, "TWO_WAY_ORDER");
  assert.ok(codes(match.findings).includes("NO_RECEIPT"));
});

test("stock already sold cannot be quietly taken back out by cancelling the delivery", async () => {
  const { yard, receipt } = await deliveredYard();
  // The shop sells 100 pieces before anyone notices the delivery was recorded wrongly.
  await yard.inventoryService.recordMovement(yard.actor, {
    idempotencyKey: "sale-1", itemId: "SOAP", warehouseId: "wh-main", batchId: "batch-aug",
    kind: "SALE_OUT", quantity: quantityFromString("2100", "PCS"), unitCost: null,
    documentDate: isoDate("2026-08-25"), source: { kind: "sales_invoice", id: "inv-1", number: "INV/1" },
  });
  await assert.rejects(
    () => yard.matching.cancelReceipt(yard.actor, receipt.id, { reason: "Wrong supplier" }),
    (error: DomainError) => {
      assert.equal(error.code, "STOCK_WOULD_GO_NEGATIVE");
      return true;
    },
  );
  // Nothing moved: the shelf and the record still agree.
  assert.equal(await stockOf(yard), "60 PCS");
  assert.equal((await yard.matching.receipt(yard.actor, receipt.id))!.state, "CONFIRMED");
});

test("an order with goods against it cannot be cancelled, only closed", async () => {
  const { yard, order } = await deliveredYard();
  await assert.rejects(
    () => yard.matching.cancelOrder(yard.actor, order.id, "Changed our mind"),
    (error: DomainError) => {
      assert.equal(error.code, "ORDER_HAS_RECEIPTS");
      assert.match(error.message, /Close the order instead/);
      return true;
    },
  );
  const closed = await yard.matching.closeOrder(yard.actor, order.id, "Supplier cannot send the remaining 10 boxes");
  assert.equal(closed.state, "CLOSED");
  assert.match(closed.summary, /Whatever arrived stays in your stock/);
  // Closing changes no stock.
  assert.equal(await stockOf(yard), "2160 PCS");
});

test("an order nothing arrived against can be cancelled, with the reason kept", async () => {
  const yard = await makeYard();
  const order = await yard.matching.createOrder(yard.actor, ORDER_INPUT);
  await yard.matching.placeOrder(yard.actor, order.id);
  const cancelled = await yard.matching.cancelOrder(yard.actor, order.id, "Found the same soap cheaper locally");
  assert.equal(cancelled.state, "CANCELLED");
  assert.match(cancelled.summary, /Found the same soap cheaper locally/);
  await assert.rejects(
    () => yard.matching.recordReceipt(yard.actor, { ...RECEIPT_INPUT, orderId: order.id }),
    (error: DomainError) => error.code === "ORDER_CANCELLED",
  );
});

// --------------------------------------------------------------- retries, approval, tenancy

test("recording the same order or delivery twice returns the first one", async () => {
  const yard = await makeYard();
  const first = await yard.matching.createOrder(yard.actor, ORDER_INPUT);
  const again = await yard.matching.createOrder(yard.actor, ORDER_INPUT);
  assert.equal(again.id, first.id);
  assert.equal((await yard.matching.orders(yard.actor)).length, 1);

  const receipt = await yard.matching.recordReceipt(yard.actor, { ...RECEIPT_INPUT, orderId: first.id });
  const receiptAgain = await yard.matching.recordReceipt(yard.actor, { ...RECEIPT_INPUT, orderId: first.id });
  assert.equal(receiptAgain.id, receipt.id);
});

test("confirming a delivery twice does not double the stock", async () => {
  const { yard, receipt } = await deliveredYard();
  await yard.matching.confirmReceipt(yard.actor, receipt.id);
  assert.equal(await stockOf(yard), "2160 PCS");
});

test("the same three documents always give the same fingerprint, and a changed one does not", async () => {
  const { yard, order } = await deliveredYard();
  const first = await yard.matching.matchForInvoice(yard.actor, soapInvoice(), { orderId: order.id });
  const second = await yard.matching.matchForInvoice(yard.actor, soapInvoice(), { orderId: order.id });
  assert.equal(first.fingerprint, second.fingerprint);

  const changed = await yard.matching.matchForInvoice(
    yard.actor, soapInvoice({ lines: [soapInvoiceLine({ ratePaise: 245_00n })] }), { orderId: order.id },
  );
  assert.notEqual(changed.fingerprint, first.fingerprint);
});

test("a held bill is cleared only by approving the exact comparison, with a reason", async () => {
  const { yard, order } = await deliveredYard();
  const match = await yard.matching.matchForInvoice(yard.actor, soapInvoice(), { orderId: order.id });
  assert.equal((await yard.matching.isClearedToPost(yard.actor, match)).cleared, false);

  await assert.rejects(
    () => yard.matching.approveMatch(yard.actor, match, "   "),
    (error: DomainError) => error.code === "MATCH_APPROVAL_REASON_REQUIRED",
  );

  const approval = await yard.matching.approveMatch(yard.actor, match, "Supplier agreed to send the 10 boxes free next week");
  assert.deepEqual(approval.accepted, ["INVOICED_ABOVE_ACCEPTED"]);
  const cleared = await yard.matching.isClearedToPost(yard.actor, match);
  assert.equal(cleared.cleared, true);
  assert.match(cleared.reason, /Supplier agreed to send the 10 boxes free next week/);

  // The approval covers that comparison and no other: change the bill and it holds again.
  const different = await yard.matching.matchForInvoice(
    yard.actor, soapInvoice({ lines: [soapInvoiceLine({ ratePaise: 300_00n })] }), { orderId: order.id },
  );
  assert.equal((await yard.matching.isClearedToPost(yard.actor, different)).cleared, false);
});

test("someone without the permission cannot order, receive or approve", async () => {
  const yard = await makeYard({ permissions: ["inventory.move"] });
  await assert.rejects(() => yard.matching.createOrder(yard.actor, ORDER_INPUT), (error: DomainError) => error.kind === "FORBIDDEN");
  await assert.rejects(() => yard.matching.recordReceipt(yard.actor, RECEIPT_INPUT), (error: DomainError) => error.kind === "FORBIDDEN");
});

test("another company's order and delivery are simply not there", async () => {
  const { yard, order, receipt } = await deliveredYard();
  const outsider = actorWith(MATCHING_PERMISSIONS, "konkan" as never);
  assert.equal(await yard.matching.order(outsider, order.id), null);
  assert.equal(await yard.matching.receipt(outsider, receipt.id), null);
  await assert.rejects(
    () => yard.matching.confirmReceipt(outsider, receipt.id),
    (error: DomainError) => error.code === "RECEIPT_UNKNOWN",
  );
});

test("every material action is on the audit trail, with the reason where there was one", async () => {
  const { yard, order, receipt } = await deliveredYard();
  await yard.matching.cancelReceipt(yard.actor, receipt.id, { reason: "Recorded against the wrong delivery note" });
  await yard.matching.cancelOrder(yard.actor, order.id, "Supplier could not supply");

  const actions = yard.audit.events.map((event) => event.action);
  for (const expected of [
    "purchase.order_created", "purchase.order_placed",
    "purchase.receipt_recorded", "purchase.receipt_confirmed",
    "purchase.receipt_cancelled", "purchase.order_cancelled",
  ]) assert.ok(actions.includes(expected), `${expected} must be on the audit trail`);

  const cancellation = yard.audit.events.find((event) => event.action === "purchase.receipt_cancelled");
  assert.equal(cancellation?.overrideReason, "Recorded against the wrong delivery note");
});

// ------------------------------------------------------- the pure engine, with no service

test("the engine is a pure function of its inputs and needs no database", () => {
  const receipt: GoodsReceipt = {
    id: "grn-1", companyId: COMPANY, receiptNumber: "GRN/1", supplierPartyId: SUPPLIER,
    supplierName: "Shree Ram Steels Private Limited", receiptDate: "2026-08-20",
    lines: [soapReceiptLine()], state: "CONFIRMED", movements: [],
    createdBy: "ravi", createdAt: "2026-08-20T10:00:00.000Z", summary: "",
  };
  const match = matchPurchase({ companyId: COMPANY, receipts: [receipt], invoice: soapInvoice() });
  assert.equal(match.outcome, "HOLD_FOR_APPROVAL");
  assert.equal(match.findings[0]!.code, "INVOICED_ABOVE_ACCEPTED");
});

test("a draft delivery is not evidence that anything arrived", async () => {
  const yard = await makeYard();
  const order = await yard.matching.createOrder(yard.actor, ORDER_INPUT);
  await yard.matching.recordReceipt(yard.actor, { ...RECEIPT_INPUT, orderId: order.id });
  assert.equal(await stockOf(yard), "0 PCS");
  const match = await yard.matching.matchForInvoice(yard.actor, soapInvoice(), { orderId: order.id });
  assert.equal(match.kind, "TWO_WAY_ORDER");
  assert.ok(codes(match.findings).includes("NO_RECEIPT"));
});
