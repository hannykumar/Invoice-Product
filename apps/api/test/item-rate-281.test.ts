/**
 * Issue #281 — a GST rate belongs to the item it was declared for, not to its HSN code.
 *
 * Before the fix the rate was declared against the code, and the most recent declaration for a code
 * won for every item under it: adding "Liquid hand wash 200ml" at 18% under the soap's code
 * 34011190 put 18% on every later bill for Herbal Bath Soap 100g, which is 5%. Every name and GST
 * number below is synthetic.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { useFixedAppClock } from '../src/app-clock.ts';
import { declaredRatesOf } from '../src/catalogue-application.ts';
import { isoDate } from '@invoice/kernel';
import { KONKAN_OWNER, SAMPOORNA_VIEWER, signIn } from './sign-in-helper.ts';

useFixedAppClock('2026-08-29T10:00:00.000Z');

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const KONKAN = '00000000-0000-4000-8000-000000000011';
const SOAP = 'sampoorna:item:SOAP';
const ABC_TRADERS = 'sampoorna:party:customer';

const request = async (method: string, path: string, body: Record<string, unknown>, session: string) => {
  const response = await handleApi(method, path, body, `Bearer ${session}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

/** The GST the Sale screen shows while the bill is typed (the same figures as the review). */
const gstOn = async (session: string, customerId: string, itemId: string, date = '2026-08-29', quantity = '10', rate = '40') => {
  const estimate = await request('POST', '/api/sales/estimate', {
    customerId, date, terms: '0', lines: JSON.stringify([{ itemId, quantity, unit: 'PCS', rate }]),
  }, session);
  assert.equal(estimate.status, 200, JSON.stringify(estimate.body));
  return estimate.body as { totals: { taxableValue: string; totalTax: string }; refusals: { code: string }[] };
};

const ratePercentOf = async (session: string, itemId: string): Promise<number | null> =>
  (await request('GET', '/api/catalogue', {}, session)).body.items.find((item: { id: string }) => item.id === itemId).ratePercent;

const HAND_WASH = { name: 'Liquid hand wash 200ml', kind: 'goods', hsnSac: '34011190', unit: 'PCS', taxKind: 'taxable', ratePercent: '18', basis: 'Our accountant says hand wash is 18%' };

test('#281: a second item under the soap\'s code at 18% leaves the soap at 5%, on the list and on the bill', async () => {
  const owner = await signIn(undefined, SAMPOORNA);
  assert.equal(await ratePercentOf(owner, SOAP), 5);
  const before = await gstOn(owner, ABC_TRADERS, SOAP);
  assert.equal(Number(before.totals.totalTax), 20);

  const created = await request('POST', '/api/items', HAND_WASH, owner);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.match(created.body.message, /charged at 18%/);
  assert.ok(
    created.body.warnings.includes('Herbal Bath Soap 100g, with the same code, is charged 5%. This item will be charged 18%. Both stay as they are.'),
    JSON.stringify(created.body.warnings),
  );
  const handWash = created.body.item.id as string;

  assert.equal(await ratePercentOf(owner, SOAP), 5);
  assert.equal(await ratePercentOf(owner, handWash), 18);
  const soap = await gstOn(owner, ABC_TRADERS, SOAP);
  assert.deepEqual([Number(soap.totals.taxableValue), Number(soap.totals.totalTax)], [400, 20], 'ten soaps at ₹40 carry ₹20 GST, not ₹72');
  assert.equal(Number((await gstOn(owner, ABC_TRADERS, handWash)).totals.totalTax), 72);

  // A retry of the same request makes nothing new and changes no rate, even with another figure in it.
  const retried = await request('POST', '/api/items', { ...HAND_WASH, ratePercent: '12' }, owner);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.item.id, handWash);
  assert.equal(retried.body.item.ratePercent, 18);
  assert.equal(Number((await gstOn(owner, ABC_TRADERS, handWash)).totals.totalTax), 72);
  assert.equal(Number((await gstOn(owner, ABC_TRADERS, SOAP)).totals.totalTax), 20);
  assert.equal(declaredRatesOf(SAMPOORNA).list(SAMPOORNA).filter((rate) => rate.itemId === handWash).length, 1);
});

test('#281: an item at the same rate under the same code gets no warning; a viewer may not add one', async () => {
  const owner = await signIn(undefined, SAMPOORNA);
  const created = await request('POST', '/api/items', { name: 'Neem bath soap 75g', kind: 'goods', hsnSac: '34011190', unit: 'PCS', taxKind: 'taxable', ratePercent: '5' }, owner);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.ok(!created.body.warnings.some((warning: string) => warning.includes('Herbal Bath Soap 100g')), JSON.stringify(created.body.warnings));

  const viewer = await signIn(SAMPOORNA_VIEWER, SAMPOORNA);
  const refused = await request('POST', '/api/items', { ...HAND_WASH, name: 'Viewer hand wash' }, viewer);
  assert.equal(refused.status, 403);
  assert.equal(Number((await gstOn(owner, ABC_TRADERS, SOAP)).totals.totalTax), 20);
});

test('#281: a new rate starts the day it is declared, or the day picked, never back in 2017', async () => {
  const owner = await signIn(undefined, SAMPOORNA);
  const created = await request('POST', '/api/items', { name: 'Shaving foam 200g', kind: 'goods', hsnSac: '33071010', unit: 'PCS', taxKind: 'taxable', ratePercent: '18' }, owner);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const foam = created.body.item.id as string;
  const declared = declaredRatesOf(SAMPOORNA).list(SAMPOORNA).find((rate) => rate.itemId === foam);
  assert.equal(declared?.effectiveFrom, '2026-08-29');

  assert.equal(Number((await gstOn(owner, ABC_TRADERS, foam)).totals.totalTax), 72);
  // A bill dated before the rate was declared has no rate behind it, and says so.
  const earlier = await request('POST', '/api/sales/preview', {
    customerId: ABC_TRADERS, date: '2026-08-28', terms: '0', lines: JSON.stringify([{ itemId: foam, quantity: '10', unit: 'PCS', rate: '40' }]),
    requestId: 'item-rate-281-earlier', approvalReason: 'Agreed with the owner',
  }, owner);
  assert.equal(earlier.status, 400, JSON.stringify(earlier.body));
  assert.match(String(earlier.body.message), /rate/i);

  const picked = await request('POST', '/api/items', { name: 'Shaving gel 100g', kind: 'goods', hsnSac: '33071010', unit: 'PCS', taxKind: 'taxable', ratePercent: '18', effectiveFrom: '2026-04-01' }, owner);
  assert.equal(picked.status, 200, JSON.stringify(picked.body));
  assert.equal(declaredRatesOf(SAMPOORNA).list(SAMPOORNA).find((rate) => rate.itemId === picked.body.item.id)?.effectiveFrom, '2026-04-01');
});

test('#281: changing an item\'s code keeps its own rate and never takes the rate of the items already there', async () => {
  const owner = await signIn(undefined, SAMPOORNA);
  const created = await request('POST', '/api/items', { name: 'Glycerine soap 125g', kind: 'goods', hsnSac: '34011110', unit: 'PCS', taxKind: 'taxable', ratePercent: '12' }, owner);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const glycerine = created.body.item.id as string;

  const moved = await request('POST', '/api/items/edit', { itemId: glycerine, hsnSac: '34011190' }, owner);
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.item.ratePercent, 12);
  assert.ok(moved.body.warnings.includes('Herbal Bath Soap 100g, with the same code, is charged 5%. This item will be charged 12%. Both stay as they are.'), JSON.stringify(moved.body.warnings));
  assert.equal(Number((await gstOn(owner, ABC_TRADERS, glycerine)).totals.totalTax), 48);
  assert.equal(Number((await gstOn(owner, ABC_TRADERS, SOAP)).totals.totalTax), 20);
});

test('#281: two items saved at once under one code each keep their own rate', async () => {
  const owner = await signIn(undefined, SAMPOORNA);
  const [first, second] = await Promise.all([
    request('POST', '/api/items', { name: 'Carbolic soap 100g', kind: 'goods', hsnSac: '34011910', unit: 'PCS', taxKind: 'taxable', ratePercent: '5' }, owner),
    request('POST', '/api/items', { name: 'Laundry soap bar 250g', kind: 'goods', hsnSac: '34011910', unit: 'PCS', taxKind: 'taxable', ratePercent: '18' }, owner),
  ]);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(Number((await gstOn(owner, ABC_TRADERS, first.body.item.id)).totals.totalTax), 20);
  assert.equal(Number((await gstOn(owner, ABC_TRADERS, second.body.item.id)).totals.totalTax), 72);
});

test('#281: one company\'s new item never changes another company\'s soap', async () => {
  const owner = await signIn(undefined, SAMPOORNA);
  await request('POST', '/api/items', { ...HAND_WASH, name: 'Tenancy hand wash' }, owner);
  const konkan = await signIn(KONKAN_OWNER, KONKAN);
  assert.equal(await ratePercentOf(konkan, 'konkan:item:SOAP'), 5);
  assert.equal(Number((await gstOn(konkan, 'konkan:party:customer', 'konkan:item:SOAP')).totals.totalTax), 20);
});

test('#281: a rate kept against a code alone, from before the fix, still bills each item at its own figure', async () => {
  const owner = await signIn(undefined, SAMPOORNA);
  // As every declaration was written before #281: no item named, the whole code covered, from 2017.
  declaredRatesOf(SAMPOORNA).declare({
    companyId: SAMPOORNA, code: '3401', kind: 'GOODS', ratePercentTimes100: 2800n,
    effectiveFrom: isoDate('2017-07-01'), effectiveTo: null, declaredBy: 'the business', declaredOn: isoDate('2026-08-29'),
    basis: 'An old declaration against the code alone',
  });
  assert.equal(Number((await gstOn(owner, ABC_TRADERS, SOAP)).totals.totalTax), 20);
});
