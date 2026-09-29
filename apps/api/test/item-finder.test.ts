/**
 * Issue #308 — the item master carries a barcode, a usual price and another name; the item's own
 * edit dialog changes them (and the HSN code, moved off the sale line); and the picker learns which
 * items sell most and what this customer was last charged.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { useFixedAppClock } from '../src/app-clock.ts';
import { stockEverything } from './stock-helper.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const signIn = async (email = 'owner@sampoorna.example.invalid', password = 'karobar-demo'): Promise<string> => {
  const response = await request('POST', '/api/auth/login', { companyId: SAMPOORNA, email, password });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.sessionId as string;
};

test('#308: an item keeps its barcode, usual price and Hindi name; one barcode finds one item', async () => {
  const owner = await signIn();
  const created = await request('POST', '/api/items', {
    name: 'Finder Glucose Biscuit', kind: 'goods', hsnSac: '19053100', unit: 'PCS', taxKind: 'taxable', ratePercentTimes100: '1800',
    barcode: '8901063010031', price: '10.50', otherName: 'ग्लूकोज़ बिस्किट',
  }, owner);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.deepEqual([created.body.item.barcodes, created.body.item.price, created.body.item.aliases], [['8901063010031'], 10.5, ['ग्लूकोज़ बिस्किट']]);
  const listed = (await request('GET', '/api/catalogue', {}, owner)).body.items.find((item: any) => item.id === created.body.item.id);
  assert.equal(listed.price, 10.5);

  const twice = await request('POST', '/api/items', { name: 'Finder Other Biscuit', kind: 'goods', hsnSac: '19053100', unit: 'PCS', taxKind: 'taxable', ratePercentTimes100: '1800', barcode: '8901063010031' }, owner);
  assert.equal(twice.status, 422);
  assert.equal(twice.body.code, 'ITEM_BARCODE_TAKEN');
  assert.match(twice.body.message, /already on Finder Glucose Biscuit/);
  const badPrice = await request('POST', '/api/items', { name: 'Finder Rusk', kind: 'goods', hsnSac: '19054000', unit: 'PCS', taxKind: 'taxable', ratePercentTimes100: '500', price: '10.555' }, owner);
  assert.equal(badPrice.body.code, 'ITEM_PRICE');

  // The edit dialog: a new code (its declared rate follows it), a new barcode, no price.
  const edited = await request('POST', '/api/items/edit', { itemId: created.body.item.id, hsnSac: '19053200', barcode: '8901063010048', price: '', otherName: 'बिस्किट' }, owner);
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual([edited.body.item.hsnSac, edited.body.item.barcodes, edited.body.item.price, edited.body.item.aliases, edited.body.item.ratePercent], ['19053200', ['8901063010048'], null, ['बिस्किट'], 18]);
  // The item may keep its own barcode; another item may not take it.
  assert.equal((await request('POST', '/api/items/edit', { itemId: created.body.item.id, barcode: '8901063010048' }, owner)).status, 200);
  assert.equal((await request('POST', '/api/items/edit', { itemId: 'sampoorna:item:SOAP', barcode: '8901063010048' }, owner)).body.code, 'ITEM_BARCODE_TAKEN');

  const viewer = await signIn('viewer@sampoorna.example.invalid', 'viewer-demo');
  assert.equal((await request('POST', '/api/items/edit', { itemId: created.body.item.id, price: '1' }, viewer)).status, 403);
});

test('#308: the picker learns the most-sold items this week and the price this customer last paid', async () => {
  const owner = await signIn();
  await stockEverything(`Bearer ${owner}`);
  const customer = await request('POST', '/api/customers', { legalName: 'Finder Kirana Store', registration: 'unregistered', stateCode: '29', line1: '3 Market Road', city: 'Bengaluru', pincode: '560002' }, owner);
  const customerId = customer.body.customer.id as string;
  const before = await request('POST', '/api/items/selling', { customerId }, owner);
  assert.equal(before.status, 200);
  assert.deepEqual(before.body.lastPrices, {}, 'a new customer has no last price');

  for (const [rate, requestId] of [['240', 'finder-308-a'], ['245.50', 'finder-308-b']]) {
    const sold = await request('POST', '/api/sales/record', {
      customerId, date: '2026-09-28', terms: '30', requestId, lines: JSON.stringify([{ itemId: 'sampoorna:item:SOAP', quantity: '2', rate }]),
    }, owner);
    assert.equal(sold.status, 200, JSON.stringify(sold.body));
  }
  const after = await request('POST', '/api/items/selling', { customerId }, owner);
  assert.equal(after.body.lastPrices['sampoorna:item:SOAP'].price, 245.5, 'the latest bill to them wins');
  assert.equal(after.body.mostSoldThisWeek[0], 'sampoorna:item:SOAP');
  assert.ok(after.body.mostSoldThisWeek.length <= 6);
  assert.equal(after.body.sold['sampoorna:item:SOAP'], before.body.sold['sampoorna:item:SOAP'] + 2);
  // Another customer has not been charged anything.
  assert.deepEqual((await request('POST', '/api/items/selling', { customerId: 'nobody' }, owner)).body.lastPrices, {});
});
