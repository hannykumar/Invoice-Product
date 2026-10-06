/**
 * Issue #290 — goods sent on a delivery challan are out of the godown: they cannot be sold to
 * somebody else, the challan says whether an e-way bill is needed, and goods on approval are
 * billed from the challan within six months.
 *
 * The issue's own example: 1,000 KGS of steel; 700 KGS go to Mehta in Pune on approval; then a
 * sale of 900 KGS to ABC Traders is tried. Reverting the fix sells the 900 and leaves the 700
 * counted twice.
 *
 * Every name, GST number and figure below is synthetic and belongs to nobody.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { useFixedAppClock } from '../src/app-clock.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const COMPANY_A = '00000000-0000-4000-8000-000000000001';
const SHREE_RAM = 'sampoorna:party:supplier';
const STEEL = 'TMT Steel Bar 12mm';

// No stock helper here: the stock is the point.
const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const signIn = async (): Promise<string> => {
  const response = await request('POST', '/api/auth/login', { companyId: COMPANY_A, email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' });
  assert.equal(response.status, 200);
  return response.body.sessionId as string;
};

const steelRow = async (owner: string) =>
  (await request('GET', '/api/reports', {}, owner)).body.stock.rows.find((row: any) => row.item === STEEL);

let owner = '';
let mehta = '';
let challan: { id: string; number: string } = { id: '', number: '' };

test('a challan on approval holds its goods, and the sale of more than is left is refused, naming the challan', async () => {
  owner = await signIn();
  const bought = await request('POST', '/api/purchases/record', {
    supplierId: SHREE_RAM, reference: 'SRS-290', date: '2026-09-20',
    lines: [{ item: STEEL, quantity: '1000', rate: '64', gst: '1800' }],
  }, owner);
  assert.equal(bought.status, 200, JSON.stringify(bought.body));
  const customer = await request('POST', '/api/customers', {
    legalName: 'Mehta Construction Supplies', registration: 'regular', gstin: '27AAACM1234K1ZN',
    line1: 'Plot 22, MIDC Bhosari', city: 'Pune', pincode: '411026',
  }, owner);
  assert.equal(customer.status, 200, JSON.stringify(customer.body));
  mehta = customer.body.customer.id;

  const onApproval = { reason: 'SUPPLY_ON_APPROVAL', date: '2026-09-21', customerId: mehta, item: STEEL, quantity: '700', rate: '90', reference: 'dc-290' };
  // Part 2: ₹63,000 + IGST ₹11,340 = ₹74,340 from Karnataka to Maharashtra needs an e-way bill.
  const checked = await request('POST', '/api/challans/preview', onApproval, owner);
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.equal(checked.body.ewayBill?.needed, true, JSON.stringify(checked.body.ewayBill));
  assert.match(checked.body.ewayBill.message, /needs an e-way bill before the vehicle leaves/);

  const issued = await request('POST', '/api/challans/issue', onApproval, owner);
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  challan = issued.body.challan;
  assert.equal(issued.body.ewayBill?.needed, true, 'offered on the spot after issue');
  assert.equal(issued.body.challan.billBy, '2027-03-21', 'six months from removal (s.31(7))');

  const row = await steelRow(owner);
  assert.equal(row.closing, '1000.000', 'the goods are still the business\'s own');

  const sale = await request('POST', '/api/sales/record', { party: 'ABC Traders', item: STEEL, quantity: '900', rate: '95', date: '2026-09-22', terms: '30', reference: 'sale-290-900' }, owner);
  assert.equal(sale.status, 409, JSON.stringify(sale.body));
  assert.equal(sale.body.code, 'SALES_STOCK_NOT_ENOUGH');
  assert.match(sale.body.message, /300/);
  assert.match(sale.body.message, new RegExp(`700 KGS is out on ${challan.number.replace(/\//g, '\\/')}`));

  const allowed = await request('POST', '/api/sales/record', { party: 'ABC Traders', item: STEEL, quantity: '300', rate: '95', date: '2026-09-22', terms: '30', reference: 'sale-290-300' }, owner);
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
});

test('a challan for goods that are not in the godown is refused, and no number is used', async () => {
  const refused = await request('POST', '/api/challans/issue', { reason: 'SUPPLY_ON_APPROVAL', date: '2026-09-23', customerId: mehta, item: STEEL, quantity: '50', rate: '90', reference: 'dc-290-short' }, owner);
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'CHALLAN_STOCK_NOT_ENOUGH');
  const numbers = (await request('GET', '/api/challans', {}, owner)).body.challans.map((c: any) => c.number);
  assert.deepEqual(numbers, [challan.number], 'the only challan is the first one');
});

test('Mehta approves: Make the bill bills exactly the challan, takes the goods out once, and links it', async () => {
  const billed = await request('POST', '/api/challans/bill', { challan: challan.id, date: '2026-09-28', terms: '30' }, owner);
  assert.equal(billed.status, 200, JSON.stringify(billed.body));
  assert.equal(billed.body.challan.state, 'INVOICED');
  assert.equal(billed.body.challan.invoice.number, billed.body.invoice.number);
  assert.equal(billed.body.invoice.amount, 74340);
  const row = await steelRow(owner);
  assert.equal(row.closing, '0.000', '1,000 − 300 sold − 700 billed from the challan');
});

test('a cancelled challan puts its goods back on sale', async () => {
  const more = await request('POST', '/api/purchases/record', { supplierId: SHREE_RAM, reference: 'SRS-290-2', date: '2026-09-24', lines: [{ item: STEEL, quantity: '100', rate: '64', gst: '1800' }] }, owner);
  assert.equal(more.status, 200, JSON.stringify(more.body));
  const out = await request('POST', '/api/challans/issue', { reason: 'SUPPLY_ON_APPROVAL', date: '2026-09-24', customerId: mehta, item: STEEL, quantity: '100', rate: '90', reference: 'dc-290-cancel' }, owner);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const blocked = await request('POST', '/api/sales/record', { party: 'ABC Traders', item: STEEL, quantity: '100', rate: '95', date: '2026-09-25', terms: '30', reference: 'sale-290-blocked' }, owner);
  assert.equal(blocked.status, 409);
  const cancelled = await request('POST', '/api/challans/cancel', { challan: out.body.challan.id, reason: 'Mehta did not want it after all' }, owner);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  const sold = await request('POST', '/api/sales/record', { party: 'ABC Traders', item: STEEL, quantity: '100', rate: '95', date: '2026-09-25', terms: '30', reference: 'sale-290-freed' }, owner);
  assert.equal(sold.status, 200, JSON.stringify(sold.body));
});

test('goods on approval near their six months are on Home', async () => {
  const purchase = await request('POST', '/api/purchases/record', { supplierId: SHREE_RAM, reference: 'SRS-290-3', date: '2026-04-01', lines: [{ item: STEEL, quantity: '10', rate: '64', gst: '1800' }] }, owner);
  assert.equal(purchase.status, 200, JSON.stringify(purchase.body));
  const old = await request('POST', '/api/challans/issue', { reason: 'SUPPLY_ON_APPROVAL', date: '2026-04-10', customerId: mehta, item: STEEL, quantity: '10', rate: '90', reference: 'dc-290-old' }, owner);
  assert.equal(old.status, 200, JSON.stringify(old.body));
  const home = (await request('GET', '/api/dashboard', {}, owner)).body;
  const tasks = JSON.stringify(home.home?.tasks ?? home.tasks ?? home);
  assert.match(tasks, new RegExp(`${old.body.challan.number.replace(/\//g, '\\/')} must be billed by 10\\/10\\/2026`));
});
