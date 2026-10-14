/**
 * Issue #289, part 1 — suppliers with no GST registration, and composition dealers, as the law
 * allows them (checked 10 Oct 2026; sources on the issue):
 *
 *  - not registered: lawful on the grounds of CGST s.22 and s.23; may not charge GST (s.32(1)); no
 *    credit on their bill (s.16(2)(a));
 *  - composition dealer: has a GSTIN but may not collect tax (s.10(4)); no credit (s.17(5)(e));
 *  - a purchase from an unregistered seller on a reverse-charge list (Notification 4/2017-CT(R)
 *    S.No. 4A raw cotton from an agriculturist, S.No. 8 metal scrap from any unregistered person) is
 *    held back with the notification named, rather than recorded without the GST the buyer owes;
 *  - GSTR-3B Table 5 counts composition purchases but not a taxable item from an unregistered seller.
 *
 * Every name and figure below is synthetic and belongs to nobody.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { useFixedAppClock } from '../src/app-clock.ts';
import { syntheticGstin } from '../../../packages/masters/src/fixtures.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const COMPANY_A = '00000000-0000-4000-8000-000000000001';
const MONTH = '2026-07';
const DATE = '2026-07-10';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

let owner = '';
const ok = async (path: string, body: Record<string, unknown>) => {
  const response = await request('POST', path, body, owner);
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(response.body)}`);
  return response.body;
};

const RAMU = { legalName: 'Ramu Kirana Wholesale', registration: 'unregistered', unregisteredBasis: 'BELOW_THRESHOLD', line1: '4, Old Market Road', city: 'Tumakuru', pincode: '572101' };
const FARMER = { legalName: 'Shivappa (farmer)', registration: 'unregistered', unregisteredBasis: 'AGRICULTURIST', line1: 'Survey No. 41, Hosahalli', city: 'Haveri', pincode: '581110' };
const COMPOSITION = { legalName: 'Lakshmi Packaging', registration: 'composition', gstin: syntheticGstin('29', 'LLLLL5555L'), line1: '9, KIADB Layout', city: 'Bengaluru', pincode: '560058' };

let ramu = '';
let farmer = '';
let composition = '';

test('a supplier with no GST number is added only on a ground the law allows', async () => {
  owner = (await request('POST', '/api/auth/login', { companyId: COMPANY_A, email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' })).body.sessionId;
  const noGround = await request('POST', '/api/suppliers', { ...RAMU, unregisteredBasis: '' }, owner);
  assert.equal(noGround.status, 422);
  assert.equal(noGround.body.code, 'SUPPLIER_UNREGISTERED_BASIS');
  const withGstin = await request('POST', '/api/suppliers', { ...RAMU, gstin: '29AAAAA0000A1ZY' }, owner);
  assert.equal(withGstin.body.code, 'SUPPLIER_UNREGISTERED_HAS_GSTIN');

  const added = await ok('/api/suppliers', RAMU);
  ramu = added.supplier.id;
  assert.equal(added.supplier.gstin, null);
  assert.equal(added.supplier.registration, 'unregistered');
  assert.equal(added.supplier.stateCode, '29', 'the state comes from the PIN code');
  assert.match(added.message, /s\.22/);
  assert.match(added.message, /s\.32\(1\)/);
  farmer = (await ok('/api/suppliers', FARMER)).supplier.id;
  composition = (await ok('/api/suppliers', COMPOSITION)).supplier.id;
});

test('their bill carries no GST and gives no credit; GST typed on it is refused, citing the law', async () => {
  const charged = await request('POST', '/api/purchases/record', {
    supplierId: ramu, reference: 'RK-11', date: DATE, lines: [{ item: 'Herbal Bath Soap 100g', quantity: '100', rate: '20', gst: '500' }],
  }, owner);
  assert.equal(charged.status, 422);
  assert.equal(charged.body.code, 'PURCHASE_GST_NOT_ALLOWED');
  assert.match(charged.body.message, /CGST s\.32\(1\)/);

  const recorded = await ok('/api/purchases/record', {
    supplierId: ramu, reference: 'RK-11', date: DATE, lines: [{ item: 'Herbal Bath Soap 100g', quantity: '100', rate: '20' }],
  });
  assert.equal(recorded.owe, 2000, '₹2,000 and not a paisa of GST');
  // GSTR-2B is built from registered suppliers' GSTR-1/IFF, GSTR-5, GSTR-6 and ICEGATE; this bill
  // can never be in it, so it is not held back waiting for it.
  assert.equal(recorded.purchaseCheck, null);
  assert.equal(recorded.bill.tax?.total ?? 0, 0);

  const fromComposition = await request('POST', '/api/purchases/record', {
    supplierId: composition, reference: 'LP-7', date: DATE, lines: [{ item: 'Herbal Bath Soap 100g', quantity: '50', rate: '20', gst: '1800' }],
  }, owner);
  assert.equal(fromComposition.body.code, 'PURCHASE_GST_NOT_ALLOWED');
  assert.match(fromComposition.body.message, /CGST s\.10\(4\)/);
  const composed = await ok('/api/purchases/record', {
    supplierId: composition, reference: 'LP-7', date: DATE, lines: [{ item: 'Herbal Bath Soap 100g', quantity: '50', rate: '20' }],
  });
  assert.equal(composed.owe, 1000);
  assert.equal(composed.purchaseCheck, null, 'a composition dealer files no GSTR-1 either');
});

test('a reverse-charge purchase from an unregistered seller is held back, naming the notification', async () => {
  await ok('/api/items', { name: 'MS Scrap (heavy melting)', kind: 'goods', hsnSac: '72044900', unit: 'KGS', taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'Rate schedule' });
  await ok('/api/items', { name: 'Raw Cotton (kapas)', kind: 'goods', hsnSac: '52010012', unit: 'KGS', taxKind: 'taxable', ratePercentTimes100: '500', basis: 'Rate schedule' });

  const scrap = await request('POST', '/api/purchases/record', {
    supplierId: ramu, reference: 'RK-12', date: DATE, lines: [{ item: 'MS Scrap (heavy melting)', quantity: '1000', rate: '30' }],
  }, owner);
  assert.equal(scrap.body.code, 'PURCHASE_REVERSE_CHARGE');
  assert.match(scrap.body.message, /4\/2017-Central Tax \(Rate\), S\.No\. 8 inserted by 06\/2024/);
  assert.match(scrap.body.message, /10 October 2024/);
  assert.match(scrap.body.message, /Rule 47A/);
  assert.match(scrap.body.message, /nothing was recorded/);

  const cotton = await request('POST', '/api/purchases/record', {
    supplierId: farmer, reference: 'SH-1', date: DATE, lines: [{ item: 'Raw Cotton (kapas)', quantity: '500', rate: '70' }],
  }, owner);
  assert.equal(cotton.body.code, 'PURCHASE_REVERSE_CHARGE');
  assert.match(cotton.body.message, /S\.No\. 4A/);

  // The same cotton from a trader below the threshold is not on the list: the entry names an
  // agriculturist as the supplier. It is an ordinary purchase with no GST.
  const fromTrader = await ok('/api/purchases/record', {
    supplierId: ramu, reference: 'RK-13', date: DATE, lines: [{ item: 'Raw Cotton (kapas)', quantity: '100', rate: '70' }],
  });
  assert.equal(fromTrader.owe, 7000);
});

test('GSTR-3B Table 5 counts the composition purchase, not the taxable items from the unregistered seller', async () => {
  await ok('/api/gst-returns/prepare', { period: MONTH });
  await ok('/api/gst-returns/approve', { period: MONTH, note: 'checked' });
  const threeB = (await ok('/api/gst-returns/export', { period: MONTH, returnType: 'GSTR3B' })).payload;
  const table5 = threeB.inward_sup.isup_details.find((row: any) => row.ty === 'GST');
  assert.equal(table5.intra + table5.inter, 1000, 'only Lakshmi Packaging’s ₹1,000 bill of supply');
});
