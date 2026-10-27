/**
 * Issue #344 — buying: what we know about a supplier (#19), the order, the delivery and the
 * comparison with the bill (#18), and recording the supplier's bill (#17).
 */
import { DemoApplication } from '../demo-application.ts';
import { ConnectorError } from '../../../../packages/platform/src/connectors.ts';
import { isWebhookChannel, purchaseInbox } from '../purchase-inbox-application.ts';
import { anything, fields, get, list, need, nothing, post, postCallingOut, publicRoute, replyJson, text, type Route } from './route.ts';

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

/** Issue #489 — what the inbox's own forms send. The company is never among them: it is the session's. */
const inboxUpload = fields({ fileId: text, einvoiceJson: text, fileName: text, source: text });
const inboxReason = fields({ reason: text });
const INBOX_SEE = need('see the purchase inbox', 'purchase.inbox.view');
const INBOX_MANAGE = need('deal with a held supplier bill', 'purchase.inbox.manage');
/** Checking and recording a bill from the inbox is the Purchase screen's own rule, plus being allowed to see the inbox. */
const INBOX_RECORD = need('record a supplier bill from the inbox', 'purchase.inbox.view', 'ledger.post.purchase');

export const PURCHASING_ROUTES: readonly Route[] = [
  // Issue #489 — the purchase inbox (#15): bills that arrived by upload, email or WhatsApp, and what became of them.
  list('/api/purchase-inbox', { access: INBOX_SEE, key: 'items' }, ({ runtime, context }) => purchaseInbox(runtime).list(context)),
  get('/api/purchase-inbox/:id', { access: INBOX_SEE, input: nothing }, ({ runtime, context, params }) => purchaseInbox(runtime).detail(context, params.id!)),
  // The inbox opens its own short units of work and reads the bill outside any of them (#366).
  postCallingOut('/api/purchase-inbox/upload', { access: need('add a supplier bill to the inbox', 'purchase.inbox.upload'), input: inboxUpload },
    ({ runtime, context, actor, input }) => purchaseInbox(runtime).upload(context, actor, input, runtime.database)),
  postCallingOut('/api/purchase-inbox/:id/retry', { access: INBOX_MANAGE, input: nothing }, ({ runtime, context, params }) => purchaseInbox(runtime).retry(context, params.id!)),
  postCallingOut('/api/purchase-inbox/:id/assign', { access: INBOX_MANAGE, input: inboxReason },
    ({ runtime, context, params, input }) => purchaseInbox(runtime).assign(context, params.id!, String(input.reason ?? ''))),
  postCallingOut('/api/purchase-inbox/:id/reject', { access: INBOX_MANAGE, input: inboxReason },
    ({ runtime, context, params, input }) => purchaseInbox(runtime).reject(context, params.id!, String(input.reason ?? ''), runtime.database)),
  // Checked and recorded through the same two calls as a typed bill (#16 checks, #17 posts); the inbox only keeps the note.
  post('/api/purchase-inbox/:id/preview', { access: INBOX_RECORD, input: purchase }, async ({ runtime, context, app, actor, params, input }) => {
    await purchaseInbox(runtime).requireBillable(context, params.id!);
    return { ...await app.previewPurchase(actor, input), documentId: params.id! };
  }),
  post('/api/purchase-inbox/:id/record', { access: INBOX_RECORD, input: purchase }, async ({ runtime, context, app, actor, params, input }) => {
    const inbox = purchaseInbox(runtime);
    const draft = await inbox.requireBillable(context, params.id!);
    const recorded = await app.recordPurchase(actor, input);
    await inbox.markBilled(context, params.id!, { billNumber: recorded.bill.number, supplierName: recorded.bill.supplier });
    return { ...recorded, documentId: params.id!, corrections: inbox.corrections(draft, input) };
  }),
  // Issue #489 — the email and WhatsApp providers' signed deliveries. No session: the signature over the bytes is the proof,
  // and the company is the address the bill was delivered to, never anything the sender wrote.
  post('/api/webhooks/purchase-inbox/:channel', { access: publicRoute('the email or WhatsApp provider proves itself by signing the bytes it sent'), input: anything },
    async ({ runtime, params, delivery }) => {
      if (!isWebhookChannel(params.channel!)) return replyJson(404, { state: 'failed', title: 'Not found', message: 'That is not a delivery address for bills.' });
      try {
        const received = await purchaseInbox(runtime).receiveDelivery(params.channel!, delivery?.rawBody ?? '', delivery?.signature ?? '');
        return replyJson(202, { state: 'received', ...received });
      } catch (error) {
        // Told nothing but that it did not verify, or that what it sent could not be read.
        if (error instanceof ConnectorError && error.code === 'UNAUTHORIZED') return replyJson(401, { state: 'failed', title: 'Not allowed', message: 'This delivery could not be verified, so it was not read.' });
        if (error instanceof ConnectorError && error.code === 'INVALID_REQUEST') return replyJson(400, { state: 'failed', title: 'Not understood', message: 'This delivery was not in the form bills are delivered in, so it was not read.' });
        throw error;
      }
    }),

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
