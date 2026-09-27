/**
 * Issue #229 — selling takes the goods out of stock, and nobody can sell steel they do not have.
 *
 * Before this, the sales screen was wired to a stand-in that agreed to everything and moved
 * nothing: after buying 500 kg and selling 450 kg the report still said 500 kg, a bill for 600 kg
 * went out without a word, and the value of the goods never reached the books.
 *
 * The worked numbers, all through the same endpoints the screen calls:
 *
 *   bought 500 kg at ₹64          → 500 kg, worth 500 × ₹64 = ₹32,000
 *   sold 450 kg                    → 500 − 450 = 50 kg, worth 50 × ₹64 = ₹3,200
 *   asked to sell 600 kg           → refused, no bill number used up
 *   50 kg came back, usable        → 50 + 50 = 100 kg on one line, worth 100 × ₹64 = ₹6,400
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const SHREE_RAM = 'sampoorna:party:supplier';
const DATE = '2026-09-27';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const signIn = async (): Promise<string> => {
  const response = await request('POST', '/api/auth/login', { companyId: SAMPOORNA, email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' });
  assert.equal(response.status, 200);
  return response.body.sessionId as string;
};

const steelRows = async (owner: string) =>
  (await request('GET', '/api/reports', {}, owner)).body.stock.rows.filter((row: any) => row.item === 'TMT Steel Bar 12mm');

test('the full stock path: buy 500, sell 450, refuse 600, take 50 back', async () => {
  const owner = await signIn();

  const bought = await request('POST', '/api/purchases/record', {
    supplierId: SHREE_RAM, reference: 'SRS-101', date: DATE,
    lines: [{ item: 'TMT Steel Bar 12mm', quantity: '500', rate: '64', gst: '1800' }],
  }, owner);
  assert.equal(bought.status, 200, JSON.stringify(bought.body));
  assert.deepEqual((await steelRows(owner)).map((row: any) => [row.closing, row.value]), [['500.000', 32000]]);

  const customer = await request('POST', '/api/customers', {
    legalName: 'Mehta Construction Supplies', registration: 'regular', gstin: '27AAACM1234K1ZN',
    line1: 'Plot 22, MIDC Bhosari', city: 'Pune', pincode: '411026',
  }, owner);
  assert.equal(customer.status, 200, JSON.stringify(customer.body));
  const sale = {
    customerId: customer.body.customer.id, item: 'TMT Steel Bar 12mm', quantity: '450', rate: '90',
    freight: '2000', vehicle: 'KA01AB1234', date: DATE, terms: '30', reference: 'stock-229-sale',
  };

  // Review takes nothing out: the 500 kg are all still there after it.
  const reviewed = await request('POST', '/api/sales/preview', sale, owner);
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  assert.deepEqual((await steelRows(owner)).map((row: any) => [row.closing, row.available]), [['500.000', '500.000']]);

  // Record once: 500 − 450 = 50, on the same line, in the same godown.
  const recorded = await request('POST', '/api/sales/record', sale, owner);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  const number = recorded.body.invoice.number as string;
  let rows = await steelRows(owner);
  assert.deepEqual(rows.map((row: any) => [row.warehouse, row.closing, row.value]), [['Bengaluru · Peenya godown', '50.000', 3200]]);
  assert.equal((await request('GET', '/api/dashboard', {}, owner)).body.stock.quantity, 50);

  // Record pressed again for the same sale: the same bill, and the goods leave once.
  const again = await request('POST', '/api/sales/record', sale, owner);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.deduplicated, true);
  assert.equal(again.body.invoice.number, number);
  assert.deepEqual((await steelRows(owner)).map((row: any) => row.closing), ['50.000']);

  // 600 kg against 50: refused at the review and at Record, in one plain sentence.
  const tooMuch = { ...sale, quantity: '600', reference: 'stock-229-too-much' };
  for (const path of ['/api/sales/preview', '/api/sales/record']) {
    const refused = await request('POST', path, tooMuch, owner);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'SALES_STOCK_NOT_ENOUGH');
    assert.equal(refused.body.message, 'You have 50 KGS of TMT Steel Bar 12mm in Bengaluru · Peenya godown. This bill asks for 600 KGS.');
  }
  assert.deepEqual((await steelRows(owner)).map((row: any) => row.closing), ['50.000']);

  // No bill number went on the refusal: the next bill takes the very next number.
  const next = await request('POST', '/api/sales/record', { ...sale, quantity: '10', freight: '', reference: 'stock-229-next' }, owner);
  assert.equal(next.status, 200, JSON.stringify(next.body));
  const sequence = (value: string) => Number(value.split('/').at(-1));
  assert.equal(sequence(next.body.invoice.number), sequence(number) + 1);
  assert.deepEqual((await steelRows(owner)).map((row: any) => row.closing), ['40.000']);

  // 50 kg come back from the 450 kg bill, usable: 40 + 50 = 90, on one line, at ₹64 a kilo.
  const documents = await request('GET', '/api/returns/documents', {}, owner);
  const original = documents.body.documents.find((document: any) => document.number === number);
  const returned = await request('POST', '/api/returns/record', {
    kind: 'SALES_RETURN', documentId: original.id, lineId: original.lines[0].id, quantity: '50', unit: 'KGS',
    date: DATE, reason: 'Bent bars', disposition: 'ACCEPTED', reference: 'stock-229-return',
  }, owner);
  assert.equal(returned.status, 200, JSON.stringify(returned.body));
  rows = await steelRows(owner);
  assert.deepEqual(rows.map((row: any) => [row.closing, row.value]), [['90.000', 5760]]);

  // The books carry the same figure as the godown, so the report has nothing to warn about.
  const reports = await request('GET', '/api/reports', {}, owner);
  assert.equal(reports.body.exceptions.items.some((item: any) => item.code === 'STOCK_VALUE_NOT_IN_BOOKS'), false);
  const stockInHand = reports.body.trialBalance.rows.find((row: any) => row.name === 'Stock in hand');
  assert.equal(stockInHand.closing, reports.body.stock.value);
  assert.equal(reports.body.trialBalance.balanced, true);
});

test('a service is sold without any stock, and never touches the godown', async () => {
  const owner = await signIn();
  const item = await request('POST', '/api/items', {
    name: 'Site measurement visit', kind: 'service', hsnSac: '998346', unit: 'NOS', ratePercent: '18',
  }, owner);
  assert.equal(item.status, 200, JSON.stringify(item.body));
  const before = (await request('GET', '/api/reports', {}, owner)).body.stock.rows;

  const sold = await request('POST', '/api/sales/record', {
    party: 'ABC Traders', item: 'Site measurement visit', quantity: '2', rate: '1500', date: DATE, terms: '0', reference: 'stock-229-service',
  }, owner);
  assert.equal(sold.status, 200, JSON.stringify(sold.body));
  const after = (await request('GET', '/api/reports', {}, owner)).body.stock.rows;
  assert.deepEqual(after, before);
});
