/**
 * Issue #279 — a sale to a customer without a GST number is a consumer sale on GSTR-1, not a B2B
 * bill with a blank GST number that blocks the whole month.
 *
 * Driven through the app over HTTP, as the screens drive it: a walk-in cash sale at the counter in
 * Karnataka and two sales to an unregistered builder in Tamil Nadu, one above the ₹1,00,000 line
 * (B2CL) and one below it (B2CS). The month is prepared, approved and exported with no blocking
 * question, and GSTR-3B table 3.2 names Tamil Nadu. A credit note to a consumer (in August, so the
 * September figures stay the worked example's) goes to B2CS, never CDNR.
 *
 * Every name, GST number and address below is synthetic and belongs to nobody.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { useFixedAppClock } from '../../apps/api/src/app-clock.ts';
import { webServer } from '../../apps/web/server.ts';
import { stockEverything } from '../../apps/api/test/stock-helper.ts';

useFixedAppClock('2026-09-27T04:30:00.000Z');

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const MONTH = '2026-09';
const SOAP = 'Herbal Bath Soap 100g';
const STEEL = 'TMT Steel Bar 12mm';

let base = '';
let session = '';

before(async () => {
  await new Promise<void>((resolve) => webServer.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(webServer.address() as AddressInfo).port}`;
  const signedIn = await ok('POST', '/api/auth/login', { companyId: SAMPOORNA, email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' });
  session = signedIn.sessionId as string;
  await stockEverything(`Bearer ${session}`);
});

after(async () => {
  await new Promise<void>((resolve) => webServer.close(() => resolve()));
});

async function ok(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(session === '' ? {} : { authorization: `Bearer ${session}` }) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const reply = await response.json() as Record<string, any>;
  assert.equal(response.status, 200, `${method} ${path} → ${response.status}: ${JSON.stringify(reply)}`);
  return reply;
}

const bills: Record<string, string> = {};

test('#279: a walk-in cash sale of ₹120 + ₹6 GST in Karnataka is recorded', async () => {
  const sale = { customerId: 'walk-in', item: SOAP, quantity: '3', rate: '40', date: '2026-09-20', terms: 'now', paidBy: 'CASH', requestId: 'e2e-279-walk-in' };
  const recorded = await ok('POST', '/api/sales/record', sale);
  assert.equal(recorded.invoice.amount, 126);
  bills.walkIn = recorded.invoice.number;
});

test('#279: Selvam Builders (Tamil Nadu, no GST number) buys ₹1,00,800 + IGST ₹18,144 = ₹1,18,944, and then ₹90,000 + IGST ₹4,500 = ₹94,500', async () => {
  const added = await ok('POST', '/api/customers', {
    legalName: 'Selvam Builders', registration: 'unregistered', line1: '14, Anna Salai', city: 'Chennai', pincode: '600002',
  });
  assert.equal(added.customer.gstin, null);
  assert.equal(added.customer.stateCode, '33');
  const catalogue = await ok('GET', '/api/catalogue');
  const steel = catalogue.items.find((item: any) => item.name === STEEL);
  const soap = catalogue.items.find((item: any) => item.name === SOAP);
  const sell = async (item: any, quantity: string, rate: string, requestId: string) => ok('POST', '/api/sales/record', {
    party: added.customer.id, date: '2026-09-21', terms: '30',
    lines: JSON.stringify([{ itemId: item.id, quantity, unit: item.unit, rate }]),
    freight: '', otherCharges: '', shipTo: 'same', requestId,
  });
  // 1,120 × ₹90 = ₹1,00,800; 18% = ₹18,144; ₹1,18,944 is above the ₹1,00,000 line
  const large = await sell(steel, '1120', '90', 'e2e-279-selvam-large');
  assert.equal(large.invoice.amount, 118944);
  bills.large = large.invoice.number;
  // 2,250 × ₹40 = ₹90,000; 5% = ₹4,500; ₹94,500 is under it. (₹90,000 of steel at 18% would be
  // ₹1,06,200 — the line is on the bill's value with tax, so that one is B2CL too.)
  const small = await sell(soap, '2250', '40', 'e2e-279-selvam-small');
  assert.equal(small.invoice.amount, 94500);
  bills.small = small.invoice.number;
});

test('#279: September — walk-in in B2CS (29), the large bill in B2CL (33), the small one in B2CS (33); approves and exports with no blocking question', async () => {
  const prepared = await ok('POST', '/api/gst-returns/prepare', { period: MONTH, reference: 'e2e-279' });
  assert.equal(prepared.counts.BLOCKING, 0, JSON.stringify(prepared.findings));
  assert.deepEqual(prepared.findings.filter((finding: any) => finding.code === 'GSTR1_BAD_GSTIN'), []);
  const sections = Object.fromEntries(prepared.sections.map((section: any) => [section.id, section]));
  assert.equal(sections.B2B?.rows.length ?? 0, 0, 'no consumer sale is filed as a business sale');
  assert.deepEqual(sections.B2CL.rows.map((row: any) => [row.label, row.placeOfSupply]), [[bills.large, 'Tamil Nadu (33)']]);
  assert.equal(prepared.mayApprove, true, JSON.stringify(prepared.whyNotApprovable));
  assert.equal(prepared.reconciliation.agrees, true);

  await ok('POST', '/api/gst-returns/approve', { period: MONTH });

  const gstr1 = (await ok('POST', '/api/gst-returns/export', { period: MONTH, returnType: 'GSTR1' })).payload;
  assert.equal(gstr1.b2b, undefined);
  const b2cs = (gstr1.b2cs as any[]).map((row) => ({ sply_ty: row.sply_ty, pos: row.pos, txval: row.txval, camt: row.camt, samt: row.samt, iamt: row.iamt }));
  assert.deepEqual(b2cs.sort((a, b) => a.pos.localeCompare(b.pos)), [
    { sply_ty: 'INTRA', pos: '29', txval: 120, camt: 3, samt: 3, iamt: 0 },
    { sply_ty: 'INTER', pos: '33', txval: 90000, camt: 0, samt: 0, iamt: 4500 },
  ]);
  assert.equal(gstr1.b2cl.length, 1);
  assert.equal(gstr1.b2cl[0].pos, '33');
  assert.deepEqual(gstr1.b2cl[0].inv.map((bill: any) => [bill.inum, bill.val, bill.itms[0].itm_det.txval, bill.itms[0].itm_det.iamt]), [[bills.large, 118944, 100800, 18144]]);

  const gstr3b = (await ok('POST', '/api/gst-returns/export', { period: MONTH, returnType: 'GSTR3B' })).payload;
  // ₹1,00,800 + ₹90,000 = ₹1,90,800; ₹18,144 + ₹4,500 = ₹22,644
  assert.deepEqual(gstr3b.inter_sup.unreg_details, [{ pos: '33', txval: 190800, iamt: 22644 }]);
});

test('#279: a credit note to a walk-in customer comes off B2CS, never CDNR', async () => {
  const sale = { customerId: 'walk-in', item: SOAP, quantity: '3', rate: '40', date: '2026-08-20', terms: 'now', paidBy: 'CASH', requestId: 'e2e-279-walk-in-aug' };
  const recorded = await ok('POST', '/api/sales/record', sale);
  const original = (await ok('GET', '/api/returns/documents')).documents.find((document: any) => document.id === recorded.invoice.id);
  const back = {
    kind: original.kind, documentId: original.id, lineId: original.lines[0].id, unit: original.lines[0].unit,
    quantity: '1', disposition: 'ACCEPTED', date: '2026-08-21', reference: 'e2e-279-return', reason: 'Wrong fragrance',
  };
  const note = await ok('POST', '/api/returns/record', back);
  const august = await ok('POST', '/api/gst-returns', { period: '2026-08' });
  const sections = Object.fromEntries(august.sections.map((section: any) => [section.id, section]));
  assert.ok(!(sections.CDNR?.rows ?? []).some((row: any) => row.label === note.note.number), 'the note is not filed as a note to a business');
  assert.deepEqual(august.findings.filter((finding: any) => finding.severity === 'BLOCKING'), []);
  // ₹120 − ₹40 = ₹80 in Karnataka at 5%
  const karnataka = sections.B2CS.rows.find((row: any) => row.placeOfSupply === 'Karnataka (29)' && row.rate === 5);
  assert.equal(karnataka.taxableValue, 80);
  assert.equal(karnataka.tax, 4);
});
