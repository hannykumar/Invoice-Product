/**
 * Issue #224 — the e-way bill's delivery address was the buyer's own record with the town and the
 * state swapped in. A Delhi buyer's goods delivered to Hyderabad went out as
 *
 *   Bawana Polymers — delivery address
 *   Delivery address given on the movement
 *   Hyderabad, Telangana - 110039
 *
 * 110039 is the buyer's Delhi PIN. The portal works the route out from the PIN, and an officer reads
 * it against the lorry. The address line was a sentence nobody typed, and the name was nobody's name.
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

const ensure = async (session: string, path: string, body: Record<string, unknown>, listKey: string, nameKey: string, name: string): Promise<string> => {
  const existing = (await request('GET', '/api/catalogue', {}, session)).body[listKey]
    .find((row: Record<string, string>) => row.name === name);
  if (existing !== undefined) return existing.id as string;
  const created = await request('POST', path, body, session);
  assert.equal(created.status, 200, created.body.message);
  return created.body[nameKey].id as string;
};

const DELHI = {
  legalName: 'Bawana Polymers', registration: 'regular', gstin: '07EEEEE4444E1ZG',
  line1: 'Plot 7, Bawana Industrial Area', city: 'New Delhi', pincode: '110039',
};
const GRANULES = {
  name: 'LDPE Granules', kind: 'goods', hsnSac: '39011000', unit: 'KGS',
  taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'The rate our accountant uses for granules',
};

/** The one bill inside the file prepared for the portal. */
const portalBill = (json: unknown): Record<string, unknown> =>
  (JSON.parse(String(json)) as { billLists: Record<string, unknown>[] }).billLists[0] as Record<string, unknown>;

const shipToBlock = (html: string): string => {
  const found = /<h4>Ship To<\/h4>\s*<p class="eway-party">(.*?)<\/p>/s.exec(html);
  assert.ok(found !== null, 'the page carries a Ship To block');
  return found[1] as string;
};

const saleFor = async (session: string, reference: string, extra: Record<string, unknown> = {}): Promise<{ invoice: string; customerId: string }> => {
  const customerId = await ensure(session, '/api/customers', DELHI, 'customers', 'customer', DELHI.legalName);
  const itemId = await ensure(session, '/api/items', GRANULES, 'items', 'item', GRANULES.name);
  const recorded = await request('POST', '/api/sales/record', {
    customerId, lines: [{ itemId, quantity: '1400', rate: '60' }], date: '2026-09-17', terms: '30', reference, ...extra,
  }, session);
  assert.equal(recorded.status, 200, recorded.body.message);
  return { invoice: recorded.body.invoice.id as string, customerId };
};

test('a delivery typed on the dispatch form carries its own PIN, never the buyer’s', async () => {
  const session = await signIn();
  const { invoice } = await saleFor(session, 'eway-224-typed');
  const dispatch = {
    invoice, distanceKm: '1800', vehicle: 'KA01AB1234', reason: 'SUPPLY',
    shipToState: '36', shipToAddress: 'Plot 12, IDA Uppal', shipToPlace: 'Hyderabad', shipToPincode: '500039',
  };

  const offline = await request('POST', '/api/eway/offline', dispatch, session);
  assert.equal(offline.status, 200, offline.body.message);
  const bill = portalBill(offline.body.json);
  assert.equal(bill.toPincode, 500039, 'the portal is told the Hyderabad PIN, not the buyer’s 110039');
  assert.equal(bill.toAddr1, 'Plot 12, IDA Uppal');
  assert.equal(bill.transactionType, 2, 'billed to one place, delivered to another');

  const raised = await request('POST', '/api/eway/generate', dispatch, session);
  assert.equal(raised.status, 200, JSON.stringify(raised.body));
  const printed = await request('POST', '/api/eway/print', { invoice }, session);
  assert.equal(printed.status, 200, printed.body.message);
  const block = shipToBlock(String(printed.body.html));
  assert.match(block, /500039/);
  assert.match(block, /Plot 12, IDA Uppal/);
  assert.ok(!block.includes('110039'), 'the buyer’s Delhi PIN is nowhere in the delivery address');
  assert.ok(!block.includes('Delivery address given on the movement'), 'no invented address line');
  assert.ok(!block.includes('— delivery address'), 'no invented name');
});

test('a PIN from another state, or no PIN at all, is refused', async () => {
  const session = await signIn();
  const { invoice } = await saleFor(session, 'eway-224-refused');
  const base = { invoice, distanceKm: '1800', vehicle: 'KA01AB1234', reason: 'SUPPLY', shipToState: '36', shipToAddress: 'Plot 12, IDA Uppal', shipToPlace: 'Hyderabad' };

  const delhiPin = await request('POST', '/api/eway/offline', { ...base, shipToPincode: '110039' }, session);
  assert.equal(delhiPin.status, 422);
  assert.match(String(delhiPin.body.message), /110039 is not in Telangana/);

  const noPin = await request('POST', '/api/eway/offline', base, session);
  assert.equal(noPin.status, 422);
  assert.match(String(noPin.body.message), /PIN code of the delivery address/);

  const noAddress = await request('POST', '/api/eway/offline', { ...base, shipToAddress: '', shipToPincode: '500039' }, session);
  assert.equal(noAddress.status, 422);
});

test('a delivery address already on the bill is the one the e-way bill carries', async () => {
  const session = await signIn();
  const customerId = await ensure(session, '/api/customers', DELHI, 'customers', 'customer', DELHI.legalName);
  const address = await request('POST', '/api/shipping-addresses', {
    customerId, label: 'Hyderabad godown', line1: 'Survey 44, Cherlapally', city: 'Hyderabad', pincode: '500051', stateCode: '36',
  }, session);
  assert.equal(address.status, 200, address.body.message);
  const { invoice } = await saleFor(session, 'eway-224-on-the-bill', { shipTo: 'address', shipToAddressId: address.body.address.id });

  // Nothing about the delivery typed on the dispatch form.
  const offline = await request('POST', '/api/eway/offline', { invoice, distanceKm: '1800', vehicle: 'KA01AB1234', reason: 'SUPPLY' }, session);
  assert.equal(offline.status, 200, offline.body.message);
  const bill = portalBill(offline.body.json);
  assert.equal(bill.toPincode, 500051);
  assert.equal(bill.toAddr1, 'Survey 44, Cherlapally');
  assert.equal(bill.actToStateCode, '36');

  // A form naming a different state from the bill is two journeys for one bill.
  const clash = await request('POST', '/api/eway/offline', {
    invoice, distanceKm: '1800', reason: 'SUPPLY', shipToState: '27', shipToAddress: 'Gat 220', shipToPlace: 'Pune', shipToPincode: '411019',
  }, session);
  assert.equal(clash.status, 422);
  assert.match(String(clash.body.message), /One bill cannot describe two journeys/);
});

test('a saved delivery address with a PIN from another state is refused', async () => {
  const session = await signIn();
  const customerId = await ensure(session, '/api/customers', DELHI, 'customers', 'customer', DELHI.legalName);
  const wrong = await request('POST', '/api/shipping-addresses', {
    customerId, label: 'Wrong PIN', line1: 'Survey 44, Cherlapally', city: 'Hyderabad', pincode: '110039', stateCode: '36',
  }, session);
  assert.equal(wrong.status, 422);
  assert.match(String(wrong.body.message), /not in Telangana/);
});
