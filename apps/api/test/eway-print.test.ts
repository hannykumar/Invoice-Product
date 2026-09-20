/**
 * Issue #191 — the driver's e-way bill page, through the API the screen uses.
 *
 * Reverting the fix takes the route away, so each of these fails. Every name, GST number and
 * address below is synthetic and belongs to nobody.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { syntheticGstin } from '../../../packages/masters/src/fixtures.ts';

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

const ensure = async (session: string, path: 'customers' | 'items', body: Record<string, unknown>, name: string): Promise<string> => {
  const catalogue = (await request('GET', '/api/catalogue', {}, session)).body;
  const existing = (path === 'customers' ? catalogue.customers : catalogue.items)
    .find((row: { name: string }) => row.name === name);
  if (existing !== undefined) return existing.id as string;
  const created = await request('POST', `/api/${path}`, body, session);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return (created.body.customer?.id ?? created.body.item?.id) as string;
};

/** An inter-state load well over ₹50,000, with a lorry on it. */
const raisedBill = async (session: string, reference: string) => {
  const customerId = await ensure(session, 'customers', {
    legalName: 'Deccan Hardware Traders', registration: 'regular', gstin: syntheticGstin('27', 'AAFCD1234K'),
    line1: '22, Laxmi Road', city: 'Pune', pincode: '411030',
  }, 'Deccan Hardware Traders');
  const itemId = await ensure(session, 'items', {
    name: 'TMT Steel Bar 12mm', kind: 'goods', hsnSac: '72142090', unit: 'KGS',
    taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'The rate our accountant uses for steel bar',
  }, 'TMT Steel Bar 12mm');
  const recorded = await request('POST', '/api/sales/record', {
    customerId, lines: [{ itemId, quantity: '2000', rate: '40' }], date: '2026-09-17', terms: '30', reference,
  }, session);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  return recorded.body.invoice.id as string;
};

test('the driver’s page carries the number, the goods and the lorry', async () => {
  const session = await signIn();
  const invoice = await raisedBill(session, 'eway-print-191');
  const raised = await request('POST', '/api/eway/generate', {
    invoice, distanceKm: '840', vehicle: 'KA01AB1234', reason: 'SUPPLY',
  }, session);
  assert.equal(raised.status, 200, JSON.stringify(raised.body));
  const number = String(raised.body.ewayBillNumber);

  const printed = await request('POST', '/api/eway/print', { invoice }, session);

  assert.equal(printed.status, 200, JSON.stringify(printed.body));
  assert.equal(printed.body.ewayBillNumber, number);
  assert.equal(printed.body.notice, null);
  for (const section of ['E-way Bill Details', 'Address Details', 'Goods Details', 'Transportation Details', 'Vehicle Details']) {
    assert.ok(String(printed.body.html).includes(section), `the page must carry the ${section} section`);
  }
  assert.ok(String(printed.body.html).includes(number), 'the e-way bill number');
  assert.ok(String(printed.body.html).includes('72142090'), 'the HSN code');
  assert.ok(String(printed.body.html).includes('KA01AB1234'), 'the vehicle');
});

test('a movement with no e-way bill raised against it has nothing to print', async () => {
  const session = await signIn();
  const invoice = await raisedBill(session, 'eway-print-191-none');

  const printed = await request('POST', '/api/eway/print', { invoice }, session);

  assert.equal(printed.status, 404);
  assert.equal(printed.body.code, 'API_EWAY_NOT_RAISED');
  assert.match(String(printed.body.message), /No e-way bill has been raised/);
});
