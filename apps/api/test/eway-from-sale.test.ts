/**
 * Issue #240 — the e-way bill is raised from the finished sale with everything already filled in
 * from the bill, and the road distance left to the portal to work out from the two PIN codes.
 *
 * Every name, GST number and address below is synthetic and belongs to nobody.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { sells, stockEverything } from './stock-helper.ts';
import { useFixedAppClock } from '../src/app-clock.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const COMPANY_A = '00000000-0000-4000-8000-000000000001';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  if (sells(method, path)) await stockEverything(sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const signIn = async (): Promise<string> => {
  const response = await request('POST', '/api/auth/login', { companyId: COMPANY_A, email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' });
  assert.equal(response.status, 200);
  return response.body.sessionId as string;
};

const ensure = async (session: string, path: string, body: Record<string, unknown>, listKey: string, nameKey: string, name: string): Promise<string> => {
  const existing = (await request('GET', '/api/catalogue', {}, session)).body[listKey]
    .find((row: Record<string, string>) => row.name === name);
  if (existing !== undefined) return existing.id as string;
  const created = await request('POST', path, body, session);
  assert.equal(created.status, 200, created.body.message);
  return created.body[nameKey].id as string;
};

const PUNE = {
  legalName: 'Bhosari Fabricators', registration: 'regular', gstin: '27AAACM1234K1ZN',
  line1: 'Plot 22, MIDC Bhosari', city: 'Pune', pincode: '411026',
};
const DELHI = {
  legalName: 'Bawana Polymers', registration: 'regular', gstin: '07EEEEE4444E1ZG',
  line1: 'Plot 7, Bawana Industrial Area', city: 'New Delhi', pincode: '110039',
};
const GRANULES = {
  name: 'LDPE Granules', kind: 'goods', hsnSac: '39011000', unit: 'KGS',
  taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'The rate our accountant uses for granules',
};

const sell = async (session: string, customer: typeof PUNE, reference: string, quantity: string, extra: Record<string, unknown> = {}) => {
  const customerId = await ensure(session, '/api/customers', customer, 'customers', 'customer', customer.legalName);
  const itemId = await ensure(session, '/api/items', GRANULES, 'items', 'item', GRANULES.name);
  const recorded = await request('POST', '/api/sales/record', {
    customerId, lines: [{ itemId, quantity, rate: '60' }], date: '2026-09-28', terms: '30', reference, ...extra,
  }, session);
  assert.equal(recorded.status, 200, recorded.body.message);
  return recorded.body;
};

/** The one bill inside the file prepared for the portal. */
const portalBill = (json: unknown): Record<string, unknown> =>
  (JSON.parse(String(json)) as { billLists: Record<string, unknown>[] }).billLists[0] as Record<string, unknown>;

test('the finished sale says it needs an e-way bill, and choosing the bill fills in everything it knows', async () => {
  const session = await signIn();
  const sold = await sell(session, PUNE, 'eway-240-pune', '1000', { vehicleNumber: 'ka 01 ab 1234' });
  assert.equal(sold.ewayBill.outcome, 'REQUIRED', 'the Sale recorded dialog offers the e-way bill');

  const opened = await request('POST', '/api/eway/for-bill', { invoice: sold.invoice.id }, session);
  assert.equal(opened.status, 200, opened.body.message);
  assert.deepEqual(opened.body.form, {
    invoice: sold.invoice.id, reason: 'SUPPLY', shipToState: '27', shipToAddress: 'Plot 22, MIDC Bhosari',
    shipToPlace: 'Pune', shipToPincode: '411026', distanceKm: '', vehicle: 'KA01AB1234',
  });
  assert.equal(opened.body.check.ready, true);
  assert.equal(opened.body.check.filled.to.gstin, '27AAACM1234K1ZN');
  assert.equal(opened.body.check.distance.sentKm, 0);

  // The form sent back exactly as filled: the buyer's own address is not a second delivery place.
  const file = await request('POST', '/api/eway/offline', opened.body.form, session);
  assert.equal(file.status, 200, file.body.message);
  const bill = portalBill(file.body.json);
  assert.equal(bill.transactionType, 1, 'billed and delivered to the same place');
  assert.equal(bill.transDistance, '0', 'the portal works the distance out from the PIN codes');
  assert.equal(opened.body.check.vehicleReady, true, 'the vehicle typed on the sale is the one on the e-way bill');
  assert.equal(bill.toPincode, 411026);

  // The bill leads the picker, with its customer, its total and "needs one".
  const choices = await request('GET', '/api/eway/bills', {}, session);
  const row = choices.body.invoices.find((candidate: any) => candidate.id === sold.invoice.id);
  assert.deepEqual([row.customer, row.label], [PUNE.legalName, 'needs one']);
  assert.equal(choices.body.invoices.findIndex((candidate: any) => candidate.status !== 'NEEDED') > choices.body.invoices.findIndex((candidate: any) => candidate.id === sold.invoice.id), true);
});

test('a bill under the limit is not offered: it says why', async () => {
  const session = await signIn();
  const sold = await sell(session, PUNE, 'eway-240-small', '10');
  assert.equal(sold.ewayBill, null);
  const opened = await request('POST', '/api/eway/for-bill', { invoice: sold.invoice.id }, session);
  assert.equal(opened.body.check.outcome, 'NOT_REQUIRED');
  assert.equal(opened.body.check.title, 'No e-way bill needed');
  assert.match(opened.body.check.reason, /not above it, so no e-way bill is needed/);
  const choices = await request('GET', '/api/eway/bills', {}, session);
  assert.equal(choices.body.invoices.find((candidate: any) => candidate.id === sold.invoice.id).label, 'not needed');
});

test('a bill with its own delivery address fills that address, never the buyer’s billing PIN (#224), and a different one typed is refused', async () => {
  const session = await signIn();
  const customerId = await ensure(session, '/api/customers', DELHI, 'customers', 'customer', DELHI.legalName);
  const address = await request('POST', '/api/shipping-addresses', {
    customerId, label: 'Hyderabad godown', line1: 'Survey 44, Cherlapally', city: 'Hyderabad', pincode: '500051', stateCode: '36',
  }, session);
  assert.equal(address.status, 200, address.body.message);
  const sold = await sell(session, DELHI, 'eway-240-ship-to', '1400', { shipTo: 'address', shipToAddressId: address.body.address.id });

  const opened = await request('POST', '/api/eway/for-bill', { invoice: sold.invoice.id }, session);
  assert.deepEqual([opened.body.form.shipToState, opened.body.form.shipToAddress, opened.body.form.shipToPincode], ['36', 'Survey 44, Cherlapally', '500051']);
  assert.equal(opened.body.form.vehicle, '', 'no vehicle was on the bill, so none is made up');
  assert.equal(opened.body.check.vehicleReady, false);

  const moved = await request('POST', '/api/eway/offline', { ...opened.body.form, shipToAddress: 'Plot 9, Uppal', shipToPincode: '500039' }, session);
  assert.equal(moved.status, 422);
  assert.equal(moved.body.code, 'EWAY_SHIP_TO_DIFFERS_FROM_BILL');
});

test('a distance that is not a number of kilometres is refused in words', async () => {
  const session = await signIn();
  const sold = await sell(session, PUNE, 'eway-240-bad-distance', '1000');
  const refused = await request('POST', '/api/eway/preview', { invoice: sold.invoice.id, distanceKm: '8.4e2' }, session);
  assert.equal(refused.status, 422);
  assert.equal(refused.body.code, 'EWAY_DISTANCE');
});
