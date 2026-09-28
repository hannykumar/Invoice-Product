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
import { useFixedAppClock } from '../src/app-clock.ts';

// Issue #234 — the running app reads the real clock; this file pins it so its dates do not drift.
useFixedAppClock('2026-09-28T10:00:00.000Z');

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
  // Issue #237 — Home lists every goods item, least left first; the steel is one of them.
  assert.equal((await request('GET', '/api/dashboard', {}, owner)).body.stockItems.find((item: any) => item.name === 'TMT Steel Bar 12mm').quantity, 50);

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
    assert.equal(refused.body.message, 'You have 50 KGS of TMT Steel Bar 12mm in Bengaluru · Peenya godown. This bill asks for 600 KGS. If the goods have arrived, enter their purchase bill first, then make this sale.');
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

/**
 * Issue #262 — a sale stopped for short stock says the way through, and the way through works.
 *
 *   in stock after this file's first test     90 kg (it starts from whatever is there)
 *   the sale asks for                          stock + 550 kg
 *   refused, naming the goods and the godown
 *   purchase bill of 550 kg recorded           stock + 550 kg
 *   the same sale, unchanged, goes through     stock + 550 − (stock + 550) = 0 kg
 */
test('#262: a short sale is refused with the way through, and after the purchase bill the same sale goes through to 0', async () => {
  const owner = await signIn();
  const before = Number((await steelRows(owner))[0]?.closing ?? '0');
  const customers = (await request('GET', '/api/catalogue', {}, owner)).body.customers;
  const mehta = customers.find((row: any) => row.name === 'Mehta Construction Supplies');
  assert.ok(mehta, 'the first test added this customer');
  const wanted = String(before + 550);
  const sale = {
    customerId: mehta.id, item: 'TMT Steel Bar 12mm', quantity: wanted, rate: '90',
    vehicle: 'KA01AB1234', date: DATE, terms: '30', reference: 'stock-262-sale',
  };

  const refused = await request('POST', '/api/sales/preview', sale, owner);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'SALES_STOCK_NOT_ENOUGH');
  assert.equal(refused.body.message, `You have ${before} KGS of TMT Steel Bar 12mm in Bengaluru · Peenya godown. This bill asks for ${wanted} KGS. If the goods have arrived, enter their purchase bill first, then make this sale.`);
  assert.equal(refused.body.details['hi-IN'], `Bengaluru · Peenya godown mein TMT Steel Bar 12mm ke ${before} KGS hain. Yeh bill ${wanted} KGS maangta hai. Agar maal aa gaya hai, to pehle uska purchase bill darj karen, phir yeh bikri karen.`);
  const short = JSON.parse(refused.body.details.shortStock);
  assert.equal(short.length, 1);
  assert.equal(short[0].warehouseId, 'wh-main');
  assert.deepEqual(
    [short[0].itemName, short[0].warehouseName, short[0].unit, short[0].available, short[0].required, short[0].shortBy],
    ['TMT Steel Bar 12mm', 'Bengaluru · Peenya godown', 'KGS', String(before), wanted, '550'],
  );
  // The item the purchase screen is opened with is the one the catalogue calls TMT Steel Bar 12mm.
  const items = (await request('GET', '/api/catalogue', {}, owner)).body.items;
  assert.equal(items.find((item: any) => item.id === short[0].itemId)?.name, 'TMT Steel Bar 12mm');
  // Nothing moved on the refusal.
  assert.deepEqual((await steelRows(owner)).map((row: any) => Number(row.closing)), [before]);

  const bought = await request('POST', '/api/purchases/record', {
    supplierId: SHREE_RAM, reference: 'SRS-262', date: DATE,
    lines: [{ itemId: short[0].itemId, quantity: '550', rate: '64', gst: '1800' }],
  }, owner);
  assert.equal(bought.status, 200, JSON.stringify(bought.body));
  assert.deepEqual((await steelRows(owner)).map((row: any) => Number(row.closing)), [before + 550]);

  const recorded = await request('POST', '/api/sales/record', sale, owner);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.ok(recorded.body.invoice.number);
  // before + 550 − (before + 550) = 0: all of it went, and not a gram below nothing.
  assert.deepEqual((await steelRows(owner)).map((row: any) => Number(row.closing)), [0]);
});
