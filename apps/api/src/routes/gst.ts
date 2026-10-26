/**
 * Issue #344 — the government side: e-invoices (#26), e-way bills (#27, #191, #240), vehicle checks
 * (#28), purchase tax credit against the government's record (#31) and GST returns (#30).
 */
import { DemoApplication } from '../demo-application.ts';
import { anything, fields, get, need, needAny, nothing, list, post, replyPdf, text, REFERENCE, type Route } from './route.ts';

const EINVOICE = need('register e-invoices', 'einvoice.generate');
const EWAY_VIEW = need('see e-way bills', 'eway.view');
const EWAY_MAKE = need('make e-way bills', 'eway.generate');
const EWAY_CHANGE = need('change e-way bills', 'eway.update');
const EWAY_CANCEL = need('cancel or reject e-way bills', 'eway.cancel');
const VEHICLES = need('check vehicles', 'transport.vehicle.check');
const ITC_IMPORT = need('bring in the government purchase record', 'itc.import');

const einvoice = fields({ invoice: text, reasonCode: text, reason: text });
/** One bill's movement. `vehicle` and the ship-to fields are read by the delivery service, which accepts either shape. */
const eway = fields({
  invoice: text, distanceKm: text, vehicle: anything, withinSameCity: text, oversized: anything, reason: text, reasonCode: text,
  fromPlace: text, fromState: text, changeReason: text, changeNote: text, currentPlace: text, currentState: text, remainingKm: text,
});
const vehicle = fields({
  invoice: text, vehicle: text, weightKg: text, distanceKm: text, interState: text, transporterId: text, coldChain: text, hazardous: text,
  platePhoto: text, plateTyped: text, declaredClass: text, declaredCapacityKg: text, checkId: text, reason: text, findingCodes: anything,
});
const period = fields({ period: text });
const itc = fields({
  period: text, content: text, fileName: text, decision: text, lineKey: text, reason: text, reference: text, requestId: text,
  gstin: text, supplierName: text, kind: text, number: text, date: text, taxableValue: text, cgst: text, sgst: text, igst: text, invoiceValue: text, itcAvailable: text,
});
const gstReturn = fields({ period: text, reference: text, note: text, reason: text, returnType: text });

export const GST_ROUTES: readonly Route[] = [
  // Issue #26 — does this bill need an IRN, and its life with the government.
  list('/api/einvoices/invoices', { access: needAny('see issued bills', 'einvoice.view', 'sales.view'), key: 'invoices' }, ({ app, actor }) => app.issuedInvoices(actor)),
  post('/api/einvoices/preview', { access: need('see e-invoices', 'einvoice.view'), input: einvoice }, ({ app, actor, input }) => app.previewEInvoice(actor, input)),
  post('/api/einvoices/register', { access: EINVOICE, input: einvoice }, ({ app, actor, input }) => app.registerEInvoice(actor, input)),
  post('/api/einvoices/reconcile', { access: EINVOICE, input: einvoice }, ({ app, actor, input }) => app.reconcileEInvoice(actor, input)),
  post('/api/einvoices/cancel', { access: need('cancel e-invoices', 'einvoice.cancel'), input: einvoice }, ({ app, actor, input }) => app.cancelEInvoice(actor, input)),
  post('/api/einvoices/offline', { access: EINVOICE, input: einvoice }, ({ app, actor, input }) => app.eInvoiceOfflineJson(actor, input)),

  // Issue #27 — do these goods need an e-way bill, and its life with the portal.
  get('/api/eway/states', { access: REFERENCE, input: nothing }, () => DemoApplication.ewayStates()),
  list('/api/eway/on-the-road', { access: EWAY_VIEW, key: 'consignments' }, ({ app, actor }) => app.ewayBillsOnTheRoad(actor)),
  post('/api/eway/preview', { access: EWAY_VIEW, input: eway }, ({ app, actor, input }) => app.previewEwayBill(actor, input)),
  // Issue #240 — the bills to choose from, and one bill's e-way bill filled in from the bill.
  list('/api/eway/bills', { access: EWAY_VIEW, key: 'invoices' }, ({ app, actor }) => app.ewayBillChoices(actor)),
  post('/api/eway/for-bill', { access: EWAY_VIEW, input: eway }, ({ app, actor, input }) => app.ewayBillForBill(actor, input)),
  post('/api/eway/generate', { access: EWAY_MAKE, input: eway }, ({ app, actor, input }) => app.generateEwayBill(actor, input)),
  post('/api/eway/vehicle', { access: EWAY_CHANGE, input: eway }, ({ app, actor, input }) => app.updateEwayVehicle(actor, input)),
  post('/api/eway/extend', { access: EWAY_CHANGE, input: eway }, ({ app, actor, input }) => app.extendEwayValidity(actor, input)),
  post('/api/eway/cancel', { access: EWAY_CANCEL, input: eway }, ({ app, actor, input }) => app.cancelEwayBill(actor, input)),
  post('/api/eway/reject', { access: EWAY_CANCEL, input: eway }, ({ app, actor, input }) => app.rejectEwayBill(actor, input)),
  post('/api/eway/reconcile', { access: EWAY_MAKE, input: eway }, ({ app, actor, input }) => app.reconcileEwayBill(actor, input)),
  post('/api/eway/offline', { access: EWAY_MAKE, input: eway }, ({ app, actor, input }) => app.ewayOfflineJson(actor, input)),
  // Issue #191 — the driver's copy: the portal's own page, on screen and as a PDF.
  post('/api/eway/print', { access: EWAY_VIEW, input: eway }, ({ app, actor, input }) => app.ewayPrint(actor, input)),
  get('/api/eway/:invoice/pdf', { access: EWAY_VIEW, input: nothing }, async ({ app, actor, params }) => {
    const result = await app.ewayPrint(actor, { invoice: params.invoice! }, { pdf: true });
    if (!('pdf' in result)) throw new TypeError('The e-way bill PDF was not produced.');
    return replyPdf(`eway-${result.ewayBillNumber.replace(/[^0-9]/g, '')}.pdf`, result.pdf);
  }),

  // Issue #28 — can this lorry carry this load, and who said to send it anyway.
  get('/api/vehicles/choices', { access: need('see vehicles', 'transport.vehicle.view'), input: nothing }, () => DemoApplication.vehicleChoices()),
  list('/api/vehicles/held', { access: need('see vehicles', 'transport.vehicle.view'), key: 'held' }, ({ app, actor }) => app.blockedVehicleChecks(actor)),
  post('/api/vehicles/record', { access: VEHICLES, input: vehicle }, ({ app, actor, input }) => app.lookupVehicleRecord(actor, input)),
  post('/api/vehicles/check', { access: VEHICLES, input: vehicle }, ({ app, actor, input }) => app.checkVehicle(actor, input)),
  post('/api/vehicles/check/override', { access: need('send a held vehicle anyway', 'transport.vehicle.override'), input: vehicle },
    ({ app, actor, input }) => app.overrideVehicleCheck(actor, input)),

  // Issue #31 — your purchases against what your suppliers told the government.
  post('/api/itc', { access: need('see purchase tax credit', 'itc.view'), input: period }, ({ app, actor, input }) => app.itcWorkspace(actor, input)),
  post('/api/itc/import', { access: ITC_IMPORT, input: itc }, ({ app, actor, input }) => app.importItcFile(actor, input)),
  post('/api/itc/typed', { access: ITC_IMPORT, input: itc }, ({ app, actor, input }) => app.addTypedItcRecord(actor, input)),
  post('/api/itc/decide', { access: need('decide on purchase tax credit', 'itc.decide'), input: itc }, ({ app, actor, input }) => app.decideItcLine(actor, input)),
  // Issue #30 — the month's GST returns: what they say, what stops them, and the file to upload.
  post('/api/gst-returns', { access: need('see GST returns', 'gst_returns.view'), input: gstReturn }, ({ app, actor, input }) => app.gstReturnWorkspace(actor, input)),
  post('/api/gst-returns/prepare', { access: need('prepare GST returns', 'gst_returns.prepare'), input: gstReturn }, ({ app, actor, input }) => app.prepareGstReturn(actor, input)),
  post('/api/gst-returns/approve', { access: need('approve GST returns', 'gst_returns.approve'), input: gstReturn }, ({ app, actor, input }) => app.approveGstReturn(actor, input)),
  post('/api/gst-returns/reopen', { access: need('reopen GST returns', 'gst_returns.reopen'), input: gstReturn }, ({ app, actor, input }) => app.reopenGstReturn(actor, input)),
  post('/api/gst-returns/export', { access: need('download GST returns', 'gst_returns.export'), input: gstReturn }, ({ app, actor, input }) => app.exportGstReturn(actor, input)),
];
