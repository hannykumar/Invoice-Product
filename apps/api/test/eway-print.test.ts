/**
 * Issue #191 — the e-way bill page a driver is handed, through the real app.
 *
 * Each test fails if the fix is reverted: reverting takes the print route away, so the request
 * comes back as an unknown path instead of a page.
 *
 * Every name, GST number and address below is synthetic and belongs to nobody.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';

const COMPANY_A = '00000000-0000-4000-8000-000000000001';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const signIn = async (): Promise<string> => {
  const response = await request('POST', '/api/auth/login', { companyId: COMPANY_A, email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' });
  assert.equal(response.status, 200);
  return response.body.sessionId as string;
};

const ensureCustomer = async (session: string, body: Record<string, unknown>): Promise<string> => {
  const existing = (await request('GET', '/api/catalogue', {}, session)).body.customers
    .find((customer: { name: string }) => customer.name === body.legalName);
  if (existing !== undefined) return existing.id as string;
  const created = await request('POST', '/api/customers', body, session);
  assert.equal(created.status, 200, created.body.message);
  return created.body.customer.id as string;
};

const ensureItem = async (session: string, body: Record<string, unknown>): Promise<string> => {
  const existing = (await request('GET', '/api/catalogue', {}, session)).body.items
    .find((item: { name: string }) => item.name === body.name);
  if (existing !== undefined) return existing.id as string;
  const created = await request('POST', '/api/items', body, session);
  assert.equal(created.status, 200, created.body.message);
  return created.body.item.id as string;
};

/** A Delhi customer of a Karnataka business: the goods cross a border, so the limit is ₹50,000. */
const DELHI = {
  legalName: 'Bawana Polymers', registration: 'regular', gstin: '07EEEEE4444E1ZG',
  line1: 'Plot 7, Bawana Industrial Area', city: 'New Delhi', pincode: '110039',
};
const GRANULES = {
  name: 'LDPE Granules', kind: 'goods', hsnSac: '39011000', unit: 'KGS',
  taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'The rate our accountant uses for granules',
};

/** One issued inter-state bill worth ₹99,120 all in, well over the ₹50,000 limit. */
const issueBill = async (session: string, reference: string): Promise<string> => {
  const customerId = await ensureCustomer(session, DELHI);
  const itemId = await ensureItem(session, GRANULES);
  const recorded = await request('POST', '/api/sales/record', {
    customerId, lines: [{ itemId, quantity: '1400', rate: '60' }],
    date: '2026-09-17', terms: '30', reference,
  }, session);
  assert.equal(recorded.status, 200, recorded.body.message);
  return recorded.body.invoice.id as string;
};

test('an e-way bill raised in the app can be printed for the driver', async () => {
  const session = await signIn();
  const invoiceId = await issueBill(session, 'eway-191-print');

  const raised = await request('POST', '/api/eway/generate', {
    invoice: invoiceId, distanceKm: '2100', vehicle: 'KA01AB1234', reason: 'SUPPLY',
  }, session);
  assert.equal(raised.status, 200, JSON.stringify(raised.body));
  const number = String(raised.body.ewayBillNumber ?? '');
  assert.match(number, /^[0-9]{12}$/);

  const printed = await request('POST', '/api/eway/print', { invoice: invoiceId }, session);
  assert.equal(printed.status, 200, printed.body.message);
  const html = String(printed.body.html);

  for (const section of ['E-Way Bill Details', 'Address Details', 'Goods Details', 'Transportation Details', 'Vehicle Details']) {
    assert.ok(html.includes(section), `the page carries the portal's "${section}" heading`);
  }
  assert.ok(html.includes(number), 'the 12-digit number');
  assert.ok(html.includes('2100 KM'), 'the approximate distance');
  assert.ok(html.includes('Outward-Supply'));
  assert.ok(html.includes('39011000'), 'the HSN code');
  assert.ok(html.includes('1400 KGS'), 'the quantity with its unit');
  assert.ok(html.includes('0.00+0.00+18.00+0.00+0.00'), 'the tax rate string');
  assert.ok(html.includes('99120.00'), 'the total invoice amount');
  assert.ok(html.includes('KA01AB1234'), 'the vehicle');
  assert.ok(html.includes('110039'), "the customer's PIN code");
  // Issue #191 — the portal's page carries no copy marking, so neither does ours.
  assert.equal(printed.body.copies, 1);
  assert.ok(!html.includes('ORIGINAL FOR RECIPIENT'));
  // Nothing QR-shaped: the provider's response carries no QR content, and we never compose one.
  assert.ok(!html.includes('<svg'));

  // And the bill screen now knows there is a second page to offer.
  const bill = await request('POST', '/api/sales/print', { invoice: invoiceId }, session);
  assert.equal(bill.body.ewayBillNumber, number);
});

test('a document with no e-way bill has nothing to print, and says so', async () => {
  const session = await signIn();
  const invoiceId = await issueBill(session, 'eway-191-none');
  const printed = await request('POST', '/api/eway/print', { invoice: invoiceId }, session);
  assert.equal(printed.status, 404);
  assert.equal(printed.body.code, 'API_EWAY_NOT_FOUND');
});
