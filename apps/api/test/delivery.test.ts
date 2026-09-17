/**
 * Issue #182 — where the goods went, who carried them, and what the bill refers back to.
 *
 * Each test here fails if the fix is reverted: reverting empties the transport boxes on every
 * bill, puts the buyer back in the consignee block whatever the delivery address was, and takes
 * the place of supply from the billing address even when the goods finished somewhere else.
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

/** The Delhi customer of a Karnataka business, and a granule sold by weight. */
const DELHI = {
  legalName: 'Bawana Polymers', registration: 'regular', gstin: '07EEEEE4444E1ZG',
  line1: 'Plot 7, Bawana Industrial Area', city: 'New Delhi', pincode: '110039',
};
const KARNATAKA = {
  legalName: 'Peenya Plastics', registration: 'regular', gstin: '29GGGGG6666G1ZG',
  line1: '18, Peenya 2nd Stage', city: 'Bengaluru', pincode: '560058',
};
const GRANULES = {
  name: 'LDPE Granules', kind: 'goods', hsnSac: '39011000', unit: 'KGS',
  taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'The rate our accountant uses for granules',
};

const printOf = async (session: string, invoiceId: string): Promise<string> => {
  const printed = await request('POST', '/api/sales/print', { invoice: invoiceId }, session);
  assert.equal(printed.status, 200, printed.body.message);
  return String(printed.body.html);
};

test('with no delivery address the sale counts in the customer’s own state, and the consignee repeats the buyer', async () => {
  const session = await signIn();
  const customerId = await ensureCustomer(session, KARNATAKA);
  const itemId = await ensureItem(session, GRANULES);

  const checked = await request('POST', '/api/sales/preview', {
    customerId, lines: [{ itemId, quantity: '10', rate: '1000' }],
    date: '2026-09-17', terms: '30', reference: 'delivery-182-same',
  }, session);
  assert.equal(checked.status, 200, checked.body.message);
  assert.match(String(checked.body.placeOfSupply), /Karnataka \(29\)/);

  const recorded = await request('POST', '/api/sales/record', {
    customerId, lines: [{ itemId, quantity: '10', rate: '1000' }],
    date: '2026-09-17', terms: '30', reference: 'delivery-182-same-2',
  }, session);
  const html = await printOf(session, recorded.body.invoice.id);
  assert.ok(/\bCGST\b/.test(html) && /\bSGST\b/.test(html), 'one state, so CGST and SGST');
  // Issue #134 — the consignee box prints in full even when it matches the buyer.
  assert.ok(html.split('Peenya Plastics').length - 1 >= 2, 'the buyer is printed twice: bill-to and ship-to');
});

test('goods sent to the customer’s own godown in another state move the sale to that state', async () => {
  const session = await signIn();
  const customerId = await ensureCustomer(session, DELHI);
  const itemId = await ensureItem(session, GRANULES);

  const address = await request('POST', '/api/shipping-addresses', {
    customerId, label: 'Pune godown', line1: 'Gat 220, Bhosari MIDC', city: 'Pune', pincode: '411019', stateCode: '27',
  }, session);
  assert.equal(address.status, 200, address.body.message);
  const shipToAddressId = address.body.address.id as string;

  const sale = {
    customerId, lines: [{ itemId, quantity: '10', rate: '1000' }],
    shipTo: 'address', shipToAddressId, date: '2026-09-17', terms: '30',
  };
  const checked = await request('POST', '/api/sales/preview', { ...sale, reference: 'delivery-182-godown' }, session);
  assert.equal(checked.status, 200, checked.body.message);
  // Section 10(1)(a) — the movement ends in Maharashtra, so the sale counts there.
  assert.match(String(checked.body.placeOfSupply), /Maharashtra \(27\)/);
  assert.match(String(checked.body.placeOfSupply), /finish their journey/);

  const recorded = await request('POST', '/api/sales/record', { ...sale, reference: 'delivery-182-godown-2' }, session);
  assert.equal(recorded.status, 200, recorded.body.message);
  const html = await printOf(session, recorded.body.invoice.id);
  assert.ok(html.includes('Gat 220, Bhosari MIDC'), 'the consignee block shows the Pune address');
  assert.ok(html.includes('Maharashtra (27)'));
  assert.ok(html.includes('IGST'), 'goods crossing a state line carry IGST');
});

test('goods delivered to a third party count where the billed customer is, not where the goods land', async () => {
  const session = await signIn();
  const billedTo = await ensureCustomer(session, KARNATAKA);
  const consignee = await ensureCustomer(session, {
    legalName: 'Nashik Moulders', registration: 'regular', gstin: '27FFFFF5555F1ZZ',
    line1: 'Plot 4, Satpur MIDC', city: 'Nashik', pincode: '422007',
  });
  const itemId = await ensureItem(session, GRANULES);

  const sale = {
    customerId: billedTo, lines: [{ itemId, quantity: '10', rate: '1000' }],
    shipTo: 'party', shipToPartyId: consignee, date: '2026-09-17', terms: '30',
  };
  const checked = await request('POST', '/api/sales/preview', { ...sale, reference: 'delivery-182-third' }, session);
  assert.equal(checked.status, 200, checked.body.message);
  // Section 10(1)(b) — the buyer's own state, although the goods went to Maharashtra.
  assert.match(String(checked.body.placeOfSupply), /Karnataka \(29\)/);
  assert.match(String(checked.body.placeOfSupply), /Nashik Moulders/);

  const recorded = await request('POST', '/api/sales/record', { ...sale, reference: 'delivery-182-third-2' }, session);
  const html = await printOf(session, recorded.body.invoice.id);
  assert.ok(html.includes('Nashik Moulders'), 'the consignee block shows the third party');
  assert.ok(html.includes('27FFFFF5555F1ZZ'), 'with their own GST number');
  assert.ok(/\bCGST\b/.test(html) && /\bSGST\b/.test(html), 'and the tax is the billed customer’s own state’s');
});

test('the transporter, vehicle, LR number, destination and order number all print in their boxes', async () => {
  const session = await signIn();
  const customerId = await ensureCustomer(session, DELHI);
  const itemId = await ensureItem(session, GRANULES);

  const carrier = await request('POST', '/api/transporters', {
    name: 'Sharma Roadlines', transporterId: '29AAAAA0000A1ZY',
  }, session);
  assert.equal(carrier.status, 200, carrier.body.message);

  const recorded = await request('POST', '/api/sales/record', {
    customerId, lines: [{ itemId, quantity: '1400', rate: '60' }],
    transporterId: carrier.body.transporter.id,
    // Typed carelessly, saved and printed in the one shape a check post reads.
    vehicleNumber: 'ka 01 ab 1234',
    lrNumber: 'SRL/2026/44120', lrDate: '2026-09-20', destination: 'Pune',
    buyerOrderNumber: 'DP/PO/188', termsOfDelivery: 'Ex-godown', otherReferences: 'Trial lot',
    date: '2026-09-17', terms: '30', reference: 'delivery-182-transport',
  }, session);
  assert.equal(recorded.status, 200, recorded.body.message);

  const html = await printOf(session, recorded.body.invoice.id);
  for (const expected of ['Sharma Roadlines', 'KA01AB1234', 'SRL/2026/44120', 'Pune', 'DP/PO/188', 'Ex-godown', 'Trial lot']) {
    assert.ok(html.includes(expected), `the printed bill must carry ${expected}`);
  }
  assert.ok(!html.includes('ka 01 ab 1234'), 'the vehicle number is normalised, not printed as typed');
});

test('an e-way bill number is twelve digits, and anything else is refused', async () => {
  const session = await signIn();
  const customerId = await ensureCustomer(session, DELHI);
  const itemId = await ensureItem(session, GRANULES);
  const sale = { customerId, lines: [{ itemId, quantity: '10', rate: '1000' }], date: '2026-09-17', terms: '30' };

  const short = await request('POST', '/api/sales/preview', { ...sale, ewayBillNumber: '72161460552', reference: 'delivery-182-short' }, session);
  assert.equal(short.status, 422);
  assert.equal(short.body.code, 'EWAY_BILL_NUMBER');
  assert.match(String(short.body.message), /exactly 12 digits/);

  const recorded = await request('POST', '/api/sales/record', { ...sale, ewayBillNumber: '721614605529', reference: 'delivery-182-eway' }, session);
  assert.equal(recorded.status, 200, recorded.body.message);
  assert.ok((await printOf(session, recorded.body.invoice.id)).includes('721614605529'));
});

test('an e-way bill raised after the bill was issued prints on every later copy, and the stored bill is untouched', async () => {
  const session = await signIn();
  const customerId = await ensureCustomer(session, DELHI);
  const itemId = await ensureItem(session, GRANULES);

  const recorded = await request('POST', '/api/sales/record', {
    customerId, lines: [{ itemId, quantity: '1400', rate: '60' }],
    date: '2026-09-17', terms: '30', reference: 'delivery-182-late',
  }, session);
  assert.equal(recorded.status, 200, recorded.body.message);
  const before = await printOf(session, recorded.body.invoice.id);

  const raised = await request('POST', '/api/eway/generate', {
    invoice: recorded.body.invoice.id, distanceKm: '1800', vehicle: 'KA01AB1234', reason: 'SUPPLY',
  }, session);
  assert.equal(raised.status, 200, JSON.stringify(raised.body));
  const number = String(raised.body.ewayBillNumber ?? raised.body.acknowledgement?.ewayBillNumber ?? '');
  assert.match(number, /^[0-9]{12}$/, JSON.stringify(raised.body));

  const after = await printOf(session, recorded.body.invoice.id);
  assert.ok(!before.includes(number), 'the first copy was printed before the number existed');
  assert.ok(after.includes(number), 'the reprint carries it');
});

test('a load over the limit is reminded about an e-way bill, and one under it is not', async () => {
  const session = await signIn();
  const delhi = await ensureCustomer(session, DELHI);
  const karnataka = await ensureCustomer(session, KARNATAKA);
  const itemId = await ensureItem(session, GRANULES);

  // 1400 × ₹60 = ₹84,000 of goods; 18% is ₹15,120; the consignment is ₹99,120, over ₹50,000.
  const big = await request('POST', '/api/sales/preview', {
    customerId: delhi, lines: [{ itemId, quantity: '1400', rate: '60' }],
    date: '2026-09-17', terms: '30', reference: 'delivery-182-reminder-yes',
  }, session);
  assert.equal(big.status, 200, big.body.message);
  assert.equal(big.body.ewayBill?.outcome, 'REQUIRED');
  assert.match(String(big.body.ewayBill.message), /before the vehicle leaves/);

  // 10 × ₹4,000 = ₹40,000 of goods; 9% + 9% is ₹7,200; the consignment is ₹47,200, under the limit.
  const small = await request('POST', '/api/sales/preview', {
    customerId: karnataka, lines: [{ itemId, quantity: '10', rate: '4000' }],
    date: '2026-09-17', terms: '30', reference: 'delivery-182-reminder-no',
  }, session);
  assert.equal(small.status, 200, small.body.message);
  assert.equal(small.body.ewayBill, null);
});

test('a vehicle number that is not a vehicle number is refused, and so is an unknown transporter', async () => {
  const session = await signIn();
  const customerId = await ensureCustomer(session, DELHI);
  const itemId = await ensureItem(session, GRANULES);
  const sale = { customerId, lines: [{ itemId, quantity: '10', rate: '1000' }], date: '2026-09-17', terms: '30' };

  const badVehicle = await request('POST', '/api/sales/preview', { ...sale, vehicleNumber: 'LORRY-1', reference: 'delivery-182-bad-vehicle' }, session);
  assert.equal(badVehicle.status, 422);
  assert.equal(badVehicle.body.code, 'VEHICLE_NUMBER');

  const unknownCarrier = await request('POST', '/api/sales/preview', { ...sale, transporterId: 'nobody', reference: 'delivery-182-bad-carrier' }, session);
  assert.equal(unknownCarrier.status, 422);
  assert.equal(unknownCarrier.body.code, 'TRANSPORTER_NOT_FOUND');
});
