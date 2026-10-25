/**
 * Issue #344 — buying: what we know about a supplier (#19), the order, the delivery and the
 * comparison with the bill (#18), and recording the supplier's bill (#17).
 */
import { DemoApplication } from '../demo-application.ts';
import { anything, fields, get, list, need, nothing, post, text, type Route } from './route.ts';

const RECORD_BILL = need('record a supplier bill', 'ledger.post.purchase');

const supplierCheck = fields({ gstin: text, party: text, stateCode: anything, reference: anything, date: anything, refresh: anything, modelHint: anything, reason: text });
/** An order, a delivery or a bill against them. `item`, `party` and the quantities are read by the matching service in either shape. */
const matching = fields({
  orderNumber: text, receiptNumber: text, reference: text, date: text, reason: text,
  item: anything, party: anything, quantity: anything, received: anything, accepted: anything, rate: anything, gst: text,
  deliveryNote: anything, rejectionReason: anything, rejectionNote: anything,
});
/** A supplier's bill. `lines` is a list of lines, or one line's fields at the top level. */
const purchase = fields({
  supplierId: text, supplier: text, party: text, reference: text, date: text,
  lines: anything, itemId: anything, item: anything, quantity: anything, unit: anything, rate: anything, gst: anything, amount: anything, useAdvance: anything,
  // Issue #289, part 2b — the day the goods or service reached the business (reverse-charge time of supply).
  receivedOn: text,
});
/** Issue #289, part 2b — a self-invoice for a purchase from an unregistered supplier. */
const selfInvoice = fields({ billId: text, date: text, idempotencyKey: text });

export const PURCHASING_ROUTES: readonly Route[] = [
  // Issue #19 — what we know about a supplier, and the evidence behind each warning.
  get('/api/suppliers/choices', { access: need('see suppliers', 'masters.read'), input: nothing }, () => ({ choices: DemoApplication.supplierChoices() })),
  post('/api/suppliers/check', { access: need('check suppliers', 'supplier.risk.view'), input: supplierCheck }, ({ app, actor, input }) => app.checkSupplier(actor, input)),
  post('/api/suppliers/check/acknowledge', { access: need('accept a supplier warning', 'supplier.risk.acknowledge'), input: supplierCheck },
    ({ app, actor, input }) => app.acknowledgeSupplierRisk(actor, input)),
  // Issue #18 — the order, the delivery and the comparison between them and the bill.
  post('/api/purchase-orders', { access: need('record purchase orders', 'purchase.order.write'), input: matching }, ({ app, actor, input }) => app.recordOrder(actor, input)),
  post('/api/goods-receipts', { access: need('record goods received', 'purchase.receipt.write'), input: matching }, ({ app, actor, input }) => app.recordReceipt(actor, input)),
  post('/api/purchases/match', { access: RECORD_BILL, input: matching }, ({ app, actor, input }) => app.matchPurchaseBill(actor, input)),
  post('/api/purchases/match/approve', { access: need('approve a held supplier bill', 'purchase.match.approve'), input: matching },
    ({ app, actor, input }) => app.approvePurchaseMatch(actor, input)),
  post('/api/purchases/preview', { access: RECORD_BILL, input: purchase }, ({ app, actor, input }) => app.previewPurchase(actor, input)),
  post('/api/purchases/record', { access: RECORD_BILL, input: purchase }, ({ app, actor, input }) => app.recordPurchase(actor, input)),
  // Issue #289, part 2b — the self-invoice (CGST s.31(3)(f), Rule 47A): issue it, print it, and the list of those due.
  post('/api/purchases/self-invoice', { access: RECORD_BILL, input: selfInvoice }, ({ app, actor, input }) => app.issueSelfInvoice(actor, input)),
  post('/api/purchases/self-invoice/print', { access: RECORD_BILL, input: selfInvoice }, ({ app, actor, input }) => app.selfInvoicePrint(actor, input)),
  list('/api/purchases/self-invoices', { access: need('see supplier bills', 'purchases.view'), key: 'items' }, ({ app, actor }) => app.selfInvoiceList(actor)),
  get('/api/purchases/:id', { access: need('see supplier bills', 'purchases.view'), input: nothing }, ({ app, actor, params }) => app.purchase(actor, params.id!)),
];
