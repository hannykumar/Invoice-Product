/**
 * Issue #18 [E18] — the whole story on a terminal, with no database.
 *
 *   npm run demo:matching
 *
 * Sampoorna Traders of Bengaluru orders 100 boxes of soap, 90 arrive fit to sell, and the bill
 * charges for all 100. Every figure below is produced by the real services, not printed by hand.
 */
import { quantityFromString } from "@invoice/kernel";
import { showQuantity } from "./matching.ts";
import { formatPaise } from "./money.ts";
import {
  ORDER_INPUT, RECEIPT_INPUT, makeYard, soapInvoice, soapInvoiceLine, soapReceiptLine,
} from "./matching-fixtures.ts";

const heading = (text: string): void => console.log(`\n${text}\n${"─".repeat(text.length)}`);
const box = (value: string) => quantityFromString(value, "BOX");

const shelf = async (yard: Awaited<ReturnType<typeof makeYard>>): Promise<string> => {
  const balance = await yard.inventoryService.balance(yard.actor, {
    itemId: "SOAP", warehouseId: "wh-main", batchId: "batch-aug",
  });
  return showQuantity(balance.physical);
};

const showMatch = (match: Awaited<ReturnType<Awaited<ReturnType<typeof makeYard>>["matching"]["matchForInvoice"]>>): void => {
  console.log(`Outcome: ${match.outcome} (${match.kind})`);
  console.log(match.summary);
  console.log("");
  for (const line of match.lines) {
    console.log(`  ${line.description}`);
    console.log(`    ordered  ${line.orderedQuantity === undefined ? "—" : showQuantity(line.orderedQuantity)}`);
    console.log(`    arrived  ${line.receivedQuantity === undefined ? "—" : showQuantity(line.receivedQuantity)}`);
    console.log(`    kept     ${line.acceptedQuantity === undefined ? "—" : showQuantity(line.acceptedQuantity)}`);
    console.log(`    billed   ${line.invoicedQuantity === undefined ? "—" : showQuantity(line.invoicedQuantity)}`);
    if (line.orderedRatePaise !== undefined) console.log(`    agreed price ${formatPaise(line.orderedRatePaise)} · billed price ${formatPaise(line.invoicedRatePaise ?? 0n)}`);
  }
  console.log("");
  for (const finding of match.findings) {
    console.log(`  [${finding.severity.padEnd(11)}] ${finding.field}`);
    console.log(`                ${finding.message}`);
  }
};

const yard = await makeYard();

heading("1. Sampoorna Traders orders 100 boxes of soap at ₹240 a box");
const order = await yard.matching.createOrder(yard.actor, ORDER_INPUT);
const placed = await yard.matching.placeOrder(yard.actor, order.id);
console.log(placed.summary);
console.log(`Committed value: ${formatPaise(placed.orderedValuePaise)}`);
console.log(`Soap in the Peenya godown: ${await shelf(yard)}  ← an order moves no stock`);

heading("2. The lorry brings 100 boxes; 10 are soaked and turned away at the gate");
const receipt = await yard.matching.recordReceipt(yard.actor, { ...RECEIPT_INPUT, orderId: order.id });
console.log(receipt.summary);
console.log(`Soap in the godown before confirming: ${await shelf(yard)}`);
const confirmed = await yard.matching.confirmReceipt(yard.actor, receipt.id);
console.log(confirmed.summary);
console.log(`Soap in the godown after confirming:  ${await shelf(yard)}  ← 90 boxes × 24 pieces`);
console.log(`Order is now: ${(await yard.matching.order(yard.actor, order.id))!.state}`);

heading("3. The supplier's bill charges for all 100 boxes");
const held = await yard.matching.matchForInvoice(yard.actor, soapInvoice(), { orderId: order.id });
showMatch(held);
console.log(`\nCan this bill be recorded? ${(await yard.matching.isClearedToPost(yard.actor, held)).cleared ? "yes" : "no — it is waiting for a person"}`);

heading("4. The owner accepts the difference, with a reason kept on record");
await yard.matching.approveMatch(yard.actor, held, "Supplier agreed to send the 10 boxes free next week");
const cleared = await yard.matching.isClearedToPost(yard.actor, held);
console.log(`Can this bill be recorded now? ${cleared.cleared ? "yes" : "no"}`);
console.log(cleared.reason);

heading("5. Had the supplier billed only for the 90 boxes kept, nothing would have held it up");
showMatch(await yard.matching.matchForInvoice(
  yard.actor,
  soapInvoice({ invoiceNumber: "SRS/2026/0089", lines: [soapInvoiceLine({ quantity: box("90") })] }),
  { orderId: order.id },
));

heading("6. The corner shop with no order at all: goods confirmed in one step");
const small = await yard.matching.goodsConfirmed(yard.actor, {
  receiptNumber: "GRN/2026/0410",
  supplierPartyId: RECEIPT_INPUT.supplierPartyId,
  supplierName: RECEIPT_INPUT.supplierName,
  receiptDate: "2026-08-26",
  lines: [soapReceiptLine({
    orderLineNumber: undefined, receivedQuantity: box("12"), acceptedQuantity: box("12"),
    rejectionReason: undefined, rejectionNote: undefined, evidence: undefined,
  })],
});
console.log(small.summary);
console.log(`Soap in the godown: ${await shelf(yard)}`);
showMatch(await yard.matching.matchForInvoice(
  yard.actor,
  soapInvoice({ invoiceNumber: "SRS/2026/0912", lines: [soapInvoiceLine({ quantity: box("12") })] }),
  { receiptIds: [small.id] },
));
console.log("");
