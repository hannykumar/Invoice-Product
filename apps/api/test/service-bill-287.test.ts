/**
 * Issue #287 — a service bill is a service bill: no e-way bill, the services place-of-supply rule
 * (IGST Act s. 12(2)), "the service is supplied to …", and a heading that says goods or services.
 *
 *   Steel cutting service, SAC 998898, 18%, ₹60,000 to Mehta (registered, Pune, 27)
 *     place of supply 27 (s. 12(2)(a))   IGST 18% = ₹10,800   no e-way bill
 *   the same service, ₹40,000, at the counter (walk-in, not registered)
 *     place of supply = our own state      CGST ₹3,600 + SGST ₹3,600
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { useFixedAppClock } from '../src/app-clock.ts';
import { signIn as signInAs } from './sign-in-helper.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const DATE = '2026-09-28';
const SERVICE = 'Steel cutting service 287';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const shop = (() => {
  let done: Promise<{ owner: string; mehta: string; lakshmi: string }> | null = null;
  return () => done ??= (async () => {
    const owner = await signInAs('owner@sampoorna.example.invalid', SAMPOORNA);
    const item = await request('POST', '/api/items', { name: SERVICE, kind: 'service', hsnSac: '998898', unit: 'NOS', ratePercent: '18', reference: 'item-287' }, owner);
    assert.equal(item.status, 200, JSON.stringify(item.body));
    const mehta = await request('POST', '/api/customers', {
      legalName: 'Mehta Cutting Clients 287', registration: 'regular', gstin: '27AAACM1234K1ZN',
      line1: 'Plot 22, MIDC Bhosari', city: 'Pune', pincode: '411026',
    }, owner);
    assert.equal(mehta.status, 200, JSON.stringify(mehta.body));
    const lakshmi = await request('POST', '/api/customers', {
      legalName: 'Lakshmi Stores 287', registration: 'unregistered', stateCode: '33', line1: '12, Usman Road', city: 'Chennai', pincode: '600017',
    }, owner);
    assert.equal(lakshmi.status, 200, JSON.stringify(lakshmi.body));
    return { owner, mehta: mehta.body.customer.id as string, lakshmi: lakshmi.body.customer.id as string };
  })();
})();

const serviceSale = (customerId: string, rate: string, requestId: string) => ({
  customerId, item: SERVICE, quantity: '1', rate, date: DATE, terms: '0', requestId,
});

test('#287: ₹60,000 of service to a registered Pune customer is IGST ₹10,800, said as a service, with no e-way bill', async () => {
  const { owner, mehta } = await shop();
  const estimate = await request('POST', '/api/sales/estimate', serviceSale(mehta, '60000', 'svc-287-est'), owner);
  assert.equal(estimate.status, 200, JSON.stringify(estimate.body));
  assert.deepEqual(estimate.body.refusals, []);
  assert.equal(estimate.body.placeOfSupply.stateCode, '27');
  assert.equal(estimate.body.placeOfSupply.split, 'IGST');
  assert.equal(estimate.body.totals.igst, 10800);
  assert.equal(estimate.body.totals.cgst, 0);
  assert.equal(estimate.body.total, 70800);
  assert.match(estimate.body.placeOfSupply.reason, /the service is supplied to Mehta Cutting Clients 287/);
  assert.doesNotMatch(estimate.body.placeOfSupply.reason, /goods/);
  assert.equal(estimate.body.ewayBill, null, 'a service is never checked for an e-way bill');

  const preview = await request('POST', '/api/sales/preview', serviceSale(mehta, '60000', 'svc-287-bill'), owner);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.match(preview.body.placeOfSupply, /^Place of supply: Maharashtra \(27\) — the service is supplied to Mehta Cutting Clients 287/);
  assert.equal(preview.body.ewayBill, null, 'no "needs an e-way bill before the vehicle leaves"');

  const recorded = await request('POST', '/api/sales/record', serviceSale(mehta, '60000', 'svc-287-bill'), owner);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.equal(recorded.body.ewayBill ?? null, null);
  const invoice = recorded.body.invoice.id as string;

  // Pressing Record again is the same bill, not a second one.
  const again = await request('POST', '/api/sales/record', serviceSale(mehta, '60000', 'svc-287-bill'), owner);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.deduplicated, true);
  assert.equal(again.body.invoice.id, invoice);

  // Not offered on the e-way bill screen, and refused there if asked for by id.
  const choices = await request('GET', '/api/eway/bills', {}, owner);
  assert.equal(choices.status, 200, JSON.stringify(choices.body));
  assert.equal(choices.body.invoices.some((row: any) => row.id === invoice), false);
  const forBill = await request('POST', '/api/eway/for-bill', { invoice }, owner);
  assert.equal(forBill.status, 422, JSON.stringify(forBill.body));
  assert.match(JSON.stringify(forBill.body), /EWAY_NOT_FOR_SERVICES/);

  // The printed bill's heading covers services (CGST Rule 46(g)), and a service bill has two copies.
  const printed = await request('POST', '/api/sales/print', { invoice }, owner);
  assert.equal(printed.status, 200, JSON.stringify(printed.body).slice(0, 300));
  assert.ok(JSON.stringify(printed.body).includes('Description of Goods / Services'));
});

test('#287: the same service at the counter counts in our own state — CGST + SGST', async () => {
  const { owner } = await shop();
  const estimate = await request('POST', '/api/sales/estimate', { customer: 'walk-in', item: SERVICE, quantity: '1', rate: '40000', date: DATE, terms: '0' }, owner);
  assert.equal(estimate.status, 200, JSON.stringify(estimate.body));
  assert.deepEqual(estimate.body.refusals, []);
  assert.equal(estimate.body.placeOfSupply.split, 'CGST_SGST');
  assert.equal(estimate.body.totals.cgst, 3600);
  assert.equal(estimate.body.totals.sgst, 3600);
  assert.equal(estimate.body.totals.igst, 0);
  assert.match(estimate.body.placeOfSupply.reason, /the service is supplied at your counter/);
  assert.equal(estimate.body.ewayBill, null);

  // ₹60,000 at the counter is still refused: CGST Rule 46(e) wants the buyer's name and address.
  const large = await request('POST', '/api/sales/estimate', { customer: 'walk-in', item: SERVICE, quantity: '1', rate: '60000', date: DATE, terms: '0' }, owner);
  assert.equal(large.status, 200, JSON.stringify(large.body));
  assert.ok(large.body.refusals.some((refusal: any) => refusal.code === 'WALK_IN_NAME_REQUIRED'), JSON.stringify(large.body.refusals));
});

test('#287: a service to an unregistered customer counts at the address saved for them (s. 12(2)(b)(i))', async () => {
  const { owner, lakshmi } = await shop();
  const estimate = await request('POST', '/api/sales/estimate', serviceSale(lakshmi, '10000', 'svc-287-lakshmi'), owner);
  assert.equal(estimate.status, 200, JSON.stringify(estimate.body));
  assert.equal(estimate.body.placeOfSupply.stateCode, '33');
  assert.equal(estimate.body.placeOfSupply.split, 'IGST');
  assert.match(estimate.body.placeOfSupply.reason, /the service is supplied to Lakshmi Stores 287, at the address saved for them/);
});

test('#287: goods and a service on one bill, or a service sent to a delivery address, are refused and say why', async () => {
  const { owner, mehta } = await shop();
  const mixed = await request('POST', '/api/sales/preview', {
    customerId: mehta, date: DATE, terms: '0', requestId: 'svc-287-mixed',
    lines: [{ item: 'TMT Steel Bar 12mm', quantity: '1', rate: '90' }, { item: SERVICE, quantity: '1', rate: '1000' }],
  }, owner);
  assert.equal(mixed.status, 422, JSON.stringify(mixed.body));
  assert.match(JSON.stringify(mixed.body), /SALE_MIXES_GOODS_AND_SERVICES/);
  assert.match(JSON.stringify(mixed.body), /one bill for the goods and another for the service/);

  const shipped = await request('POST', '/api/sales/preview', { ...serviceSale(mehta, '1000', 'svc-287-ship'), shipTo: 'address', shipToAddressId: 'anything' }, owner);
  assert.equal(shipped.status, 422, JSON.stringify(shipped.body));
  assert.match(JSON.stringify(shipped.body), /SERVICE_NO_SHIP_TO/);
});

test('#287: a service bill takes no vehicle, transporter, destination or e-way bill number (Rule 138)', async () => {
  const { owner, mehta } = await shop();
  const moved = await request('POST', '/api/sales/preview', {
    ...serviceSale(mehta, '60000', 'svc-287-moved'),
    vehicleNumber: 'KA01AB1234', ewayBillNumber: '123456789012', destination: 'Pune',
  }, owner);
  assert.equal(moved.status, 422, JSON.stringify(moved.body));
  assert.match(JSON.stringify(moved.body), /SERVICE_NO_TRANSPORT/);
  assert.match(JSON.stringify(moved.body), /service is not sent in a vehicle/);

  // Distance alone is still a movement answer — a service never travels kilometres.
  const distanced = await request('POST', '/api/sales/preview', { ...serviceSale(mehta, '60000', 'svc-287-dist'), distanceKm: '120' }, owner);
  assert.equal(distanced.status, 422, JSON.stringify(distanced.body));
  assert.match(JSON.stringify(distanced.body), /SERVICE_NO_TRANSPORT/);

  // The same answers are refused at the estimate, as data rather than an error.
  const estimate = await request('POST', '/api/sales/estimate', { ...serviceSale(mehta, '60000', 'svc-287-moved-est'), vehicleNumber: 'KA01AB1234' }, owner);
  assert.equal(estimate.status, 200, JSON.stringify(estimate.body));
  assert.ok(estimate.body.refusals.some((refusal: any) => refusal.code === 'SERVICE_NO_TRANSPORT'), JSON.stringify(estimate.body.refusals));

  // And at Record, the same refusal — nothing is issued for a service "sent" somewhere.
  const recorded = await request('POST', '/api/sales/record', { ...serviceSale(mehta, '60000', 'svc-287-moved-rec'), transporterId: 'trans-1' }, owner);
  assert.equal(recorded.status, 422, JSON.stringify(recorded.body));
  assert.match(JSON.stringify(recorded.body), /SERVICE_NO_TRANSPORT/);
});

test('#287: goods are still goods — the e-way reminder and the goods wording are unchanged', async () => {
  const { owner, mehta } = await shop();
  const estimate = await request('POST', '/api/sales/estimate', { customerId: mehta, item: 'TMT Steel Bar 12mm', quantity: '1', rate: '90', date: DATE, terms: '0' }, owner);
  assert.equal(estimate.status, 200, JSON.stringify(estimate.body));
  assert.match(estimate.body.placeOfSupply.reason, /the goods go to Mehta Cutting Clients 287/);
  assert.notEqual(estimate.body.ewayBill, null, 'goods are still checked for an e-way bill');
});

test('#287: a viewer cannot record a service bill', async () => {
  const { mehta } = await shop();
  const viewer = await signInAs('viewer@sampoorna.example.invalid', SAMPOORNA);
  const denied = await request('POST', '/api/sales/record', serviceSale(mehta, '1000', 'svc-287-viewer'), viewer);
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
});
