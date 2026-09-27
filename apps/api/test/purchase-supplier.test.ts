/**
 * Issue #228 — the Purchase screen records a real supplier's real bill.
 *
 * Before this, every purchase was posted to one built-in supplier, a person chose "same state" or
 * "another state" by hand, and the checks were a fixed "all clear". A Maharashtra supplier's bill
 * could be booked as CGST and SGST in a Karnataka business, and nothing noticed. Now the supplier
 * comes from the supplier list, the kind of GST comes from the two GST numbers, a bill carries as
 * many lines as it has, and the real duplicate and tax checks (#16) run on every bill.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const KONKAN = '00000000-0000-4000-8000-000000000011';
const SHREE_RAM = 'sampoorna:party:supplier';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const signIn = async (companyId: string, email: string): Promise<string> => {
  const response = await request('POST', '/api/auth/login', { companyId, email, password: 'karobar-demo' });
  assert.equal(response.status, 200);
  return response.body.sessionId as string;
};

const steel = { item: 'TMT Steel Bar 12mm', quantity: '500', rate: '64', gst: '1800' };
const soap = { item: 'Herbal Bath Soap 100g', quantity: '10', unit: 'BOX', rate: '100', gst: '500' };

test('the supplier list holds the demo supplier, with its state taken from its GST number', async () => {
  const owner = await signIn(SAMPOORNA, 'owner@sampoorna.example.invalid');
  const catalogue = await request('GET', '/api/catalogue', {}, owner);
  const supplier = catalogue.body.suppliers.find((row: any) => row.id === SHREE_RAM);
  assert.equal(supplier.gstin, '27AAECS5678D1Z4');
  assert.equal(supplier.stateCode, '27');
  assert.equal(supplier.stateName, 'Maharashtra');
  // A supplier is not offered as somebody to bill.
  assert.equal(catalogue.body.customers.some((row: any) => row.id === SHREE_RAM), false);
});

test('a purchase from a 27 supplier into a 29 company posts IGST, never CGST and SGST, with no state asked', async () => {
  const owner = await signIn(SAMPOORNA, 'owner@sampoorna.example.invalid');
  // The old screen's "same state" answer is sent on purpose: it must make no difference.
  const input = { supplierId: SHREE_RAM, reference: 'SRS-228-1', date: '2026-09-01', lines: [steel], supplierState: 'same' };
  const preview = await request('POST', '/api/purchases/preview', input, owner);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.taxType, 'IGST');
  assert.deepEqual(preview.body.tax, { cgst: 0, sgst: 0, igst: 5760, total: 5760 });
  assert.ok(preview.body.effects.includes('The supplier is in Maharashtra (27) and your godown is in Karnataka (29), so the bill carries IGST.'));

  const recorded = await request('POST', '/api/purchases/record', input, owner);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.equal(recorded.body.bill.igst, 5760);
  assert.equal(recorded.body.bill.cgst, 0);
  assert.equal(recorded.body.bill.sgst, 0);
  assert.equal(recorded.body.bill.total, 37760);
  assert.equal(recorded.body.bill.supplier, 'Shree Ram Steels Private Limited');
});

test('a bill with two lines at 18% and 5% posts both lines, each with its own tax', async () => {
  const owner = await signIn(SAMPOORNA, 'owner@sampoorna.example.invalid');
  const input = { supplierId: SHREE_RAM, reference: 'SRS-228-2', date: '2026-09-02', lines: JSON.stringify([steel, soap]) };
  const preview = await request('POST', '/api/purchases/preview', input, owner);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  // 18% of ₹32,000 is ₹5,760; 5% of ₹1,000 is ₹50; together ₹5,810.
  assert.ok(preview.body.effects.includes('IGST: ₹5,760.00 + ₹50.00 = ₹5,810.00'));
  const recorded = await request('POST', '/api/purchases/record', input, owner);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.deepEqual(recorded.body.bill.lines.map((line: any) => [line.item, line.taxable, line.igst]), [
    ['TMT Steel Bar 12mm', 32000, 5760],
    ['Herbal Bath Soap 100g', 1000, 50],
  ]);
  assert.equal(recorded.body.bill.igst, 5810);
  assert.equal(recorded.body.bill.total, 38810);
});

test('the same supplier GST number and bill number twice is refused, and pressing Record twice records once', async () => {
  const owner = await signIn(SAMPOORNA, 'owner@sampoorna.example.invalid');
  const input = { supplierId: SHREE_RAM, reference: 'SRS-228-3', date: '2026-09-03', lines: [steel] };
  const first = await request('POST', '/api/purchases/record', input, owner);
  assert.equal(first.body.deduplicated, false);
  const pressedAgain = await request('POST', '/api/purchases/record', input, owner);
  assert.equal(pressedAgain.status, 200);
  assert.equal(pressedAgain.body.deduplicated, true);
  assert.equal(pressedAgain.body.bill.id, first.body.bill.id);

  // The same number again with different contents — written another way, even — is the same bill.
  const retyped = await request('POST', '/api/purchases/record', { ...input, reference: 'srs 228/3', lines: [{ ...steel, quantity: '400' }] }, owner);
  assert.equal(retyped.status, 409);
  assert.equal(retyped.body.code, 'PURCHASE_DUPLICATE');
  assert.match(retyped.body.message, /already in your books/);
  const preview = await request('POST', '/api/purchases/preview', { ...input, lines: [{ ...steel, quantity: '400' }] }, owner);
  assert.equal(preview.body.code, 'PURCHASE_DUPLICATE');

  const reports = await request('GET', '/api/reports', {}, owner);
  assert.equal(reports.body.purchases.rows.filter((row: any) => row.number === 'SRS-228-3').length, 1);
});

test('a new supplier is added with a checked GST number, and a supplier in our own state is charged CGST and SGST', async () => {
  const owner = await signIn(SAMPOORNA, 'owner@sampoorna.example.invalid');
  const mistyped = await request('POST', '/api/suppliers', { legalName: 'Peenya Hardware Stores', gstin: '29AABCP1234Q1Z5', line1: '5 Industrial Road', city: 'Bengaluru', pincode: '560058' }, owner);
  assert.equal(mistyped.status, 422);
  assert.equal(mistyped.body.code, 'SUPPLIER_GSTIN');
  const wrongPin = await request('POST', '/api/suppliers', { legalName: 'Peenya Hardware Stores', gstin: '29AABCP1234Q1Z3', line1: '5 Industrial Road', city: 'Bengaluru', pincode: '411026' }, owner);
  assert.equal(wrongPin.status, 422);
  assert.equal(wrongPin.body.code, 'SUPPLIER_PINCODE_STATE');

  const added = await request('POST', '/api/suppliers', { legalName: 'Peenya Hardware Stores', gstin: '29AABCP1234Q1Z3', line1: '5 Industrial Road', city: 'Bengaluru', pincode: '560058' }, owner);
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.supplier.stateCode, '29');
  const recorded = await request('POST', '/api/purchases/record', { supplierId: added.body.supplier.id, reference: 'PHS-1', date: '2026-09-04', lines: [{ ...steel, quantity: '100', rate: '60' }] }, owner);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  // ₹6,000 at 18% is ₹1,080, half to each: ₹540 CGST and ₹540 SGST.
  assert.deepEqual([recorded.body.bill.cgst, recorded.body.bill.sgst, recorded.body.bill.igst], [540, 540, 0]);
  assert.equal(recorded.body.bill.supplier, 'Peenya Hardware Stores');
});

test('a supplier nobody added is refused rather than posted to the demo supplier', async () => {
  const owner = await signIn(SAMPOORNA, 'owner@sampoorna.example.invalid');
  const missing = await request('POST', '/api/purchases/preview', { reference: 'NONE-1', date: '2026-09-05', lines: [steel] }, owner);
  assert.equal(missing.body.code, 'SUPPLIER_REQUIRED');
  const unknown = await request('POST', '/api/purchases/preview', { supplier: 'Nobody Steels', reference: 'NONE-2', date: '2026-09-05', lines: [steel] }, owner);
  assert.equal(unknown.body.code, 'SUPPLIER_NOT_FOUND');
  // A customer is not a supplier.
  const customer = await request('POST', '/api/purchases/preview', { supplierId: 'sampoorna:party:customer', reference: 'NONE-3', date: '2026-09-05', lines: [steel] }, owner);
  assert.equal(customer.body.code, 'SUPPLIER_NOT_FOUND');
});

test('a bill dated in the future or a total that does not add up is refused by the real checks', async () => {
  const owner = await signIn(SAMPOORNA, 'owner@sampoorna.example.invalid');
  const future = await request('POST', '/api/purchases/preview', { supplierId: SHREE_RAM, reference: 'FUT-1', date: '2099-01-01', lines: [steel] }, owner);
  assert.equal(future.body.code, 'PURCHASE_NEEDS_CHECKING');
  assert.match(future.body.message, /still in the future/);
  const wrongTotal = await request('POST', '/api/purchases/preview', { supplierId: SHREE_RAM, reference: 'TOT-1', date: '2026-09-06', amount: '40000', lines: [steel] }, owner);
  assert.equal(wrongTotal.body.code, 'PURCHASE_NEEDS_CHECKING');
  assert.match(wrongTotal.body.message, /₹40,000.00/);
});

test('the purchase check claims IGST that agrees with the portal, and holds back a bill whose kind of GST differs', async () => {
  const owner = await signIn(KONKAN, 'owner@konkan.example.invalid');
  // Konkan is in Goa (30), and so is its supplier: CGST and SGST in the books.
  const bill = await request('POST', '/api/purchases/record', { supplierId: 'konkan:party:supplier', reference: 'WCS-228', date: '2026-09-10', lines: [{ item: 'TMT Steel Bar 12mm', quantity: '500', rate: '64', gst: '1800' }] }, owner);
  assert.deepEqual([bill.body.bill.cgst, bill.body.bill.sgst, bill.body.bill.igst], [2880, 2880, 0]);
  // The supplier filed the same bill as IGST ₹5,760. Same total, different tax.
  const workspace = await request('POST', '/api/itc/typed', {
    period: '2026-09', gstin: '30AAFCW7788Q1ZE', supplierName: 'Western Coast Supplies', number: 'WCS-228', date: '2026-09-10',
    taxableValue: '32000', igst: '5760', invoiceValue: '37760',
  }, owner);
  assert.equal(workspace.status, 200, JSON.stringify(workspace.body));
  const line = workspace.body.lines.find((row: any) => row.number === 'WCS-228');
  assert.notEqual(line.status, 'EXACT');
  assert.equal(line.outcome, 'HELD_BACK');
  assert.equal(line.sentence, 'Your books say CGST and SGST; the supplier filed IGST. One of the two is wrong. ₹5,760.00 is held back until the bill or the filing is corrected.');
  assert.equal(workspace.body.claimable, 0);
  assert.equal(workspace.body.heldBack, 5760);
});
