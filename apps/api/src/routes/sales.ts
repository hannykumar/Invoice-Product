/**
 * Issue #344 — bills, their print and PDF, cancelling them, money received and paid, quotations and
 * proforma invoices, delivery challans, and returns with their credit and debit notes.
 */
import { ChallanDesk } from '../challan-application.ts';
import { anything, fields, get, need, needAny, nothing, list, post, replyPdf, text, REFERENCE, type Route } from './route.ts';

const DRAFT = need('start a bill', 'sales.draft.write');
const CHALLANS = need('issue delivery challans', 'challan.issue');
const PRESALE = needAny('make quotations or proforma invoices', 'quotation.issue', 'proforma.issue');
const MONEY = need('record money received or paid', 'payments.record');
const RETURNS = need('record returns', 'returns.create');
const SALES_VIEW = need('see bills, quotations and challans', 'sales.view');
const RETURNS_VIEW = needAny('see returns and credit or debit notes', 'sales.view', 'purchases.view');

const safeFileName = (number: string): string => `${number.replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf`;

/**
 * A bill being typed. `lines` is a list of lines or one line's fields at the top level; the sale
 * service reads either. `price` arrives as `10.5` from the web app and as text from tests.
 */
const sale = fields({
  customerId: text, customer: text, party: text, date: text, terms: text, notes: anything,
  lines: anything, itemId: anything, item: anything, quantity: anything, unit: anything, rate: anything,
  freight: anything, otherCharges: anything, paidBy: text, paidAmount: anything, distanceKm: text,
  underLut: anything, exportCurrency: text, shippingBillNumber: text, shippingBillDate: text, portCode: text, exportCountry: text, exchangeRate: text,
});
const cancel = fields({ invoice: text, reason: text, cancelGovernmentDocuments: anything });
/** Money in or out. `bills` arrives both as a list and as its JSON text: the payment service reads both. */
const payment = fields({
  direction: text, partyId: text, party: text, amount: anything, date: text, method: text, mode: text,
  chequeNumber: text, chequeDate: text, reference: text, requestId: text,
  bills: anything, invoices: anything, invoice: anything, advance: anything,
  purchaseOrderNumber: text, purchaseOrderDate: text, supplierReceiptNumber: text, supplierReceiptDate: text,
});
const challan = fields({
  challan: text, customerId: text, customer: text, party: text, reason: text, reasonNote: text, deliveryState: text, deliveryPlace: text,
  itemId: text, item: text, date: text, quantity: text, unit: text, rate: anything, reference: anything,
  invoice: text, ewayBillNumber: text, vehicle: text, transporter: text, locale: anything, format: anything, copy: text,
  terms: text, ewayBillCancelledOnPortal: anything,
});
const presale = fields({
  kind: text, document: text, customerId: text, customer: text, party: text, itemId: text, item: text, date: text, validUntil: anything,
  quantity: text, unit: text, rate: anything, terms: anything, purpose: anything, buyerOrderNumber: anything, paymentTerms: anything,
  reference: anything, bankDetails: anything, invoice: text, reason: text, locale: anything, format: anything, token: text,
});
const advance = fields({ document: text, advance: text, amount: anything, date: text, mode: text, utr: anything, reason: text, reference: anything, which: anything });
const goodsReturn = fields({
  kind: text, documentId: text, lineId: text, reference: anything, date: text, reason: text, disposition: text,
  quantity: text, unit: text, supplierNoteNumber: text, supplierNoteDate: text, noteId: text,
});

export const SALES_ROUTES: readonly Route[] = [
  // Issue #306 — the live GST and total while a bill is typed. Stores nothing.
  post('/api/sales/estimate', { access: DRAFT, input: sale }, ({ app, actor, input }) => app.estimateSale(actor, input)),
  post('/api/sales/preview', { access: DRAFT, input: sale }, ({ app, actor, input }) => app.previewSale(actor, input)),
  post('/api/sales/record', { access: need('issue a bill', 'sales.draft.write', 'sales.finalise'), input: sale }, ({ app, actor, input }) => app.recordSale(actor, input)),
  // Issue #233 — cancelling a wrong bill: what it will do, then doing it. Refused with the credit-note
  // route once the bill's month is approved or filed.
  post('/api/sales/cancel/preview', { access: need('cancel a bill', 'sales.cancel'), input: cancel }, ({ app, actor, input }) => app.previewCancelSale(actor, input)),
  post('/api/sales/cancel', { access: need('cancel a bill', 'sales.cancel'), input: cancel }, ({ app, actor, input }) => app.cancelSale(actor, input)),
  // Issue #132 — the finished bill, on screen and ready for the printer, in the chosen language and on
  // the paper it will be printed on. Issue #183: `copies: "all"` is the business's own printer taking
  // the whole marked set in one job; everything else, and every PDF a customer receives, is the Original.
  post('/api/sales/print', { access: need('print bills', 'sales.draft.write'), input: fields({ invoice: text, format: anything, locale: anything, copies: anything }) },
    ({ app, actor, input }) => app.invoicePrint(actor, String(input.invoice ?? ''), { format: input.format, locale: input.locale, allCopies: input.copies === 'all' })),
  // Issue #133 — the PDF comes off the same page.
  get('/api/sales/:invoice/pdf', { access: SALES_VIEW, input: nothing }, async ({ app, actor, params }) => {
    const result = await app.invoicePrint(actor, params.invoice!, { pdf: true });
    if (!('pdf' in result)) throw new TypeError('The bill PDF was not produced.');
    return replyPdf(safeFileName(result.number), result.pdf);
  }),
  get('/api/sales/:invoice/preview', { access: SALES_VIEW, input: nothing }, ({ app, actor, params }) => app.invoicePrint(actor, params.invoice!)),

  post('/api/payments/preview', { access: MONEY, input: payment }, ({ app, actor, input }) => app.previewPayment(actor, input)),
  post('/api/payments/record', { access: MONEY, input: payment }, ({ app, actor, input }) => app.recordPayment(actor, input)),
  // Issue #230 — the chosen customer's or supplier's own open bills, and the receipt or payment voucher.
  post('/api/payments/open-bills', { access: MONEY, input: payment }, ({ app, actor, input }) => app.paymentOpenBills(actor, input)),
  post('/api/payments/voucher', { access: MONEY, input: fields({ paymentId: text }) }, ({ app, actor, input }) => app.paymentVoucher(actor, input)),

  // Issue #142 — quotations and proforma invoices: the papers sent before a sale. None of these posts
  // anything; a quotation becomes a sale only through the ordinary sale, as a draft first.
  list('/api/presale', { access: SALES_VIEW, key: 'documents' }, ({ app, actor }) => app.presale.list(actor)),
  post('/api/presale/preview', { access: PRESALE, input: presale }, ({ app, actor, input }) => app.presale.preview(actor, input)),
  post('/api/presale/issue', { access: PRESALE, input: presale }, ({ app, actor, input }) => app.presale.issue(actor, input)),
  post('/api/presale/print', { access: PRESALE, input: presale }, ({ app, actor, input }) => app.presale.print(actor, input)),
  post('/api/presale/convert', { access: need('turn a quotation into a bill', 'quotation.issue', 'sales.draft.write'), input: presale }, ({ app, actor, input }) => app.convertQuotation(actor, input)),
  post('/api/presale/issue-sale', { access: need('issue a bill', 'sales.draft.write', 'sales.finalise'), input: presale }, ({ app, actor, input }) => app.issueConvertedSale(actor, input)),
  post('/api/presale/link-invoice', { access: PRESALE, input: presale }, ({ app, actor, input }) => app.presale.linkInvoice(actor, input)),
  post('/api/presale/cancel', { access: needAny('withdraw quotations or proforma invoices', 'quotation.cancel', 'proforma.cancel'), input: presale },
    ({ app, actor, input }) => app.presale.cancel(actor, input)),
  // Issue #165 — money received against a proforma: the receipt voucher, and the refund voucher.
  post('/api/presale/advances', { access: MONEY, input: advance }, ({ app, actor, input }) => app.presale.advances(actor, input)),
  post('/api/presale/advance', { access: MONEY, input: advance }, ({ app, actor, input }) => app.presale.recordAdvance(actor, input)),
  post('/api/presale/refund-advance', { access: MONEY, input: advance }, ({ app, actor, input }) => app.presale.refundAdvance(actor, input)),
  post('/api/presale/voucher', { access: MONEY, input: advance }, ({ app, actor, input }) => app.presale.printVoucher(actor, input)),

  // Issue #141 — delivery challans: goods that move before the bill exists.
  get('/api/challans/reasons', { access: REFERENCE, input: nothing }, () => ChallanDesk.reasons()),
  list('/api/challans', { access: SALES_VIEW, key: 'challans' }, ({ app, actor }) => app.challans.list(actor)),
  list('/api/challans/movable', { access: SALES_VIEW, key: 'challans' }, async ({ app, actor }) => ({ challans: await app.challans.movable(actor) })),
  post('/api/challans/preview', { access: CHALLANS, input: challan }, ({ app, actor, input }) => app.challans.preview(actor, input)),
  post('/api/challans/issue', { access: CHALLANS, input: challan }, ({ app, actor, input }) => app.challans.issue(actor, input)),
  post('/api/challans/print', { access: CHALLANS, input: challan }, ({ app, actor, input }) => app.challans.print(actor, input)),
  post('/api/challans/eway', { access: CHALLANS, input: challan }, ({ app, actor, input }) => app.challans.attachEwayBill(actor, input)),
  post('/api/challans/link-invoice', { access: CHALLANS, input: challan }, ({ app, actor, input }) => app.challans.linkInvoice(actor, input)),
  post('/api/challans/cancel', { access: need('cancel delivery challans', 'challan.cancel'), input: challan }, ({ app, actor, input }) => app.challans.cancel(actor, input)),
  // Issue #290 — bill the goods a challan sent, from the challan itself.
  post('/api/challans/bill', { access: need('make bills', 'sales.finalise'), input: challan }, ({ app, actor, input }) => app.billChallan(actor, input)),

  list('/api/returns/documents', { access: RETURNS_VIEW, key: 'documents' }, ({ app, actor }) => app.returnDocuments(actor)),
  post('/api/returns/preview', { access: RETURNS, input: goodsReturn }, ({ app, actor, input }) => app.previewReturn(actor, input)),
  post('/api/returns/record', { access: RETURNS, input: goodsReturn }, ({ app, actor, input }) => app.recordReturn(actor, input)),
  // Issue #249 — the supplier's credit note for goods sent back, added when it arrives.
  post('/api/returns/supplier-note', { access: RETURNS, input: goodsReturn }, ({ app, actor, input }) => app.recordSupplierCreditNote(actor, input)),
  // Issue #186 — the credit or debit note on paper: listed, printed, and downloaded as a PDF.
  list('/api/returns/notes', { access: RETURNS_VIEW, key: 'notes' }, ({ app, actor }) => app.listReturnNotes(actor)),
  post('/api/returns/print', { access: RETURNS, input: fields({ note: text, format: anything, locale: anything }) },
    ({ app, actor, input }) => app.notePrint(actor, String(input.note ?? ''), { format: input.format, locale: input.locale })),
  get('/api/returns/:note/pdf', { access: RETURNS_VIEW, input: nothing }, async ({ app, actor, params }) => {
    const result = await app.notePrint(actor, params.note!, { pdf: true });
    if (!('pdf' in result)) throw new TypeError('The note PDF was not produced.');
    return replyPdf(safeFileName(result.number), result.pdf);
  }),
];
