/**
 * Issue #289, part 3 — a purchase line marked "credit not available" because CGST s.17(5) blocks
 * it: its GST goes into what it cost, not into Input GST, and GSTR-3B shows it in Table 4(A) and
 * takes it back out in Table 4(B)(1) (Circular 170/02/2022-GST, 06.07.2022, para 4 A and B; form as
 * amended by Notification 14/2022-CT). Under reverse charge the tax is still owed (s.9(3)); only
 * the credit goes. Law read 21 Oct 2026; sources in packages/purchasing/src/blocked-credit.ts.
 *
 * Every name and figure below is synthetic and belongs to nobody.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { useFixedAppClock } from '../src/app-clock.ts';
import { signIn } from './sign-in-helper.ts';
import { syntheticGstin } from '../../../packages/masters/src/fixtures.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const COMPANY_A = '00000000-0000-4000-8000-000000000001';
const MONTH = '2026-09';
const DATE = '2026-09-10';

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
const refused = async (path: string, body: Record<string, unknown>) => {
  const response = await request('POST', path, body, owner);
  assert.equal(response.status >= 400, true, `${path} should be refused: ${JSON.stringify(response.body)}`);
  return response.body;
};
/** Table 4 of the month's GSTR-3B, box by box (tax only), and 3.1(d)'s reverse-charge tax. */
const table4 = async () => {
  const month = await ok('/api/gst-returns', { period: MONTH });
  const threeB = month.gstr3b ?? month.workspace?.gstr3b;
  const box = (id: string) => threeB.credit.find((row: any) => row.boxId === id)?.tax ?? 0;
  const rcm = threeB.heads.filter((head: any) => head.head === 'CGST' || head.head === 'SGST').reduce((total: number, head: any) => total + head.reverseChargeCash, 0);
  return { a3: box('4A(3)'), a5: box('4A(5)'), b: box('4B'), c: box('4C'), rcm };
};

let garage = '';
let furniture = '';
let guards = '';

test('suppliers and items', async () => {
  owner = await signIn('owner@sampoorna.example.invalid', COMPANY_A);
  garage = (await ok('/api/suppliers', { legalName: 'Speedy Motor Works', registration: 'regular', gstin: syntheticGstin('29', 'MMMMM7777M'), line1: '8, Garage Road', city: 'Bengaluru', pincode: '560034' })).supplier.id;
  furniture = (await ok('/api/suppliers', { legalName: 'Ashoka Furniture Mart', registration: 'regular', gstin: syntheticGstin('29', 'FFFFF8888F'), line1: '2, Timber Yard', city: 'Bengaluru', pincode: '560053' })).supplier.id;
  guards = (await ok('/api/suppliers', { legalName: 'Shankar Watch and Ward', registration: 'unregistered', unregisteredBasis: 'BELOW_THRESHOLD', line1: '5, Gate Street', city: 'Bengaluru', pincode: '560011' })).supplier.id;
  await ok('/api/items', { name: 'Car servicing', kind: 'service', hsnSac: '998714', unit: 'NOS', taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'Rate schedule' });
  await ok('/api/items', { name: 'Office chair', kind: 'goods', hsnSac: '94013000', unit: 'NOS', taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'Rate schedule' });
  await ok('/api/items', { name: 'Diwali gift box', kind: 'goods', hsnSac: '94013000', unit: 'NOS', taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'Rate schedule' });
  await ok('/api/items', { name: 'Security guard service', kind: 'service', hsnSac: '998525', unit: 'NOS', taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'Rate schedule' });
});

test('servicing the owner\'s car (s.17(5)(ab)): ₹10,000 + ₹1,800 GST — the ₹1,800 goes into cost, none is claimed; 4(A)(5) and 4(B)(1) both carry it', async () => {
  const before = await table4();
  const bill = { supplierId: garage, reference: 'SMW-41', date: DATE, lines: [{ item: 'Car servicing', quantity: '1', rate: '10000', gst: '1800', blocked: 'vehicle_insurance_repair' }] };
  const preview = await ok('/api/purchases/preview', bill);
  assert.equal(preview.tax.total, 0, 'no GST to claim back');
  const said = preview.effects.join(' ');
  assert.match(said, /credit not available/);
  assert.match(said, /s\.17\(5\)\(ab\)/);
  assert.match(said, /₹1,800\.00/);
  assert.match(said, /added to cost: ₹1,800\.00/);

  const recorded = await ok('/api/purchases/record', bill);
  assert.equal(recorded.owe, 11800, 'the garage is owed the whole bill, GST included');
  assert.equal(recorded.bill.cgst + recorded.bill.sgst, 0, 'nothing in Input GST');
  const again = await ok('/api/purchases/record', bill);
  assert.equal(again.deduplicated, true);

  const after = await table4();
  assert.equal(after.a5 - before.a5, 1800, '4(A)(5): the whole credit, as GSTR-2B would show it');
  assert.equal(after.b - before.b, 1800, '4(B)(1): the s.17(5) part taken back out');
  assert.equal(after.c - before.c, 0, '4(C): nothing more to use');
});

test('one bill, two kinds: chairs for the shop are claimed; Diwali gifts (s.17(5)(h)) are not', async () => {
  const preview = await ok('/api/purchases/preview', {
    supplierId: furniture, reference: 'AFM-7', date: DATE,
    lines: [
      { item: 'Office chair', quantity: '2', rate: '2500', gst: '1800' },
      { item: 'Diwali gift box', quantity: '4', rate: '500', gst: '1800', blocked: '17(5)(h)' },
    ],
  });
  // Chairs ₹5,000 × 18% = ₹900 claimed; gifts ₹2,000 × 18% = ₹360 into cost.
  assert.equal(preview.tax.total, 900);
  assert.equal(preview.amount, 8260, '₹5,000 + ₹900 + ₹2,000 + ₹360');
  assert.match(preview.effects.join(' '), /Diwali gift box: credit not available — given away as gifts or free samples \(CGST s\.17\(5\)\(h\)\)\. Its ₹360\.00/);
  const recorded = await ok('/api/purchases/record', {
    supplierId: furniture, reference: 'AFM-7', date: DATE,
    lines: [
      { item: 'Office chair', quantity: '2', rate: '2500', gst: '1800' },
      { item: 'Diwali gift box', quantity: '4', rate: '500', gst: '1800', blocked: '17(5)(h)' },
    ],
  });
  assert.equal(recorded.owe, 8260);
  assert.equal(recorded.bill.cgst + recorded.bill.sgst, 900);
});

test('reverse charge and blocked: security for the owner\'s home (s.17(5)(g)) — the ₹1,800 is still paid in 3.1(d), 4(A)(3) and 4(B)(1) carry it', async () => {
  const before = await table4();
  const recorded = await ok('/api/purchases/record', {
    supplierId: guards, reference: 'SWW-3', date: DATE, receivedOn: DATE, rcm_security_body_corporate: 'no',
    lines: [{ item: 'Security guard service', quantity: '1', rate: '10000', blocked: 'personal_use' }],
  });
  assert.equal(recorded.owe, 10000, 'the agency charges no GST');
  assert.equal(recorded.bill.cgst + recorded.bill.sgst, 0, 'no credit in the books');
  // The self-invoice is still due: the purchase is under reverse charge whatever the credit.
  assert.notEqual(recorded.reverseCharge.selfInvoice, null);
  await ok('/api/purchases/self-invoice', { billId: recorded.reverseCharge.billId, date: DATE });
  const after = await table4();
  assert.equal(after.rcm - before.rcm, 1800, '3.1(d): s.17(5) takes the credit, never the tax owed (s.9(3))');
  assert.equal(after.a3 - before.a3, 1800);
  assert.equal(after.b - before.b, 1800);
  assert.equal(after.c - before.c, 0);
});

test('the GSTR-3B file puts the blocked credit in 4(B)(1) (RUL), not 4(B)(2)', async () => {
  await ok('/api/gst-returns/prepare', { period: MONTH });
  await ok('/api/gst-returns/approve', { period: MONTH, note: 'checked' });
  const file = (await ok('/api/gst-returns/export', { period: MONTH, returnType: 'GSTR3B' })).payload;
  const rul = file.itc_elg.itc_rev.find((row: any) => row.ty === 'RUL');
  const oth = file.itc_elg.itc_rev.find((row: any) => row.ty === 'OTH');
  assert.equal(rul.camt + rul.samt, 3600, 'the car servicing ₹1,800 + the guards ₹1,800');
  assert.equal(oth.camt + oth.samt, 0);
});

test('wrong inputs: an unknown reason, and "not available" on a line with no GST', async () => {
  const unknown = await refused('/api/purchases/preview', { supplierId: garage, reference: 'SMW-42', date: DATE, lines: [{ item: 'Car servicing', quantity: '1', rate: '100', gst: '1800', blocked: 'because' }] });
  assert.equal(unknown.code, 'PURCHASE_BLOCKED_REASON');
  const untaxed = await refused('/api/purchases/preview', { supplierId: garage, reference: 'SMW-43', date: DATE, lines: [{ item: 'Car servicing', quantity: '1', rate: '100', gst: '0', blocked: 'vehicle_insurance_repair' }] });
  assert.equal(untaxed.code, 'PURCHASE_BLOCKED_NO_GST');
});
