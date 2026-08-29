/**
 * Issue #26 [E26] — the whole lifecycle on a terminal, with no database and no credential.
 *
 *   npm run demo:einvoice
 *
 * Sampoorna Traders of Bengaluru sells cement to a buyer in Pune. Every figure below comes from
 * the real services; the Invoice Registration Portal is synthetic and behind #8's gateway.
 */
import { decideApplicability } from "./applicability.ts";
import { toOfflineJson } from "./payload.ts";
import {
  aboveThreshold, belowThreshold, invoiceDocument, makeEInvoiceDesk,
} from "./einvoice-fixtures.ts";

const heading = (text: string): void => console.log(`\n${text}\n${"─".repeat(text.length)}`);

const showDecision = (label: string, decision: ReturnType<typeof decideApplicability>): void => {
  console.log(`${label}`);
  console.log(`  → ${decision.outcome}`);
  console.log(`  ${decision.reason}`);
  console.log(`  Rule ${decision.ruleId}${decision.sourceRef === undefined ? "" : ` · ${decision.sourceRef}`}`);
};

heading("1. Does this bill even need an e-invoice number?");
showDecision("A trader turning over ₹90 lakh:", decideApplicability(belowThreshold()));
console.log("");
showDecision("The same bill, from a business turning over ₹8 crore:", decideApplicability(aboveThreshold()));
console.log("");
showDecision("A ₹900 crore business selling to a walk-in customer:", decideApplicability(aboveThreshold({
  recipientKind: "B2C", recipientGstin: undefined,
  supplier: { gstin: aboveThreshold().supplier.gstin, aggregateTurnoverPaise: 900_00_00_000_00n },
})));
console.log("");
showDecision("A business that has not told us its turnover:", decideApplicability(aboveThreshold({
  supplier: { gstin: aboveThreshold().supplier.gstin },
})));

const desk = makeEInvoiceDesk();

heading("2. What will be sent, before anything is sent");
const preview = await desk.service.preview(desk.actor, { document: invoiceDocument(), applicability: aboveThreshold() });
console.log(preview.summary);
console.log(`Ready to send: ${preview.ready}`);
console.log(`The e-invoice number this bill will get: ${preview.expectedIrn}`);
console.log(`Must be reported by: ${preview.reportableUntil}`);
console.log(`Registered with the government so far: ${desk.portal.registeredIrns().length}`);

heading("3. Sending it");
const registered = await desk.service.register(desk.actor, { document: invoiceDocument(), applicability: aboveThreshold() });
console.log(`Status: ${registered.status}`);
console.log(registered.message);
console.log(`IRN:            ${registered.acknowledgement?.irn}`);
console.log(`Acknowledgement: ${registered.acknowledgement?.ackNumber} on ${registered.acknowledgement?.ackDate}`);
console.log(`Signed QR:      ${registered.acknowledgement?.signedQrCode.slice(0, 48)}…`);
console.log(`Can be cancelled until: ${registered.cancellableUntil}`);
console.log(`It matches what we predicted: ${registered.acknowledgement?.irn === preview.expectedIrn}`);

heading("4. Pressing the button again");
const again = await desk.service.register(desk.actor, { document: invoiceDocument(), applicability: aboveThreshold() });
console.log(again.message);
console.log(`Same record: ${again.id === registered.id}`);
console.log(`IRNs at the government: ${desk.portal.registeredIrns().length}`);

heading("5. What happens when the portal is down");
const outageDesk = makeEInvoiceDesk();
outageDesk.portal.setMode("outage");
const failed = await outageDesk.service.register(outageDesk.actor, { document: invoiceDocument(), applicability: aboveThreshold() });
console.log(`Status: ${failed.status}   ← not REGISTERED, because we do not know that it is`);
console.log(failed.message);
console.log("\nAnd the bill can still be exported for manual upload:");
const offline = JSON.parse(toOfflineJson(invoiceDocument()));
console.log(`  ${JSON.stringify(offline.InvoiceList[0].DocDtls)}`);
console.log(`  note: ${offline._karobar.note}`);

heading("6. Cancelling it, inside the government's window");
const cancelled = await desk.service.cancel(desk.actor, "inv-001", {
  reasonCode: "DATA_ENTRY_MISTAKE",
  reason: "The buyer's GST number was typed wrong",
});
console.log(`Status: ${cancelled.status}`);
console.log(cancelled.message);
console.log("");
