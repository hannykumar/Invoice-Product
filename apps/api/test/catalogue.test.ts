/**
 * Issue #181 — the bill names the customer and the goods that were actually chosen.
 *
 * Each test here fails if the fix is reverted: reverting puts the one demo customer and the one
 * demo item back on every bill, charges the seller's own state to an out-of-state customer, and
 * allows only one line on a sale.
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

/** A registered customer in Delhi, for a Karnataka business: an inter-state sale. */
const DELHI_POLYMERS = {
  legalName: 'Delhi Polymers',
  registration: 'regular',
  gstin: '07EEEEE4444E1ZG',
  line1: 'Plot 7, Bawana Industrial Area',
  city: 'New Delhi',
  pincode: '110039',
  phone: '9811100022',
};

const PP_REGRIND = { name: 'PP Regrind', kind: 'goods', hsnSac: '39021000', unit: 'KGS', taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'The rate our accountant has always used for plastic granules' };
const HDPE_BAGS = { name: 'HDPE Bags', kind: 'goods', hsnSac: '39232100', unit: 'BAG', taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'The rate our accountant has always used for plastic bags' };

/** Creates a record once. A second run of the same test file re-uses the one already there. */
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

test('the bill names the customer and the item that were chosen, and neither demo record appears on it', async () => {
  const session = await signIn();
  const customerId = await ensureCustomer(session, DELHI_POLYMERS);
  const itemId = await ensureItem(session, PP_REGRIND);

  const recorded = await request('POST', '/api/sales/record', {
    customerId,
    lines: [{ itemId, quantity: '1400', rate: '60' }],
    date: '2026-08-29', terms: '30', reference: 'catalogue-181-one',
  }, session);
  assert.equal(recorded.status, 200, recorded.body.message);

  const printed = await request('POST', '/api/sales/print', { invoice: recorded.body.invoice.id }, session);
  assert.equal(printed.status, 200, printed.body.message);
  const html = String(printed.body.html);
  for (const expected of ['Delhi Polymers', '07EEEEE4444E1ZG', 'Plot 7, Bawana Industrial Area', 'Delhi (07)', 'PP Regrind', '39021000', '1400', 'KGS']) {
    assert.ok(html.includes(expected), `the printed bill must carry ${expected}`);
  }
  assert.ok(!html.includes('ABC Traders'), 'the demo customer is not on this bill');
  assert.ok(!html.includes('Herbal Bath Soap'), 'the demo item is not on this bill');
});

test('a Delhi customer of a Karnataka business is charged IGST, not CGST and SGST', async () => {
  const session = await signIn();
  const customerId = await ensureCustomer(session, DELHI_POLYMERS);
  const itemId = await ensureItem(session, PP_REGRIND);

  const checked = await request('POST', '/api/sales/preview', {
    customerId,
    lines: [{ itemId, quantity: '1400', rate: '60' }],
    date: '2026-08-29', terms: '30', reference: 'catalogue-181-igst',
  }, session);
  assert.equal(checked.status, 200, checked.body.message);
  // 1400 KGS × ₹60 = ₹84,000.00 of goods; 18% of that is ₹15,120.00; the bill is ₹99,120.00.
  assert.equal(checked.body.amount, 99120);

  const recorded = await request('POST', '/api/sales/record', {
    customerId,
    lines: [{ itemId, quantity: '1400', rate: '60' }],
    date: '2026-08-29', terms: '30', reference: 'catalogue-181-igst-2',
  }, session);
  const html = String((await request('POST', '/api/sales/print', { invoice: recorded.body.invoice.id }, session)).body.html);
  assert.ok(html.includes('IGST'), 'an inter-state sale carries IGST');
  assert.ok(html.includes('Delhi (07)'), 'the place of supply is where the customer is');
  assert.ok(!/\bCGST\b/.test(html), 'and never CGST on an inter-state sale');
});

test('a sale carries as many lines as it takes', async () => {
  const session = await signIn();
  const customerId = await ensureCustomer(session, DELHI_POLYMERS);
  const regrind = await ensureItem(session, PP_REGRIND);
  const bags = await ensureItem(session, HDPE_BAGS);

  const recorded = await request('POST', '/api/sales/record', {
    customerId,
    lines: [
      { itemId: regrind, quantity: '1400', rate: '60' },
      { itemId: bags, quantity: '10', rate: '500' },
    ],
    date: '2026-08-29', terms: '30', reference: 'catalogue-181-two-lines',
  }, session);
  assert.equal(recorded.status, 200, recorded.body.message);
  // 1400 × 60 = ₹84,000.00 and 10 × 500 = ₹5,000.00, so ₹89,000.00 of goods.
  // 18% of ₹89,000.00 is ₹16,020.00, and the bill is ₹1,05,020.00.
  assert.equal(recorded.body.invoice.amount, 105020);

  const html = String((await request('POST', '/api/sales/print', { invoice: recorded.body.invoice.id }, session)).body.html);
  assert.ok(html.includes('PP Regrind'));
  assert.ok(html.includes('HDPE Bags'));
  assert.ok(html.includes('BAG'));
});

test('a customer in our own state is charged CGST and SGST', async () => {
  const session = await signIn();
  const customerId = await ensureCustomer(session, {
    legalName: 'Bengaluru Plastics', registration: 'regular', gstin: '29CCCCC2222C1Z4',
    line1: '42, Rajajinagar Industrial Estate', city: 'Bengaluru', pincode: '560010',
  });
  const itemId = await ensureItem(session, PP_REGRIND);

  const checked = await request('POST', '/api/sales/preview', {
    customerId,
    lines: [{ itemId, quantity: '40', rate: '2100' }],
    date: '2026-08-29', terms: '30', reference: 'catalogue-181-intra',
  }, session);
  assert.equal(checked.status, 200, checked.body.message);
  // 40 × ₹2,100 = ₹84,000.00 of goods; 9% CGST is ₹7,560.00 and 9% SGST is ₹7,560.00;
  // ₹84,000.00 + ₹7,560.00 + ₹7,560.00 = ₹99,120.00.
  assert.equal(checked.body.amount, 99120);

  const recorded = await request('POST', '/api/sales/record', {
    customerId,
    lines: [{ itemId, quantity: '40', rate: '2100' }],
    date: '2026-08-29', terms: '30', reference: 'catalogue-181-intra-2',
  }, session);
  const html = String((await request('POST', '/api/sales/print', { invoice: recorded.body.invoice.id }, session)).body.html);
  assert.ok(/\bCGST\b/.test(html) && /\bSGST\b/.test(html), 'a sale inside one state carries CGST and SGST');
  assert.ok(html.includes('Karnataka (29)'));
});

test('a customer whose address disagrees with their GST number is refused, and both states are named', async () => {
  const session = await signIn();
  const refused = await request('POST', '/api/customers', {
    legalName: 'Mismatched Traders', registration: 'regular', gstin: '07EEEEE4444E1ZG',
    line1: '9, Peenya 2nd Stage', city: 'Bengaluru', pincode: '560058', stateCode: '29',
  }, session);
  assert.equal(refused.status, 422);
  assert.match(String(refused.body.message), /Delhi/);
  assert.match(String(refused.body.message), /Karnataka/);
});

test('a customer or an item that is not a record cannot be billed', async () => {
  const session = await signIn();
  const noCustomer = await request('POST', '/api/sales/preview', {
    customerId: 'Someone We Never Saved',
    lines: [{ itemId: 'Herbal Bath Soap 100g', quantity: '1', rate: '10' }],
    date: '2026-08-29', terms: '0', reference: 'catalogue-181-unknown-party',
  }, session);
  assert.equal(noCustomer.status, 422);
  assert.equal(noCustomer.body.code, 'CUSTOMER_NOT_FOUND');

  const noItem = await request('POST', '/api/sales/preview', {
    customerId: 'ABC Traders',
    lines: [{ itemId: 'Something We Never Stocked', quantity: '1', rate: '10' }],
    date: '2026-08-29', terms: '0', reference: 'catalogue-181-unknown-item',
  }, session);
  assert.equal(noItem.status, 422);
  assert.equal(noItem.body.code, 'ITEM_NOT_FOUND');
});

test('an item with no rate behind it cannot be billed, and no table supplies one', async () => {
  const session = await signIn();
  // A rate declared from 1 April 2027 says nothing about a sale made in 2026.
  const itemId = await ensureItem(session, {
    name: 'Unpriced Granules', kind: 'goods', hsnSac: '39023000', unit: 'KGS',
    taxKind: 'taxable', ratePercentTimes100: '1800', effectiveFrom: '2027-04-01',
    basis: 'Declared for next year only',
  });
  const customerId = await ensureCustomer(session, DELHI_POLYMERS);

  const refused = await request('POST', '/api/sales/preview', {
    customerId,
    lines: [{ itemId, quantity: '10', rate: '100' }],
    date: '2026-08-29', terms: '0', reference: 'catalogue-181-no-rate',
  }, session);
  assert.equal(refused.status, 400, refused.body.message);
  assert.match(String(refused.body.message), /rate/i);
});

test('a challan prints the consignee that was chosen, and the goods that went', async () => {
  const session = await signIn();
  const customerId = await ensureCustomer(session, DELHI_POLYMERS);
  const itemId = await ensureItem(session, PP_REGRIND);

  const issued = await request('POST', '/api/challans/issue', {
    customerId, item: itemId, quantity: '200', rate: '60',
    reason: 'JOB_WORK', date: '2026-08-29', reference: 'catalogue-181-challan',
  }, session);
  assert.equal(issued.status, 200, issued.body.message);

  const printed = await request('POST', '/api/challans/print', { challan: issued.body.challan.id }, session);
  const html = String(printed.body.html);
  for (const expected of ['Delhi Polymers', '07EEEEE4444E1ZG', 'PP Regrind', '39021000']) {
    assert.ok(html.includes(expected), `the printed challan must carry ${expected}`);
  }
  assert.ok(!html.includes('ABC Traders'));
});

test('the item list refuses a bad HSN code, an unknown unit and a missing rate', async () => {
  const session = await signIn();
  const badHsn = await request('POST', '/api/items', { ...PP_REGRIND, name: 'Bad Code Granules', hsnSac: '39021' }, session);
  assert.equal(badHsn.status, 422);
  assert.match(String(badHsn.body.message), /2, 4, 6 or 8 digits/);

  const badUnit = await request('POST', '/api/items', { ...PP_REGRIND, name: 'Bad Unit Granules', unit: 'SACKS' }, session);
  assert.equal(badUnit.status, 422);
  assert.equal(badUnit.body.code, 'ITEM_UNIT');

  const noRate = await request('POST', '/api/items', { name: 'Rateless Granules', kind: 'goods', hsnSac: '39021000', unit: 'KGS', taxKind: 'taxable' }, session);
  assert.equal(noRate.status, 422);
  assert.equal(noRate.body.code, 'ITEM_RATE_REQUIRED');
});
