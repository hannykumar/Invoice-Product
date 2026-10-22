/**
 * Issue #289, part 2 — reverse charge: purchases on which the registered buyer pays the GST
 * (CGST s.9(3)). Law checked 10–11 Oct 2026; sources on the issue:
 *
 *  - the lists: goods Notification 4/2017-CT(R), services 13/2017-CT(R), as amended;
 *  - GTA freight (13/2017 S.No. 1): only where a consignment note was issued; not where the GTA opted
 *    for forward charge and says so on its bill (05/2022, 08/2023); exempt at ₹1,500 or less a
 *    truckload, ₹750 or less a consignee, and for some goods (12/2017-CT(R) S.No. 21); 5% under
 *    reverse charge (GST Council, 56th meeting, 3 Sep 2025);
 *  - advocates (13/2017 S.No. 2), exempt to a business with turnover up to ₹20 lakh (12/2017 S.No. 45);
 *  - the tax is paid in cash (s.49(4), Circular 172/04/2022-GST): GSTR-3B 3.1(d), credit 4(A)(3).
 *
 * Every name and figure below is synthetic and belongs to nobody.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { useFixedAppClock } from '../src/app-clock.ts';
import { syntheticGstin } from '../../../packages/masters/src/fixtures.ts';
import { signIn as signInAs } from './sign-in-helper.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const COMPANY_A = '00000000-0000-4000-8000-000000000001';
const MONTH = '2026-08';
const DATE = '2026-08-12';

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
const questionsOf = (body: Record<string, any>) => JSON.parse(body.details.questions) as { id: string; question: string; why: string }[];

let scrapDealer = '';
let transporter = '';
let advocate = '';

test('suppliers and items for the reverse-charge cases', async () => {
  owner = await signInAs('owner@sampoorna.example.invalid', COMPANY_A);
  scrapDealer = (await ok('/api/suppliers', { legalName: 'Kabadi Traders', registration: 'unregistered', unregisteredBasis: 'BELOW_THRESHOLD', line1: '2, Scrap Lane', city: 'Bengaluru', pincode: '560026' })).supplier.id;
  transporter = (await ok('/api/suppliers', { legalName: 'Sri Durga Roadways', registration: 'regular', gstin: syntheticGstin('29', 'DDDDD4444D'), line1: '7, Lorry Stand', city: 'Bengaluru', pincode: '560023' })).supplier.id;
  advocate = (await ok('/api/suppliers', { legalName: 'R. Iyer, Advocate', registration: 'regular', gstin: syntheticGstin('29', 'IIIII3333I'), line1: '11, Court Road', city: 'Bengaluru', pincode: '560001' })).supplier.id;
  await ok('/api/items', { name: 'Copper scrap', kind: 'goods', hsnSac: '74040010', unit: 'KGS', taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'Rate schedule' });
  // The item record says 18%; under reverse charge the law's rate for GTA freight is 5%.
  await ok('/api/items', { name: 'Lorry freight (GTA)', kind: 'service', hsnSac: '996791', unit: 'NOS', taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'Rate schedule' });
  await ok('/api/items', { name: 'Legal fees', kind: 'service', hsnSac: '998212', unit: 'NOS', taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'Rate schedule' });
});

test('metal scrap from a seller with no GST number: recorded, the buyer owes 18%, the seller is owed the price', async () => {
  const preview = await ok('/api/purchases/preview', {
    supplierId: scrapDealer, reference: 'KT-1', date: DATE, lines: [{ item: 'Copper scrap', quantity: '200', rate: '500' }],
  });
  const said = preview.effects.join(' ');
  assert.match(said, /4\/2017-Central Tax \(Rate\), S\.No\. 8 inserted by 06\/2024/);
  assert.match(said, /3\.1\(d\)/);
  assert.match(said, /s\.49\(4\)/);
  assert.match(said, /Rule 47A/, 'the self-invoice is named while the app does not make it yet');
  assert.match(preview.message, /reverse charge/);

  const recorded = await ok('/api/purchases/record', {
    supplierId: scrapDealer, reference: 'KT-1', date: DATE, lines: [{ item: 'Copper scrap', quantity: '200', rate: '500' }],
  });
  assert.equal(recorded.owe, 100000, '₹1,00,000 to the seller, and not a paisa of GST');
  assert.equal(recorded.bill.cgst, 9000);
  assert.equal(recorded.bill.sgst, 9000);
  // Never in GSTR-2B: the credit is self-assessed and claimed in the same month (4(A)(3)).
  assert.equal(recorded.purchaseCheck.outcome, 'CLAIM_NOW');
  assert.match(recorded.purchaseCheck.sentence, /in cash/);
  assert.match(recorded.purchaseCheck.sentence, /never in GSTR-2B/);
});

test('GTA freight: asks only what the code cannot tell, one question at a time, and keeps the answers', async () => {
  const bill = { supplierId: transporter, reference: 'SDR-55', date: DATE, lines: [{ item: 'Lorry freight (GTA)', quantity: '1', rate: '8000' }] };

  const first = await refused('/api/purchases/preview', bill);
  assert.equal(first.code, 'PURCHASE_REVERSE_CHARGE_QUESTION');
  assert.deepEqual(questionsOf(first).map((ask) => ask.id), ['gta_consignment_note']);
  assert.match(questionsOf(first)[0]!.why, /13\/2017-CT\(R\), S\.No\. 1/);

  // Not a GTA: no consignment note, so it is an ordinary bill with the GST the transporter charged.
  const notGta = await ok('/api/purchases/preview', { ...bill, lines: [{ ...bill.lines[0], gst: '1800' }], rcm_gta_consignment_note: 'no' });
  assert.equal(notGta.tax.total, 1440);
  assert.doesNotMatch(notGta.message, /reverse charge/);

  const second = await refused('/api/purchases/preview', { ...bill, rcm_gta_consignment_note: 'yes' });
  assert.deepEqual(questionsOf(second).map((ask) => ask.id), ['gta_exempt']);
  assert.match(questionsOf(second)[0]!.why, /12\/2017-CT\(R\), S\.No\. 21/);

  const third = await refused('/api/purchases/preview', { ...bill, rcm_gta_consignment_note: 'yes', rcm_gta_exempt: 'no' });
  assert.deepEqual(questionsOf(third).map((ask) => ask.id), ['gta_forward_charge'], 'asked of a registered transporter only');

  // The transporter charging GST on a reverse-charge bill is refused, naming Rule 46(p).
  const charged = await refused('/api/purchases/preview', { ...bill, lines: [{ ...bill.lines[0], gst: '500' }], rcm_gta_consignment_note: 'yes', rcm_gta_exempt: 'no', rcm_gta_forward_charge: 'no' });
  assert.equal(charged.code, 'PURCHASE_REVERSE_CHARGE_GST_CHARGED');
  assert.match(charged.message, /Rule 46\(p\)/);

  const answered = { ...bill, reverseChargeAnswers: { gta_consignment_note: 'yes', gta_exempt: 'no', gta_forward_charge: 'no' } };
  const recorded = await ok('/api/purchases/record', answered);
  assert.equal(recorded.owe, 8000);
  assert.equal(recorded.bill.cgst + recorded.bill.sgst, 400, '5% of ₹8,000 — the law’s rate, not the item’s 18%');
});

test('GTA freight that is exempt, or where the GTA opted to pay the GST itself, is not reverse charge', async () => {
  const exempt = await ok('/api/purchases/record', {
    supplierId: transporter, reference: 'SDR-56', date: DATE, lines: [{ item: 'Lorry freight (GTA)', quantity: '1', rate: '1200' }],
    rcm_gta_consignment_note: 'yes', rcm_gta_exempt: 'yes',
  });
  assert.equal(exempt.owe, 1200);
  assert.equal(exempt.bill.cgst + exempt.bill.sgst, 0);

  const forward = await ok('/api/purchases/record', {
    supplierId: transporter, reference: 'SDR-57', date: DATE, lines: [{ item: 'Lorry freight (GTA)', quantity: '1', rate: '10000', gst: '1800' }],
    rcm_gta_consignment_note: 'yes', rcm_gta_exempt: 'no', rcm_gta_forward_charge: 'yes',
  });
  assert.equal(forward.owe, 11800, 'the GTA charged 18% on its own bill, paid to them as on any bill');
});

test('an advocate: reverse charge unless the business was below ₹20 lakh last year', async () => {
  const bill = { supplierId: advocate, reference: 'RI-9', date: DATE, lines: [{ item: 'Legal fees', quantity: '1', rate: '25000' }] };
  const asked = await refused('/api/purchases/preview', bill);
  assert.deepEqual(questionsOf(asked).map((ask) => ask.id), ['legal_advocate']);
  const small = await refused('/api/purchases/preview', { ...bill, rcm_legal_advocate: 'yes' });
  assert.deepEqual(questionsOf(small).map((ask) => ask.id), ['legal_turnover_above_limit']);
  assert.match(questionsOf(small)[0]!.why, /12\/2017-CT\(R\), S\.No\. 45/);

  const recorded = await ok('/api/purchases/record', { ...bill, rcm_legal_advocate: 'yes', rcm_legal_turnover_above_limit: 'yes' });
  assert.equal(recorded.owe, 25000);
  assert.equal(recorded.bill.cgst + recorded.bill.sgst, 4500, '18% from the item’s rate');
});

test('GSTR-3B: the tax is in 3.1(d), the self-assessed credit in 4(A)(3), and it is paid in cash', async () => {
  const month = await ok('/api/gst-returns', { period: MONTH });
  const threeB = month.gstr3b ?? month.workspace?.gstr3b;
  assert.ok(threeB, JSON.stringify(Object.keys(month)));
  const cgst = threeB.heads.find((head: any) => head.head === 'CGST');
  // Scrap ₹9,000 + GTA ₹200 + legal ₹2,250 of CGST under reverse charge.
  assert.equal(cgst.reverseChargeCash, 11450);
  assert.ok(cgst.cashToPay >= 11450, 'credit cannot pay reverse-charge tax');

  await ok('/api/gst-returns/prepare', { period: MONTH });
  await ok('/api/gst-returns/approve', { period: MONTH, note: 'checked' });
  const file = (await ok('/api/gst-returns/export', { period: MONTH, returnType: 'GSTR3B' })).payload;
  const reverse = file.sup_details.isup_rev;
  assert.equal(reverse.camt + reverse.samt, 22900, 'scrap ₹18,000 + GTA ₹400 + legal ₹4,500');
  const selfAssessed = file.itc_elg.itc_avl.find((row: any) => row.ty === 'ISRC');
  // The scrap dealer has no GST number: its credit is self-assessed. The GTA and the advocate are
  // registered: their reverse-charge bills reach GSTR-2B and are matched there as usual.
  assert.equal(selfAssessed.camt + selfAssessed.samt, 18000);
});
